// GraphQL v4 executor for the documents gh / github-mcp-server send: a small
// recursive-descent parser + executor over the store. No library, stdlib only.
// Unknown fields answer HTTP 200 with an `errors` array naming the field.

import {
  visibleRepo, gid, ungid, branchTip, stamp,
  type Store, type Repo, type Issue, type Pull,
} from './store.ts';
import {
  createIssueInternal, createPullInternal, mergePullInternal,
  pullIsConflicted, prDiff,
} from './rest.ts';
import { VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  alias: string | null; name: string;
  args: { name: string; value: Value }[];
  children: SelectionNode[];
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string | null; children: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue: Value | null }[];
  selections: SelectionNode[];
}

interface Token { kind: string; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}():![]=@$&|'.includes(c)) { tokens.push({ kind: c, value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token | undefined { return this.tokens[this.pos]; }
  next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  expect(kind: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`);
    return t;
  }
  match(kind: string): boolean {
    if (this.peek()?.kind === kind) { this.pos += 1; return true; }
    return false;
  }
  name(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.kind}`);
    return t.value;
  }
  parseValue(): Value {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of document');
    if (t.kind === '$') { this.next(); return { kind: 'variable', name: this.name() }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'number') {
      this.next();
      return t.value.includes('.') || t.value.includes('e') || t.value.includes('E')
        ? { kind: 'float', value: Number(t.value) } : { kind: 'int', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === '[') {
      this.next();
      const items: Value[] = [];
      while (!this.match(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (t.kind === '{') {
      this.next();
      const fields: { name: string; value: Value }[] = [];
      while (!this.match('}')) {
        const name = this.name();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected token ${t.kind}`);
  }
  parseArgs(): { name: string; value: Value }[] {
    const args: { name: string; value: Value }[] = [];
    if (!this.match('(')) return args;
    while (!this.match(')')) {
      const name = this.name();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }
  parseSelections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (!this.match('}')) {
      if (this.peek()?.kind === '...') {
        this.next();
        if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') {
          this.next();
          const type = this.name();
          out.push({ kind: 'fragment', type, children: this.parseSelections() });
        } else {
          const name = this.name();
          out.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.name();
      let alias: string | null = null;
      let fieldName = first;
      if (this.peek()?.kind === ':') {
        this.next();
        alias = first;
        fieldName = this.name();
      }
      const args = this.parseArgs();
      // Directives (@include etc.): skip them.
      while (this.peek()?.kind === '@') {
        this.next();
        this.name();
        this.parseArgs();
      }
      const children = this.peek()?.kind === '{' ? this.parseSelections() : [];
      out.push({ kind: 'field', field: { alias, name: fieldName, args, children } });
    }
    return out;
  }
  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      if (this.peek()?.kind === 'name') name = this.name();
    }
    const variables: Operation['variables'] = [];
    if (this.match('(')) {
      while (!this.match(')')) {
        this.expect('$');
        const vname = this.name();
        this.expect(':');
        let type = '';
        if (this.match('[')) { type += '['; type += this.name(); this.expect(']'); }
        else type += this.name();
        if (this.match('!')) type += '!';
        let defaultValue: Value | null = null;
        if (this.match('=')) defaultValue = this.parseValue();
        variables.push({ name: vname, type, defaultValue });
      }
    }
    // Directives on the operation: skip.
    while (this.peek()?.kind === '@') { this.next(); this.name(); this.parseArgs(); }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

export function parseDocument(src: string): Document {
  const parser = new Parser(tokenize(src));
  const operations: Operation[] = [];
  const fragments = new Map<string, SelectionNode[]>();
  while (parser.peek()) {
    const t = parser.peek()!;
    if (t.kind === 'name' && t.value === 'fragment') {
      parser.next();
      const name = parser.name();
      if (parser.peek()?.kind === 'name' && parser.peek()!.value === 'on') { parser.next(); parser.name(); }
      fragments.set(name, parser.parseSelections());
      continue;
    }
    operations.push(parser.parseOperation());
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- executor

type Vars = Record<string, unknown>;

function resolveValue(v: Value, vars: Vars): unknown {
  switch (v.kind) {
    case 'variable': return vars[v.name];
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, vars: Vars): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg ? resolveValue(arg.value, vars) : undefined;
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt',
  'url', 'repository', 'comments', 'labels', 'assignees', 'participants', 'timelineItems',
];
const PR_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
  'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommitSha',
  'headRef', 'baseRef', 'url', 'repository', 'reviews', 'commits', 'additions', 'deletions', 'changedFiles',
];
const REPO_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  'createdAt', 'updatedAt', 'isPrivate', 'isFork', 'stargazerCount', 'forkCount', 'licenseInfo',
];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE'];

interface ExecCtx {
  store: Store;
  vars: Vars;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueNode(ctx: ExecCtx, repo: Repo, issue: Issue, field: FieldNode): Record<string, unknown> {
  return execSelections(ctx, 'Issue', { issue, repo }, field.children);
}
function prNode(ctx: ExecCtx, repo: Repo, pull: Pull, field: FieldNode): Record<string, unknown> {
  return execSelections(ctx, 'PullRequest', { pull, repo }, field.children);
}

function repoNode(ctx: ExecCtx, repo: Repo, field: FieldNode): Record<string, unknown> {
  return execSelections(ctx, 'Repository', { repo }, field.children);
}

function resolveField(ctx: ExecCtx, type: string, holder: Record<string, unknown>, field: FieldNode): unknown {
  const name = field.name;
  const bad = (t: string): unknown => {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${t}".` });
    return undefined;
  };
  if (type === 'Query') {
    if (name === 'viewer') return execSelections(ctx, 'User', { login: VIEWER_LOGIN }, field.children);
    if (name === 'repository') {
      const owner = String(argValue(field, 'owner', ctx.vars) ?? '');
      const repoName = String(argValue(field, 'name', ctx.vars) ?? '');
      const repo = visibleRepo(ctx.store, owner, repoName);
      if (!repo) return null;
      return repoNode(ctx, repo, field);
    }
    if (name === 'node') {
      const id = String(argValue(field, 'id', ctx.vars) ?? '');
      const parts = ungid(id);
      if (!parts) return null;
      if (parts[0] === 'Repository') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
        if (!repo) return null;
        return execSelections(ctx, 'Repository', { repo }, field.children);
      }
      if (parts[0] === 'Issue') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
        const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
        if (!repo || !issue) return null;
        return execSelections(ctx, 'Issue', { issue, repo }, field.children);
      }
      if (parts[0] === 'PullRequest') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
        const pull = repo?.pulls.find((p) => p.number === Number(parts[2]));
        if (!repo || !pull) return null;
        return execSelections(ctx, 'PullRequest', { pull, repo }, field.children);
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(argValue(field, 'name', ctx.vars) ?? '');
      return typeNode(ctx, typeName, field);
    }
    if (name === '__schema') return { queryType: { name: 'Query' } };
    return bad('Query');
  }
  if (type === 'User') {
    if (name === 'login') return holder.login as string;
    if (name === 'id') return gid('User', String(holder.login));
    return bad('User');
  }
  if (type === 'Repository') {
    const repo = holder.repo as Repo;
    switch (name) {
      case 'id': return gid('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return execSelections(ctx, 'User', { login: repo.owner }, field.children);
      case 'defaultBranchRef': {
        const tip = branchTip(repo);
        if (!tip) return null;
        return execSelections(ctx, 'Ref', { name: repo.defaultBranch }, field.children);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'issue': {
        const number = Number(argValue(field, 'number', ctx.vars));
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return issueNode(ctx, repo, issue, field);
      }
      case 'issues': return issuesConnection(ctx, repo, field);
      case 'pullRequests': return pullsConnection(ctx, repo, field, false);
      case 'pullRequest': {
        const number = Number(argValue(field, 'number', ctx.vars));
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return null;
        return prNode(ctx, repo, pull, field);
      }
      default: return bad('Repository');
    }
  }
  if (type === 'Ref') {
    if (name === 'name') return holder.name as string;
    return bad('Ref');
  }
  if (type === 'Issue') {
    const issue = holder.issue as Issue;
    switch (name) {
      case 'id': return gid('Issue', (holder.repo as Repo).id, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return gqlState(issue.state);
      case 'body': return issue.body;
      case 'author': return execSelections(ctx, 'User', { login: issue.user }, field.children);
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      default: return bad('Issue');
    }
  }
  if (type === 'PullRequest') {
    const pull = holder.pull as Pull;
    const repo = holder.repo as Repo;
    switch (name) {
      case 'id': return gid('PullRequest', repo.id, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'mergeable': return pullIsConflicted(ctx.store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'body': return pull.body;
      case 'files': {
        const first = Number(argValue(field, 'first', ctx.vars) ?? 100);
        const files = prDiff(ctx.store, repo, pull).files.slice(0, first);
        return execSelections(ctx, 'PullRequestChangedFileConnection', { files }, field.children);
      }
      default: return bad('PullRequest');
    }
  }
  if (type === 'IssueConnection') {
    const items = holder.items as Issue[];
    if (name === 'nodes') return items.map((issue) => issueNode(ctx, holder.repo as Repo, issue, field));
    if (name === 'edges') return items.map((issue) => ({ node: issueNode(ctx, holder.repo as Repo, issue, field), cursor: cursorFor(issue.number) }));
    if (name === 'pageInfo') return execSelections(ctx, 'PageInfo', holder, field.children);
    if (name === 'totalCount') return items.length;
    return bad('IssueConnection');
  }
  if (type === 'PullRequestConnection') {
    const items = holder.items as Pull[];
    if (name === 'nodes') return items.map((pull) => prNode(ctx, holder.repo as Repo, pull, field));
    if (name === 'pageInfo') return execSelections(ctx, 'PageInfo', holder, field.children);
    if (name === 'totalCount') return items.length;
    return bad('PullRequestConnection');
  }
  if (type === 'PullRequestChangedFileConnection') {
    const files = holder.files as { filename: string }[];
    if (name === 'nodes') {
      return files.map((f) => execSelections(ctx, 'PullRequestChangedFile', { file: f }, field.children));
    }
    if (name === 'pageInfo') return execSelections(ctx, 'PageInfo', holder, field.children);
    if (name === 'totalCount') return files.length;
    return bad('PullRequestChangedFileConnection');
  }
  if (type === 'PullRequestChangedFile') {
    if (name === 'path') return (holder.file as { filename: string }).filename;
    return bad('PullRequestChangedFile');
  }
  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return holder.hasNextPage as boolean;
    if (name === 'endCursor') return (holder.endCursor as string | null) ?? null;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return (holder.startCursor as string | null) ?? null;
    return bad('PageInfo');
  }
  if (type === '__Type') {
    const t = holder.typeName as string;
    if (name === 'name') return t;
    if (name === 'kind') return t === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (name === 'fields') {
      const fields = t === 'Issue' ? ISSUE_TYPE_FIELDS : t === 'PullRequest' ? PR_TYPE_FIELDS : t === 'Repository' ? REPO_TYPE_FIELDS : [];
      return fields.map((f) => execSelections(ctx, '__Field', { fieldName: f }, field.children));
    }
    if (name === 'enumValues') {
      if (t !== 'SearchType') return [];
      return SEARCH_ENUM.map((e) => execSelections(ctx, '__EnumValue', { fieldName: e }, field.children));
    }
    return bad('__Type');
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return holder.fieldName as string;
    return bad(type);
  }
  return bad(type);
}

function typeNode(ctx: ExecCtx, typeName: string, field: FieldNode): Record<string, unknown> | null {
  if (!['Issue', 'PullRequest', 'Repository', 'SearchType', 'User'].includes(typeName)) return null;
  return execSelections(ctx, '__Type', { typeName }, field.children);
}

function issuesConnection(ctx: ExecCtx, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.vars);
  const after = argValue(field, 'after', ctx.vars);
  const states = argValue(field, 'states', ctx.vars);
  const orderBy = argValue(field, 'orderBy', ctx.vars) as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  } else {
    list = list.filter((i) => i.state === 'open');
  }
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  // CREATED_AT: by creation sequence; ties by number (DESC per the rules when direction is DESC).
  list.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const idx = list.findIndex((i) => i.number === afterNumber);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const total = list.length;
  const limit = typeof first === 'number' ? first : total;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return execSelections(ctx, 'IssueConnection', { items: page, repo, hasNextPage, endCursor, startCursor: page.length > 0 ? cursorFor(page[0].number) : null }, field.children);
}

function pullsConnection(ctx: ExecCtx, repo: Repo, field: FieldNode, _all: boolean): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.vars);
  let list = repo.pulls.filter((p) => p.state === 'open');
  list = [...list].sort((a, b) => b.seq - a.seq);
  const total = list.length;
  const limit = typeof first === 'number' ? first : total;
  const page = list.slice(0, limit);
  return execSelections(ctx, 'PullRequestConnection', { items: page, repo, hasNextPage: list.length > page.length, endCursor: null, startCursor: null }, field.children);
}

function execSelections(ctx: ExecCtx, type: string, holder: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.field.alias ?? sel.field.name;
      const value = resolveField(ctx, type, holder, sel.field);
      if (value !== undefined) out[key] = value;
    } else if (sel.kind === 'fragment') {
      if (sel.type === null || sel.type === type) {
        Object.assign(out, execSelections(ctx, type, holder, sel.children));
      }
    } else if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) Object.assign(out, execSelections(ctx, type, holder, frag));
    }
  }
  return out;
}

// ---------------------------------------------------------------- mutations

function findRepoByGid(ctx: ExecCtx, id: string): Repo | null {
  const parts = ungid(id);
  if (!parts || parts[0] !== 'Repository') return null;
  return [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1])) ?? null;
}

function execMutation(ctx: ExecCtx, field: FieldNode): Record<string, unknown> {
  const name = field.name;
  const input = (argValue(field, 'input', ctx.vars) ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = findRepoByGid(ctx, String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'Repository not found' }); return {}; }
    const created = createIssueInternal(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) { ctx.errors.push({ message: created.error }); return {}; }
    return { createIssue: execSelectionsPatched(ctx, 'CreateIssuePayload', { issue: created, repo }, field.children) };
  }
  if (name === 'closeIssue') {
    const parts = ungid(String(input.issueId ?? ''));
    if (!parts || parts[0] !== 'Issue') { ctx.errors.push({ message: 'Issue not found' }); return {}; }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
    const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
    if (!repo || !issue) { ctx.errors.push({ message: 'Issue not found' }); return {}; }
    issue.state = 'closed';
    const { at } = stamp(ctx.store);
    issue.updatedAt = at;
    issue.closedAt = at;
    return { closeIssue: execSelectionsPatched(ctx, 'CloseIssuePayload', { issue, repo }, field.children) };
  }
  if (name === 'createPullRequest') {
    const repo = findRepoByGid(ctx, String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'Repository not found' }); return {}; }
    const created = createPullInternal(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) { ctx.errors.push({ message: created.error }); return {}; }
    return { createPullRequest: execSelectionsPatched(ctx, 'CreatePullRequestPayload', { pull: created, repo }, field.children) };
  }
  if (name === 'mergePullRequest') {
    const parts = ungid(String(input.pullRequestId ?? ''));
    if (!parts || parts[0] !== 'PullRequest') { ctx.errors.push({ message: 'Pull request not found' }); return {}; }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
    const pull = repo?.pulls.find((p) => p.number === Number(parts[2]));
    if (!repo || !pull) { ctx.errors.push({ message: 'Pull request not found' }); return {}; }
    const merged = mergePullInternal(ctx.store, repo, pull);
    if ('error' in merged) { ctx.errors.push({ message: merged.error }); return {}; }
    return { mergePullRequest: execSelectionsPatched(ctx, 'MergePullRequestPayload', { pull, repo }, field.children) };
  }
  if (name === 'addComment') {
    const parts = ungid(String(input.subjectId ?? ''));
    if (!parts || parts[0] !== 'Issue') { ctx.errors.push({ message: 'Subject not found' }); return {}; }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(parts[1]));
    const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
    if (!repo || !issue) { ctx.errors.push({ message: 'Issue not found' }); return {}; }
    const { at } = stamp(ctx.store);
    const comment = { id: ctx.store.nextObjectId++, body: String(input.body ?? ''), user: VIEWER_LOGIN, createdAt: at, updatedAt: at };
    issue.comments.push(comment);
    return { addComment: execSelectionsPatched(ctx, 'AddCommentPayload', { comment, repo, issue }, field.children) };
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return {};
}

// Payload types resolve through the same field resolver with dedicated holders.
function resolvePayloadField(ctx: ExecCtx, type: string, holder: Record<string, unknown>, field: FieldNode): unknown {
  const name = field.name;
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') {
      const issue = holder.issue as Issue;
      return execSelections(ctx, 'Issue', { issue, repo: holder.repo as Repo }, field.children);
    }
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') {
      const pull = holder.pull as Pull;
      return execSelections(ctx, 'PullRequest', { pull, repo: holder.repo as Repo }, field.children);
    }
  }
  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return execSelectionsPatched(ctx, 'IssueCommentEdge', holder, field.children);
  }
  if (type === 'IssueCommentEdge') {
    if (name === 'node') {
      const comment = holder.comment as { id: number; body: string };
      const out: Record<string, unknown> = {};
      for (const sel of field.children) {
        if (sel.kind === 'field') {
          if (sel.field.name === 'id') out[sel.field.alias ?? 'id'] = gid('IssueComment', (holder.repo as Repo).id, (holder.issue as Issue).number, comment.id);
          else if (sel.field.name === 'body') out[sel.field.alias ?? 'body'] = comment.body;
        }
      }
      return out;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return undefined;
}

// Patch execSelections to route payload types through resolvePayloadField.
const origExecSelections = execSelections;
function execSelectionsPatched(ctx: ExecCtx, type: string, holder: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  if (type.endsWith('Payload') || type === 'IssueCommentEdge') {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'field') {
        const key = sel.field.alias ?? sel.field.name;
        const value = resolvePayloadField(ctx, type, holder, sel.field);
        if (value !== undefined) out[key] = value;
      } else if (sel.kind === 'fragment') {
        if (sel.type === null || sel.type === type) Object.assign(out, execSelectionsPatched(ctx, type, holder, sel.children));
      } else if (sel.kind === 'spread') {
        const frag = ctx.fragments.get(sel.name);
        if (frag) Object.assign(out, execSelectionsPatched(ctx, type, holder, frag));
      }
    }
    return out;
  }
  return origExecSelections(ctx, type, holder, selections);
}

// The payload resolvers call execSelections; redirect them through the patch.
function execSelectionsWithPayload(ctx: ExecCtx, type: string, holder: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  return execSelectionsPatched(ctx, type, holder, selections);
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult { data?: Record<string, unknown>; errors?: { message: string }[] }

export function executeGraphQL(store: Store, query: string, variables: Vars, operationName?: string): GraphQLResult {
  let doc: Document;
  try {
    doc = parseDocument(query);
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const op = operationName
    ? doc.operations.find((o) => o.name === operationName)
    : doc.operations[0];
  if (!op) return { errors: [{ message: `Unknown operation ${operationName ?? ''}` }] };
  const vars: Vars = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue) vars[v.name] = resolveValue(v.defaultValue, vars);
  }
  const ctx: ExecCtx = { store, vars, fragments: doc.fragments, errors: [] };
  let data: Record<string, unknown> = {};
  if (op.kind === 'mutation') {
    for (const sel of op.selections) {
      if (sel.kind === 'field') Object.assign(data, execMutation(ctx, sel.field));
    }
  } else {
    data = execSelectionsWithPayload(ctx, 'Query', {}, op.selections);
  }
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
