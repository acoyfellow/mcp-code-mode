import { toJsonCompatible } from "./json.js";
import { searchCatalog } from "./search.js";
import type {
	ExposeFilter,
	Sandbox,
	SearchHandler,
	ToolCallResult,
	ToolSchema,
	WithCodeModeOptions,
} from "./types.js";

export interface CodeModeInputs {
	listTools: () => Promise<ToolSchema[]>;
	callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface CodeModeHandlers {
	listTools: () => Promise<{ tools: ToolSchema[] }>;
	callTool: (req: {
		params: { name: string; arguments?: Record<string, unknown> };
	}) => Promise<ToolCallResult>;
}

export interface WrapInputs extends CodeModeInputs {
	register: (handlers: CodeModeHandlers) => void;
}

export type CoreCodeModeOptions = WithCodeModeOptions & { sandbox: Sandbox };

const DEFAULTS = {
	searchName: "search",
	searchDescription:
		"Search this server's tool catalog by keyword. Returns matching tool schemas you can then call inside `execute()` as `tools.<name>(args)`.",
	executeName: "execute",
	executeDescription:
		"Run JavaScript in an isolated sandbox. Underlying tools are reachable as `await tools.<name>(args)`. The return value of your top-level expression is sent back. `console.log` output is captured. No network, fs, or process access.",
	defaultTimeoutMs: 15_000,
	maxTimeoutMs: 60_000,
};

/**
 * Build code-mode handlers without importing Node or the MCP SDK. Supply a
 * sandbox appropriate to the host: Worker Loader, QuickJS, Deno, or another
 * implementation of the structural Sandbox interface.
 */
export function createCodeMode(
	inputs: CodeModeInputs,
	options: CoreCodeModeOptions,
): CodeModeHandlers {
	const sandbox = options.sandbox;
	const keepNative = new Set(options.keepNative ?? []);
	const exposeFilter = makeExposeFilter(options.expose, keepNative);

	const searchName = options.searchTool?.name ?? DEFAULTS.searchName;
	const executeName = options.executeTool?.name ?? DEFAULTS.executeName;
	if (searchName === executeName) {
		throw new Error(`search and execute tools must have different names (both are '${searchName}').`);
	}
	const searchHandler = options.searchTool?.handler ?? searchCatalog;
	const executeDefault = options.executeTool?.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs;
	const executeMax = options.executeTool?.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs;

	const searchTool: ToolSchema = {
		name: searchName,
		description: options.searchTool?.description ?? DEFAULTS.searchDescription,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keywords to match against tool names + descriptions." },
				limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
			},
			required: ["query"],
		},
	};

	const executeTool: ToolSchema = {
		name: executeName,
		description: options.executeTool?.description ?? DEFAULTS.executeDescription,
		inputSchema: {
			type: "object",
			properties: {
				code: {
					type: "string",
					description:
						"JavaScript to run. Use `await tools.<name>(args)`. Top-level await ok. Return a value to send back.",
				},
				timeout_ms: { type: "integer", default: executeDefault, minimum: 100, maximum: executeMax },
			},
			required: ["code"],
		},
	};

	return {
		async listTools() {
			const all = await inputs.listTools();
			assertNoSyntheticCollisions(all, searchName, executeName);
			const native = all.filter((tool) => keepNative.has(tool.name));
			return { tools: [searchTool, executeTool, ...native] };
		},
		async callTool(req) {
			const { name, arguments: args = {} } = req.params;
			if (name === searchName) {
				return handleSearch(inputs, exposeFilter, searchHandler, searchName, executeName, args);
			}
			if (name === executeName) {
				return handleExecute(
					inputs,
					sandbox,
					exposeFilter,
					searchName,
					executeName,
					executeDefault,
					executeMax,
					options.audit ?? "full",
					args,
				);
			}
			if (keepNative.has(name)) return inputs.callTool(name, args);
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Unknown tool '${name}'. This server is in code-mode — call '${searchName}' to discover composable tools and '${executeName}' to use them.`,
					},
				],
			};
		},
	};
}

export function withCodeModeCore(inputs: WrapInputs, options: CoreCodeModeOptions): void {
	inputs.register(createCodeMode(inputs, options));
}

function makeExposeFilter(
	expose: ExposeFilter | undefined,
	keepNative: Set<string>,
): (name: string) => boolean {
	if (!expose) return (name) => !keepNative.has(name);
	if (Array.isArray(expose)) {
		const set = new Set(expose);
		return (name) => set.has(name) && !keepNative.has(name);
	}
	return (name) => expose(name) && !keepNative.has(name);
}

async function handleSearch(
	inputs: CodeModeInputs,
	exposeFilter: (name: string) => boolean,
	searchHandler: SearchHandler,
	searchName: string,
	executeName: string,
	args: Record<string, unknown>,
): Promise<ToolCallResult> {
	const query = String(args.query ?? "");
	const rawLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 10;
	const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 50);
	const all = await inputs.listTools();
	assertNoSyntheticCollisions(all, searchName, executeName);
	const pool = all.filter((tool) => exposeFilter(tool.name));
	const hits = await searchHandler(pool, query, limit);
	return {
		structuredContent: { tools: hits, total: pool.length },
		content: [
			{
				type: "text",
				text: hits.length
					? `Found ${hits.length} of ${pool.length} tool(s):\n\n${hits.map((tool) => `- ${tool.name}\n  ${tool.description ?? ""}`).join("\n\n")}`
					: `No tools matched '${query}'. ${pool.length} tools available; try a broader query.`,
			},
		],
	};
}

async function handleExecute(
	inputs: CodeModeInputs,
	sandbox: Sandbox,
	exposeFilter: (name: string) => boolean,
	searchName: string,
	executeName: string,
	defaultTimeout: number,
	maxTimeout: number,
	audit: "full" | "metadata",
	args: Record<string, unknown>,
): Promise<ToolCallResult> {
	const code = String(args.code ?? "");
	const rawTimeout = typeof args.timeout_ms === "number" ? args.timeout_ms : defaultTimeout;
	const timeoutMs = Math.min(Math.max(rawTimeout, 100), maxTimeout);

	const all = await inputs.listTools();
	assertNoSyntheticCollisions(all, searchName, executeName);
	const expose = all.filter((tool) => exposeFilter(tool.name)).map((tool) => tool.name);

	let result = await sandbox.run({
		code,
		timeoutMs,
		expose,
		invoke: async (tool, callArgs) => {
			if (!exposeFilter(tool)) throw new Error(`Tool '${tool}' is not exposed inside execute().`);
			const response = await inputs.callTool(tool, callArgs);
			if (response.isError) {
				const text = response.content?.find((item) => item.type === "text")?.text ?? "tool returned isError";
				throw new Error(text);
			}
			return response.structuredContent ?? response.content;
		},
	});

	try {
		result.value = toJsonCompatible(result.value, "execute return value");
		result.calls = result.calls.map((call) => ({
			...call,
			args: toJsonCompatible(call.args, `arguments for tool '${call.tool}'`) as Record<string, unknown>,
			result: toJsonCompatible(call.result, `result from tool '${call.tool}'`),
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = {
			logs: result.logs.map(String),
			calls: [],
			timedOut: result.timedOut,
			error: { message },
			durationMs: result.durationMs,
		};
	}

	const calls = audit === "metadata"
		? result.calls.map(({ tool, error, startedAt, durationMs }) => ({
			tool,
			error,
			startedAt,
			durationMs,
		}))
		: result.calls;

	const summary: string[] = [];
	if (result.error) summary.push(`ERROR: ${result.error.message}`);
	if (result.timedOut) summary.push(`TIMED OUT after ${timeoutMs}ms`);
	if (result.logs.length) summary.push(`--- console ---\n${result.logs.join("\n")}`);
	if (calls.length) {
		summary.push(
			`--- tool calls (${calls.length}) ---\n${calls
				.map((call) => {
					const argumentsSummary = "args" in call ? `(${shortJson(call.args)})` : "";
					return `${call.tool}${argumentsSummary} -> ${call.error ? `ERR ${call.error}` : "ok"} [${call.durationMs}ms]`;
				})
				.join("\n")}`,
		);
	}
	summary.push(`--- value ---\n${stringify(result.value)}`);

	return {
		isError: Boolean(result.error || result.timedOut),
		structuredContent: {
			value: result.value,
			logs: result.logs,
			calls,
			error: result.error,
			timedOut: result.timedOut,
			durationMs: result.durationMs,
		},
		content: [{ type: "text", text: summary.join("\n\n") }],
	};
}

function assertNoSyntheticCollisions(
	catalog: ToolSchema[],
	searchName: string,
	executeName: string,
): void {
	const collision = catalog.find((tool) => tool.name === searchName || tool.name === executeName);
	if (collision) {
		throw new Error(
			`Underlying tool '${collision.name}' collides with a synthetic code-mode tool. ` +
				"Rename the synthetic tool with searchTool.name or executeTool.name.",
		);
	}
}

function stringify(value: unknown): string {
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function shortJson(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized.length > 60 ? `${serialized.slice(0, 57)}...` : serialized;
	} catch {
		return "<unserializable>";
	}
}
