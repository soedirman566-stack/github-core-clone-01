# github-core-clone-01 — a standalone GitHub-compatible forge

One Node 22 process, standard library only, no build step. It serves four
surfaces from a single in-memory store:

- **Git smart HTTP** — protocol v0 and v2: ref advertisement, `ls-refs`,
  fetch (full, incremental and shallow, with deepen), and receive-pack with
  per-ref report-status inside side-band-64k. Objects are stored
  byte-for-byte and re-served identically; packs are written without deltas
  and read with full OFS/REF delta resolution.
- **REST v3** (`/api/v3`) — repositories, issues, labels, comments, pull
  requests (including files and squash/merge), the contents API, git refs,
  branches and commit lists, with GitHub-style pagination and error shapes.
- **GraphQL v4** (`/api/graphql`) — viewer/repository/issue/pull-request
  reads, cursor-paginated issue connections, the create/close/merge/comment
  mutations, Relay `node(id:)` lookups, `__type` introspection, and operation
  batching. Global ids are opaque and stable.
- **MCP** (`/mcp`) — JSON-RPC 2.0: `server/discover` (2026-07-28), the legacy
  `initialize` handshake, and eight tools (`create_repo`, `get_repo`,
  `list_repos`, `create_issue`, `get_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) over the same store, so an
  object created on one surface is the same object on every other.

The token owner is derived deterministically from the trial's fixed scenario
seed (see `scenario.ts`); every repository belongs to that viewer, and a
repository named under any other owner does not exist.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> npm start
```

The process binds an ephemeral loopback port, registers it with the env,
serves until the env answers `{"done": true}` on `/done`, and exits 0.

## Layout

| file          | what it holds                                                                 |
| ------------- | ----------------------------------------------------------------------------- |
| `main.ts`     | lifecycle: bind, register, serve, poll `/done`, exit                          |
| `app.ts`      | HTTP wiring: auth, manual routing, serialisation                              |
| `store.ts`    | the in-memory state: repos, git objects/refs, issues, pulls, labels, comments |
| `scenario.ts` | the deterministic viewer identity (FNV-1a + splitmix64 + xorshift64*)         |
| `git.ts`      | the git plane: objects, packs, pkt-lines, reachability, smart HTTP            |
| `rest.ts`     | the REST v3 surface and the shared pull-request merge/file logic              |
| `graphql.ts`  | a small GraphQL parser and resolver-walking executor                          |
| `mcp.ts`      | the MCP endpoint: discovery, handshake, tools                                 |

See `STATUS.md` for implementation notes and how to rerun the conformance
suite locally.
