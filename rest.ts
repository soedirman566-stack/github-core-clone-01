// rest.ts — the REST v3 surface.
//
// Routes are matched on decoded path segments under /api/v3. Every reply is a
// plain {status, body, headers} triple; app.ts serialises it (always JSON,
// always with an X-GitHub-Request-Id). Shapes follow GitHub's: rich objects
// with the fields the suite reads, subset-matched by its client. Ownership is
// absolute: a repository named under any owner but the viewer does not exist.

import type { CommentRec, IssueRec, PullRec, RepoRec, Store } from './store.ts';
import {
  apiCommitMessage,
  buildTreeFromFlat,
  diffFlats,
  flattenTree,
  getObject,
  isAncestor,
  isOid,
  makeCommit,
  mergeBase,
  mergeFlats,
  parseCommit,
  parseTree,
  putObject,
  resolveToCommit,
  ZERO_OID,
} from './git.ts';

export interface RestRequest {
  readonly method: string;
  /** Decoded path segments after /api/v3 (empty for the root). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body when it was an object, else null. */
  readonly body: Record<string, unknown> | null;
  /** The request path without the query string (for Link headers). */
  readonly path: string;
  readonly origin: string;
}

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function reply(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function notFound(): RestReply {
  return reply(404, { message: 'Not Found' });
}

function unprocessable(message: string): RestReply {
  return reply(422, { message });
}

// ------------------------------------------------------------------- shapes

const userJsonCache = new WeakMap<Store, Record<string, unknown>>();

export function userJson(store: Store): Record<string, unknown> {
  const cached = userJsonCache.get(store);
  if (cached) return cached;
  const viewer = store.viewer;
  const json: Record<string, unknown> = {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.login}`, 'utf8').toString('base64'),
    name: viewer.name,
    email: viewer.email,
    type: 'User',
    site_admin: false,
    avatar_url: '',
    html_url: '',
  };
  userJsonCache.set(store, json);
  return json;
}

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: '',
    clone_url: '',
    ssh_url: '',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const position = [...repo.labels.keys()].indexOf(name) + 1;
  return { id: repo.id * 1000 + position, name, color: label?.color ?? '000000', description: null, default: false };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(store),
    comments: store.commentsOf(repo, issue.number).length,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    url: '',
  };
}

export function commentJson(store: Store, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: userJson(store),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: '',
    url: '',
  };
}

/** The head sha a pull request reports: the live branch tip, else its creation tip. */
export function pullHeadSha(repo: RepoRec, pull: PullRec): string {
  return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(store),
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pullHeadSha(repo, pull) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    url: '',
  };
}

// --------------------------------------------------------------- pagination

interface Page<T> {
  readonly items: T[];
  readonly headers: Record<string, string>;
}

/** Slice a list by page/per_page and build the Link header when more pages exist. */
function paginate<T>(req: RestRequest, items: T[]): Page<T> {
  const perPageRaw = parseInt(req.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(req.query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `${req.origin}${req.path}?${params.toString()}`;
    };
    headers.link = `<${linkFor(page + 1)}>; rel="next", <${linkFor(lastPage)}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ------------------------------------------------------------ pull requests

/** The flattened tree at a commit, or an empty map when there is none. */
function flatAt(repo: RepoRec, commitSha: string | null): Map<string, { sha: string; mode: string }> {
  if (!commitSha) return new Map();
  const object = getObject(repo, commitSha);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** A pull request's changed files against its merge-base with the base branch. */
export function pullFileChanges(repo: RepoRec, pull: PullRec): { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[] {
  const headTip = pullHeadSha(repo, pull);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headCommit = resolveToCommit(repo, headTip);
  if (!headCommit) return [];
  const baseCommit = baseTip ? resolveToCommit(repo, baseTip) : null;
  const mb = baseCommit ? mergeBase(repo, headCommit, baseCommit) : null;
  const changes = diffFlats(repo, flatAt(repo, mb), flatAt(repo, headCommit));
  const headFlat = flatAt(repo, headCommit);
  const baseFlat = flatAt(repo, mb);
  return changes.map((change) => ({
    filename: change.path,
    status: change.status === 'modified' ? 'modified' : change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    sha: headFlat.get(change.path)?.sha ?? baseFlat.get(change.path)?.sha ?? ZERO_OID,
  }));
}

/** The merged flat tree for a pull request, or null when it conflicts. */
function mergedFlat(repo: RepoRec, pull: PullRec): { flat: Map<string, { sha: string; mode: string }>; baseTip: string; headTip: string } | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headTip = pullHeadSha(repo, pull);
  if (!baseTip) return null;
  const baseCommit = resolveToCommit(repo, baseTip);
  const headCommit = resolveToCommit(repo, headTip);
  if (!baseCommit || !headCommit) return null;
  const mb = mergeBase(repo, headCommit, baseCommit);
  const merged = mergeFlats(flatAt(repo, mb), flatAt(repo, headCommit), flatAt(repo, baseCommit));
  if (!merged) return null;
  return { flat: merged, baseTip: baseCommit, headTip: headCommit };
}

/** Whether an open pull request merges cleanly onto the current base tip. */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  return mergedFlat(repo, pull) === null;
}

/**
 * Merge a pull request onto its base branch: a squash commit (one parent) or a
 * merge commit (two parents) carrying the three-way merged tree. On success
 * the pull record is closed/merged and the new commit id returned.
 */
export function mergePullRequest(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): { sha: string } | { conflict: true } | { gone: true } {
  if (pull.merged || pull.state !== 'open') return { gone: true };
  const plan = mergedFlat(repo, pull);
  if (!plan) return { conflict: true };
  const tree = buildTreeFromFlat(repo, plan.flat);
  const parents = method === 'merge' ? [plan.baseTip, plan.headTip] : [plan.baseTip];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}` : `${pull.title} (#${pull.number})`;
  const sha = makeCommit(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.gitVersion += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  return { sha };
}

// ------------------------------------------------------------------- router

function bodyString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function labelNames(body: Record<string, unknown> | null): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** Validate that every named label exists; returns an error reply or null. */
function checkLabels(repo: RepoRec, names: string[]): RestReply | null {
  for (const name of names) {
    if (!repo.labels.has(name)) return unprocessable(`label '${name}' does not exist`);
  }
  return null;
}

function createRepo(store: Store, req: RestRequest): RestReply {
  const name = bodyString(req.body, 'name');
  if (!name) return unprocessable('name is required');
  const repo = store.createRepo(name, {
    description: bodyString(req.body, 'description') ?? '',
    isPrivate: req.body?.private === true,
  });
  if (!repo) return unprocessable('name already exists on this account');
  return reply(201, repoJson(store, repo));
}

function listIssues(store: Store, repo: RepoRec, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const page = paginate(req, issues);
  return reply(200, page.items.map((issue) => issueJson(store, repo, issue)), page.headers);
}

function createIssue(store: Store, repo: RepoRec, req: RestRequest): RestReply {
  const title = bodyString(req.body, 'title');
  if (!title) return unprocessable('title is required');
  const names = labelNames(req.body);
  const labelError = checkLabels(repo, names);
  if (labelError) return labelError;
  const issue = store.addIssue(repo, { title, body: bodyString(req.body, 'body') ?? '', labels: names });
  return reply(201, issueJson(store, repo, issue));
}

function patchIssue(store: Store, repo: RepoRec, issue: IssueRec, req: RestRequest): RestReply {
  const state = bodyString(req.body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = bodyString(req.body, 'title');
  if (title !== undefined) issue.title = title;
  const body = bodyString(req.body, 'body');
  if (body !== undefined) issue.body = body;
  if (Array.isArray(req.body?.labels)) {
    const names = labelNames(req.body);
    const labelError = checkLabels(repo, names);
    if (labelError) return labelError;
    issue.labels = names;
  }
  repo.updatedAt = new Date().toISOString();
  return reply(200, issueJson(store, repo, issue));
}

function listPulls(store: Store, repo: RepoRec, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.seq - b.seq);
  const page = paginate(req, pulls);
  return reply(200, page.items.map((pull) => pullJson(store, repo, pull)), page.headers);
}

function createPull(store: Store, repo: RepoRec, req: RestRequest): RestReply {
  const title = bodyString(req.body, 'title') ?? '';
  const headRaw = bodyString(req.body, 'head') ?? '';
  const baseRaw = bodyString(req.body, 'base') ?? '';
  const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
  const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha) return unprocessable(`head branch '${head}' does not exist`);
  if (!repo.refs.get(`refs/heads/${base}`)) return unprocessable(`base branch '${base}' does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return unprocessable('a pull request already exists for this head and base');
    }
  }
  const pull = store.addPull(repo, { title, body: bodyString(req.body, 'body') ?? '', headRef: head, baseRef: base, headSha });
  return reply(201, pullJson(store, repo, pull));
}

function mergePullRoute(repo: RepoRec, pull: PullRec, req: RestRequest): RestReply {
  if (pull.merged) return reply(405, { message: 'Pull Request is not mergeable' });
  const methodRaw = bodyString(req.body, 'merge_method') ?? 'merge';
  if (methodRaw !== 'merge' && methodRaw !== 'squash') return reply(405, { message: `merge method '${methodRaw}' is not supported` });
  const outcome = mergePullRequest(repo, pull, methodRaw);
  if ('conflict' in outcome) return reply(405, { message: 'Merge conflict' });
  if ('gone' in outcome) return reply(405, { message: 'Pull Request is not mergeable' });
  return reply(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ----------------------------------------------------------------- contents

/** The commit a ref name (branch) resolves to, or null. */
function refCommit(repo: RepoRec, ref: string | undefined): string | null {
  const branch = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? (isOid(branch) ? branch : undefined);
  if (!tip) return null;
  return resolveToCommit(repo, tip);
}

function contentsGet(repo: RepoRec, path: string, req: RestRequest): RestReply {
  const commit = refCommit(repo, req.query.get('ref') ?? undefined);
  if (!commit) return notFound();
  const commitObject = getObject(repo, commit);
  if (!commitObject) return notFound();
  let treeSha = parseCommit(commitObject.data).tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = getObject(repo, treeSha);
    if (!tree || tree.type !== 'tree') return notFound();
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return notFound();
    const isLast = i === segments.length - 1;
    if (!isLast) {
      if (entry.mode !== '40000' && entry.mode !== '040000') return notFound();
      treeSha = entry.sha;
      continue;
    }
    if (entry.mode === '40000' || entry.mode === '040000') {
      const dirTree = getObject(repo, entry.sha);
      if (!dirTree) return notFound();
      return reply(200, dirListing(repo, entry.sha, path));
    }
    const blob = getObject(repo, entry.sha);
    if (!blob) return notFound();
    return reply(200, {
      type: 'file',
      name: entry.name,
      path,
      sha: entry.sha,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
      url: '',
      html_url: '',
      download_url: null,
    });
  }
  // path === '' — the root listing.
  return reply(200, dirListing(repo, treeSha, ''));
}

function dirListing(repo: RepoRec, treeSha: string, basePath: string): Record<string, unknown>[] {
  const tree = getObject(repo, treeSha);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = !isDir ? getObject(repo, entry.sha) : null;
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
      sha: entry.sha,
      size: blob ? blob.data.length : 0,
      url: '',
      html_url: '',
      download_url: null,
    };
  });
}

function contentsPut(repo: RepoRec, path: string, req: RestRequest): RestReply {
  const content = bodyString(req.body, 'content');
  if (content === undefined) return unprocessable('content is required');
  const message = bodyString(req.body, 'message') ?? '';
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const givenSha = bodyString(req.body, 'sha');
  let baseCommit = refCommit(repo, branch);
  if (!baseCommit) baseCommit = refCommit(repo, repo.defaultBranch);
  const flat = flatAt(repo, baseCommit);
  const existing = flat.get(path);
  if (existing && givenSha === undefined) return unprocessable('sha is required when updating a file');
  if (existing && givenSha !== undefined && givenSha !== existing.sha) return reply(409, { message: 'sha does not match the current file' });
  const blobSha = putObject(repo, 'blob', Buffer.from(content.replace(/\s+/g, ''), 'base64'));
  flat.set(path, { sha: blobSha, mode: '100644' });
  const tree = buildTreeFromFlat(repo, flat);
  const commit = makeCommit(repo, tree, baseCommit ? [baseCommit] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.gitVersion += 1;
  const blob = getObject(repo, blobSha);
  return reply(existing ? 200 : 201, {
    content: {
      type: 'file',
      name: path.split('/').pop() as string,
      path,
      sha: blobSha,
      size: blob ? blob.data.length : 0,
      encoding: 'base64',
      url: '',
      html_url: '',
      download_url: null,
    },
    commit: { sha: commit, message, tree: { sha: tree }, author: null, committer: null },
  });
}

function contentsDelete(repo: RepoRec, path: string, req: RestRequest): RestReply {
  const message = bodyString(req.body, 'message') ?? '';
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const givenSha = bodyString(req.body, 'sha');
  const baseCommit = refCommit(repo, branch);
  if (!baseCommit) return notFound();
  const flat = flatAt(repo, baseCommit);
  const existing = flat.get(path);
  if (!existing) return notFound();
  if (givenSha !== undefined && givenSha !== existing.sha) return reply(409, { message: 'sha does not match the current file' });
  flat.delete(path);
  const tree = buildTreeFromFlat(repo, flat);
  const commit = makeCommit(repo, tree, [baseCommit], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.gitVersion += 1;
  return reply(200, { content: null, commit: { sha: commit, message, tree: { sha: tree }, author: null, committer: null } });
}

// ------------------------------------------------------------------- commits

function authorParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(parseInt(match[3] as string, 10) * 1000).toISOString(),
  };
}

function listCommits(repo: RepoRec, req: RestRequest): RestReply {
  const shaParam = req.query.get('sha') ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${shaParam}`);
  if (!tip && isOid(shaParam)) tip = shaParam;
  if (!tip) return notFound();
  const start = resolveToCommit(repo, tip);
  if (!start) return notFound();
  const ordered: string[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    const object = getObject(repo, current);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  const page = paginate(req, ordered);
  const items = page.items.map((sha) => {
    const info = parseCommit((getObject(repo, sha) as { data: Buffer }).data);
    return {
      sha,
      node_id: Buffer.from(`Commit:${sha}`, 'utf8').toString('base64'),
      commit: {
        author: authorParts(info.author),
        committer: authorParts(info.committer),
        message: apiCommitMessage(info),
        tree: { sha: info.tree, url: '' },
        comment_count: 0,
      },
      url: '',
      html_url: '',
      parents: info.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    };
  });
  return reply(200, items, page.headers);
}

// --------------------------------------------------------------------- main

/** Route one REST request. Authentication and body parsing happened in app.ts. */
export function handleRest(store: Store, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return reply(
      200,
      {
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${req.origin}/api/v3/repos/{owner}/{repo}/issues/{number}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return reply(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return reply(200, userJson(store));
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') return createRepo(store, req);
    if (method === 'GET') {
      const page = paginate(req, store.listRepos());
      return reply(200, page.items.map((repo) => repoJson(store, repo)), page.headers);
    }
    return notFound();
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();

  const repo = store.repo(seg[1] as string, seg[2] as string);
  if (!repo) return notFound();
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const description = bodyString(req.body, 'description');
      if (description !== undefined) repo.description = description;
      const name = bodyString(req.body, 'name');
      if (name !== undefined && name !== repo.name) return unprocessable('renaming is not supported');
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      repo.updatedAt = new Date().toISOString();
      return reply(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return reply(204, null);
    }
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(store, repo, req);
      if (method === 'POST') return createIssue(store, repo, req);
      return notFound();
    }
    const number = parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number) || String(number) !== rest[1]) return notFound();
    if (rest.length === 2) {
      const issue = repo.issues.get(number);
      if (method === 'GET') {
        if (issue) return reply(200, issueJson(store, repo, issue));
        const pull = repo.pulls.get(number);
        if (pull) return reply(200, { ...issueJson(store, repo, { number: pull.number, title: pull.title, body: pull.body, state: pull.state, labels: [], seq: pull.seq }), pull_request: { url: '' } });
        return notFound();
      }
      if (method === 'PATCH') {
        if (!issue) return notFound();
        return patchIssue(store, repo, issue, req);
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issueExists = repo.issues.has(number) || repo.pulls.has(number);
      if (!issueExists) return notFound();
      if (method === 'GET') {
        return reply(200, store.commentsOf(repo, number).map((comment) => commentJson(store, comment)));
      }
      if (method === 'POST') {
        const body = bodyString(req.body, 'body');
        if (body === undefined) return unprocessable('body is required');
        const comment = store.addComment(repo, number, body);
        return reply(201, commentJson(store, comment));
      }
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return reply(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    if (method === 'POST') {
      const name = bodyString(req.body, 'name');
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('label already exists');
      const color = (bodyString(req.body, 'color') ?? '000000').replace(/^#/, '').toLowerCase();
      repo.labels.set(name, { name, color });
      return reply(201, labelJson(repo, name));
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(store, repo, req);
      if (method === 'POST') return createPull(store, repo, req);
      return notFound();
    }
    const number = parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number) || String(number) !== rest[1]) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (method === 'GET') return pull ? reply(200, pullJson(store, repo, pull)) : notFound();
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound();
      const page = paginate(req, pullFileChanges(repo, pull));
      return reply(200, page.items, page.headers);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return notFound();
      return mergePullRoute(repo, pull, req);
    }
    return notFound();
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, path, req);
    if (method === 'PUT') return contentsPut(repo, path, req);
    if (method === 'DELETE') return contentsDelete(repo, path, req);
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = bodyString(req.body, 'ref') ?? '';
      const sha = bodyString(req.body, 'sha') ?? '';
      if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      if (!isOid(sha) || !getObject(repo, sha)) return unprocessable('sha does not name an object');
      if (repo.refs.has(ref)) return unprocessable('reference already exists');
      repo.refs.set(ref, sha);
      repo.gitVersion += 1;
      const object = getObject(repo, sha) as { type: string };
      return reply(201, { ref, node_id: '', object: { sha, type: object.type, url: '' }, url: '' });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) return notFound();
      const object = getObject(repo, oid);
      return reply(200, { ref, node_id: '', object: { sha: oid, type: object?.type ?? 'commit', url: '' }, url: '' });
    }
    return notFound();
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      return reply(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return notFound();
      return reply(200, { name, commit: { sha, url: '' }, protected: false });
    }
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    return listCommits(repo, req);
  }

  return notFound();
}
