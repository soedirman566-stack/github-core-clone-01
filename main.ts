// main.ts — the process lifecycle the trial harness drives.
//
//   1. bind an ephemeral port on loopback (never 8080: that is the env's);
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register — the first register
//      wins, a conflict means we are already registered, and a 400/405 is a
//      contract failure worth dying on;
//   3. serve until GET $MAKEFUN_ENV_URL/done answers {"done": true}, then
//      exit 0. Poll with backoff; never hold a request open.
//
// Errors before registration are fatal (stderr + exit 1): a forge that cannot
// announce itself can only fail the trial by silence otherwise. SIGTERM and
// SIGINT close the listener before exiting, so a harness that stops the
// process early never leaves a half-bound port behind.

import { createForgeServer } from './app.ts';
import { Store } from './store.ts';

/** Register retries before the env is declared unreachable. */
const REGISTER_MAX_ATTEMPTS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) throw new Error('MAKEFUN_ENV_URL is not set');
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const base = envUrl.replace(/\/+$/, '');

  const store = new Store();
  const server = createForgeServer(store, token);

  const shutdown = (code: number): void => {
    server.close(() => process.exit(code));
    // If connections linger, do not let the close wait forever.
    setTimeout(() => process.exit(code), 1000).unref();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no bound address'));
      else resolve(address.port);
    });
  });

  // Register, retrying transient failures with backoff. 200 (accepted) and
  // 409 (already registered) both mean the env knows where we live; 400/405
  // are contract failures, and a bounded attempt count keeps a dead env from
  // hanging the trial's boot budget.
  let delay = 250;
  let registered = false;
  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS && !registered; attempt += 1) {
    let status: number | null = null;
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = response.status;
      await response.text().catch(() => '');
    } catch {
      status = null;
    }
    if (status === 200 || status === 409) registered = true;
    else if (status === 400 || status === 405) throw new Error(`register refused with HTTP ${status}`);
    else if (attempt < REGISTER_MAX_ATTEMPTS) {
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
  if (!registered) throw new Error(`register did not succeed after ${REGISTER_MAX_ATTEMPTS} attempts`);

  // Long-poll /done until the suite is over.
  delay = 250;
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${base}/done`);
      const payload = (await response.json()) as { done?: unknown };
      done = payload.done === true;
    } catch {
      done = false;
    }
    if (done) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  shutdown(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

