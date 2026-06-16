import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function main() {
const work = mkdtempSync(join(tmpdir(), 'mcp-code-mode-consumer-'));

try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const tarball = join(work, packed[0].filename);
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'packed-consumer-proof', private: true, type: 'module' }, null, 2),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `file:${tarball}`,
      '@modelcontextprotocol/sdk@1.29.0',
    ],
    { cwd: work, stdio: 'pipe' },
  );

  writeFileSync(join(work, 'server.mjs'), serverSource);
  writeFileSync(join(work, 'proof.mjs'), clientSource);
  const output = execFileSync('node', ['proof.mjs'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PROOF_CWD: work },
  });
  const result = JSON.parse(output);
  if (result.ok !== true) throw new Error(`consumer proof returned ${output}`);
  console.log(`Packed stdio consumer passed: ${result.visibleTools.join(', ')}`);
} finally {
  if (process.env.KEEP_PACKED_CONSUMER !== '1') rmSync(work, { recursive: true, force: true });
  else console.log(`Packed consumer retained at ${work}`);
}
}

const serverSource = String.raw`
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { wrapServer } from 'mcp-code-mode';

const memories = [];
const catalog = [
  { name: 'recall', description: 'Search remembered project facts.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'inbox', description: 'Read agent messages.', inputSchema: { type: 'object', properties: {} } },
  { name: 'remember', description: 'Persist a project fact.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const toolkit = {
  listTools: async () => catalog,
  callTool: async (name, args) => {
    if (name === 'recall') return ok({ hits: memories.filter((text) => text.includes(String(args.query))) });
    if (name === 'inbox') return ok({ messages: [] });
    if (name === 'remember') { memories.push(String(args.text)); return ok({ stored: true }); }
    return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  },
};
const server = new Server({ name: 'packed-consumer', version: '0.0.1' }, { capabilities: { tools: {} } });
wrapServer(server, toolkit, {
  expose: ['recall', 'inbox'],
  keepNative: ['remember'],
  limits: { maxToolCalls: 4, maxConcurrentCalls: 2 },
  executeTool: { defaultTimeoutMs: 500, maxTimeoutMs: 1000 },
});
await server.connect(new StdioServerTransport());
`;

const clientSource = String.raw`
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const assert = (condition, message, detail) => { if (!condition) throw new Error(message + ': ' + JSON.stringify(detail)); };
const client = new Client({ name: 'packed-proof', version: '0.0.1' });
const transport = new StdioClientTransport({ command: 'node', args: ['server.mjs'], cwd: process.env.PROOF_CWD, stderr: 'pipe' });
try {
  await client.connect(transport);
  const visibleTools = (await client.listTools()).tools.map((tool) => tool.name);
  assert(JSON.stringify(visibleTools) === JSON.stringify(['search', 'execute', 'remember']), 'wrong visible catalog', visibleTools);
  const search = await client.callTool({ name: 'search', arguments: { query: 'project memory' } });
  assert(search.structuredContent.tools.some((tool) => tool.name === 'recall'), 'recall not discovered', search);
  await client.callTool({ name: 'remember', arguments: { text: 'packed consumer proof' } });
  const execution = await client.callTool({ name: 'execute', arguments: { code: "const r=await tools.recall({query:'packed'}); const i=await tools.inbox({}); return {r,i};" } });
  assert(execution.isError === false && execution.structuredContent.value.r.hits.length === 1, 'composition failed', execution);
  assert(execution.structuredContent.calls.every((call) => !('args' in call) && !('result' in call)), 'audit leaked payloads', execution);
  const denied = await client.callTool({ name: 'execute', arguments: { code: "return tools.remember({text:'denied'});" } });
  assert(denied.isError === true, 'native mutation available in guest', denied);
  const timeout = await client.callTool({ name: 'execute', arguments: { code: 'while(true){}', timeout_ms: 100 } });
  assert(timeout.isError === true && timeout.structuredContent.timedOut === true, 'timeout failed', timeout);
  console.log(JSON.stringify({ ok: true, visibleTools }));
} finally {
  await client.close();
}
`;

await main();
