// REST v3 surface (/api/v3). Pure handlers over the store; app.ts owns HTTP plumbing
// (auth, request ids, JSON parsing). Shared helpers are exported for GraphQL/MCP.

import {
  ZERO_OID, isOid, putObject, parseCommit, parseTree, collectReachable,
  treeFiles, buildTreeFromFiles, mergeBase, lineDiff, gid,
  getRepo, visibleRepo, createRepo, resolveRef, branchTip, stamp, bumpGitVersion,
  type Store, type Repo, type Issue, type Pull, type Label,
} from './store.ts';
import { VIEWER_LOGIN, VIEWER_NAME, VIEWER_EMAIL } from './scenario.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body?: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

function userJson(login: string): Record<string, unknown> {
  return {
    login, id: 1000, node_id: gid('User', login), avatar_url: '', gravatar_id: '',
    url: `/api/v3/users/${login}`, html_url: `https://example.invalid/${login}`,
    type: 'User', site_admin: false, name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : `${login}@example.invalid`,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: gid('Repository', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner), private: repo.private, description: repo.description,
    fork: false, created_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString().replace('.000Z', 'Z'),
    updated_at: new Date((1_735_689_600 + store.seq) * 1000).toISOString().replace('.000Z', 'Z'),
    pushed_at: new Date((1_735_689_600 + store.seq) * 1000).toISOString().replace('.000Z', 'Z'),
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, mirror_url: null, archived: false, disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, web_commit_signoff_required: false,
    topics: [], visibility: repo.private ? 'private' : 'public', forks: 0, open_issues: 0,
    watchers: 0, default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: gid('Label', label.name), url: '', name: label.name, color: label.color, default: false, description: label.description ?? '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: gid('Issue', repo.id, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    user: userJson(issue.user), labels: issue.labels.map(labelJson),
    assignee: null, assignees: [], locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
    author_association: 'OWNER', html_url: '', url: '',
    repository_url: '', labels_url: '', comments_url: '', events_url: '',
  };
}

export function prDiff(store: Store, repo: Repo, pull: Pull): { files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] } {
  const mb = mergeBase(repo, pull.baseSha, pull.headSha);
  const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const mbFiles = mbTree ? treeFiles(repo, mbTree) : new Map<string, string>();
  const headFiles = treeFiles(repo, headTree);
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const a = mbFiles.get(path);
    const b = headFiles.get(path);
    if (a === b) continue;
    if (a === undefined) {
      const data = repo.objects.get(b!)!.data.toString('utf8');
      const lines = data === '' ? 0 : data.split('\n').length;
      files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b === undefined) {
      const data = repo.objects.get(a)!.data.toString('utf8');
      const lines = data === '' ? 0 : data.split('\n').length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const d = lineDiff(repo.objects.get(a)!.data.toString('utf8'), repo.objects.get(b)!.data.toString('utf8'));
      files.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return { files };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const diff = prDiff(store, repo, pull);
  const additions = diff.files.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
  return {
    id: pull.id, node_id: gid('PullRequest', repo.id, pull.number), number: pull.number,
    title: pull.title, body: pull.body, state: pull.state,
    user: userJson(pull.user), locked: false,
    created_at: pull.createdAt, updated_at: pull.updatedAt, closed_at: pull.closedAt,
    merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha, merged: pull.merged,
    mergeable: !pullIsConflicted(store, repo, pull), mergeable_state: pull.merged ? 'unknown' : 'clean',
    draft: false, additions, deletions, changed_files: diff.files.length, commits: 1,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(repo.owner), repo: repoJson(store, repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(repo.owner), repo: repoJson(store, repo) },
    html_url: '', url: '', author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, c: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: c.id, node_id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body,
    user: userJson(c.user), created_at: c.createdAt, updated_at: c.updatedAt, html_url: '', url: '',
    author_association: 'OWNER',
  };
}

/** True when the head cannot squash-merge onto the base (both sides changed a file differently).
 * The base is the CURRENT tip of the base branch, not the sha captured when the PR was opened:
 * after another PR merges, the base has moved and a second PR touching the same file conflicts. */
export function pullIsConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  if (pull.merged || pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.base) ?? pull.baseSha;
  const mb = mergeBase(repo, baseTip, pull.headSha);
  if (!mb) return false;
  const mbTree = parseCommit(repo.objects.get(mb)!.data).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const mbFiles = treeFiles(repo, mbTree);
  const headFiles = treeFiles(repo, headTree);
  const baseFiles = treeFiles(repo, baseTree);
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path);
    const h = headFiles.get(path);
    const b = baseFiles.get(path);
    const headChanged = h !== m;
    const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return true;
  }
  return false;
}

// ---------------------------------------------------------------- shared mutations (REST / GraphQL / MCP)

export function createIssueInternal(store: Store, repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string; status: number } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { error: `Label '${name}' does not exist`, status: 422 };
    labels.push(label);
  }
  const { at, seq } = stamp(store);
  const issue: Issue = {
    id: store.nextObjectId++, number: repo.nextNumber++, title, body: body ?? '',
    state: 'open', labels, user: VIEWER_LOGIN, createdAt: at, updatedAt: at, closedAt: null,
    comments: [], seq,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullInternal(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string; status: number } {
  const strip = (r: string): string => (r.includes(':') ? r.split(':').pop()! : r);
  const headRef = strip(head);
  const baseRef = strip(base);
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (!headSha || !baseSha) return { error: 'Head or base branch does not exist', status: 422 };
  if (repo.pulls.some((p) => p.state === 'open' && p.head === headRef && p.base === baseRef)) {
    return { error: 'A pull request already exists for this head and base', status: 422 };
  }
  const { at, seq } = stamp(store);
  const pull: Pull = {
    id: store.nextObjectId++, number: repo.nextNumber++, title, body: body ?? '', state: 'open',
    head: headRef, base: baseRef, headSha, baseSha,
    merged: false, mergedAt: null, mergeCommitSha: null,
    user: VIEWER_LOGIN, createdAt: at, updatedAt: at, closedAt: null, seq,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error.
 * Merges onto the CURRENT base tip (the base may have moved since the PR was opened). */
export function mergePullInternal(store: Store, repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
  if (pullIsConflicted(store, repo, pull)) return { error: 'Merge conflict', status: 405 };
  const baseTip = branchTip(repo, pull.base) ?? pull.baseSha;
  const mb = mergeBase(repo, baseTip, pull.headSha);
  const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const mbFiles = mbTree ? treeFiles(repo, mbTree) : new Map<string, string>();
  const headFiles = treeFiles(repo, headTree);
  const baseFiles = treeFiles(repo, baseTree);
  const merged = new Map(baseFiles);
  for (const [path, oid] of headFiles) if (mbFiles.get(path) !== oid) merged.set(path, oid);
  for (const path of mbFiles.keys()) if (!headFiles.has(path) && mbFiles.get(path) !== baseFiles.get(path)) merged.delete(path);
  const newTree = buildTreeFromFiles(repo, merged);
  const { at, seq } = stamp(store);
  const ts = 1_735_689_600 + seq;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n`;
  const commitData = Buffer.from(
    `tree ${newTree}\nparent ${baseTip}\nauthor ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\ncommitter ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\n\n${message}`,
    'utf8',
  );
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  bumpGitVersion(repo);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = at;
  pull.mergeCommitSha = sha;
  pull.updatedAt = at;
  pull.closedAt = at;
  return { sha };
}

/** Commit one file version on a branch (creating the branch from the default tip when needed). */
export function commitFile(
  store: Store, repo: Repo, branch: string | undefined, path: string, content: Buffer, message: string,
  expectedSha?: string,
): { commitSha: string; blobSha: string; created: boolean } | { error: string; status: number } {
  const branchName = branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branchName}`);
  if (!tip && branchName !== repo.defaultBranch) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip) tip = baseTip;
  }
  const files = new Map<string, string>();
  if (tip) {
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    for (const [p, o] of treeFiles(repo, tree)) files.set(p, o);
  }
  const existing = files.get(path);
  if (existing !== undefined) {
    if (expectedSha !== undefined && expectedSha !== existing) return { error: 'sha does not match the current file', status: 409 };
    if (expectedSha === undefined) return { error: 'sha is required to update a file', status: 409 };
  }
  const blobSha = putObject(repo, 'blob', content);
  files.set(path, blobSha);
  const tree = buildTreeFromFiles(repo, files);
  const { seq } = stamp(store);
  const ts = 1_735_689_600 + seq;
  const lines = [`tree ${tree}`];
  if (tip) lines.push(`parent ${tip}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`, `committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`, '');
  const commitData = Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  bumpGitVersion(repo);
  return { commitSha, blobSha, created: existing === undefined };
}

export function deleteFile(
  store: Store, repo: Repo, branch: string | undefined, path: string, message: string,
): { commitSha: string } | { error: string; status: number } {
  const branchName = branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branchName}`);
  if (!tip) return { error: 'Not Found', status: 404 };
  const tree = parseCommit(repo.objects.get(tip)!.data).tree;
  const files = new Map(treeFiles(repo, tree));
  if (!files.has(path)) return { error: 'Not Found', status: 404 };
  files.delete(path);
  const newTree = buildTreeFromFiles(repo, files);
  const { seq } = stamp(store);
  const ts = 1_735_689_600 + seq;
  const commitData = Buffer.from(
    `tree ${newTree}\nparent ${tip}\nauthor ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\ncommitter ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\n\n${message.endsWith('\n') ? message : `${message}\n`}`,
    'utf8',
  );
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  bumpGitVersion(repo);
  return { commitSha };
}

// ---------------------------------------------------------------- routing

interface Ctx {
  store: Store;
  origin: string;
  query: URLSearchParams;
  body: unknown;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: null, total: items.length };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const q = new URLSearchParams(query);
  q.set('page', String(page + 1));
  q.set('per_page', String(perPage));
  return `<${origin}${path}?${q.toString()}>; rel="next"`;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** List commits reachable from `tip`, newest first (DFS pre-order over parents). */
function listCommits(repo: Repo, tip: string): { sha: string; commit: { message: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string }; tree: { sha: string } } }[] {
  const out: { sha: string; commit: { message: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string }; tree: { sha: string } } }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const ident = (line: string): { name: string; email: string; date: string } => {
      const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line) ?? null;
      if (!m) return { name: line, email: '', date: '' };
      return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
    };
    out.push({
      sha: oid,
      commit: {
        message: c.message,
        author: ident(c.author),
        committer: ident(c.committer),
        tree: { sha: c.tree },
      },
    });
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]);
  }
  return out;
}

export function handleRest(ctx: Ctx, method: string, segments: string[]): RestResult {
  const { store } = ctx;
  const seg = segments;
  const q = ctx.query;

  // GET /api/v3/ — root
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise_version: '3.0.0' });
  }
  // GET /api/v3/user
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson(VIEWER_LOGIN));
  }
  // /api/v3/user/repos
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
      const items = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx.origin, '/api/v3/user/repos', q, page, perPage, all.length);
      if (link) headers.link = link;
      return ok(200, items.map((r) => repoJson(store, r)), headers);
    }
    if (method === 'POST') {
      const b = asRecord(ctx.body);
      const name = asString(b.name);
      if (name === '') return err(422, 'name is required');
      if (getRepo(store, VIEWER_LOGIN, name)) return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
      const repo = createRepo(store, VIEWER_LOGIN, name, asString(b.description), b.private === true);
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1];
    const name = seg[2];
    const rest = seg.slice(3);
    const repo = visibleRepo(store, owner, name);
    if (!repo) return err(404, 'Not Found');
    // /repos/{o}/{r} itself
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const b = asRecord(ctx.body);
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner}/${name}`);
        return { status: 204 };
      }
      return err(404, 'Not Found');
    }
    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
        return ok(200, list);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: rest[1], commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }
    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = q.get('sha');
      const tip = shaParam ? resolveRef(repo, shaParam) : branchTip(repo);
      if (!tip) return ok(200, []);
      return ok(200, listCommits(repo, tip));
    }
    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const b = asRecord(ctx.body);
        const ref = asString(b.ref);
        const sha = asString(b.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        bumpGitVersion(repo);
        return ok(201, { ref, object: { sha, type: 'commit', url: '' } });
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit', url: '' } });
      }
      if (method === 'GET' && rest.length === 2) {
        return ok(200, sortedRefsList(repo));
      }
      return err(404, 'Not Found');
    }
    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refParam = q.get('ref') ?? undefined;
      if (method === 'GET') return contentsGet(store, repo, path, refParam);
      if (method === 'PUT') {
        const b = asRecord(ctx.body);
        const content = asString(b.content);
        if (content === '') return err(422, 'content is required');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const branch = typeof b.branch === 'string' ? b.branch : undefined;
        const result = commitFile(store, repo, branch, path, bytes, asString(b.message) || 'Update file', typeof b.sha === 'string' ? b.sha : undefined);
        if ('error' in result) return err(result.status, result.error);
        const { at } = stamp(store);
        return ok(result.created ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: result.blobSha, size: bytes.length, type: 'file', encoding: 'base64', url: '', html_url: '', git_url: '', download_url: '' },
          commit: { sha: result.commitSha, message: asString(b.message) || 'Update file', author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: at }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: at } },
        });
      }
      if (method === 'DELETE') {
        const b = asRecord(ctx.body);
        const branch = typeof b.branch === 'string' ? b.branch : undefined;
        const result = deleteFile(store, repo, branch, path, asString(b.message) || 'Delete file');
        if ('error' in result) return err(result.status, result.error);
        return ok(200, { commit: { sha: result.commitSha } });
      }
      return err(404, 'Not Found');
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) return ok(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST' && rest.length === 1) {
        const b = asRecord(ctx.body);
        const name = asString(b.name);
        if (name === '') return err(422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing) return ok(201, labelJson(existing));
        const label: Label = { name, color: typeof b.color === 'string' ? b.color : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
        repo.labels.set(name, label);
        return ok(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(list, q);
          return ok(200, page.map((i) => issueJson(repo, i)));
        }
        if (method === 'POST') {
          const b = asRecord(ctx.body);
          const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          const created = createIssueInternal(store, repo, asString(b.title), asString(b.body), labels);
          if ('error' in created) return err(created.status, created.error);
          return ok(201, issueJson(repo, created));
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const b = asRecord(ctx.body);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? issue.updatedAt : null;
          }
          const { at } = stamp(store);
          issue.updatedAt = at;
          if (issue.state === 'closed' && !issue.closedAt) issue.closedAt = at;
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issue.comments.map((c) => commentJson(repo, issue, c)));
        if (method === 'POST') {
          const b = asRecord(ctx.body);
          const { at } = stamp(store);
          const comment: Issue['comments'][number] = { id: store.nextObjectId++, body: asString(b.body), user: VIEWER_LOGIN, createdAt: at, updatedAt: at };
          issue.comments.push(comment);
          return ok(201, commentJson(repo, issue, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, q);
          return ok(200, page.map((p) => pullJson(store, repo, p)));
        }
        if (method === 'POST') {
          const b = asRecord(ctx.body);
          const created = createPullInternal(store, repo, asString(b.title), asString(b.body), asString(b.head), asString(b.base));
          if ('error' in created) return err(created.status, created.error);
          return ok(201, pullJson(store, repo, created));
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, prDiff(store, repo, pull).files);
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return err(404, 'Not Found');
        if (method === 'PUT') {
          const merged = mergePullInternal(store, repo, pull);
          if ('error' in merged) return err(merged.status, merged.error);
          return ok(200, { sha: merged.sha, merged: true, message: `Pull Request #${pull.number} successfully merged` });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function sortedRefsList(repo: Repo): Record<string, unknown>[] {
  return [...repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, oid]) => ({ ref: name, object: { sha: oid, type: 'commit', url: '' } }));
}

function contentsGet(store: Store, repo: Repo, path: string, refParam: string | undefined): RestResult {
  const tip = refParam ? resolveRef(repo, refParam) : branchTip(repo);
  if (!tip) return err(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
  const rootTree = parseCommit(commit.data).tree;
  const files = treeFiles(repo, rootTree);
  const blobOid = files.get(path);
  if (blobOid) {
    const data = repo.objects.get(blobOid)!.data;
    return ok(200, {
      type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path,
      content: data.toString('base64'), sha: blobOid, url: '', html_url: '', git_url: '', download_url: '',
    });
  }
  // Directory listing: walk the tree to `path`.
  let treeOid = rootTree;
  const prefix = path === '' ? '' : `${path}/`;
  if (path !== '') {
    const segs = path.split('/');
    let okWalk = true;
    for (const seg of segs) {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') { okWalk = false; break; }
      const entry = parseTree(treeObj.data).find((e) => e.name === seg && e.mode === '40000');
      if (!entry) { okWalk = false; break; }
      treeOid = entry.oid;
    }
    if (!okWalk) return err(404, 'Not Found');
  }
  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return err(404, 'Not Found');
  const entries = parseTree(treeObj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)?.data.length ?? 0,
    name: e.name, path: `${prefix}${e.name}`, sha: e.oid,
    url: '', html_url: '', git_url: '', download_url: e.mode === '40000' ? null : '',
  }));
  return ok(200, entries);
}
