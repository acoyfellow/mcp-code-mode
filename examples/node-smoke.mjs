import { withCodeMode } from '../dist/index.js';

const catalog = [
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object' },
  },
];

let handlers;
withCodeMode({
  listTools: async () => catalog,
  callTool: async (_name, args) => ({
    content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
    structuredContent: { sum: Number(args.a) + Number(args.b) },
  }),
  register: (value) => {
    handlers = value;
  },
}, {
  expose: ['add'],
});

const result = await handlers.callTool({
  params: {
    name: 'execute',
    arguments: {
      code: 'const result = await tools.add({ a: 20, b: 22 }); return result.sum;',
    },
  },
});

if (result.isError || result.structuredContent.value !== 42) {
  throw new Error(`Node smoke test failed: ${JSON.stringify(result)}`);
}

console.log('Node ESM smoke test passed: 20 + 22 = 42');
