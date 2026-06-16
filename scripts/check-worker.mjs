import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/core.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});

const output = result.outputFiles[0]?.text ?? '';
if (!output) throw new Error('Worker-neutral core bundle was empty.');
if (/from\s+["']node:|require\(["']node:/.test(output)) {
  throw new Error('Worker-neutral core bundle contains a Node built-in import.');
}

console.log(`Worker-neutral core bundle passed: ${(Buffer.byteLength(output) / 1024).toFixed(1)} KB`);
