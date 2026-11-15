// In-memory store: repositories, git objects/refs, issues, pull requests, labels.
// Everything the four surfaces (git smart HTTP, REST v3, GraphQL, MCP) read and write
// lives here, so a change on one surface is visible on the others immediately.
//
// Determinism: ids and timestamps come from counters, never the wall clock or
// Math.random, so two runs that receive the same requests in the same order hold the
// same state.

import { createHash } from 'node:crypto';
import { VIEWER_LOGIN } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (v: string): boolean => HEX40.test(v);

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- git parsing

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8').replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r) && r !== ZERO_OID) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal); walks parents. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** Flat path -> blob oid map of a tree (recursive). Results cached per tree oid. */
const treeFileCache = new Map<string, Map<string, string>>();
export function treeFiles(repo: Repo, treeOid: string): Map<string, string> {
  const cached = treeFileCache.get(treeOid);
  if (cached) return cached;
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else if (e.mode !== '160000') out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  walk(treeOid, '');
  // Cache is per-process and trees are immutable; cap size to stay bounded.
  if (treeFileCache.size > 4096) treeFileCache.clear();
  treeFileCache.set(treeOid, out);
  return out;
}

/** Build (and store) a tree object from a flat path -> blob oid map. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node { files: Map<string, string>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Find the merge-base of two commits (first common ancestor, newest-first walk). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const qa = [a];
  while (qa.length) {
    const oid = qa.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
  }
  const qb = [b];
  const seen = new Set<string>();
  while (qb.length) {
    const oid = qb.pop()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  return null;
}

// ---------------------------------------------------------------- domain types

export interface Label { name: string; color: string; description?: string }
export interface IssueComment { id: number; body: string; user: string; createdAt: string; updatedAt: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: string; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: IssueComment[]; seq: number;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  user: string; createdAt: string; updatedAt: string; closedAt: string | null; seq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  issues: Issue[]; pulls: Pull[]; labels: Map<string, Label>;
  nextNumber: number; // shared issue + PR numbering, GitHub-style
}

export interface Store {
  repos: Map<string, Repo>; // key `${owner}/${name}`
  nextRepoId: number;
  nextObjectId: number; // for issue/comment/PR numeric ids
  seq: number; // global creation sequence (drives created_at + ordering)
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 1000, nextObjectId: 1, seq: 0 };
}

/** Deterministic timestamp: fixed epoch + sequence seconds. */
export function stamp(store: Store): { at: string; seq: number } {
  store.seq += 1;
  const sec = 1_735_689_600 + store.seq;
  return { at: new Date(sec * 1000).toISOString().replace('.000Z', 'Z'), seq: store.seq };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** A repo the token owner may see: only the viewer's own repos exist in this forge. */
export function visibleRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return getRepo(store, owner, name);
}

export function createRepo(store: Store, owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const { seq } = stamp(store);
  const repo: Repo = {
    id: store.nextRepoId++,
    name, owner, description, private: isPrivate,
    defaultBranch: 'main', createdSeq: seq,
    objects: new Map(), refs: new Map(),
    issues: [], pulls: [], labels: new Map(),
    nextNumber: 1,
    gitVersion: 0,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

/** Bump a repo's git version after any object/ref mutation (invalidates git response caches). */
export function bumpGitVersion(repo: Repo): void {
  repo.gitVersion += 1;
}

/** Resolve a ref name (branch, full ref, or sha) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  if (repo.refs.has(full)) return repo.refs.get(full)!;
  return null;
}

/** The tip commit of a branch (default branch when omitted). */
export function branchTip(repo: Repo, branch?: string): string | null {
  const name = branch ?? repo.defaultBranch;
  return repo.refs.get(`refs/heads/${name}`) ?? null;
}

/** Global (Relay-style) ids: opaque base64, stable across reads, decodable by node(). */
export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}
export function ungid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

/** Line counts for a pull-request file diff (added/deleted lines, LCS-based). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS length via a compact DP over the shorter side.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    const cur = new Array<number>(short.length + 1).fill(0);
    for (let j = 1; j <= short.length; j += 1) {
      cur[j] = long[i - 1] === short[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[short.length];
  return { additions: b.length - common, deletions: a.length - common };
}
