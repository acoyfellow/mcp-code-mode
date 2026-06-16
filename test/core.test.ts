import { describe, expect, test } from "bun:test";
import { createWorkerSandbox, withCodeMode } from "../src/index.js";
import type { ToolCallResult, ToolSchema, WrapInputs } from "../src/index.js";

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

function harness() {
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
		{ keepNative: ["delete_record"] },
	);
	return handlers;
}

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

	test("blocks Function-constructor escapes", async () => {
		const result = await createWorkerSandbox().run({
			code: `return (() => {}).constructor("return process")();`,
			timeoutMs: 1_000,
			expose: [],
			invoke: async () => undefined,
		});
		expect(result.error?.message).toContain("Code generation from strings disallowed");
	});

	test("reports uncloneable tool results instead of hanging", async () => {
		const result = await createWorkerSandbox().run({
			code: `return tools.bad_result({});`,
			timeoutMs: 1_000,
			expose: ["bad_result"],
			invoke: async () => ({ callback: () => undefined }),
		});
		expect(result.timedOut).toBe(false);
		expect(result.error?.message).toMatch(/clone|function/i);
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
