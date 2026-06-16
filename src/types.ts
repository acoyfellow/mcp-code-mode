/**
 * Shared types for mcp-code-mode.
 *
 * We deliberately keep these structural so the library does not have to import
 * the MCP SDK at runtime — the wrap function takes whatever Server-shaped
 * object the SDK gives you and threads it through.
 */

export interface ToolSchema {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface ToolCallResult {
	content: Array<{ type: string; text?: string; [k: string]: unknown }>;
	isError?: boolean;
	structuredContent?: unknown;
}

export interface ToolInvoker {
	listTools(): Promise<ToolSchema[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface SandboxCallRecord {
	tool: string;
	args: Record<string, unknown>;
	result?: unknown;
	error?: string;
	startedAt: number;
	durationMs: number;
}

export interface SandboxResult {
	value?: unknown;
	logs: string[];
	calls: SandboxCallRecord[];
	error?: { message: string; stack?: string };
	timedOut: boolean;
	durationMs: number;
}

export interface SandboxRunOptions {
	code: string;
	timeoutMs: number;
	maxLogBytes?: number;
	/** Tool names exposed inside the sandbox as `tools.<name>(args)`. */
	expose: string[];
	/** Bridge back to the parent process for `tools.*` calls. */
	invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface Sandbox {
	name: string;
	run(options: SandboxRunOptions): Promise<SandboxResult>;
}

export type ExposeFilter = string[] | ((toolName: string) => boolean);

export type SearchHandler = (
	catalog: ToolSchema[],
	query: string,
	limit: number,
) => ToolSchema[] | Promise<ToolSchema[]>;

export interface WithCodeModeOptions {
	/**
	 * Which underlying tools become bindings inside `execute()`'s `tools` object.
	 * Pass exact names or a predicate. Required unless `unsafeExposeAll` is true.
	 */
	expose?: ExposeFilter;

	/**
	 * Explicitly expose every underlying tool except `keepNative`. This is unsafe
	 * for changing or third-party catalogs and exists only for trusted servers.
	 */
	unsafeExposeAll?: boolean;

	/**
	 * Tools that should remain top-level on the wrapped server, visible to the
	 * agent as their own tool calls. Use this for side-effectful operations the
	 * agent should reason about explicitly (writes, deploys, payments).
	 */
	keepNative?: string[];

	/** Sandbox implementation. Defaults to the worker_threads sandbox. */
	sandbox?: Sandbox;

	/**
	 * Audit detail returned to the MCP client. `full` includes child arguments
	 * and results; `metadata` keeps only tool name, status, and timing.
	 * Defaults to `metadata`; opt into `full` only for non-sensitive tools.
	 */
	audit?: "full" | "metadata";

	/** Per-execution resource budgets. */
	limits?: {
		maxToolCalls?: number;
		maxConcurrentCalls?: number;
		maxCodeBytes?: number;
		maxLogBytes?: number;
		maxResultBytes?: number;
	};

	/** Override the synthetic `search` tool or replace its catalog ranker. */
	searchTool?: { name?: string; description?: string; handler?: SearchHandler };

	/** Override the synthetic `execute` tool. */
	executeTool?: {
		name?: string;
		description?: string;
		defaultTimeoutMs?: number;
		maxTimeoutMs?: number;
	};
}
