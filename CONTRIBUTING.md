# Contributing

## Development

Requirements: Bun, Node.js 20 or newer, and npm.

```bash
bun install
bun run verify
bun run demo
```

To exercise the real stdio example through MCP Inspector:

```bash
bun run play
```

## Pull requests

Keep changes focused and include regression coverage for behavior changes.
`bun run verify` must pass before opening a pull request. Security-sensitive
changes should state which sandbox boundary they affect and include an explicit
negative test for the capability being denied.
