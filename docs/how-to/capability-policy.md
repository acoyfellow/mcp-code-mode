# How to classify tools for Code Mode

Code Mode changes the unit of authority. One visible `execute` call may perform
many hidden child calls, in parallel or conditionally. Treat the guest catalog
as a capability grant, not a display preference.

## Use three classes

| Class | Behavior | Examples |
|---|---|---|
| Composable | Included in `expose`; callable inside guest JavaScript | search, get, list, bounded read/query |
| Native | Included in `keepNative`; visible as a direct MCP tool | send, comment, create, update, retry, deploy |
| Denied | In neither list; unavailable through the wrapped surface | destructive/admin operations the client should not perform |

Unknown and newly added tools should remain denied or native until reviewed.

## Prefer exact names

```ts
wrapServer(server, toolkit, {
  expose: [
    'issues.search',
    'issues.get',
    'projects.list',
  ],
  keepNative: [
    'issues.comment',
    'issues.update',
  ],
});
```

Exact names make catalog drift visible in review. Predicates are convenient but
broaden authority automatically when a matching tool appears later:

```ts
// Use only when this naming policy is itself an intentional capability grant.
expose: (name) => name.startsWith('read_');
```

Never infer authorization solely from verbs. A method called `resolve` may be a
query or a mutation; a method called `read` may mark state as read.

## Review a tool before exposing it

A composable tool should normally satisfy all of these:

1. No externally visible side effect.
2. Safe if guest execution times out after the call starts.
3. Safe under bounded parallel calls.
4. Bounded latency and output size.
5. No human elicitation, notification, payment, deploy, retry, or lifecycle
   transition.
6. Server rechecks user authorization on every call.
7. Returned data is appropriate for model context.

Read-only does not automatically mean cheap or non-sensitive. Logs, email,
internal documents, and broad searches may still need narrower arguments,
result limits, or metadata-only auditing.

## Keep downstream enforcement

`expose` is defense in depth. It does not replace:

- authentication;
- per-user authorization;
- input/output validation;
- idempotency keys;
- cancellation contracts;
- server-side quotas.

The wrapper calls your existing dispatcher. That dispatcher remains the final
authority.

## Use `unsafeExposeAll` only for static trusted fixtures

```ts
wrapServer(server, toolkit, {
  unsafeExposeAll: true,
});
```

This is intentionally verbose. It means every catalog tool except
`keepNative` is executable, including tools added later. Do not use it for
third-party, federated, or changing catalogs.

## Audit without duplicating sensitive data

The default is:

```ts
audit: 'metadata';
```

Each child record contains method, status, and timing. Use `audit: 'full'` only
when arguments/results are non-sensitive and their additional context cost is
acceptable.

## Bound amplification

Start with the defaults, then lower them for expensive backends:

```ts
limits: {
  maxToolCalls: 20,
  maxConcurrentCalls: 4,
  maxCodeBytes: 32 * 1024,
  maxLogBytes: 16 * 1024,
  maxResultBytes: 256 * 1024,
}
```

These limits bound one guest execution. Add a server-level queue or semaphore
to bound simultaneous executions across requests.

## Treat timeout correctly

A timeout terminates the guest worker. It does not cancel a downstream promise
that already crossed into your dispatcher. Keep non-idempotent operations
native unless the downstream API supplies reliable cancellation or idempotency.
