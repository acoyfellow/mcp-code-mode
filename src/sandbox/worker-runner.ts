/**
 * Runs inside a disposable worker thread. User code executes in a contextified
 * VM while tool calls cross a JSON-only MessagePort bridge to the parent.
 *
 * No host-realm function or object remains reachable when user code starts.
 * VM-realm wrappers capture one bridge function, remove it from globalThis,
 * serialize arguments before crossing out, and parse results back into VM-realm
 * objects. The outer worker still provides the hard wall-clock timeout.
 *
 * Node's vm module remains defense-in-depth rather than a hardened hostile-code
 * boundary. Use QuickJS for code supplied by an untrusted principal.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createContext, Script } from "node:vm";

type CallId = number;
let nextCallId: CallId = 1;
const pending = new Map<CallId, (responseJson: string) => void>();

if (!parentPort) throw new Error("worker-runner started without a parentPort");

const port = parentPort;
const { code, expose } = workerData as { code: string; expose: string[] };

port.on("message", (msg: { kind: string; id: CallId; ok: boolean; value?: unknown; error?: string }) => {
	if (msg.kind !== "call-result") return;
	const resolve = pending.get(msg.id);
	if (!resolve) return;
	pending.delete(msg.id);
	resolve(JSON.stringify(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error }));
});

function hostBridge(kind: string, nameOrLine: string, argsJson?: string): Promise<string> | undefined {
	if (kind === "log") {
		port.postMessage({ kind: "log", line: nameOrLine });
		return undefined;
	}
	if (kind !== "call") throw new Error(`Unknown bridge operation '${kind}'.`);
	return new Promise((resolve) => {
		const id = nextCallId++;
		pending.set(id, resolve);
		port.postMessage({
			kind: "call",
			id,
			tool: nameOrLine,
			args: JSON.parse(argsJson ?? "{}"),
		});
	});
}

const context = createContext(
	{ __hostBridge: hostBridge },
	{
		name: "mcp-code-mode",
		codeGeneration: { strings: false, wasm: false },
	},
);

const setup = new Script(
	`(() => {
		const bridge = globalThis.__hostBridge;
		delete globalThis.__hostBridge;

		const safeStringify = (value) => {
			if (typeof value === "string") return value;
			try { return JSON.stringify(value); }
			catch { return String(value); }
		};

		const tools = Object.create(null);
		for (const name of ${JSON.stringify(expose)}) {
			Object.defineProperty(tools, name, {
				enumerable: true,
				value: async (args = {}) => {
					let argsJson;
					try { argsJson = JSON.stringify(args); }
					catch (error) { throw new Error("Tool arguments must be JSON-compatible: " + error.message); }
					const response = JSON.parse(await bridge("call", name, argsJson));
					if (!response.ok) throw new Error(response.error ?? "tool call failed");
					return response.value;
				},
			});
		}
		Object.freeze(tools);

		const writeLog = (prefix, args) => {
			const line = prefix + args.map(safeStringify).join(" ");
			bridge("log", line);
		};
		const sandboxConsole = Object.freeze({
			log: (...args) => writeLog("", args),
			info: (...args) => writeLog("", args),
			warn: (...args) => writeLog("[warn] ", args),
			error: (...args) => writeLog("[error] ", args),
		});

		Object.defineProperties(globalThis, {
			tools: { value: tools, writable: false, configurable: false },
			console: { value: sandboxConsole, writable: false, configurable: false },
		});
	})();`,
	{ filename: "mcp-code-mode.setup.js" },
);
setup.runInContext(context);

(async () => {
	try {
		const script = new Script(`(async () => {\n${code}\n})()`, {
			filename: "mcp-code-mode.execute.js",
		});
		const value = await script.runInContext(context);
		port.postMessage({ kind: "done", value });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		port.postMessage({ kind: "error", message, stack });
	}
})();
