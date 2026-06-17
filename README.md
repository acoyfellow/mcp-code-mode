# mcp-code-mode

> Turn a Node/Bun MCP server with many eager tools into two: `search` and sandboxed `execute`.

[![CI](https://github.com/acoyfellow/mcp-code-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/acoyfellow/mcp-code-mode/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![status: 0.0.1](https://img.shields.io/badge/status-0.0.1-black)](#status)

Large MCP catalogs spend prompt tokens on schemas the model may not use and turn
multi-step work into repeated model/tool round trips. `mcp-code-mode` wraps one
server in place:

- `search` progressively discloses tool schemas;
- `execute` runs JavaScript that composes approved tools;
- consequential tools stay visible as ordinary native MCP calls.

The server keeps its existing authentication, authorization, dispatcher, and
transport. This is a library, not a gateway.

## Install

```bash
npm install https://github.com/acoyfellow/mcp-code-mode/releases/download/v0.0.1/mcp-code-mode-0.0.1.tgz
```

The npm package name is reserved for a future registry publication. The GitHub
release above is the verified `v0.0.1` distribution.

## Wrap a server

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { wrapServer } from 'mcp-code-mode';

const server = new Server(
  { name: 'my-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

wrapServer(
  server,
  {
    listTools: async () => catalog,
    callTool: async (name, args) => dispatch(name, args),
  },
  {
    // Required: only these tools exist inside guest JavaScript.
    expose: ['search_catalog', 'get_entity', 'list_reports'],

    // Writes and other consequential actions stay explicit.
    keepNative: ['refresh_entity', 'delete_thing'],
  },
);
```

Before:

```text
search_catalog · get_entity · list_reports · refresh_entity · delete_thing
```

After:

```text
search · execute · refresh_entity · delete_thing
```

Inside `execute`, the model can write:

```js
const entity = await tools.get_entity({ id: 'svc-42' });
const reports = await tools.list_reports({ owner: entity.owner });
return reports.map((report) => report.id);
```

Names containing hyphens or dots use bracket notation:

```js
await tools['service-mcp.get-record']({ id: '42' });
```

## Fail-closed by default

`expose` is a positive capability policy. Unknown and newly added catalog tools
do not become executable automatically. A fully trusted static catalog must opt
in explicitly with `unsafeExposeAll: true`.

Default per-execution budgets:

| Budget | Default |
|---|---:|
| Child calls | 100 |
| Concurrent child calls | 10 |
| Guest code | 64 KiB |
| Captured logs | 64 KiB |
| Child/final result data | 1 MiB |
| Timeout | 15 seconds |

Audit receipts default to metadata only—tool name, status, and timing—without
copying sensitive arguments or results. Set `audit: 'full'` only for trusted,
non-sensitive tools.

Timeout stops guest JavaScript; it cannot undo a downstream operation that
already started. Keep sends, comments, payments, retries, deploys, deletes, and
other consequential actions native unless the downstream API has an explicit
idempotency/cancellation contract.

## Sandboxes

| Sandbox | Boundary | Use |
|---|---|---|
| Node worker + contextified VM | Disposable worker, no ambient Node/network globals, hard outer timeout | First-party or agent-generated programs |
| QuickJS-WASM | Separate JS engine with interrupt support | Stronger boundary for untrusted principals |

Node's `vm` is defense in depth, not a hardened hostile-code boundary. See
[Security](SECURITY.md) and [Architecture](docs/architecture.md).

## Cloudflare Workers

Use the official experimental
[`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode)
for Worker Loader execution, MCP/OpenAPI connectors, approvals, durable replay,
rollback, and snippets. This package is focused on in-place Node/Bun MCP server
wrapping; it complements rather than replaces the official Worker runtime.

## Proven consumers

The release gate installs the exact tarball into fresh temporary projects and
drives separate real stdio MCP processes:

| Consumer | Composable | Native | Preserved contract |
|---|---|---|---|
| Deja-shaped memory server | `recall`, `inbox` | `remember` | Persistence remains explicit |
| `firestore-mcp-kit@0.1.0` | `notes.get`, `notes.exists` | `notes.create`, `notes.update` | Zod validation and app authorization survive wrapping |

## Documentation

| Need | Read |
|---|---|
| First integration | [Tutorial](docs/tutorial.md) |
| Decide what may compose | [Capability policy](docs/how-to/capability-policy.md) |
| API and defaults | [Reference](docs/reference.md) |
| Runtime design | [Architecture](docs/architecture.md) |
| Measured behavior | [Stress results](docs/stress-results.md) |
| Security and reporting | [Security](SECURITY.md) |

## Development

```bash
git clone https://github.com/acoyfellow/mcp-code-mode
cd mcp-code-mode
bun install
bun run verify
bun run demo
```

Useful commands:

```bash
bun run play             # real stdio example in MCP Inspector
bun run stress           # repeatable local load probe
bun run prove:consumer   # clean Deja-shaped tarball consumer
bun run prove:firestore  # clean firestore-mcp-kit tarball consumer
```

## Status

`0.0.1`. The GitHub release is installable and CI-verified. The package is not
yet published to npm.

MIT. Built by [@acoyfellow](https://github.com/acoyfellow).
