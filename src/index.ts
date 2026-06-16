/**
 * Node/Bun entry point for mcp-code-mode.
 *
 * `withCodeMode()` defaults to the disposable worker_threads sandbox.
 * `wrapServer()` adapts an MCP SDK Server in place. Runtime-neutral hosts such
 * as Cloudflare Workers should import `mcp-code-mode/core` and supply their own
 * Sandbox implementation.
 */
import { createRequire } from "node:module";
import { withCodeModeCore } from "./core.js";
import type { WrapInputs } from "./core.js";
import { createWorkerSandbox } from "./sandbox/worker.js";
import type { ToolInvoker, WithCodeModeOptions } from "./types.js";

export type {
	CodeModeHandlers,
	CodeModeInputs,
	CoreCodeModeOptions,
	WrapInputs,
} from "./core.js";
export { createCodeMode, withCodeModeCore } from "./core.js";
export { searchCatalog } from "./search.js";
export { createWorkerSandbox } from "./sandbox/worker.js";
export type {
	ExposeFilter,
	Sandbox,
	SearchHandler,
	ToolCallResult,
	ToolInvoker,
	ToolSchema,
	WithCodeModeOptions,
} from "./types.js";

export interface McpServerLike {
	setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<unknown> | unknown): void;
}

/** Wrap transport-independent inputs with the default Node worker sandbox. */
export function withCodeMode(inputs: WrapInputs, options: WithCodeModeOptions = {}): void {
	withCodeModeCore(inputs, {
		...options,
		sandbox: options.sandbox ?? createWorkerSandbox(),
	});
}

/** Patch an MCP SDK Server's tools/list and tools/call handlers in place. */
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
					handlers.callTool(
						req as { params: { name: string; arguments?: Record<string, unknown> } },
					),
				);
			},
		},
		options,
	);

	return server;
}

function loadSchemas(): { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown } {
	try {
		const require = createRequire(import.meta.url);
		const types = require("@modelcontextprotocol/sdk/types.js");
		return {
			ListToolsRequestSchema: types.ListToolsRequestSchema,
			CallToolRequestSchema: types.CallToolRequestSchema,
		};
	} catch (error) {
		throw new Error(
			"wrapServer() needs `@modelcontextprotocol/sdk` installed, or pass `schemas` explicitly. " +
				"Either `bun add @modelcontextprotocol/sdk` or use `mcp-code-mode/core` directly.",
			{ cause: error },
		);
	}
}
