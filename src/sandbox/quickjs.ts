import type { Sandbox, SandboxResult, SandboxRunOptions } from "../types.js";

/**
 * QuickJS-WASM sandbox via `@sebastianwessel/quickjs`. Optional dependency.
 *
 * Why you might want this over the worker_threads sandbox:
 *  - Hard memory limits (configurable, enforced by the engine).
 *  - Interrupt handler for CPU-bound code.
 *  - True absence of host APIs (no `Buffer`, `process`, or Node globals).
 *
 * Install the optional packages, then pass the returned sandbox to code mode:
 *
 *   bun add @sebastianwessel/quickjs @jitl/quickjs-ng-wasmfile-release-sync
 *
 *   import { createQuickJSSandbox } from "mcp-code-mode/sandbox/quickjs";
 *   withCodeMode(inputs, { sandbox: await createQuickJSSandbox() });
 */
export async function createQuickJSSandbox(): Promise<Sandbox> {
	let quickJS: typeof import("@sebastianwessel/quickjs");
	let variant: typeof import("@jitl/quickjs-ng-wasmfile-release-sync").default;
	try {
		quickJS = await import("@sebastianwessel/quickjs");
		variant = (await import("@jitl/quickjs-ng-wasmfile-release-sync")).default;
	} catch (err) {
		throw new Error(
			"createQuickJSSandbox() requires `@sebastianwessel/quickjs` and " +
				"`@jitl/quickjs-ng-wasmfile-release-sync`. Install them with " +
				"`bun add @sebastianwessel/quickjs @jitl/quickjs-ng-wasmfile-release-sync`.",
			{ cause: err },
		);
	}

	const { runSandboxed } = await quickJS.loadQuickJs(variant);

	return {
		name: "quickjs-wasm",
		async run(options: SandboxRunOptions): Promise<SandboxResult> {
			const startedAt = Date.now();
			const logs: string[] = [];
			const calls: SandboxResult["calls"] = [];

			const toolsBridge: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
			for (const name of options.expose) {
				toolsBridge[name] = async (args: Record<string, unknown> = {}) => {
					const callStart = Date.now();
					try {
						const value = await options.invoke(name, args);
						calls.push({
							tool: name,
							args,
							result: value,
							startedAt: callStart,
							durationMs: Date.now() - callStart,
						});
						return value;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						calls.push({
							tool: name,
							args,
							error: message,
							startedAt: callStart,
							durationMs: Date.now() - callStart,
						});
						throw new Error(message);
					}
				};
			}

			try {
				const result = await runSandboxed(
					async ({ evalCode }) =>
						evalCode(`
							const tools = env.tools;
							globalThis.env = undefined;
							globalThis.process = undefined;
							globalThis.Buffer = undefined;
							globalThis.fetch = undefined;
							export default await (async () => {
								${options.code}
							})();
						`),
					{
						env: { tools: toolsBridge },
						executionTimeout: options.timeoutMs,
						allowFetch: false,
						allowFs: false,
						console: {
							log: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
							info: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
							warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(stringify).join(" ")}`),
							error: (...args: unknown[]) => logs.push(`[error] ${args.map(stringify).join(" ")}`),
						},
					},
				);

				if (!result.ok) {
					const message = result.error?.message ?? "quickjs eval failed";
					return {
						logs,
						calls,
						timedOut: isTimeoutError(message),
						error: { message, stack: result.error?.stack },
						durationMs: Date.now() - startedAt,
					};
				}

				return {
					value: result.data,
					logs,
					calls,
					timedOut: false,
					durationMs: Date.now() - startedAt,
				};
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				return {
					logs,
					calls,
					timedOut: isTimeoutError(error.message),
					error: { message: error.message, stack: error.stack },
					durationMs: Date.now() - startedAt,
				};
			}
		},
	};
}

function isTimeoutError(message: string): boolean {
	return /timeout|timed out|time limit|interrupted|exceeded.*time/i.test(message);
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
