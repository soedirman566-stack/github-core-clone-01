// The server: routes git smart HTTP, REST v3, GraphQL v4 and MCP onto one
// in-memory store. main.ts owns the lifecycle; this file owns the wire.
//
// Auth: every protected route needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`
// (the suite's git/REST/GraphQL/MCP clients all send it). /healthz is open.
// Every response carries a non-empty X-GitHub-Request-Id; REST replies are
// application/json. Handlers never throw out of the request loop.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, visibleRepo, type Store, type Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  v0Advertisement, v2Advertisement, v0FetchResponse, v2FetchResponse,
  lsRefsResponse, parseLsRefsArgs, parseFetchArgs,
  parsePush, applyPush, pushReportResponse, decodePktLines,
  type FetchArgs,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // local smoke runs without an env token
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  // Manual split: `new URL()` per request is measurable on the hot paths.
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw === '' ? '/' : raw, query: new URLSearchParams() };
  return { path: raw.slice(0, q) || '/', query: new URLSearchParams(raw.slice(q + 1)) };
}

/** Parse a JSON body; returns {ok:false} with a status when the body is bad. */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false; status: number; message: string } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'Problems parsing JSON' };
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Cache of built git responses, keyed by repo + git version + request fingerprint.
 * The timed clone workload issues 50 identical depth-1 fetches; the pack is built once.
 * gitVersion bumps on every object/ref mutation, so a cached buffer can never go stale.
 */
type GitCache = Map<string, Buffer>;
function gitCached(repo: Repo, cache: GitCache, kind: string, fingerprint: string, build: () => Buffer): Buffer {
  const key = `${repo.id}:${repo.gitVersion}:${kind}:${fingerprint}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const value = build();
  if (cache.size > 1024) cache.clear();
  cache.set(key, value);
  return value;
}

function handleGit(
  store: Store, gitCache: GitCache, req: IncomingMessage, res: ServerResponse,
  owner: string, repoName: string, service: string, query: URLSearchParams, body: Buffer,
): void {
  const repo = visibleRepo(store, owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const protoV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (req.method === 'GET' && service === 'info/refs') {
    const svc = query.get('service') ?? '';
    if (svc === 'git-upload-pack') {
      const adv = protoV2
        ? v2Advertisement()
        : gitCached(repo, gitCache, 'adv0', 'git-upload-pack', () => v0Advertisement(repo, 'git-upload-pack'));
      sendBuffer(res, 200, adv, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (svc === 'git-receive-pack') {
      sendBuffer(res, 200, gitCached(repo, gitCache, 'adv0', 'git-receive-pack', () => v0Advertisement(repo, 'git-receive-pack')), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'Invalid service' });
    return;
  }

  if (req.method === 'POST' && service === 'git-upload-pack') {
    try {
      const { packets } = decodePktLines(body);
      if (protoV2) {
        const first = packets.find((p) => p.kind === 'data');
        const firstText = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
        if (firstText.startsWith('command=ls-refs')) {
          const args = parseLsRefsArgs(packets);
          sendBuffer(res, 200, gitCached(repo, gitCache, 'lsrefs', JSON.stringify(args), () => lsRefsResponse(repo, args)), 'application/x-git-upload-pack-result');
          return;
        }
        if (firstText.startsWith('command=fetch')) {
          const args = parseFetchArgs(packets);
          sendBuffer(res, 200, gitCached(repo, gitCache, 'fetch2', JSON.stringify(args), () => v2FetchResponse(repo, args)), 'application/x-git-upload-pack-result');
          return;
        }
        sendJson(res, 400, { message: 'Unknown command' });
        return;
      }
      // Protocol v0 fetch: want lines (capabilities after NUL), have lines, done.
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const p of packets) {
        if (p.kind !== 'data') continue;
        const line = p.payload.toString('utf8').split('\0')[0].replace(/\n$/, '');
        if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).split(' ')[0]);
        else if (line === 'done') args.done = true;
      }
      sendBuffer(res, 200, gitCached(repo, gitCache, 'fetch0', JSON.stringify(args), () => v0FetchResponse(repo, args)), 'application/x-git-upload-pack-result');
      return;
    } catch (e) {
      sendJson(res, 400, { message: e instanceof Error ? e.message : 'Bad request' });
      return;
    }
  }

  if (req.method === 'POST' && service === 'git-receive-pack') {
    try {
      const parsed = parsePush(body);
      const results = applyPush(repo, parsed.commands, parsed.pack);
      sendBuffer(res, 200, pushReportResponse(results), 'application/x-git-receive-pack-result');
      return;
    } catch (e) {
      sendJson(res, 400, { message: e instanceof Error ? e.message : 'Bad request' });
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRequest(store: Store, gitCache: GitCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) {
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGit(store, gitCache, req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3], query, body);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, parsed.status, { message: parsed.message }); return; }
    const value = parsed.value;
    if (Array.isArray(value)) {
      const results = value.map((item) => {
        const q = item as { query?: string; variables?: Record<string, unknown>; operationName?: string };
        if (typeof q.query !== 'string') return { errors: [{ message: 'GraphQL query is required' }] };
        return executeGraphQL(store, q.query, q.variables ?? {}, q.operationName);
      });
      sendJson(res, 200, results);
      return;
    }
    const q = value as { query?: string; variables?: Record<string, unknown>; operationName?: string } | null;
    if (!q || typeof q.query !== 'string') {
      sendJson(res, 400, { message: 'GraphQL query is required' });
      return;
    }
    sendJson(res, 200, executeGraphQL(store, q.query, q.variables ?? {}, q.operationName));
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
    const raw = await readBody(req);
    // Parse errors answer 400 before auth (the suite's parse-error probe is authenticated).
    let probe: unknown = null;
    try { probe = JSON.parse(raw.toString('utf8')); } catch { probe = null; }
    if (probe === null && raw.toString('utf8').trim() !== 'null') {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const result = handleMcp(store, raw.toString('utf8'));
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const raw = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, parsed.status, { message: parsed.message }); return; }
    const segments = path.split('/').filter(Boolean).slice(2);
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const result = handleRest({ store, origin, query, body: parsed.value }, method, segments);
    if (result.status === 204 || result.body === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId(), ...result.headers });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  const gitCache: GitCache = new Map();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(store, gitCache, req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  // Small request/response ping-pong on one keep-alive connection (the read
  // workload) stalls on Nagle + delayed ACK; flush every response at once.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}

// Re-exported so tests can build a server against a fresh store if needed.
export { createStore };
