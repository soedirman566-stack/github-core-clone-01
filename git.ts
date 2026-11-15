// git.ts — the git plane: objects, packs, pkt-lines, reachability.
//
// Objects are stored byte-for-byte as they arrive (a pushed commit is served
// back identically), and every object the forge creates itself — contents-API
// commits, merge commits — goes through the same hash/store path. Packfiles
// are written without deltas (legal, and the reader still resolves OFS_DELTA
// and REF_DELTA for packs clients send). All protocol state lives in the
// RepoRec; this module is functions over it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';
import { VIEWER } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

/** SHA-1 over `<type> <length>\0<data>` — the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and answer its id (idempotent: objects are immutable). */
export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: RepoRec, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  /** The raw message: everything after the header's blank line, byte-exact. */
  readonly message: string;
  readonly author: string;
  readonly committer: string;
}

/** Parse a commit object. Headers end at the first blank line; the rest is the message. */
export function parseCommit(data: Buffer): CommitInfo {
  const split = data.indexOf('\n\n');
  const head = (split < 0 ? data : data.subarray(0, split)).toString('utf8');
  const message = split < 0 ? '' : data.subarray(split + 2).toString('utf8');
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

/** The message as the REST surface shows it: the stored bytes minus one trailing newline. */
export function apiCommitMessage(info: CommitInfo): string {
  return info.message.endsWith('\n') ? info.message.slice(0, -1) : info.message;
}

const FORGE_IDENT = `${VIEWER.name} <${VIEWER.email}> 1700000000 +0000`;

/** Build and store a commit object; answers its id. */
export function makeCommit(repo: RepoRec, tree: string, parents: string[], message: string): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENT}`, `committer ${FORGE_IDENT}`, '', message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** Parse a tree object: `<mode> <name>\0<20-byte id>` repeated. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Serialise tree entries in git's order (names compared with '/' appended for directories). */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (isDirMode(a.mode) ? '/' : '');
    const kb = b.name + (isDirMode(b.mode) ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path → blob entry, recursively. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const tree = getObject(repo, treeSha);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Write a tree hierarchy for a flattened path map; answers the root tree id. */
export function buildTreeFromFlat(repo: RepoRec, flat: Map<string, { sha: string; mode: string }>): string {
  const files: TreeEntry[] = [];
  const dirs = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [path, entry] of flat) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      files.push({ mode: entry.mode, name: path, sha: entry.sha });
    } else {
      const head = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let bucket = dirs.get(head);
      if (!bucket) {
        bucket = new Map();
        dirs.set(head, bucket);
      }
      bucket.set(rest, entry);
    }
  }
  const entries = [...files];
  for (const [name, bucket] of dirs) {
    entries.push({ mode: '40000', name, sha: buildTreeFromFlat(repo, bucket) });
  }
  return putObject(repo, 'tree', buildTreeData(entries));
}

/** The empty tree's id (a tree with no entries), created on demand. */
export function emptyTree(repo: RepoRec): string {
  return putObject(repo, 'tree', Buffer.alloc(0));
}

// -------------------------------------------------------------- tags, refs

/** An annotated tag's target id (the `object` header). */
export function parseTagTarget(data: Buffer): string {
  const split = data.indexOf('\n\n');
  const head = (split < 0 ? data : data.subarray(0, split)).toString('utf8');
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

/** Follow tag objects to the commit they name; null when the chain breaks. */
export function resolveToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(repo, current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTagTarget(object.data);
    if (!isOid(current)) return null;
  }
  return null;
}

/** The commit a ref peels to when it names a tag object; null for non-tags. */
export function peelRef(repo: RepoRec, oid: string): string | null {
  const object = getObject(repo, oid);
  if (!object || object.type !== 'tag') return null;
  return resolveToCommit(repo, oid);
}

/** Every commit reachable from `tip` (inclusive), breadth-first. */
export function commitAncestors(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    const object = getObject(repo, current);
    if (!object || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = getObject(repo, current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (the first of b's ancestors that a also has), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfA.has(current)) return current;
    const object = getObject(repo, current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ------------------------------------------------------------- reachability

/** Add a tree and everything under it to `out`. */
function collectTree(repo: RepoRec, treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const tree = getObject(repo, treeSha);
  if (!tree || tree.type !== 'tree') return;
  out.add(treeSha);
  for (const entry of parseTree(tree.data)) {
    if (isDirMode(entry.mode)) collectTree(repo, entry.sha, out);
    else out.add(entry.sha);
  }
}

/** Every object reachable from the given roots (commits walk their whole history). */
export function collectClosure(repo: RepoRec, roots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (out.has(oid)) continue;
    const object = getObject(repo, oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      collectTree(repo, info.tree, out);
      for (const parent of info.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data));
    } else if (object.type === 'tree') {
      collectTree(repo, oid, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

/** Encode one object's pack header: the type/size varint. */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type] as number;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 of the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA/REF_DELTA
 * (a REF_DELTA base may come from `resolveBase` — a thin pack). Throws on
 * any structural problem; callers turn that into an unpack failure.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | null): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry & { resolved?: GitObject }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: inflated.buffer, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (entry: RawPackEntry & { resolved?: GitObject }): GitObject => {
    if (entry.resolved) return entry.resolved;
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid) ?? resolveBase?.(entry.baseOid) ?? null;
      if (!base) throw new Error('ref-delta base missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPES[entry.typeCode] as GitObjectType, data: entry.data };
    }
    entry.resolved = object;
    resolvedByOid.set(hashObject(object.type, object.data), object);
    return object;
  };
  return raw.map((entry) => resolve(entry));
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** A sequential pkt-line reader over a complete request body. */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next packet, or null at the end of the buffer. Throws on bad framing. */
  next(): PktPacket | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.offset + 4 > this.buffer.length) throw new Error('truncated pkt-line');
    const hex = this.buffer.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (length < 4 || this.offset + length > this.buffer.length) throw new Error('pkt-line overruns body');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Everything not yet consumed (a push's packfile rides here). */
  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

/** Wrap a packfile in side-band-64k band-1 packets (pkt-line length ≤ 65520 incl. header). */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

// ------------------------------------------------------------ fetch planning

export interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** Commits grouped by generation distance from `roots` (0 = the roots themselves). */
function generations(repo: RepoRec, roots: string[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = roots.filter((oid) => getObject(repo, oid)?.type === 'commit');
  for (const oid of frontier) distance.set(oid, 0);
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const info = parseCommit((getObject(repo, oid) as GitObject).data);
      for (const parent of info.parents) {
        if (!distance.has(parent) && getObject(repo, parent)?.type === 'commit') {
          distance.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/** The object set for a set of commits: the commits plus their full tree closures. */
function objectsForCommits(repo: RepoRec, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const object = getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    out.add(oid);
    collectTree(repo, parseCommit(object.data).tree, out);
  }
  return out;
}

function toObjects(repo: RepoRec, oids: Set<string>): GitObject[] {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = getObject(repo, oid);
    if (object) objects.push(object);
  }
  return objects;
}

/**
 * Plan a fetch: which objects to pack, and the shallow boundary to report.
 *   - no depth: everything reachable from the wants that the haves' closure lacks;
 *   - depth: that many generations in total measured from the wants. What the
 *     client already holds is its shallow closure — each held commit plus its
 *     tree — never the held commits' history, which is exactly what a shallow
 *     client does not have. The reported boundary is the included commits
 *     whose parents stayed behind, plus any old boundary whose whole history
 *     this fetch completed (unshallow).
 */
export function planFetch(repo: RepoRec, wants: string[], haves: string[], depth: number | null, boundary: string[]): FetchPlan {
  const haveClosure = collectClosure(repo, haves.filter((oid) => getObject(repo, oid)));
  if (depth === null || depth <= 0) {
    const wanted = collectClosure(repo, wants.filter((oid) => getObject(repo, oid)));
    for (const oid of haveClosure) wanted.delete(oid);
    return { objects: toObjects(repo, wanted), shallow: [], unshallow: boundary.filter((oid) => getObject(repo, oid)) };
  }
  const distance = generations(repo, wants);
  const included = new Set<string>();
  for (const [oid, dist] of distance) {
    if (dist < depth) included.add(oid);
  }
  const held = new Set<string>();
  for (const oid of [...haves, ...boundary]) {
    for (const heldOid of objectsForCommits(repo, [oid])) held.add(heldOid);
  }
  const oids = objectsForCommits(repo, included);
  for (const oid of held) oids.delete(oid);
  const shallow: string[] = [];
  for (const oid of included) {
    const info = parseCommit((getObject(repo, oid) as GitObject).data);
    if (info.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const b of boundary) {
    if (!included.has(b) && !wants.includes(b)) continue;
    let complete = true;
    for (const ancestor of commitAncestors(repo, b)) {
      if (ancestor !== b && !included.has(ancestor)) {
        complete = false;
        break;
      }
    }
    if (complete) unshallow.push(b);
  }
  return {
    objects: toObjects(repo, oids),
    shallow: shallow.filter((oid) => !unshallow.includes(oid)),
    unshallow,
  };
}

// ------------------------------------------------------- diffs and merging

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
}

function contentLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence length of two line arrays (two-row DP). */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 25_000_000) {
    // Fallback for very large files: count shared lines as a multiset.
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let shared = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        shared += 1;
        counts.set(line, left - 1);
      }
    }
    return shared;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length] as number;
}

function lineDelta(repo: RepoRec, baseSha: string | null, headSha: string | null): { additions: number; deletions: number } {
  const base = baseSha ? (getObject(repo, baseSha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const head = headSha ? (getObject(repo, headSha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const baseLines = contentLines(base);
  const headLines = contentLines(head);
  const shared = lcsLength(baseLines, headLines);
  return { additions: headLines.length - shared, deletions: baseLines.length - shared };
}

/** The changed paths between two flattened trees, with line counts. */
export function diffFlats(
  repo: RepoRec,
  base: Map<string, { sha: string; mode: string }>,
  head: Map<string, { sha: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && after && before.sha === after.sha) continue;
    const delta = lineDelta(repo, before?.sha ?? null, after?.sha ?? null);
    changes.push({
      path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: delta.additions,
      deletions: delta.deletions,
    });
  }
  return changes;
}

/**
 * Three-way merge of flattened trees: a path conflicts when both sides changed
 * it since the merge-base with different results. Returns the merged flat map,
 * or null on conflict.
 */
export function mergeFlats(
  base: Map<string, { sha: string; mode: string }>,
  head: Map<string, { sha: string; mode: string }>,
  onto: Map<string, { sha: string; mode: string }>,
): Map<string, { sha: string; mode: string }> | null {
  const same = (a?: { sha: string }, b?: { sha: string }): boolean => (a?.sha ?? null) === (b?.sha ?? null);
  const merged = new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys(), ...onto.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const o = onto.get(path);
    const headChanged = !same(b, h);
    const ontoChanged = !same(b, o);
    if (headChanged && ontoChanged && !same(h, o)) return null;
    const winner = headChanged ? h : o;
    if (winner) merged.set(path, winner);
  }
  return merged;
}

// ------------------------------------------------------------- smart HTTP

import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Sorted ref names: branches first, then tags, then anything else. */
export function sortedRefNames(repo: RepoRec): string[] {
  const names = [...repo.refs.keys()];
  const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
  return names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The ref lines of a v0 advertisement (HEAD first), without the service preamble. */
function v0RefLines(repo: RepoRec, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  lines.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${capabilities}\n`));
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    lines.push(pktLine(`${oid} ${name}\n`));
    const peeled = peelRef(repo, oid);
    if (peeled) lines.push(pktLine(`${peeled} ${name}^{}\n`));
  }
  return lines;
}

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

/** GET info/refs: a v2 capability advertisement when asked, else v0 refs. */
export function handleInfoRefs(repo: RepoRec, service: string, protocolV2: boolean, res: ServerResponse): void {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, contentType, body);
    return;
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS_V0;
  const parts = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH];
  sendBuffer(res, 200, contentType, Buffer.concat(parts));
}

/** Read data packet payloads as text lines until a flush/delim or the end. */
function readLines(reader: PktReader): { lines: string[]; endedBy: 'flush' | 'delim' | 'eof' } {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) return { lines, endedBy: 'eof' };
    if (packet.kind === 'flush') return { lines, endedBy: 'flush' };
    if (packet.kind === 'delim') return { lines, endedBy: 'delim' };
    if (packet.kind === 'end') return { lines, endedBy: 'flush' };
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
}

/** POST git-upload-pack with protocol v2: ls-refs or fetch. */
export function handleUploadPackV2(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const reader = new PktReader(body);
  const first = readLines(reader);
  const commandLine = first.lines.find((line) => line.startsWith('command='));
  const args = readLines(reader).lines;
  if (commandLine === 'command=ls-refs') {
    answerLsRefs(repo, args, res);
    return;
  }
  if (commandLine === 'command=fetch') {
    answerFetchV2(repo, args, res);
    return;
  }
  sendText(res, 400, 'unknown command\n');
}

function answerLsRefs(repo: RepoRec, args: string[], res: ServerResponse): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const peeled = peelRef(repo, oid);
      if (peeled) suffix = ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  lines.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
}

/** Parse fetch arguments shared by both protocol versions. */
interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  boundary: string[];
  done: boolean;
}

function parseFetchArgs(lines: string[], v0: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: null, boundary: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.boundary.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  void v0;
  return args;
}

/** The pack for a fetch: cached per repository version and request shape; planned only on a miss. */
function fetchPack(repo: RepoRec, args: FetchArgs, version: string): Buffer {
  const key = [version, repo.gitVersion, ...args.wants, '|', ...args.haves, '|', String(args.depth), '|', ...args.boundary].join(':');
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.boundary);
  const pack = writePack(plan.objects);
  if (repo.packCache.size > 128) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

function answerFetchV2(repo: RepoRec, argLines: string[], res: ServerResponse): void {
  const args = parseFetchArgs(argLines, false);
  const cacheKey = ['resp-v2', repo.gitVersion, ...args.wants, '|', ...args.haves, '|', String(args.depth), '|', ...args.boundary, '|', String(args.done)].join(':');
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached);
    return;
  }
  const parts: Buffer[] = [];
  const common = args.haves.filter((oid) => getObject(repo, oid) && args.wants.some((want) => isAncestor(repo, oid, want) || oid === want));
  parts.push(pktLine('acknowledgments\n'));
  if (common.length > 0) {
    parts.push(pktLine(`ACK ${common[common.length - 1]} common\n`));
    if (args.done) parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (args.done && args.wants.length > 0) {
    const plan = planFetch(repo, args.wants, args.haves, args.depth, args.boundary);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    const pack = fetchPack(repo, args, 'v2');
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (repo.packCache.size > 128) repo.packCache.clear();
  repo.packCache.set(cacheKey, body);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
}

/** POST git-upload-pack with protocol v0: wants, flush, haves, done. */
export function handleUploadPackV0(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const reader = new PktReader(body);
  const firstSection = readLines(reader);
  if (!firstSection.lines.some((line) => line.startsWith('want '))) {
    sendText(res, 400, 'expected want lines\n');
    return;
  }
  const secondSection = readLines(reader);
  const args = parseFetchArgs([...firstSection.lines, ...secondSection.lines], true);
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.boundary);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.filter((oid) => getObject(repo, oid) && args.wants.some((want) => isAncestor(repo, oid, want) || oid === want));
  if (common.length > 0) parts.push(pktLine(`ACK ${common[common.length - 1]} common\n`));
  else parts.push(pktLine('NAK\n'));
  const pack = fetchPack(repo, args, 'v0');
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST git-receive-pack: apply ref updates from a command list plus pack. */
export function handleReceivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const reader = new PktReader(body);
  const section = readLines(reader);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let capabilities = '';
  section.lines.forEach((raw, index) => {
    let line = raw;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (index === 0) capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  });
  const packBytes = reader.rest();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackError === null ? 'ok' : `error: ${unpackError}`}\n`];
  let changed = false;
  for (const command of commands) {
    const failure = unpackError !== null ? 'unpacker error' : validateAndApply(repo, command);
    if (failure === null) {
      report.push(`ok ${command.ref}\n`);
      changed = true;
    } else {
      report.push(`ng ${command.ref} ${failure}\n`);
    }
  }
  if (changed) repo.gitVersion += 1;

  const wantsStatus = capabilities.split(' ').includes('report-status') || capabilities.split(' ').includes('report-status-v2');
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  const reportStream = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (!wantsStatus) {
    responseBody = PKT_FLUSH;
  } else if (wantsSideband) {
    // The report stream rides inside band 1, itself pkt-framed, with its inner flush.
    const packets: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    responseBody = Buffer.concat(packets);
  } else {
    responseBody = reportStream;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', responseBody);
}

/** Validate one push command and apply it; returns the refusal reason or null. */
function validateAndApply(repo: RepoRec, command: { oldOid: string; newOid: string; ref: string }): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return 'invalid ref';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return 'stale info';
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return null;
  }
  const object = getObject(repo, newOid);
  if (!object) return 'bad object';
  if (ref.startsWith('refs/heads/')) {
    const commit = resolveToCommit(repo, newOid);
    if (commit === null) return 'bad object';
    if (oldOid !== ZERO_OID && !isAncestor(repo, oldOid, commit)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}

/** Keep the Store import used for types in this module's signatures. */
export type { Store };
