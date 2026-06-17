# Tutorial: wrap your first MCP server

This tutorial starts with three tools and ends with a server exposing
`search`, `execute`, and one explicit native write.

## 1. Install

```bash
npm install @modelcontextprotocol/sdk \
  https://github.com/acoyfellow/mcp-code-mode/releases/download/v0.0.1/mcp-code-mode-0.0.1.tgz
```

`mcp-code-mode` supports Node 20+ and Bun.

## 2. Define the original catalog and dispatcher

```ts
import type { ToolCallResult, ToolSchema } from 'mcp-code-mode';

const catalog: ToolSchema[] = [
  {
    name: 'records.search',
    description: 'Search records by text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'records.get',
    description: 'Get one record by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'records.delete',
    description: 'Delete one record.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // Keep your existing authentication, authorization, validation, and domain
  // dispatch here. The wrapper does not replace server-side enforcement.
  const value = await dispatch(name, args);
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}
```

## 3. Wrap the MCP server

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { wrapServer } from 'mcp-code-mode';

const server = new Server(
  { name: 'records', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

wrapServer(
  server,
  {
    listTools: async () => catalog,
    callTool,
  },
  {
    expose: ['records.search', 'records.get'],
    keepNative: ['records.delete'],
  },
);

await server.connect(new StdioServerTransport());
```

The client now sees:

```text
search · execute · records.delete
```

`records.delete` remains a normal top-level MCP call. It does not exist inside
guest JavaScript.

## 4. Discover schemas

Call the synthetic search tool:

```json
{
  "name": "search",
  "arguments": { "query": "find records" }
}
```

The response includes matching tool names, descriptions, and input schemas.

## 5. Compose reads

Call `execute` with a JavaScript body:

```json
{
  "name": "execute",
  "arguments": {
    "code": "const hits = await tools['records.search']({ query: 'edge' }); const full = await Promise.all(hits.items.map((item) => tools['records.get']({ id: item.id }))); return full;"
  }
}
```

The result includes the final value, captured logs, child-call metadata, timeout
state, and total duration.

## 6. Try the repository playground

From a clone:

```bash
bun install
bun run play
```

MCP Inspector opens with the real stdio example configured. Connect, list tools,
then try `search`, `execute`, and the native `create_note` tool.

## Next

- Decide the policy for your real catalog with the
  [capability-policy guide](how-to/capability-policy.md).
- Tune budgets and response handling using the [reference](reference.md).
- Read the [security model](../SECURITY.md) before exposing third-party or
  changing catalogs.
