// Git smart HTTP: pkt-line framing, packfile read/write (plain + OFS/REF deltas),
// protocol v2 upload-pack (ls-refs, fetch incl. shallow/deepen), v0 advertisement
// and receive-pack v0 with report-status + side-band-64k. No git binary, stdlib only.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import {
  ZERO_OID, isOid, hashObject, putObject, parseTree, parseCommit, parseTag,
  collectReachable, isAncestor, treeFiles, bumpGitVersion, type Repo, type GitObject, type ObjType,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole buffer of pkt-lines; throws on malformed framing. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { off += 4; continue; } // response-end: skip
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

export function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- packfile

const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number; typeCode: number; size: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
  resolved?: Buffer; resolvedType?: ObjType; oid?: string;
}

/** Read a packfile; resolve OFS/REF deltas (bases may live in `lookup`, for thin packs). */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readVarintSize(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function writePackHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
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

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 of the body. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(writePackHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'github-core-clone/1.0.0';
const HEAD_REF = 'refs/heads/main';

export function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const target = parseTag(obj.data).object;
  const t = repo.objects.get(target);
  return t?.type === 'commit' ? target : null;
}

/** v2 capability advertisement: "version 2" + capability lines. */
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** v0 advertisement for a service, with the "# service=" preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:${HEAD_REF} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(HEAD_REF) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export interface LsRefsArgs { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }

/** Parse a v2 ls-refs request body (after the command line + delim). */
export function parseLsRefsArgs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data' || !seenDelim) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: (string | 'flush')[] = [];
  const headOid = repo.refs.get(HEAD_REF);
  const emit = (oid: string, name: string, extra: string): void => {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => name.startsWith(p))) return;
    lines.push(`${oid} ${name}${extra}\n`);
  };
  if (headOid) {
    emit(headOid, 'HEAD', args.symrefs ? ` symref-target:${HEAD_REF}` : '');
  } else if (args.unborn) {
    lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${HEAD_REF}` : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    let extra = '';
    if (args.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) extra += ` peeled:${peeled}`;
    }
    emit(ref.oid, ref.name, extra);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------- fetch (v2 + v0)

export interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[];
  depth: number | null; done: boolean;
}

/** Parse a v2 fetch request body. */
export function parseFetchArgs(packets: Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data' || !seenDelim) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

/**
 * The objects a fetch must deliver, and the shallow boundary it reports.
 * - depth N: commits within N generations of the wants (distance < N), plus trees/blobs.
 * - otherwise: reachable(wants) minus reachable(haves).
 * Held objects (reachable from haves) are never re-sent.
 */
/** One commit plus its full tree closure (tree, subtrees, blobs) — no parents. */
function commitClosure(repo: Repo, commitOid: string): Set<string> {
  const out = new Set<string>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  out.add(commitOid);
  const stack = [parseCommit(obj.data).tree];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    out.add(oid);
    if (o.type === 'tree') for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
  }
  return out;
}

export function planFetch(repo: Repo, args: FetchArgs): { objects: GitObject[]; oids: Set<string>; shallow: string[]; unshallow: string[] } {
  // What the client already holds: the commits reachable from its haves, but a
  // shallow client stops at its shallow boundary — the parents of a shallow
  // commit are NOT held, even though the server can reach them.
  const shallowSet = new Set(args.shallow);
  const heldCommits = new Set<string>();
  const heldQueue = [...args.haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (heldCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    heldCommits.add(oid);
    if (shallowSet.has(oid)) continue; // boundary: parents are not held
    for (const p of parseCommit(obj.data).parents) heldQueue.push(p);
  }
  const held = new Set<string>();
  for (const c of heldCommits) for (const o of commitClosure(repo, c)) held.add(o);

  const wanted = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    // BFS by generation from the wants; distance 0 = the wants themselves.
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const w of args.wants) {
      if (isOid(w) && repo.objects.has(w)) { dist.set(w, 0); queue.push(w); }
    }
    const depthCommits: string[] = [];
    while (queue.length) {
      const oid = queue.shift()!;
      const d = dist.get(oid)!;
      if (d >= args.depth) continue;
      depthCommits.push(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (!dist.has(p) && repo.objects.has(p)) { dist.set(p, d + 1); queue.push(p); }
        }
      }
    }
    // The boundary: commits at the deepest delivered generation.
    const maxD = args.depth - 1;
    for (const oid of depthCommits) if (dist.get(oid) === maxD) shallow.push(oid);
    // Previous boundaries whose parents are now delivered are unshallow.
    const delivered = new Set(depthCommits);
    for (const b of args.shallow) {
      const obj = repo.objects.get(b);
      if (obj?.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.length > 0 && parents.every((p) => delivered.has(p))) unshallow.push(b);
      }
    }
    // A depth fetch delivers only the boundary commits' own tree closures —
    // never the parents' history (collectReachable would leak it).
    for (const oid of depthCommits) for (const o of commitClosure(repo, oid)) wanted.add(o);
  } else {
    for (const o of collectReachable(repo, args.wants)) wanted.add(o);
  }
  for (const h of held) wanted.delete(h);
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, oids: wanted, shallow, unshallow };
}

/** Sideband pkt-lines for a pack: band-1 chunks, each within the pkt-line limit. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const MAX_DATA = 65512;
  for (let off = 0; off < pack.length; off += MAX_DATA) {
    const slice = pack.subarray(off, Math.min(pack.length, off + MAX_DATA));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

/** v2 fetch response: acknowledgments, shallow-info, packfile sections.
 * Real git's server behaviour (verified against git 2.43 upload-pack):
 * - `done` sent (single-shot fetch): no acknowledgments section; straight to
 *   shallow-info (when any) and packfile.
 * - `done` not sent (negotiation round): acknowledgments first — `ACK <oid>`
 *   for every have the server holds (or NAK when none is common), then
 *   `ready`, delim, and the packfile section IN THE SAME response when a
 *   common commit was found. With no common commit, NAK + delim + flush
 *   only; the client then sends more haves or `done`.
 */
export function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    const common = args.haves.filter((h) => isOid(h) && repo.objects.has(h));
    parts.push(pktLine('acknowledgments\n'));
    if (common.length > 0) {
      for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
    if (common.length === 0) {
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  if (objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(writePack(objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK + shallow lines as plain pkt-lines, then sideband pack. */
export function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (objects.length > 0) parts.push(...sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

export interface PushCommand { oldOid: string; newOid: string; ref: string }

/** Parse a receive-pack request: command pkt-lines up to flush, then the raw pack. */
export function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let off = 0;
  for (;;) {
    if (off + 4 > body.length) throw new Error('truncated push');
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line in push');
    const len = Number.parseInt(head, 16);
    if (len === 0) { off += 4; break; }
    if (len < 4 || off + len > body.length) throw new Error('truncated push pkt-line');
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error('bad push command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  return { commands, pack: body.subarray(off) };
}

/** Apply a push: store the pack's objects, then apply each ref command. */
export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): { ref: string; ok: boolean; reason: string }[] {
  if (pack.length > 0) {
    const objects = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete: allowed when the ref exists (oldOid matched and was non-zero).
      if (current === ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        changed = true;
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unable to resolve' });
      continue;
    }
    if (current !== ZERO_OID && !isAncestor(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  if (changed || pack.length > 0) bumpGitVersion(repo);
  return results;
}

/**
 * report-status reply: the report lines are themselves pkt-lined (with a flush)
 * inside one side-band-64k band-1 packet, then the outer flush. Real git demuxes
 * band 1 and parses the inner pkt-line stream, so the inner flush is required.
 */
export function pushReportResponse(results: { ref: string; ok: boolean; reason: string }[]): Buffer {
  const lines: string[] = ['unpack ok\n'];
  for (const r of results) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const inner = pktLines([...lines, 'flush']);
  const band = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  return Buffer.concat([band, pktFlush()]);
}
