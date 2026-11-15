// graphql.ts — the GraphQL v4 surface.
//
// A small hand-written parser (operations, variables, inline values, aliases,
// inline fragments and fragment spreads — the shapes gh and github-mcp-server
// send) and a resolver-walking executor over the same store the REST surface
// uses, so an object created on one surface reads identically on the other.
// Global ids are opaque base64 `Type:key` strings, stable across reads.

import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { mergePullRequest, pullConflicts, pullFileChanges } from './rest.ts';

// --------------------------------------------------------------------- ids

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$[]!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] }
  | { kind: 'variable'; name: string };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  selection: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead && ahead.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition '${token.value}'`);
    }
    return { operations, fragments };
  }

  /** Variable definitions are skipped structurally: values arrive as JSON. */
  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        // Skip a balanced argument list.
        this.expectPunct('(');
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const ahead = this.peek();
        if (ahead && ahead.kind === 'name' && ahead.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (ahead && ahead.kind === 'name') {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selection: SelectionNode[] = [];
    if (this.atPunct('{')) selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------- executor

type Obj = { __typename: string } & Record<string, unknown>;
type Resolver = (obj: Obj, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, FragmentNode>;
  readonly errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
    case 'variable':
      return ctx.variables[node.name] ?? null;
  }
}

function evalArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = evalValue(value, ctx);
  return out;
}

function executeSelectionSet(obj: Obj, typeName: string, selections: SelectionNode[], ctx: Ctx, out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelectionSet(obj, typeName, selection.selection, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === typeName) {
        executeSelectionSet(obj, typeName, fragment.selection, ctx, out);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const value = resolver(obj, evalArgs(field, ctx), ctx);
    out[key] = completeValue(value, field, ctx);
  }
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object') {
    const obj = value as Obj;
    const out: Record<string, unknown> = {};
    executeSelectionSet(obj, obj.__typename, field.selection, ctx, out);
    return out;
  }
  return value;
}

// ------------------------------------------------------------- object makers

function userObj(store: Store): Obj {
  const viewer = store.viewer;
  return { __typename: 'User', _login: viewer.login, _id: viewer.id, _name: viewer.name, _email: viewer.email };
}

function repoObj(repo: RepoRec): Obj {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: RepoRec, pull: PullRec): Obj {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObj(repo: RepoRec, commentId: number, body: string): Obj {
  return { __typename: 'IssueComment', _repo: repo, _commentId: commentId, _body: body };
}

function issueCursor(repo: RepoRec, issue: IssueRec): string {
  return Buffer.from(`cursor:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

// ------------------------------------------------------------- type registry

const TYPE_REGISTRY: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; values?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'closed', 'url'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------- resolvers

function findRepoByGlobalId(store: Store, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  return store.repoById(parseInt(decoded.key, 10));
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = store.repoById(parseInt(repoId ?? '', 10));
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(number ?? '', 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = store.repoById(parseInt(repoId ?? '', 10));
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(number ?? '', 10));
  return pull ? { repo, pull } : null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_obj, _args, ctx) => userObj(ctx.store),
    repository: (_obj, args, ctx) => {
      const repo = ctx.store.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    },
    node: (_obj, args, ctx) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = ctx.store.repoById(parseInt(decoded.key, 10));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.type === 'Issue') {
        const found = findIssueByGlobalId(ctx.store, id);
        return found ? issueObj(found.repo, found.issue) : null;
      }
      if (decoded.type === 'PullRequest') {
        const found = findPullByGlobalId(ctx.store, id);
        return found ? pullObj(found.repo, found.pull) : null;
      }
      if (decoded.type === 'User') return userObj(ctx.store);
      return null;
    },
    __type: (_obj, args) => {
      const name = String(args.name ?? '');
      return TYPE_REGISTRY[name] ? { __typename: '__Type', _name: name } : null;
    },
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const issue = ctx.store.addIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', _issue: issueObj(repo, issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.issueId);
      if (!found) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', _issue: issueObj(found.repo, found.issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      if (!headSha || !repo.refs.get(`refs/heads/${baseRef}`)) {
        ctx.errors.push({ message: 'head or base branch not found' });
        return null;
      }
      const pull = ctx.store.addPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha,
      });
      return { __typename: 'CreatePullRequestPayload', _pull: pullObj(repo, pull) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(ctx.store, input.pullRequestId);
      if (!found) {
        ctx.errors.push({ message: 'pull request not found' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'MERGE');
      const outcome = mergePullRequest(found.repo, found.pull, method === 'MERGE' ? 'merge' : 'squash');
      if ('conflict' in outcome) {
        ctx.errors.push({ message: 'merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', _pull: pullObj(found.repo, found.pull) };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.subjectId);
      const pullFound = found ? null : findPullByGlobalId(ctx.store, input.subjectId);
      const target = found ?? pullFound;
      if (!target) {
        ctx.errors.push({ message: 'subject not found' });
        return null;
      }
      const number = found ? found.issue.number : (pullFound as { pull: PullRec }).pull.number;
      const comment = ctx.store.addComment(target.repo, number, String(input.body ?? ''));
      const node = commentObj(target.repo, comment.id, comment.body);
      return { __typename: 'AddCommentPayload', _edge: { __typename: 'IssueCommentEdge', _node: node, _cursor: '' } };
    },
  },
  CreateIssuePayload: { issue: (obj) => obj._issue },
  CloseIssuePayload: { issue: (obj) => obj._issue },
  CreatePullRequestPayload: { pullRequest: (obj) => obj._pull },
  MergePullRequestPayload: { pullRequest: (obj) => obj._pull },
  AddCommentPayload: { commentEdge: (obj) => obj._edge },
  IssueCommentEdge: {
    node: (obj) => obj._node,
    cursor: (obj) => obj._cursor,
  },
  User: {
    id: (obj) => globalId('User', String(obj._login)),
    login: (obj) => obj._login,
    name: (obj) => obj._name,
    email: (obj) => obj._email,
    avatarUrl: () => '',
    url: () => '',
  },
  Repository: {
    id: (obj) => globalId('Repository', String((obj._repo as RepoRec).id)),
    databaseId: (obj) => (obj._repo as RepoRec).id,
    name: (obj) => (obj._repo as RepoRec).name,
    nameWithOwner: (obj) => {
      const repo = obj._repo as RepoRec;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (_obj, _args, ctx) => userObj(ctx.store),
    description: (obj) => (obj._repo as RepoRec).description,
    isPrivate: (obj) => (obj._repo as RepoRec).isPrivate,
    defaultBranchRef: (obj) => ({ __typename: 'Ref', _name: (obj._repo as RepoRec).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (obj) => (obj._repo as RepoRec).createdAt,
    updatedAt: (obj) => (obj._repo as RepoRec).updatedAt,
    url: () => '',
    issue: (obj, args) => {
      const repo = obj._repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    },
    pullRequest: (obj, args) => {
      const repo = obj._repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    },
    issues: (obj, args) => {
      const repo = obj._repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      list.sort((a, b) => a.number - b.number);
      if (orderBy?.direction === 'DESC') list.reverse();
      let start = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        try {
          const text = Buffer.from(args.after, 'base64').toString('utf8');
          const number = parseInt(text.split(':').pop() ?? '', 10);
          const index = list.findIndex((issue) => issue.number === number);
          if (index >= 0) start = index + 1;
        } catch {
          start = 0;
        }
      }
      const first = typeof args.first === 'number' ? args.first : 30;
      const nodes = list.slice(start, start + first);
      const hasNextPage = start + nodes.length < list.length;
      const endCursor = nodes.length > 0 ? issueCursor(repo, nodes[nodes.length - 1] as IssueRec) : null;
      return {
        __typename: 'IssueConnection',
        _nodes: nodes.map((issue) => issueObj(repo, issue)),
        _pageInfo: { __typename: 'PageInfo', _hasNextPage: hasNextPage, _endCursor: endCursor },
        _totalCount: list.length,
      };
    },
    pullRequests: (obj, args) => {
      const repo = obj._repo as RepoRec;
      const first = typeof args.first === 'number' ? args.first : 30;
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      return {
        __typename: 'PullRequestConnection',
        _nodes: list.slice(0, first).map((pull) => pullObj(repo, pull)),
        _totalCount: list.length,
      };
    },
  },
  Issue: {
    id: (obj) => globalId('Issue', `${(obj._repo as RepoRec).id}:${(obj._issue as IssueRec).number}`),
    number: (obj) => (obj._issue as IssueRec).number,
    title: (obj) => (obj._issue as IssueRec).title,
    state: (obj) => ((obj._issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (obj) => (obj._issue as IssueRec).body,
    author: (_obj, _args, ctx) => userObj(ctx.store),
    createdAt: (obj) => (obj._repo as RepoRec).createdAt,
    updatedAt: (obj) => (obj._repo as RepoRec).updatedAt,
    closed: (obj) => (obj._issue as IssueRec).state === 'closed',
    url: () => '',
  },
  PullRequest: {
    id: (obj) => globalId('PullRequest', `${(obj._repo as RepoRec).id}:${(obj._pull as PullRec).number}`),
    number: (obj) => (obj._pull as PullRec).number,
    title: (obj) => (obj._pull as PullRec).title,
    body: (obj) => (obj._pull as PullRec).body,
    state: (obj) => {
      const pull = obj._pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (obj) => (obj._pull as PullRec).merged,
    headRefName: (obj) => (obj._pull as PullRec).headRef,
    baseRefName: (obj) => (obj._pull as PullRec).baseRef,
    mergeable: (obj) => {
      const repo = obj._repo as RepoRec;
      const pull = obj._pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (obj, args) => {
      const repo = obj._repo as RepoRec;
      const pull = obj._pull as PullRec;
      const first = typeof args.first === 'number' ? args.first : 30;
      const changes = pullFileChanges(repo, pull);
      return {
        __typename: 'PullRequestChangedFileConnection',
        _nodes: changes.slice(0, first).map((change) => ({ __typename: 'PullRequestChangedFile', _path: change.filename })),
        _totalCount: changes.length,
      };
    },
    author: (_obj, _args, ctx) => userObj(ctx.store),
    createdAt: (obj) => (obj._repo as RepoRec).createdAt,
    updatedAt: (obj) => (obj._repo as RepoRec).updatedAt,
    url: () => '',
  },
  PullRequestChangedFile: { path: (obj) => obj._path },
  IssueComment: {
    id: (obj) => globalId('IssueComment', `${(obj._repo as RepoRec).id}:${obj._commentId as number}`),
    body: (obj) => obj._body,
    author: (_obj, _args, ctx) => userObj(ctx.store),
    createdAt: (obj) => (obj._repo as RepoRec).createdAt,
    updatedAt: (obj) => (obj._repo as RepoRec).updatedAt,
    url: () => '',
  },
  Ref: {
    id: (obj) => globalId('Ref', String(obj._name)),
    name: (obj) => obj._name,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (obj) => obj._nodes,
    pageInfo: (obj) => obj._pageInfo,
    totalCount: (obj) => obj._totalCount,
  },
  PullRequestConnection: {
    nodes: (obj) => obj._nodes,
    totalCount: (obj) => obj._totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => obj._nodes,
    totalCount: (obj) => obj._totalCount,
  },
  PageInfo: {
    hasNextPage: (obj) => obj._hasNextPage,
    endCursor: (obj) => obj._endCursor,
    hasPreviousPage: () => false,
    startCursor: () => null,
  },
  __Type: {
    name: (obj) => obj._name,
    kind: (obj) => (TYPE_REGISTRY[obj._name as string] as { kind: string }).kind,
    fields: (obj) => {
      const entry = TYPE_REGISTRY[obj._name as string];
      if (!entry || entry.kind !== 'OBJECT') return null;
      return (entry.fields ?? []).map((name) => ({ __typename: '__Field', _name: name }));
    },
    enumValues: (obj) => {
      const entry = TYPE_REGISTRY[obj._name as string];
      if (!entry || entry.kind !== 'ENUM') return null;
      return (entry.values ?? []).map((name) => ({ __typename: '__EnumValue', _name: name }));
    },
  },
  __Field: { name: (obj) => obj._name },
  __EnumValue: { name: (obj) => obj._name },
};

// -------------------------------------------------------------------- entry

export interface GraphQLReply {
  readonly status: number;
  readonly body: unknown;
}

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(store: Store, request: OperationRequest): Record<string, unknown> {
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'query is required' }] };
  }
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = (operationName ? parsed.operations.find((op) => op.name === operationName) : undefined) ?? parsed.operations[0];
  if (!operation) return { errors: [{ message: 'no operation found' }] };
  const ctx: Ctx = {
    store,
    variables: (request.variables !== null && typeof request.variables === 'object' ? request.variables : {}) as Record<string, unknown>,
    fragments: parsed.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet({ __typename: rootType }, rootType, operation.selection, ctx, data);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(store: Store, payload: unknown): GraphQLReply {
  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => executeOperation(store, (entry ?? {}) as OperationRequest)) };
  }
  if (payload !== null && typeof payload === 'object') {
    return { status: 200, body: executeOperation(store, payload as OperationRequest) };
  }
  return { status: 400, body: { errors: [{ message: 'request body must be an operation or an array of operations' }] } };
}
