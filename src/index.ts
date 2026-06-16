/**
 * mcp-code-mode
 *
 * Wrap an MCP server so its `tools/list` returns just two synthetic tools:
 *
 *   search(query, limit?)   — keyword search over the underlying catalog
 *   execute(code, timeout?) — run JS in a sandbox; underlying tools are
 *                             reachable as `tools.<name>(args)` bindings
 *
 * Side-effectful tools you want the agent to call out explicitly stay
 * surfaced as top-level tools via `keepNative: [...]`.
 *
 * The transport-agnostic path does not import the MCP SDK at runtime. Supply
 * list/call/register functions to `withCodeMode()`, or use `wrapServer()` to
 * patch an MCP SDK Server's tools/list and tools/call handlers.
 */
import { createRequire } from "node:module";
import { searchCatalog } from "./search.js";
import { createWorkerSandbox } from "./sandbox/worker.js";
import type {
	ExposeFilter,
	SearchHandler,
	Sandbox,
	ToolCallResult,
	ToolInvoker,
	ToolSchema,
	WithCodeModeOptions,
} from "./types.js";

export type {
	ExposeFilter,
	SearchHandler,
	Sandbox,
	ToolCallResult,
	ToolInvoker,
	ToolSchema,
	WithCodeModeOptions,
} from "./types.js";
export { searchCatalog } from "./search.js";
export { createWorkerSandbox } from "./sandbox/worker.js";

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
 * Minimal structural type for an MCP-SDK Server. We type loosely so we don't
 * pin a specific SDK version.
 */
export interface McpServerLike {
	setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<unknown> | unknown): void;
}

/**
 * Optional structural "toolkit" the caller can hand us if they don't want to
 * give us the raw Server object. Useful for adapters / custom transports.
 */
export interface WrapInputs {
	listTools: () => Promise<ToolSchema[]>;
	callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
	/** Receives the patched handlers; you wire them up to your transport. */
	register: (handlers: {
		listTools: () => Promise<{ tools: ToolSchema[] }>;
		callTool: (req: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<ToolCallResult>;
	}) => void;
}

/**
 * Wrap a toolkit (list + call functions) and register the new handlers. This
 * is the runtime-agnostic path. For the SDK-Server convenience wrapper, see
 * `wrapServer` below.
 */
export function withCodeMode(inputs: WrapInputs, options: WithCodeModeOptions = {}): void {
	const sandbox: Sandbox = options.sandbox ?? createWorkerSandbox();
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
				code: { type: "string", description: "JavaScript to run. Use `await tools.<name>(args)`. Top-level await ok. Return a value to send back." },
				timeout_ms: { type: "integer", default: executeDefault, minimum: 100, maximum: executeMax },
			},
			required: ["code"],
		},
	};

	inputs.register({
		async listTools() {
			const all = await inputs.listTools();
			assertNoSyntheticCollisions(all, searchName, executeName);
			const native = all.filter((t) => keepNative.has(t.name));
			return { tools: [searchTool, executeTool, ...native] };
		},
		async callTool(req) {
			const { name, arguments: args = {} } = req.params;
			if (name === searchName) {
				return handleSearch(inputs, exposeFilter, searchHandler, searchName, executeName, args);
			}
			if (name === executeName) {
				return handleExecute(inputs, sandbox, exposeFilter, searchName, executeName, executeDefault, executeMax, args);
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
	});
}

/**
 * Convenience wrapper for users of `@modelcontextprotocol/sdk`. Patches the
 * Server's request handlers in-place. Returns the same Server for chaining.
 */
export function wrapServer<T extends McpServerLike>(
	server: T,
	toolkit: ToolInvoker,
	options: WithCodeModeOptions = {},
	schemas?: { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown },
): T {
	const { ListToolsRequestSchema, CallToolRequestSchema } = schemas ?? loadSchemas();

	withCodeMode(
		{
			listTools: toolkit.listTools.bind(toolkit),
			callTool: toolkit.callTool.bind(toolkit),
			register: (handlers) => {
				server.setRequestHandler(ListToolsRequestSchema, () => handlers.listTools());
				server.setRequestHandler(CallToolRequestSchema, (req: unknown) =>
					handlers.callTool(req as { params: { name: string; arguments?: Record<string, unknown> } }),
				);
			},
		},
		options,
	);

	return server;
}

function loadSchemas(): { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown } {
	try {
		// Keep the lower-level withCodeMode() path free of MCP SDK runtime imports.
		// createRequire works from ESM and loads the schemas only when wrapServer()
		// is actually used.
		const require = createRequire(import.meta.url);
		const types = require("@modelcontextprotocol/sdk/types.js");
		return {
			ListToolsRequestSchema: types.ListToolsRequestSchema,
			CallToolRequestSchema: types.CallToolRequestSchema,
		};
	} catch (err) {
		throw new Error(
			"wrapServer() needs `@modelcontextprotocol/sdk` installed, or pass `schemas` explicitly. " +
				"Either `bun add @modelcontextprotocol/sdk` or use the lower-level `withCodeMode()` directly.",
			{ cause: err },
		);
	}
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
	inputs: WrapInputs,
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
	const pool = all.filter((t) => exposeFilter(t.name));
	const hits = await searchHandler(pool, query, limit);
	return {
		structuredContent: { tools: hits, total: pool.length },
		content: [
			{
				type: "text",
				text: hits.length
					? `Found ${hits.length} of ${pool.length} tool(s):\n\n${hits.map((t) => `- ${t.name}\n  ${t.description ?? ""}`).join("\n\n")}`
					: `No tools matched '${query}'. ${pool.length} tools available; try a broader query.`,
			},
		],
	};
}

async function handleExecute(
	inputs: WrapInputs,
	sandbox: Sandbox,
	exposeFilter: (name: string) => boolean,
	searchName: string,
	executeName: string,
	defaultTimeout: number,
	maxTimeout: number,
	args: Record<string, unknown>,
): Promise<ToolCallResult> {
	const code = String(args.code ?? "");
	const rawTimeout = typeof args.timeout_ms === "number" ? args.timeout_ms : defaultTimeout;
	const timeoutMs = Math.min(Math.max(rawTimeout, 100), maxTimeout);

	const all = await inputs.listTools();
	assertNoSyntheticCollisions(all, searchName, executeName);
	const expose = all.filter((t) => exposeFilter(t.name)).map((t) => t.name);

	const result = await sandbox.run({
		code,
		timeoutMs,
		expose,
		invoke: async (tool, callArgs) => {
			if (!exposeFilter(tool)) throw new Error(`Tool '${tool}' is not exposed inside execute().`);
			const res = await inputs.callTool(tool, callArgs);
			if (res.isError) {
				const text = res.content?.find((c) => c.type === "text")?.text ?? "tool returned isError";
				throw new Error(text);
			}
			return res.structuredContent ?? res.content;
		},
	});

	const summary: string[] = [];
	if (result.error) summary.push(`ERROR: ${result.error.message}`);
	if (result.timedOut) summary.push(`TIMED OUT after ${timeoutMs}ms`);
	if (result.logs.length) summary.push(`--- console ---\n${result.logs.join("\n")}`);
	if (result.calls.length) {
		summary.push(
			`--- tool calls (${result.calls.length}) ---\n${result.calls
				.map((c) => `${c.tool}(${shortJson(c.args)}) -> ${c.error ? `ERR ${c.error}` : "ok"} [${c.durationMs}ms]`)
				.join("\n")}`,
		);
	}
	summary.push(`--- value ---\n${stringify(result.value)}`);

	return {
		isError: Boolean(result.error || result.timedOut),
		structuredContent: {
			value: result.value,
			logs: result.logs,
			calls: result.calls,
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
		const s = JSON.stringify(value);
		return s.length > 60 ? `${s.slice(0, 57)}...` : s;
	} catch {
		return "<unserializable>";
	}
}
