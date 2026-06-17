# Changelog

## 0.0.1 — 2026-06-17

First public proof release.

### Added

- In-place MCP SDK server wrapper exposing synthetic `search` and `execute`.
- Fail-closed composable-tool allowlist and explicit native-tool exceptions.
- Disposable Node worker/contextified VM sandbox.
- Optional QuickJS-WASM sandbox.
- Weighted lexical catalog search with schema terms and identifier normalization.
- Metadata-only and full child-call audit envelopes.
- Call-count, concurrency, code, log, result, and timeout budgets.
- Real MCP SDK client/server tests and MCP Inspector playground.
- Clean tarball consumer proofs shaped after Deja and
  `firestore-mcp-kit@0.1.0`.
- GitHub Release tarball and SHA-256 checksum.

### Security

- Removed ambient Node and network globals from the default guest context.
- Disabled string/WASM code generation in the contextified VM.
- Prevented host-function, Promise, and returned-object constructor escapes by
  crossing the bridge as JSON.
- Rejected non-JSON arguments and results.
- Added fail-closed tool-name and synthetic-name collision handling.

### Scope

This package is focused on Node/Bun MCP servers. Cloudflare Worker products
should use the official experimental `@cloudflare/codemode` runtime.
