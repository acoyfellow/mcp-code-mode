/**
 * Runs inside a disposable worker thread. The user program executes in a
 * contextified VM with no Node globals, while the worker itself provides the
 * message bridge back to the parent.
 *
 * The outer worker is still important: terminating it gives us a hard wall-clock
 * timeout even for async code and infinite loops. The VM context removes ambient
 * process/fs/network access and disables string/WASM code generation.
 *
 * Node's vm module is defense-in-depth, not a hardened security boundary. Use
 * the QuickJS sandbox when executing code from an untrusted principal.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createContext, Script } from "node:vm";

type CallId = number;
let nextCallId: CallId = 1;
const pending = new Map<
	CallId,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

if (!parentPort) {
	throw new Error("worker-runner started without a parentPort");
}

const port = parentPort;
const { code, expose } = workerData as { code: string; expose: string[] };

port.on("message", (msg: { kind: string; id: CallId; ok: boolean; value?: unknown; error?: string }) => {
	if (msg.kind !== "call-result") return;
	const entry = pending.get(msg.id);
	if (!entry) return;
	pending.delete(msg.id);
	if (msg.ok) entry.resolve(msg.value);
	else entry.reject(new Error(msg.error ?? "tool call failed"));
});

function makeBridge(toolName: string) {
	return (args: Record<string, unknown> = {}) =>
		new Promise((resolve, reject) => {
			const id = nextCallId++;
			pending.set(id, { resolve, reject });
			port.postMessage({ kind: "call", id, tool: toolName, args });
		});
}

const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = Object.create(null);
for (const name of expose) tools[name] = makeBridge(name);
Object.freeze(tools);

const sandboxConsole = Object.freeze({
	log: (...args: unknown[]) => port.postMessage({ kind: "log", line: args.map(stringify).join(" ") }),
	info: (...args: unknown[]) => port.postMessage({ kind: "log", line: args.map(stringify).join(" ") }),
	warn: (...args: unknown[]) => port.postMessage({ kind: "log", line: `[warn] ${args.map(stringify).join(" ")}` }),
	error: (...args: unknown[]) => port.postMessage({ kind: "log", line: `[error] ${args.map(stringify).join(" ")}` }),
});

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

const context = createContext(
	{ tools, console: sandboxConsole },
	{
		name: "mcp-code-mode",
		codeGeneration: { strings: false, wasm: false },
	},
);

(async () => {
	try {
		const script = new Script(`(async () => {\n${code}\n})()`, {
			filename: "mcp-code-mode.execute.js",
		});
		const value = await script.runInContext(context);
		port.postMessage({ kind: "done", value });
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		port.postMessage({ kind: "error", message: error.message, stack: error.stack });
	}
})();
