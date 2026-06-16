import { describe, expect, test } from "bun:test";
import { createWorkerSandbox, searchCatalog, withCodeMode } from "../src/index.js";
import type {
	ToolCallResult,
	ToolSchema,
	WithCodeModeOptions,
	WrapInputs,
} from "../src/index.js";

const tools: ToolSchema[] = [
	{
		name: "echo",
		description: "Echo text back.",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	{
		name: "add",
		description: "Add two numbers.",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
	},
	{
		name: "delete_record",
		description: "Delete a record.",
		inputSchema: { type: "object", properties: { id: { type: "string" } } },
	},
];

function ok(value: unknown): ToolCallResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function harness(options: WithCodeModeOptions = {}) {
	let handlers!: Parameters<WrapInputs["register"]>[0];
	withCodeMode(
		{
			listTools: async () => tools,
			callTool: async (name, args) => {
				if (name === "echo") return ok({ text: String(args.text) });
				if (name === "add") return ok({ sum: Number(args.a) + Number(args.b) });
				if (name === "delete_record") return ok({ deleted: String(args.id) });
				return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
			},
			register: (registered) => {
				handlers = registered;
			},
		},
		{ keepNative: ["delete_record"], ...options },
	);
	return handlers;
}

describe("searchCatalog", () => {
	test("splits namespaced tool names and normalizes simple plurals", () => {
		const catalog: ToolSchema[] = [
			{ name: "google-workspace-mcp_chat_search_messages" },
			{ name: "gitlab-mcp-server_get_job_log" },
		];
		expect(searchCatalog(catalog, "find chat messages", 5).map((tool) => tool.name)).toEqual([
			"google-workspace-mcp_chat_search_messages",
		]);
		expect(searchCatalog(catalog, "failed job logs", 5).map((tool) => tool.name)).toEqual([
			"gitlab-mcp-server_get_job_log",
		]);
	});
});

describe("withCodeMode", () => {
	test("collapses the catalog and keeps explicit tools native", async () => {
		const listed = await harness().listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual(["search", "execute", "delete_record"]);
	});

	test("search returns schemas only for exposed tools", async () => {
		const result = await harness().callTool({
			params: { name: "search", arguments: { query: "numbers" } },
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ tools: [tools[1]], total: 2 });
	});

	test("execute chains calls and returns an audit envelope", async () => {
		const result = await harness().callTool({
			params: {
				name: "execute",
				arguments: {
					code: `
						const echoed = await tools.echo({ text: "answer" });
						const added = await tools.add({ a: 20, b: 22 });
						console.log(echoed.text, added.sum);
						return { label: echoed.text, value: added.sum };
					`,
				},
			},
		});
		const envelope = result.structuredContent as {
			value: unknown;
			logs: string[];
			calls: Array<{ tool: string }>;
		};
		expect(result.isError).toBe(false);
		expect(envelope.value).toEqual({ label: "answer", value: 42 });
		expect(envelope.logs).toEqual(["answer 42"]);
		expect(envelope.calls.map((call) => call.tool)).toEqual(["echo", "add"]);
	});

	test("metadata audit omits child arguments and results", async () => {
		const result = await harness({ audit: "metadata" }).callTool({
			params: {
				name: "execute",
				arguments: { code: `return tools.add({ a: 20, b: 22 });` },
			},
		});
		const calls = (result.structuredContent as {
			calls: Array<Record<string, unknown>>;
		}).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tool: "add" });
		expect(calls[0]).not.toHaveProperty("args");
		expect(calls[0]).not.toHaveProperty("result");
	});

	test("kept-native tools cannot run inside execute", async () => {
		const result = await harness().callTool({
			params: {
				name: "execute",
				arguments: { code: `return tools.delete_record({ id: "1" });` },
			},
		});
		expect(result.isError).toBe(true);
		expect((result.structuredContent as { error: { message: string } }).error.message).toContain(
			"tools.delete_record is not a function",
		);
	});

	test("kept-native tools still run as top-level calls", async () => {
		const result = await harness().callTool({
			params: { name: "delete_record", arguments: { id: "1" } },
		});
		expect(result.structuredContent).toEqual({ deleted: "1" });
	});

	test("clamps search limits and supports a custom ranker", async () => {
		let receivedLimit = 0;
		let handlers!: Parameters<WrapInputs["register"]>[0];
		withCodeMode(
			{
				listTools: async () => tools,
				callTool: async () => ok({}),
				register: (registered) => {
					handlers = registered;
				},
			},
			{
				searchTool: {
					handler: (catalog, _query, limit) => {
						receivedLimit = limit;
						return catalog.slice(0, limit);
					},
				},
			},
		);
		await handlers.callTool({
			params: { name: "search", arguments: { query: "anything", limit: 999.9 } },
		});
		expect(receivedLimit).toBe(50);
	});

	test("rejects collisions with synthetic tool names", async () => {
		let handlers!: Parameters<WrapInputs["register"]>[0];
		withCodeMode({
			listTools: async () => [{ name: "execute", description: "A real underlying tool." }],
			callTool: async () => ok({}),
			register: (registered) => {
				handlers = registered;
			},
		});
		expect(handlers.listTools()).rejects.toThrow("collides with a synthetic code-mode tool");
	});
});

describe("worker sandbox", () => {
	test("does not expose ambient Node or network globals", async () => {
		const result = await createWorkerSandbox().run({
			code: `return {
				process: typeof process,
				require: typeof require,
				fetch: typeof fetch,
				Buffer: typeof Buffer,
				globalProcess: typeof globalThis.process,
			};`,
			timeoutMs: 1_000,
			expose: [],
			invoke: async () => undefined,
		});
		expect(result.value).toEqual({
			process: "undefined",
			require: "undefined",
			fetch: "undefined",
			Buffer: "undefined",
			globalProcess: "undefined",
		});
	});

	test("blocks VM and injected-capability constructor escapes", async () => {
		for (const code of [
			`return (() => {}).constructor("return process")();`,
			`return console.log.constructor("return process")();`,
			`return tools.echo.constructor("return process")();`,
			`const result = await tools.echo({}); return result.constructor.constructor("return process")();`,
		]) {
			const result = await createWorkerSandbox().run({
				code,
				timeoutMs: 1_000,
				expose: ["echo"],
				invoke: async () => ({ ok: true }),
			});
			expect(result.value).toBeUndefined();
			expect(result.error?.message).toMatch(/Code generation from strings disallowed|not a function/);
		}
	});

	test("rejects non-JSON tool results instead of hanging", async () => {
		const result = await createWorkerSandbox().run({
			code: `return tools.bad_result({});`,
			timeoutMs: 1_000,
			expose: ["bad_result"],
			invoke: async () => ({ value: 42n }),
		});
		expect(result.timedOut).toBe(false);
		expect(result.error?.message).toMatch(/JSON-compatible|BigInt/i);
	});

	test("rejects cyclic and BigInt execute return values", async () => {
		const cyclic = await createWorkerSandbox().run({
			code: `const value = {}; value.self = value; return value;`,
			timeoutMs: 1_000,
			expose: [],
			invoke: async () => undefined,
		});
		const bigint = await createWorkerSandbox().run({
			code: `return 42n;`,
			timeoutMs: 1_000,
			expose: [],
			invoke: async () => undefined,
		});
		expect(cyclic.error?.message).toContain("execute return value must be JSON-compatible");
		expect(bigint.error?.message).toContain("execute return value must be JSON-compatible");
	});

	test("terminates runaway code", async () => {
		const result = await createWorkerSandbox().run({
			code: "while (true) {}",
			timeoutMs: 100,
			expose: [],
			invoke: async () => undefined,
		});
		expect(result.timedOut).toBe(true);
	});
});
