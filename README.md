# mcp-code-mode

> Wrap a Node/Bun MCP server so it exposes `search` + `execute` instead of N eager tools. The agent writes JavaScript; a local worker or QuickJS sandbox calls an explicit tool allowlist.

[![MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![status: 0.0.1](https://img.shields.io/badge/status-0.0.1-black?style=for-the-badge)](#status)

Most MCP servers grow into 30, 50, 100 tools. The agent burns thousands of
tokens on schemas it won't use this turn, and four-step chains become four
round trips. Code-mode collapses that surface to two tools — a keyword
`search` over the catalog, and an `execute` that runs JS in a sandbox where
the underlying tools are `await tools.<name>(args)` bindings.

This is a **Node/Bun server adapter**, not a gateway or a general hosted Code
Mode runtime. Install it inside an MCP server you control; the server keeps its
existing auth, dispatcher, and transport.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { wrapServer } from "mcp-code-mode";

const server = new Server({ name: "my-server", version: "0.1.0" }, { capabilities: { tools: {} } });
// ...register your 50 tools as usual...

wrapServer(server, {
  listTools:  async () => myToolCatalog,
  callTool:   async (name, args) => myDispatch(name, args),
}, {
  // Fail closed: only these methods exist inside guest JavaScript.
  expose: ["search_catalog", "get_entity", "list_reports"],
  // Consequential actions remain explicit top-level MCP calls.
  keepNative: ["refresh_entity", "delete_thing"],
});
```

`tools/list` now returns `[search, execute, refresh_entity, delete_thing]`.
Only the three explicitly exposed methods are callable inside `execute()`;
unknown or newly added catalog tools fail closed.

## Quick start

```bash
git clone https://github.com/acoyfellow/mcp-code-mode
cd mcp-code-mode
bun install
bun run verify
bun run demo
```

`verify` type-checks the library, examples, and tests; runs the worker and
QuickJS sandbox suites; performs a real MCP SDK client/server round trip; builds
the package; and checks the npm tarball. `demo` prints the wrapped catalog, a
search, a three-tool chain, its audit envelope, and the `keepNative` boundary.

To interact with a real stdio server in MCP Inspector:

```bash
bun run play
```

Open the URL Inspector prints, connect, and try `search`, `execute`, and the
native `create_note` tool.

## What's in the box

| Piece                          | What it does                                                                 |
|--------------------------------|------------------------------------------------------------------------------|
| `wrapServer(server, kit, opts)` | Patch an MCP SDK `Server` in place. |
| `withCodeMode(inputs, opts)` | Transport-independent Node/Bun registration path. |
| `createWorkerSandbox()` | Default Node sandbox: disposable worker plus contextified VM. |
| `createQuickJSSandbox()` | Optional separate-engine sandbox using QuickJS-WASM. |
| `searchCatalog(tools, q)` | Weighted lexical ranker; replaceable through `searchTool.handler`. |
| `mcp-code-mode/core` | Low-level structural core used by the Node adapter; not a Worker runtime. |

## What `execute()` actually runs

The user code runs in a disposable, contextified V8 worker (or QuickJS)
sandbox with two injected capabilities: `tools` and `console`. Node globals and
network/filesystem APIs are unavailable. Top-level await works. The return
value is sent back to the agent.

The default worker is appropriate for first-party or agent-generated code but
Node's `vm` module is defense-in-depth, not a hardened hostile-code boundary.
Use QuickJS when the code author is an untrusted principal.

```js
// inside execute({ code: "..." })
const component = (await tools.search_catalog({ kind: "Component", name: "my-svc" })).items[0];
const owner     = (await tools.get_groups({ name: component.spec.owner })).items[0];
const reports   = await tools.get_direct_reports({ user: owner.spec.profile.email });
// Raw names that contain hyphens use bracket notation:
// await tools["service-mcp_get_record"]({ id: "42" });
console.log(`${reports.length} reports for ${owner.metadata.name}`);
return reports.map(r => r.spec.profile.email);
```

The agent sees one round trip. The wrapped server sees three tool calls,
audited in the response envelope.

## The response envelope

```ts
{
  isError: boolean,
  structuredContent: {
    value:      unknown,                  // your top-level return
    logs:       string[],                 // captured console.*
    calls:      { tool, args?, result?, error?, durationMs }[],
    error?:     { message, stack? },
    timedOut:   boolean,
    durationMs: number,
  },
  content: [{ type: "text", text: "<human-readable summary>" }],
}
```

Harnesses that understand `structuredContent` get the full per-call audit.
Those that don't still get a readable summary in `content[0].text`.

## Configuration

```ts
wrapServer(server, toolkit, {
  // Required allowlist: tools available inside execute().
  expose: ["search_catalog", "get_components", "get_users", /* ... */],
  // ...or a predicate:
  // expose: (name) => name.startsWith("get_") || name.startsWith("search_"),

  // Tools that stay surfaced as top-level tools on the wrapped server.
  // Use for side-effectful operations the agent should reason about explicitly.
  keepNative: ["refresh_entity", "run_entity_checks"],

  // Swap the sandbox.
  sandbox: await createQuickJSSandbox(),

  // Metadata is the safe default. Opt into "full" only for non-sensitive data.
  audit: "metadata",

  limits: {
    maxToolCalls: 100,
    maxConcurrentCalls: 10,
    maxCodeBytes: 64 * 1024,
    maxLogBytes: 64 * 1024,
    maxResultBytes: 1024 * 1024,
  },

  // Tune the synthetic tools (or replace the tiny keyword ranker).
  searchTool:  {
    name: "find",
    description: "...",
    handler: async (catalog, query, limit) => semanticSearch(catalog, query, limit),
  },
  executeTool: { name: "run",    description: "...", defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000 },
});
```

## Sandboxes

| Sandbox        | Cold start | Memory caps | CPU interrupt | Native deps | Best for                                  |
|----------------|------------|-------------|---------------|-------------|-------------------------------------------|
| worker_threads + VM | ~5ms | host-managed | outer worker termination | none | First-party / agent-generated code |
| QuickJS-WASM | ~25ms | engine-enforced | engine interrupt | optional dependencies | Untrusted code, strict boundaries |

Both local implementations use the same structural `Sandbox` interface.
`mcp-code-mode/core` remains available for adapters, but this project does not
provide or claim a Cloudflare Worker runtime.

## Cloudflare Workers

Use the official experimental
[`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode)
package for Worker Loader execution, MCP/OpenAPI connectors, approval-paused
actions, durable replay/rollback logs, and snippets. This project complements
that package for Node/Bun MCP servers; it does not replace it.

## Why a library and not a gateway

A gateway sits between the harness and N MCP servers and collapses them all.
That's great for cross-server composition, but it duplicates every server's
catalog, executor, auth context, and deployment.

A library wraps one server in place. The server already owns those things.
You ship one updated MCP, every consumer benefits, no new processes. The
tradeoff is that one `execute()` block can't span servers — but most useful
chains live inside one server anyway, especially aggregator servers that already pool many backends behind a single
MCP.

Use [forgemax](https://github.com/postrv/forgemax) when you can't modify the
servers. Use this when you can.

## Operational limits

- **Classify capabilities, not names.** `expose` is required. To expose a fully
  trusted static catalog, the caller must explicitly set `unsafeExposeAll:
  true`. `keepNative` is presentation policy, not authorization; every
  underlying dispatcher must still authenticate, authorize, and validate.
- **Timeout is not cancellation.** Terminating guest JavaScript cannot undo or
  abort a downstream tool call that already started. Keep writes, payments,
  notifications, deploys, and other consequential calls native unless the
  downstream API supplies its own cancellation/idempotency contract.
- **Budgets are local, not quotas.** The package bounds child-call count and
  concurrency plus code/log/result bytes per execution. The default still
  creates one V8 worker per execution; apply a host-level queue across requests.
- **Return JSON.** Tool arguments, tool results, and the final value must be
  JSON-compatible. Cycles, functions, and BigInt values are rejected.

Run the repeatable local load probe with `bun run stress`; raise worker pressure
with `STRESS_CONCURRENCY=200 bun run stress`.

## Status

`0.0.1`, not yet published. Tests cover fail-closed exposure, execution
budgets, worker and QuickJS boundaries, search, native tools, timeout, audit,
and a real MCP SDK round trip. A clean packed tarball was also installed into a
copy of the real Deja stdio MCP server and successfully composed `recall +
inbox` while keeping all mutations native.

Publish only after the packed-consumer proof is automated in CI and this narrow
Node/Bun positioning has a second adopter.

MIT. Built by [@acoyfellow](https://github.com/acoyfellow).
