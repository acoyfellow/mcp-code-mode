import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function main() {
const work = mkdtempSync(join(tmpdir(), 'mcp-code-mode-firestore-'));

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }));
  const tarball = join(work, packed[0].filename);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'firestore-code-mode-proof', private: true, type: 'module' }, null, 2));
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund',
    `file:${tarball}`,
    '@modelcontextprotocol/sdk@1.29.0',
    'firestore-mcp-kit@0.1.0',
    'zod@4.3.6',
  ], { cwd: work, stdio: 'pipe' });
  writeFileSync(join(work, 'server.mjs'), serverSource);
  writeFileSync(join(work, 'proof.mjs'), clientSource);
  const output = execFileSync('node', ['proof.mjs'], { cwd: work, encoding: 'utf8' });
  const result = JSON.parse(output);
  if (result.ok !== true) throw new Error(`Firestore consumer proof returned ${output}`);
  console.log(`Firestore MCP Kit consumer passed: ${result.visibleTools.join(', ')}`);
} finally {
  if (process.env.KEEP_FIRESTORE_CONSUMER !== '1') rmSync(work, { recursive: true, force: true });
  else console.log(`Firestore consumer retained at ${work}`);
}
}

const serverSource = String.raw`
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFirestoreResource, defineTool, executeTool, getDocument, setDocument, updateDocument } from 'firestore-mcp-kit';
import { z } from 'zod';
import { wrapServer } from 'mcp-code-mode';

const values = new Map();
const firestore = { doc(path) { return { path, async get() { return { id: path.split('/').at(-1) ?? '', exists: values.has(path), data: () => values.get(path) }; }, async set(value) { values.set(path, value); }, async update(value) { values.set(path, { ...(values.get(path) ?? {}), ...value }); }, async delete() { values.delete(path); } }; } };
const resource = createFirestoreResource(firestore, (id) => 'notes/' + id);
const Note = z.object({ id: z.string(), title: z.string(), body: z.string() });
const NoteId = z.object({ id: z.string().min(1) });
const Update = z.object({ id: z.string().min(1), title: z.string().min(1) });
let canWrite = true;
const tools = [
  defineTool({ name: 'notes.create', description: 'Create a note.', inputSchema: Note, outputSchema: Note, authorize: () => canWrite, async execute({ input }) { await setDocument(resource, input.id, input); return input; } }),
  defineTool({ name: 'notes.get', description: 'Get a note.', inputSchema: NoteId, outputSchema: Note.nullable(), execute: ({ input }) => getDocument(resource, input.id) }),
  defineTool({ name: 'notes.exists', description: 'Check a note.', inputSchema: NoteId, outputSchema: z.object({ exists: z.boolean() }), async execute({ input }) { return { exists: (await getDocument(resource, input.id)) !== null }; } }),
  defineTool({ name: 'notes.update', description: 'Update a note.', inputSchema: Update, outputSchema: Note, authorize: () => canWrite, async execute({ input }) { const current=await getDocument(resource,input.id); if(!current) throw new Error('not found'); const next={...current,title:input.title}; await updateDocument(resource,input.id,next); return next; } }),
];
const catalog = tools.map((definition) => ({ name: definition.name, description: definition.description, inputSchema: z.toJSONSchema(definition.inputSchema) }));
const callTool = async (name, args) => { const definition=tools.find((tool)=>tool.name===name); if(!definition) return {isError:true,content:[{type:'text',text:'unknown'}]}; try { const result=await executeTool(definition,{context:{},input:args}); return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}; } catch(error) { return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:String(error)}]}; } };
const server = new Server({name:'firestore-code-mode-proof',version:'0.0.1'},{capabilities:{tools:{}}});
wrapServer(server,{listTools:async()=>catalog,callTool},{expose:['notes.get','notes.exists'],keepNative:['notes.create','notes.update'],audit:'metadata'},{ListToolsRequestSchema,CallToolRequestSchema});
await server.connect(new StdioServerTransport());
`;

const clientSource = String.raw`
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const assert=(condition,message,detail)=>{if(!condition)throw new Error(message+': '+JSON.stringify(detail));};
const client=new Client({name:'firestore-proof',version:'0.0.1'});
const transport=new StdioClientTransport({command:'node',args:['server.mjs'],cwd:process.cwd(),stderr:'pipe'});
try {
 await client.connect(transport);
 const visibleTools=(await client.listTools()).tools.map((tool)=>tool.name);
 assert(JSON.stringify(visibleTools)===JSON.stringify(['search','execute','notes.create','notes.update']),'wrong catalog',visibleTools);
 const created=await client.callTool({name:'notes.create',arguments:{id:'proof',title:'Code Mode',body:'Firestore consumer'}}); assert(created.isError!==true,'create failed',created);
 const execution=await client.callTool({name:'execute',arguments:{code:"const [note,status]=await Promise.all([tools['notes.get']({id:'proof'}),tools['notes.exists']({id:'proof'})]); return {title:note.title,exists:status.exists};"}});
 assert(execution.isError===false&&execution.structuredContent.value.title==='Code Mode'&&execution.structuredContent.value.exists===true,'read composition failed',execution);
 assert(execution.structuredContent.calls.length===2&&execution.structuredContent.calls.every((call)=>!('args'in call)&&!('result'in call)),'metadata audit failed',execution);
 const guestWrite=await client.callTool({name:'execute',arguments:{code:"return tools['notes.update']({id:'proof',title:'denied'});"}}); assert(guestWrite.isError===true,'guest write available',guestWrite);
 const invalid=await client.callTool({name:'execute',arguments:{code:"return tools['notes.get']({id:''});"}}); assert(invalid.isError===true&&invalid.structuredContent.calls[0].error.includes('Invalid tool input'),'validation missing',invalid);
 console.log(JSON.stringify({ok:true,visibleTools}));
} finally { await client.close(); }
`;

await main();
