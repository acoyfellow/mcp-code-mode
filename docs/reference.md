# Reference

## Runtime support

- Node.js 20+
- Bun
- ESM only
- MCP SDK peer dependency: `@modelcontextprotocol/sdk >= 1.0.0`

For Cloudflare Worker Loader execution and durable approvals/replay, use the
official experimental `@cloudflare/codemode` package.

## Exports

| Export | Entry | Description |
|---|---|---|
| `wrapServer` | `mcp-code-mode` | Patch an MCP SDK `Server` in place |
| `withCodeMode` | `mcp-code-mode` | Register handlers against structural list/call inputs |
| `createWorkerSandbox` | `mcp-code-mode` or `/sandbox/worker` | Default Node worker + VM sandbox |
| `createQuickJSSandbox` | `/sandbox/quickjs` | Optional QuickJS-WASM sandbox |
| `searchCatalog` | `mcp-code-mode` or `/search` | Default lexical catalog ranker |
| `createCodeMode` | `/core` | Low-level handler factory requiring a supplied sandbox |

## `wrapServer`

```ts
wrapServer(server, toolkit, options, schemas?);
```

### Toolkit

```ts
type ToolInvoker = {
  listTools(): Promise<ToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
};
```

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `expose` | `string[] \| (name) => boolean` | required | Tools available inside guest JavaScript |
| `unsafeExposeAll` | `boolean` | `false` | Explicitly expose every non-native tool |
| `keepNative` | `string[]` | `[]` | Tools retained as visible top-level MCP calls |
| `sandbox` | `Sandbox` | Node worker | Guest execution implementation |
| `audit` | `'metadata' \| 'full'` | `'metadata'` | Child receipt detail |
| `limits` | object | see below | Per-execution budgets |
| `searchTool` | object | built-in search | Name, description, or ranker override |
| `executeTool` | object | built-in execute | Name, description, and timeout bounds |

Passing both `expose` and `unsafeExposeAll` throws. Passing neither throws.

### Default limits

```ts
{
  maxToolCalls: 100,
  maxConcurrentCalls: 10,
  maxCodeBytes: 64 * 1024,
  maxLogBytes: 64 * 1024,
  maxResultBytes: 1024 * 1024,
}
```

The default execution timeout is 15 seconds; the maximum client-selectable
timeout is 60 seconds.

## Synthetic `search`

Input:

```ts
{
  query: string;
  limit?: number; // clamped to 1..50, default 10
}
```

Output `structuredContent`:

```ts
{
  tools: ToolSchema[];
  total: number; // total exposed/composable catalog size
}
```

The built-in ranker tokenizes names, descriptions, and input schemas; splits
namespaces/camelCase; normalizes simple plurals; and applies a small general
alias set. Replace it with `searchTool.handler` for domain-specific retrieval.

## Synthetic `execute`

Input:

```ts
{
  code: string;       // async-function body; top-level await and return work
  timeout_ms?: number;
}
```

Tools are available by exact raw name:

```js
await tools.get_record({ id: '42' });
await tools['service-mcp.get-record']({ id: '42' });
```

Output:

```ts
{
  isError: boolean;
  structuredContent: {
    value?: unknown;
    logs: string[];
    calls: Array<{
      tool: string;
      args?: Record<string, unknown>; // full audit only
      result?: unknown;               // full audit only
      error?: string;
      startedAt: number;
      durationMs: number;
    }>;
    error?: { message: string; stack?: string };
    timedOut: boolean;
    durationMs: number;
  };
  content: Array<{ type: 'text'; text: string }>;
}
```

Arguments, child results, and final values must be JSON-compatible. Functions,
cycles, and BigInt values fail the execution.

## Sandbox contract

```ts
type Sandbox = {
  name: string;
  run(options: {
    code: string;
    timeoutMs: number;
    maxLogBytes?: number;
    expose: string[];
    invoke(tool: string, args: Record<string, unknown>): Promise<unknown>;
  }): Promise<SandboxResult>;
};
```

Custom sandboxes should return errors in `SandboxResult` rather than throw.
They must not provide capabilities beyond `tools` and captured `console` unless
the caller documents that authority explicitly.

## Errors

Configuration errors throw during wrapping. Guest/tool/runtime failures return
an MCP `isError` result with a readable text summary and structured error data.

A timeout reports `timedOut: true`. Downstream calls already in progress may
continue; timeout is not cancellation.
