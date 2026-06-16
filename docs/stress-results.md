# Stress results

These are development measurements, not service-level guarantees. Run the
repeatable probe on your target host with `bun run stress`.

## 2026-06-16 — Apple Silicon, Node 24

| Scenario | Result |
|---|---:|
| 250 sequential child calls in one worker execution | 18.0 ms |
| 250 parallel child calls in one worker execution | 13.3 ms |
| 50 concurrent worker executions / 1,000 child calls | 91.8 ms; ~285 MB transient RSS increase |
| 200 concurrent worker executions / 200 child calls | 426.0 ms; ~986 MB transient RSS increase |
| 10 MB child-tool result | 31.5 ms |
| 10,000-tool catalog × 100 lexical searches | 998.6 ms total |
| 100 sequential QuickJS executions | 346.4 ms |
| 25 concurrent QuickJS executions | 52.4 ms |
| 100 parallel child calls in one QuickJS execution | 20.4 ms |

A separate 20-case retrieval check against a real 182-tool aggregate MCP
catalog measured Recall@5:

- original exact-overlap ranker: 15/20 (75%);
- identifier splitting and plural normalization: 17/20 (85%);
- weighted names/schema terms plus the small general alias set: 20/20 (100%).

The retrieval cases covered merge-request review, CI diagnosis, issue tracking,
logs, incidents, wiki/docs, mail/chat/calendar, monitoring, releases, and
network investigation. The private catalog and query fixtures are intentionally
not committed.

## Boundary findings

The stress pass found and fixed:

- non-JSON cyclic and BigInt return values reaching the MCP envelope;
- QuickJS stopping an infinite loop but not marking the result timed out;
- host-realm functions and returned objects allowing constructor-based escape
  from the default VM context;
- a Node-only package entry preventing custom-sandbox use in Workers;
- poor retrieval for namespaced underscore-separated tool names.

One limit is fundamental: a guest timeout stops the guest, not an already
started downstream tool call. Consequential tools should stay native and enforce
idempotency/authorization downstream.
