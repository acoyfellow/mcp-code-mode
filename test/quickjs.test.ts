import { expect, test } from "bun:test";
import { createQuickJSSandbox } from "../src/sandbox/quickjs.js";

test("QuickJS bridges tools, captures logs, and returns a value", async () => {
	const sandbox = await createQuickJSSandbox();
	const result = await sandbox.run({
		code: `
			const result = await tools.add({ a: 20, b: 22 });
			console.log("sum", result.sum);
			return result.sum;
		`,
		timeoutMs: 2_000,
		expose: ["add"],
		invoke: async (_name, args) => ({ sum: Number(args.a) + Number(args.b) }),
	});

	expect(result.error).toBeUndefined();
	expect(result.value).toBe(42);
	expect(result.logs).toEqual(["sum 42"]);
	expect(result.calls.map((call) => call.tool)).toEqual(["add"]);
});

test("QuickJS classifies execution time limits as timeouts", async () => {
	const sandbox = await createQuickJSSandbox();
	const result = await sandbox.run({
		code: `while (true) {}`,
		timeoutMs: 100,
		expose: [],
		invoke: async () => undefined,
	});

	expect(result.timedOut).toBe(true);
	expect(result.error?.message).toMatch(/time/i);
});

test("QuickJS does not expose Node or network globals", async () => {
	const sandbox = await createQuickJSSandbox();
	const result = await sandbox.run({
		code: `return {
			process: typeof process,
			require: typeof require,
			fetch: typeof fetch,
			Buffer: typeof Buffer,
		};`,
		timeoutMs: 2_000,
		expose: [],
		invoke: async () => undefined,
	});

	expect(result.value).toEqual({
		process: "undefined",
		require: "undefined",
		fetch: "undefined",
		Buffer: "undefined",
	});
});
