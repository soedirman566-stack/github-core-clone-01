// mcp.ts — the Model Context Protocol surface.
//
// JSON-RPC 2.0 over POST /mcp, Streamable HTTP style: plain JSON answers (no
// session; the modern server/discover revision is spoken, and the legacy
// initialize handshake is answered too). Tools act on the same store as REST,
// so an object made here is the same object there. The tools array is built
// once and never mutated — two tools/list calls answer byte-identical bytes.

import type { RepoRec, Store } from './store.ts';
import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, text] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'number' : 'string', description: text };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list: constant for the life of the process. */
const TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: 'The repository name.',
    description: 'The repository description.',
    private: 'Whether the repository is private.',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
  }, ['owner', 'repo']),
  tool('list_repos', 'List the repositories of the authenticated user.', {}, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
    title: 'The issue title.',
    body: 'The issue body.',
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by its number.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
    issue_number: 'The issue number.',
  }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
    state: 'Filter by state: open, closed or all.',
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
    title: 'The pull request title.',
    body: 'The pull request body.',
    head: 'The head branch name.',
    base: 'The base branch name.',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request (squash) and close it.', {
    owner: 'The repository owner login.',
    repo: 'The repository name.',
    pull_number: 'The pull request number.',
  }, ['owner', 'repo', 'pull_number']),
];

// -------------------------------------------------------------- tool results

interface ToolOutcome {
  readonly payload?: unknown;
  readonly errorText?: string;
}

function ok(payload: unknown): ToolOutcome {
  return { payload };
}

function err(text: string): ToolOutcome {
  return { errorText: text };
}

function findRepo(store: Store, args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return store.repo(owner, name);
}

function runTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = store.repo(store.viewer.login, repoName);
      if (existing) return ok(repoJson(store, existing));
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (!repo) return err(`repository '${repoName}' already exists`);
      return ok(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      return repo ? ok(repoJson(store, repo)) : err('repository not found');
    }
    case 'list_repos': {
      return ok(store.listRepos().map((repo) => repoJson(store, repo)));
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return err('repository not found');
      const issue = store.addIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return ok(issueJson(store, repo, issue));
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      if (!repo) return err('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      return issue ? ok(issueJson(store, repo, issue)) : err('issue not found');
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return err('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return ok(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return err('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      if (!headSha) return err(`head branch '${head}' does not exist`);
      if (!repo.refs.get(`refs/heads/${base}`)) return err(`base branch '${base}' does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return err('a pull request already exists for this head and base');
        }
      }
      const pull = store.addPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
      });
      return ok(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return err('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return err('pull request not found');
      const outcome = mergePullRequest(repo, pull, 'squash');
      if ('conflict' in outcome) return err('merge conflict');
      if ('gone' in outcome) return err('pull request is not mergeable');
      return ok(pullJson(store, repo, pull));
    }
    default:
      return err(`unknown tool '${name}'`);
  }
}

// -------------------------------------------------------------------- wire

export interface McpReply {
  readonly status: number;
  /** The JSON-RPC response (or an array of them for a batch), or null for an empty answer. */
  readonly body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id as string | number | null, result } };
}

function rpcError(id: unknown, status: number, code: number, message: string): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } } };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function handleMessage(store: Store, message: Record<string, unknown>): McpReply {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params !== null && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;
  if (id === undefined) {
    // A notification: accepted, never answered.
    return { status: 202, body: null };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const def = TOOLS.find((candidate) => candidate.name === toolName);
      if (!def) return rpcError(id, 200, -32602, `unknown tool '${toolName}'`);
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const missing = def.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      const outcome = runTool(store, toolName, args);
      if (outcome.errorText !== undefined) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.errorText }], isError: true });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
        isError: false,
      });
    }
    default:
      return rpcError(id, 200, -32601, `method not found: ${method}`);
  }
}

/** Handle one POST /mcp body. Authentication happened in app.ts. */
export function handleMcp(store: Store, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, 400, -32700, 'Parse error');
  }
  if (Array.isArray(parsed)) {
    const replies: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const reply = handleMessage(store, entry as Record<string, unknown>);
        if (reply.body) replies.push(reply.body);
      }
    }
    return { status: 200, body: replies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, 400, -32600, 'Invalid request');
  }
  return handleMessage(store, parsed as Record<string, unknown>);
}
