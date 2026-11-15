// app.ts — HTTP wiring: one server, four surfaces, one store.
//
// Routing is manual on purpose: the path is split once, segments are decoded
// once, and the hot paths (git advertisement, issue reads) never build a URL
// object. Authentication is a single bearer comparison applied to everything
// except /healthz. Every failure is a JSON or plain-text answer — the server
// never throws a request into an HTML error page and never dies on one.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPackV0, handleUploadPackV2 } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Create the forge's HTTP server around a store and the trial's bearer token. */
export function createForgeServer(store: Store, token: string): Server {
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `forge-${requestCounter.toString(16).padStart(6, '0')}`;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const rawPath = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    const query = new URLSearchParams(qIndex < 0 ? '' : rawUrl.slice(qIndex + 1));
    const segments = rawPath.split('/').filter((part) => part !== '').map(decodeSegment);

    if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = hasBody ? await readBody(req) : Buffer.alloc(0);

    if (req.headers.authorization !== `Bearer ${token}`) {
      const headers = segments[0] === 'api' ? { 'x-github-request-id': nextRequestId() } : {};
      sendJson(res, 401, { message: 'Bad credentials' }, headers);
      return;
    }

    // MCP: POST /mcp (DELETE closes a session we never opened; answer politely).
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'DELETE') {
        sendJson(res, 200, null);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const reply = handleMcp(store, body.toString('utf8'));
      if (reply.body === null || reply.body === undefined) {
        res.writeHead(reply.status);
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body);
      return;
    }

    // GraphQL: POST /api/graphql.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'request body is not JSON' }] });
        return;
      }
      const reply = handleGraphQL(store, payload);
      sendJson(res, reply.status, reply.body);
      return;
    }

    // REST: /api/v3/...
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      let parsedBody: Record<string, unknown> | null = null;
      if (body.length > 0) {
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          parsedBody = parsed as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': nextRequestId() });
          return;
        }
      }
      const restReq: RestRequest = {
        method,
        segments: segments.slice(2),
        query,
        body: parsedBody,
        path: rawPath,
        origin: `http://${req.headers.host ?? 'localhost'}`,
      };
      const reply = handleRest(store, restReq);
      sendJson(res, reply.status, reply.body, { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
      return;
    }

    // Git smart HTTP: /<owner>/<repo>.git/...
    if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -4);
      const repo = store.repo(owner, repoName);
      if (!repo) {
        sendPlain(res, 404, 'repository not found\n');
        return;
      }
      const tail = segments.slice(2);
      if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
        const service = query.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendPlain(res, 400, 'unknown service\n');
          return;
        }
        const protocol = req.headers['git-protocol'];
        const v2 = typeof protocol === 'string' && protocol.includes('version=2');
        handleInfoRefs(repo, service, v2, res);
        return;
      }
      if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
        const protocol = req.headers['git-protocol'];
        const v2 = typeof protocol === 'string' && protocol.includes('version=2');
        try {
          if (v2) handleUploadPackV2(repo, body, res);
          else handleUploadPackV0(repo, body, res);
        } catch {
          if (!res.headersSent) sendPlain(res, 400, 'bad upload-pack request\n');
        }
        return;
      }
      if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
        try {
          handleReceivePack(repo, body, res);
        } catch {
          if (!res.headersSent) sendPlain(res, 400, 'bad receive-pack request\n');
        }
        return;
      }
      sendPlain(res, 404, 'not found\n');
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }
}
