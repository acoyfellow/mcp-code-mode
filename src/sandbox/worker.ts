import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { toJsonCompatible } from "../json.js";
import type {
	Sandbox,
	SandboxCallRecord,
	SandboxResult,
	SandboxRunOptions,
} from "../types.js";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "./worker-runner.js");

/**
 * Disposable worker + contextified VM sandbox. No native dependencies.
 *
 * The VM removes ambient Node/network globals and disables string/WASM code
 * generation. The outer worker supplies a hard wall-clock timeout. Node's VM is
 * defense-in-depth rather than a hardened hostile-code boundary; use QuickJS
 * when the code author is an untrusted principal.
 */
export function createWorkerSandbox(): Sandbox {
	return {
		name: "worker_threads",
		run(options: SandboxRunOptions): Promise<SandboxResult> {
			return runInWorker(options);
		},
	};
}

function runInWorker(options: SandboxRunOptions): Promise<SandboxResult> {
	return new Promise((resolvePromise) => {
		const startedAt = Date.now();
		const logs: string[] = [];
		const calls: SandboxCallRecord[] = [];
		let settled = false;

		const worker = new Worker(RUNNER, {
			workerData: { code: options.code, expose: options.expose },
			stdout: true,
			stderr: true,
		});

		const finishError = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.terminate().catch(() => {});
			resolvePromise({
				logs,
				calls,
				timedOut: false,
				error: { message: error.message, stack: error.stack },
				durationMs: Date.now() - startedAt,
			});
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			worker.terminate().catch(() => {});
			resolvePromise({
				logs,
				calls,
				timedOut: true,
				error: { message: `sandbox timed out after ${options.timeoutMs}ms` },
				durationMs: Date.now() - startedAt,
			});
		}, options.timeoutMs);

		worker.on("message", async (msg: WorkerMessage) => {
			if (msg.kind === "log") {
				logs.push(msg.line);
				return;
			}
			if (msg.kind === "call") {
				const callStart = Date.now();
				let safeArgs: Record<string, unknown> = {};
				try {
					safeArgs = toJsonCompatible(
						msg.args,
						`arguments for tool '${msg.tool}'`,
					) as Record<string, unknown>;
					const invoked = await options.invoke(msg.tool, safeArgs);
					const result = toJsonCompatible(invoked, `result from tool '${msg.tool}'`);
					calls.push({
						tool: msg.tool,
						args: safeArgs,
						result,
						startedAt: callStart,
						durationMs: Date.now() - callStart,
					});
					try {
						worker.postMessage({ kind: "call-result", id: msg.id, ok: true, value: result });
					} catch (error) {
						finishError(error instanceof Error ? error : new Error(String(error)));
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					calls.push({
						tool: msg.tool,
						args: safeArgs,
						error: message,
						startedAt: callStart,
						durationMs: Date.now() - callStart,
					});
					try {
						worker.postMessage({ kind: "call-result", id: msg.id, ok: false, error: message });
					} catch (postError) {
						finishError(postError instanceof Error ? postError : new Error(String(postError)));
					}
				}
				return;
			}
			if (msg.kind === "done") {
				if (settled) return;
				let value: unknown;
				try {
					value = toJsonCompatible(msg.value, "execute return value");
				} catch (error) {
					finishError(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				settled = true;
				clearTimeout(timer);
				worker.terminate().catch(() => {});
				resolvePromise({
					value,
					logs,
					calls,
					timedOut: false,
					durationMs: Date.now() - startedAt,
				});
				return;
			}
			if (msg.kind === "error") {
				const error = new Error(msg.message);
				error.stack = msg.stack;
				finishError(error);
			}
		});

		worker.on("error", finishError);
		worker.on("exit", (code) => {
			if (!settled) finishError(new Error(`sandbox worker exited before returning a result (code ${code})`));
		});
	});
}

type WorkerMessage =
	| { kind: "log"; line: string }
	| { kind: "call"; id: number; tool: string; args: Record<string, unknown> }
	| { kind: "done"; value: unknown }
	| { kind: "error"; message: string; stack?: string };
