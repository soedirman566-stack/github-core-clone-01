// MCP (Model Context Protocol, Streamable HTTP) endpoint, modern era
// 2026-07-28: server/discover first, then tools/list + tools/call.
// Names/args mirror github-mcp-server, as the suite maps its requests onto
// the schema's nearest property name.

import {
  createRepo, getRepo, visibleRepo,
  type Store,
} from './store.ts';
import {
  issueJson, pullJson, repoJson,
  createIssueInternal, createPullInternal, mergePullInternal,
} from './rest.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the issues: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by owner, repository and issue number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        number: { type: 'integer', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the pull requests: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function resolveRepo(store: Store, args: Record<string, unknown>) {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) { owner = parts[0]; repoName = parts[1]; }
  }
  return visibleRepo(store, owner, repoName);
}

function textResult(value: unknown) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type ToolOutcome = { ok: boolean; value: unknown } | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown } {
  const missing = (tool: ToolDef): string | null => {
    for (const req of tool.inputSchema.required ?? []) {
      if (args[req] === undefined || args[req] === null || args[req] === '') return req;
    }
    return null;
  };
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  const miss = missing(tool);
  if (miss) return { isError: true, content: [{ type: 'text', text: `Missing required argument: ${miss}` }] };

  try {
    switch (name) {
      case 'create_repo': {
        const existing = getRepo(store, VIEWER_LOGIN, String(args.name));
        const repo = existing ?? createRepo(store, VIEWER_LOGIN, String(args.name), String(args.description ?? ''), args.private === true);
        return textResult(repoJson(store, repo));
      }
      case 'get_repo': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        return textResult(repoJson(store, repo));
      }
      case 'create_issue': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const created = createIssueInternal(store, repo, String(args.title), String(args.body ?? ''), []);
        if ('error' in created) return errorResult(created.error);
        return textResult(issueJson(repo, created));
      }
      case 'list_issues': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        return textResult(list.map((i) => issueJson(repo, i)));
      }
      case 'create_pull_request': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const created = createPullInternal(store, repo, String(args.title), String(args.body ?? ''), String(args.head), String(args.base));
        if ('error' in created) return errorResult(created.error);
        return textResult(pullJson(store, repo, created));
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
        if (!pull) return errorResult('Pull request not found');
        const merged = mergePullInternal(store, repo, pull);
        if ('error' in merged) return errorResult(merged.error);
        return textResult({ ...pullJson(store, repo, pull), sha: merged.sha, merged: true });
      }
      case 'get_issue': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        if (!issue) return errorResult('Issue not found');
        return textResult(issueJson(repo, issue));
      }
      case 'list_pull_requests': {
        const repo = resolveRepo(store, args);
        if (!repo) return errorResult('Repository not found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        return textResult(list.map((p) => pullJson(store, repo, p)));
      }
      default:
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

export interface McpResponse { status: number; body: unknown | null }

export function handleMcp(store: Store, rawBody: string): McpResponse {
  let req: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(rawBody) as typeof req;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: (req && 'id' in req ? req.id : null) ?? null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const hasId = req.id !== undefined && req.id !== null;
  const id = req.id ?? null;
  const method = req.method;
  const params = (req.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): McpResponse => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpResponse => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (!hasId) {
    // A request with a method but no id is a notification we do not know.
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return result({
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return error(-32601, `Method not found: ${toolName}`);
      return result(callTool(store, toolName, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

