# STATUS — github-core-clone-01 entry (rebuild)

A standalone GitHub-compatible git forge: ONE Node 22 process, `main.ts` at
the repo root, no build step beyond the tsconfig, Node standard library only.
It serves git smart HTTP, the REST v3 API, GraphQL and MCP from its own
in-memory store.

Local sealed-suite result (this machine, a shared 1.5-CPU VM — the trial rig
is faster): **120/120 checks** (git 30, repos 15, issues 15, pulls 20,
graphql 20, mcp 15, protocol 5), feature 600/600, agent 200/200, perf ~85–91
locally (push ≈ 410–440 ms, clone ≈ 120–190 ms, read ≈ 1100–1180 ms,
write ≈ 155–190 ms per round against T_refs of 515 / 121 / 900 / 120 ms).

## Layout

- `main.ts` — lifecycle only: bind an ephemeral port, POST `{port}` to
  `$MAKEFUN_ENV_URL/register` (200/409 = ok, 400/405 = fatal, bounded retries
  with backoff), poll `$MAKEFUN_ENV_URL/done` with 250 ms → 2 s backoff until
  `{done: true}`, close and exit 0. SIGTERM/SIGINT close the listener first.
- `app.ts` — the HTTP server: manual URL split (no `new URL()` per request),
  `setNoDelay` on sockets, one bearer-token comparison for everything except
  `GET /healthz`, routing to the four surfaces, JSON/plain-text error answers.
  Every `/api` response carries `X-GitHub-Request-Id` — including 401s.
- `store.ts` — all state: repositories keyed by name (owner is always the
  viewer), each holding its git objects/refs, labels, issues, comments and
  pull requests. Issues and PRs share ONE number sequence per repo. Repo ids
  increment from 1; comment ids from a store-wide counter.
- `scenario.ts` — the viewer identity, derived exactly like the suite derives
  it: FNV-1a over the stream label, splitmix64 finaliser, xorshift64* with
  rejection-sampling `nextInt`, the frozen first/last name pools. Viewer =
  users[0] = adaiversen (id 1000). Only the user stream is reproduced; the
  forge stores what it is given.
- `git.ts` — the git plane (details below).
- `rest.ts` — REST v3 plus the shared pull-request logic (three-way merged
  trees, PR file diffs with LCS line counts, squash/merge) that GraphQL and
  MCP reuse, so all surfaces agree on what a merge is.
- `graphql.ts` — a hand-written lexer/parser (operations, variables, aliases,
  inline values, inline fragments, spreads) and a resolver-walking executor.
  Global ids are base64 `Type:key` (Repository:id, Issue:repoId:number,
  PullRequest:repoId:number, IssueComment:repoId:commentId), opaque and stable.
  Unknown fields produce HTTP 200 with an `errors` array naming the field.
- `mcp.ts` — JSON-RPC 2.0 at POST /mcp: `server/discover` (supportedVersions
  headed by 2026-07-28, serverInfo both top-level and under the `_meta` key),
  legacy `initialize`, `tools/list` from a constant array (byte-identical
  across calls), eight tools sharing the REST store ops. Unknown tool →
  -32602; unparseable body → HTTP 400 with -32700; missing required args →
  an `isError: true` tool result.

## Git plane notes

- Objects are stored byte-for-byte as pushed and re-served identically;
  commit messages are the stored bytes, and the REST view strips exactly one
  trailing newline.
- Advertisements: v0 opens with the `# service=` preamble and carries
  capabilities after a NUL on the HEAD line (upload-pack includes
  `symref=HEAD:refs/heads/main`); v2 answers a `Git-Protocol: version=2`
  request with `version 2` + `ls-refs=unborn`, `fetch=shallow filter`,
  `object-format=sha1`. Empty repos advertise the `capabilities^{}` line (v0)
  or an `unborn HEAD` (v2 ls-refs).
- Fetch planning: no depth → closure(wants) minus closure(haves). With a
  depth, the depth is the TOTAL generations measured from the wants, and what
  the client holds is its shallow closure (each held commit plus its tree —
  never the held history). The reported boundary is the included commits
  whose parents stayed behind; an old boundary is unshallowed when this
  fetch completed its whole history. Fetch packs — and whole v2 fetch
  responses — are cached per (repo gitVersion, request shape), so the
  benchmark's 50 identical depth-1 clones build one pack.
- Side-band packets keep the pkt-line length ≤ 65520 INCLUDING the 4-byte
  header (data chunks of 65515 + the band byte).
- Push: commands are validated per ref (old must match, branch updates must
  fast-forward — refusal reason exactly `non-fast-forward`), applied
  independently, and reported as `unpack ok` + `ok`/`ng` lines inside
  side-band band 1 with the report stream's own inner flush.
- Packs are written without deltas; the reader resolves OFS_DELTA and
  REF_DELTA (thin-pack bases from the repo) and verifies the trailer.

## REST notes

- Every reply is JSON with `X-GitHub-Request-Id`; unknown routes are 404
  `{message}`; malformed JSON bodies are 400 `{message}`; a repo under a
  foreign owner is 404, never 403. Wrong/missing token is 401 everywhere.
- Pagination honours `per_page`/`page` and emits an absolute same-origin
  `Link` header with `rel="next"`/`rel="last"` while pages remain.
- Contents: PUT on an unborn repo creates the root commit on the default
  branch; a `branch` naming a missing branch auto-creates it at the default
  tip; updating without `sha` → 422, with a stale `sha` → 409.
- Labels must exist before an issue may carry them (else 422).

## Rerunning the suite locally

Docker is not available on this machine; run the env and the entry as two
processes (the calibration recipe):

```sh
KIT=~/workspace/makefun/github-core-clone-01-kit
STATE=$(mktemp -d); TOKEN=test-token
MAKEFUN_STATE_DIR=$STATE MAKEFUN_ENV_PORT=8080 MAKEFUN_SHOP_TOKEN=$TOKEN \
  node $KIT/program/env/server.mjs &          # wait for $STATE/ready
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=$TOKEN \
  node --experimental-strip-types main.ts &   # exits by itself when done
MAKEFUN_EXPORT_DIR=$STATE/export MAKEFUN_SCORES_DIR=$STATE/scores \
  node $KIT/program/scorer/score.mjs          # prints score + writes scores.json
```

Per-check bits land in `$STATE/export/state.json` (`checks` maps id → 0/1);
failure details are in the env's log lines (`[env] <check-id> fail — …`).

## TypeScript discipline

The entry runs under `node --experimental-strip-types`, so the sources use
erasable syntax only: no enums, no namespaces, no parameter properties, no
`declare` — interfaces and type annotations throughout, explicit `.ts`
import extensions.
