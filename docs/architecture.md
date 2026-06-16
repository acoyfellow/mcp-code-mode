# Architecture

A wrapped MCP server, with one synthetic `search` tool, one synthetic `execute`
tool, an optional pass-through list of "keep native" tools, and a sandbox
behind `execute()` that brokers calls back to the underlying tool implementations.

The package is Node/Bun-focused. Its low-level `mcp-code-mode/core` entry keeps
the catalog/policy logic structural, while the main entry adds the default
worker sandbox and MCP SDK adapter. Cloudflare Worker products should use the
official `@cloudflare/codemode` runtime.

```text
   ┌──────────────────────────┐         tools/list ──► [search, execute, ...keepNative]
   │       LLM harness        │ ──────► tools/call(search,  query) ─┐
   │  (pi, Claude, Cursor)    │         tools/call(execute, code)  │
   └──────────────────────────┘                                    │
                                                                   ▼
                            ┌──────────────────────────────────────────────────┐
                            │              wrapped MCP server                  │
                            │  (your `Server` + `withCodeMode(...)`)           │
                            │                                                  │
                            │   search(query)  ──►  searchCatalog(inner)       │
                            │                                                  │
                            │   execute(code)  ──►  sandbox.run({              │
                            │                          code, timeoutMs,        │
                            │                          expose: [names],       │
                            │                          invoke: <bridge>       │
                            │                       })                        │
                            │                              │                  │
                            │                              ▼                  │
                            │                  ┌──────────────────────────┐   │
                            │                  │       sandbox            │   │
                            │                  │ (worker_threads default, │   │
                            │                  │  or QuickJS-WASM)        │   │
                            │                  │                          │   │
                            │                  │  user code runs here     │   │
                            │                  │  `tools.<name>(args)` ──┼───┘
                            │                  │  posts back to parent    │
                            │                  └──────────────────────────┘
                            │                              │
                            │              <bridge calls inner.callTool(name, args)>
                            │                              │
                            │   inner toolset (your real implementations)
                            └──────────────────────────────────────────────────┘
```

## What changes on the wire

Before:

```json
{ "method": "tools/list", "result": { "tools": [ /* 50 schemas */ ] } }
```

After `withCodeMode(server, { keepNative: ["refresh_entity"] })`:

```json
{
  "method": "tools/list",
  "result": {
    "tools": [
      { "name": "search",          "description": "..." },
      { "name": "execute",         "description": "..." },
      { "name": "refresh_entity",  "description": "..." }
    ]
  }
}
```

The other 47 tools still exist — they're just only reachable from inside
`execute()` as `await tools.<name>(args)`. Schemas for them are discoverable
via `search(query)`.

## The expose / keep-native split

Two orthogonal questions per tool:

| Question                                | If **yes**            | If **no**             |
|------------------------------------------|-----------------------|------------------------|
| Should the agent be able to call it inside JS chains? | `expose`              | not exposed            |
| Should the agent see it as its own tool? | `keepNative`          | hidden behind `search` |

The default is fail-closed: callers must provide `expose`, or deliberately opt a
fully trusted static catalog into `unsafeExposeAll: true`. Audit receipts default
to metadata-only.
Most servers want to flip a small handful of write-side-effect tools into
`keepNative` so the model reasons about them explicitly.

## Sandbox boundary

### worker_threads (default)

- Fresh worker plus contextified V8 VM per `execute()` call. No shared state.
- The runner is dependency-free; it accepts a `code` string + an `expose` list.
- VM-realm `tools` and `console` wrappers capture a single host bridge, then
  remove that bridge from `globalThis` before user code starts.
- Calls cross the bridge as JSON strings so host-realm functions, Promises, and
  returned object constructors are not exposed as VM escape gadgets.
- No `require`, `process`, `fs`, `Buffer`, or network globals. String and WASM
  code generation are disabled in the VM context.
- Hard timeout terminates the outer worker. A tight `while(true){}` burns one
  core until that timeout fires.
- Node documents `vm` as defense-in-depth rather than a hardened security
  boundary. Use QuickJS when the code author is an untrusted principal.

### QuickJS (optional)

- Loaded via optional `@sebastianwessel/quickjs` and WASM variant packages.
- Engine-enforced memory isolation and CPU interrupts; Node/network globals are
  removed before user code runs.
- Roughly 25ms cold-start vs roughly 5ms for the worker path on Apple Silicon.
- Same `tools` / `console` bridge contract.

Both sandboxes emit the same `SandboxResult` shape, so the wrapper code is
identical.

## The `execute()` return envelope

```ts
{
  isError: boolean,
  structuredContent: {
    value:        unknown,                  // your top-level return
    logs:         string[],                 // captured console.*
    calls:        SandboxCallRecord[],      // every tools.* invocation
    error:        { message, stack? } | undefined,
    timedOut:     boolean,
    durationMs:   number,
  },
  content: [{ type: "text", text: "<human-readable summary>" }],
}
```

The summary text is what the agent actually sees by default. Harnesses that
understand `structuredContent` can show the full audit trail (every tool call,
duration, args, result) in their UI.

## Why a library and not a gateway

A gateway (e.g. forgemax) sits between the harness and N downstream MCP servers
and collapses them all behind one `search` + `execute`. That's powerful for
cross-server composition, but it duplicates the catalog, the executor, the
auth contexts, and the deployment surface.

A library wraps **one** server in place. The server already owns its catalog,
its executor, and its auth. We just rewrite its `tools/list` and intercept
`tools/call`. The downside is no cross-server composition in a single
`execute()` block — but per-server codemode is enough for most workloads,
especially when an aggregator server already pools many backends behind a
single MCP.

Both shapes coexist. Use a gateway when you can't modify the servers. Use
this library when you can.

## Cancellation and side effects

The sandbox timeout bounds guest execution, not downstream work. Once a tool
call crosses into the server dispatcher, terminating the guest cannot undo or
necessarily abort it. `expose` should therefore be a positive capability
allowlist; consequential tools should remain native and enforce authorization,
idempotency, and cancellation in their own implementation.
