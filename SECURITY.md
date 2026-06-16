# Security

## Sandbox boundaries

`mcp-code-mode` executes agent-authored JavaScript. Choose the sandbox based on
who controls that code:

- The default worker + VM sandbox removes ambient Node, filesystem, and network
  globals, disables string/WASM code generation, and terminates the outer worker
  on timeout. Node's `vm` module is defense-in-depth, not a hardened hostile-code
  boundary. Use it for first-party or agent-generated programs operating on an
  allowlisted tool catalog.
- The optional QuickJS sandbox is the stronger boundary for code supplied by an
  untrusted principal. It runs in a separate JavaScript engine with network and
  filesystem capabilities disabled.

`keepNative` is a visibility and composition policy, not authorization. The
wrapped MCP server must still authenticate requests, authorize every underlying
tool call, validate arguments, and enforce resource limits.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for
`acoyfellow/mcp-code-mode`. Do not open a public issue containing exploit code or
credentials.
