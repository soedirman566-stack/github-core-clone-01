// Entry point for the forge. This file owns only the harness lifecycle:
// bring the HTTP app up on an ephemeral port, tell the grading environment
// where it can be reached, hold it open until the environment reports the
// trial over, then shut down. Everything GitHub-shaped lives in app.ts.

import { createApp } from './app.ts';

// Each request to the environment gets thirty seconds before we abandon it.
const REQUEST_TIMEOUT_MS = 30_000;

// Patience schedule: a quarter second at first, doubling after every
// failure, never longer than two seconds a wait.
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;
const MAX_DOUBLINGS = 8;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitAfter(failures: number): number {
  const grown = FIRST_WAIT_MS * 2 ** Math.min(failures, MAX_DOUBLINGS);
  return Math.min(grown, LONGEST_WAIT_MS);
}

// POST our port to the environment's /register endpoint, retrying until it
// sticks. 200 means we checked in; 409 means another instance registered
// first, which counts as checked in too. 400 and 405 can never succeed, so
// those abort. Anything else, network failures included, earns a retry.
async function checkIn(base: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      reply = null; // environment unreachable for now; the wait below applies
    }
    if (reply !== null) {
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        const detail = await reply.text();
        throw new Error(`check-in refused (HTTP ${reply.status}): ${detail}`);
      }
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

// Poll /done until its JSON body really carries done: true. A failed
// request or a "not yet" body both mean: back off and ask again.
async function holdUntilDone(base: string): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true
        ) {
          return;
        }
      }
    } catch {
      // A blown poll is only a slower "not yet".
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const given = process.env.MAKEFUN_ENV_URL;
  if (given === undefined || given.trim() === '') {
    console.error('MAKEFUN_ENV_URL is unset, so there is nowhere to check in.');
    process.exit(1);
  }
  const base = given.replace(/\/+$/, '');

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the app server did not report the port it bound');
  }

  console.log(`forge listening on port ${bound.port}; checking in with the suite`);
  await checkIn(base, bound.port);
  console.log('checked in; standing by while the suite runs');
  await holdUntilDone(base);
  console.log('suite reports done; shutting the forge down');
  server.close();
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
