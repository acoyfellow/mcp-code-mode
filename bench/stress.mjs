import { performance } from 'node:perf_hooks';
import { createWorkerSandbox, searchCatalog } from '../dist/index.js';
import { createQuickJSSandbox } from '../dist/sandbox/quickjs.js';

const worker = createWorkerSandbox();
const metrics = [];

async function measure(name, run) {
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const detail = await run();
  const durationMs = performance.now() - started;
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
  const metric = { name, durationMs: round(durationMs), rssDeltaMb: round(rssDeltaMb), ...detail };
  metrics.push(metric);
  console.log(metric);
}

const execute = (code, expose, invoke, timeoutMs = 30_000) =>
  worker.run({ code, expose, invoke, timeoutMs });

await measure('worker: 250 sequential calls', async () => {
  const result = await execute(
    'let n=0; for(let i=0;i<250;i++) n=(await tools.inc({n})).n; return n;',
    ['inc'],
    async (_tool, args) => ({ n: Number(args.n) + 1 }),
  );
  assert(result.value === 250 && result.calls.length === 250, result);
  return { calls: result.calls.length };
});

await measure('worker: 250 parallel calls', async () => {
  const result = await execute(
    'const xs=await Promise.all(Array.from({length:250},(_,i)=>tools.square({n:i}))); return xs.length;',
    ['square'],
    async (_tool, args) => ({ n: Number(args.n) ** 2 }),
  );
  assert(result.value === 250 && result.calls.length === 250, result);
  return { calls: result.calls.length };
});

const concurrentExecutions = Number(process.env.STRESS_CONCURRENCY ?? 50);
await measure(`worker: ${concurrentExecutions} concurrent executions`, async () => {
  const results = await Promise.all(
    Array.from({ length: concurrentExecutions }, () =>
      execute(
        'return (await Promise.all(Array.from({length:20},(_,i)=>tools.echo({i})))).length;',
        ['echo'],
        async (_tool, args) => args,
      ),
    ),
  );
  const calls = results.reduce((total, result) => total + result.calls.length, 0);
  assert(results.every((result) => result.value === 20) && calls === concurrentExecutions * 20, results[0]);
  return { executions: results.length, calls };
});

await measure('search: 10k catalog x 100 queries', async () => {
  const catalog = Array.from({ length: 10_000 }, (_, index) => ({
    name: `namespace_${index}_get_project_issue_comments`,
    description: `Fetch project issue comments page ${index}`,
  }));
  let hits = 0;
  for (let index = 0; index < 100; index++) {
    hits += searchCatalog(catalog, 'find project issue comments', 10).length;
  }
  assert(hits === 1_000, { hits });
  return { catalog: catalog.length, queries: 100, hits };
});

await measure('worker: timeout does not cancel an in-flight call', async () => {
  let completed = false;
  const result = await execute(
    'return tools.slow({});',
    ['slow'],
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      completed = true;
      return { ok: true };
    },
    100,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(result.timedOut && completed, { result, completed });
  return { timedOut: result.timedOut, downstreamCallCompleted: completed };
});

const quickjs = await createQuickJSSandbox();
await measure('quickjs: 25 concurrent executions', async () => {
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      quickjs.run({
        code: `return ${index} + 1;`,
        expose: [],
        invoke: async () => undefined,
        timeoutMs: 2_000,
      }),
    ),
  );
  assert(results.every((result, index) => result.value === index + 1), results[0]);
  return { executions: results.length };
});

console.log(JSON.stringify({ runtime: process.version, metrics }, null, 2));

function assert(condition, detail) {
  if (!condition) throw new Error(`Stress assertion failed: ${JSON.stringify(detail)}`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
