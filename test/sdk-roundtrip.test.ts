import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { wrapServer } from "../src/index.js";
import type { ToolCallResult, ToolSchema } from "../src/index.js";

const catalog: ToolSchema[] = [
	{
		name: "multiply",
		description: "Multiply two numbers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

test("wrapServer completes a real MCP client/server round trip", async () => {
	const server = new Server(
		{ name: "code-mode-test", version: "0.0.1" },
		{ capabilities: { tools: {} } },
	);
	wrapServer(server, {
		listTools: async () => catalog,
		callTool: async (name, args): Promise<ToolCallResult> => {
			if (name === "multiply") {
				const value = { product: Number(args.a) * Number(args.b) };
				return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
			}
			return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
		},
	}, { expose: ["multiply"] });

	const client = new Client({ name: "code-mode-test-client", version: "0.0.1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual(["search", "execute"]);

		const searched = await client.callTool({ name: "search", arguments: { query: "multiply" } });
		expect(searched.isError).not.toBe(true);
		expect((searched.content as Array<{ type: string }>)[0]).toMatchObject({ type: "text" });

		const executed = await client.callTool({
			name: "execute",
			arguments: {
				code: `const value = await tools.multiply({ a: 6, b: 7 }); return value.product;`,
			},
		});
		expect(executed.isError).toBe(false);
		expect(executed.structuredContent).toMatchObject({ value: 42, timedOut: false });
	} finally {
		await client.close();
		await server.close();
	}
});
