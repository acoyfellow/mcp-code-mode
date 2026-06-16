/**
 * Minimal end-to-end demo of mcp-code-mode without the SDK.
 *
 * We build a fake "server" that pretends to have 4 tools (echo, add, slugify,
 * fetch_user), wrap it with `withCodeMode`, and then drive the wrapped
 * handlers directly. No transports, no harness — just proves the round trip.
 *
 * Run: `bun run demo` from the repo root.
 */
import { withCodeMode } from "../../src/index.js";
import type { ToolCallResult, ToolSchema, WrapInputs } from "../../src/index.js";

const tools: ToolSchema[] = [
	{ name: "echo", description: "Echo a string back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
	{ name: "slugify", description: "Turn a string into a URL slug.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "fetch_user", description: "Pretend to fetch a user by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
	switch (name) {
		case "echo":
			return ok({ text: String(args.text) });
		case "add":
			return ok({ sum: Number(args.a) + Number(args.b) });
		case "slugify":
			return ok({ slug: String(args.text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") });
		case "fetch_user":
			return ok({ id: String(args.id), name: `User ${args.id}`, email: `user-${args.id}@example.com` });
		default:
			return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
	}
}

function ok(value: unknown): ToolCallResult {
	return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

let patched!: Parameters<WrapInputs["register"]>[0];
const inputs: WrapInputs = {
	listTools: async () => tools,
	callTool,
	register: (handlers) => (patched = handlers),
};

withCodeMode(inputs, {
	expose: ["echo", "add", "slugify"],
	keepNative: ["fetch_user"], // pretend this one has side effects worth surfacing
});

async function main() {
	console.log("\n=== tools/list (post-wrap) ===");
	const listed = await patched.listTools();
	for (const t of listed.tools) console.log(`  - ${t.name}: ${t.description}`);

	console.log("\n=== search('add numbers') ===");
	const search = await patched.callTool({ params: { name: "search", arguments: { query: "add numbers" } } });
	console.log(search.content?.[0]?.text);

	console.log("\n=== execute( chain: slugify(echo()) + add() ) ===");
	const exec = await patched.callTool({
		params: {
			name: "execute",
			arguments: {
				code: `
					const echoed = await tools.echo({ text: "Hello, Code Mode!" });
					const slug   = await tools.slugify({ text: echoed.text });
					const sum    = await tools.add({ a: 21, b: 21 });
					console.log("intermediate slug:", slug.slug);
					return { slug: slug.slug, sum: sum.sum };
				`,
			},
		},
	});
	console.log(exec.content?.[0]?.text);

	console.log("\n=== execute( tries to call kept-native fetch_user ) ===");
	const denied = await patched.callTool({
		params: {
			name: "execute",
			arguments: { code: `return await tools.fetch_user({ id: "42" });` },
		},
	});
	console.log(denied.content?.[0]?.text);

	console.log("\n=== fetch_user called natively (top-level) ===");
	const native = await patched.callTool({ params: { name: "fetch_user", arguments: { id: "42" } } });
	console.log(native.content?.[0]?.text);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
