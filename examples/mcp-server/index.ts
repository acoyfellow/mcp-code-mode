#!/usr/bin/env bun
/**
 * A real stdio MCP server for playing with mcp-code-mode in MCP Inspector.
 *
 * Run from the repo root:
 *   bun run play
 *
 * The underlying catalog has six tools. The client sees only search, execute,
 * and the intentionally native create_note tool.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapServer } from "../../src/index.js";
import type { ToolCallResult, ToolSchema } from "../../src/index.js";

const projects = [
	{ id: "mcp-code-mode", name: "MCP Code Mode", status: "finishing", owner: "Jordan" },
	{ id: "terrarium", name: "Terrarium", status: "active", owner: "Jordan" },
	{ id: "my-ax", name: "My AX", status: "active", owner: "Jordan" },
];

const notes = [
	{ id: "n1", project: "mcp-code-mode", text: "Land a real MCP client round-trip before publishing." },
	{ id: "n2", project: "mcp-code-mode", text: "Keep write-side tools native and visible." },
	{ id: "n3", project: "terrarium", text: "Use bounded child agents for repo archaeology." },
];

const catalog: ToolSchema[] = [
	{
		name: "list_projects",
		description: "List all projects and their current status.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_project",
		description: "Get one project by id.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
	},
	{
		name: "find_notes",
		description: "Find notes containing a text query.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	},
	{
		name: "get_project_notes",
		description: "Get every note for a project id.",
		inputSchema: {
			type: "object",
			properties: { project: { type: "string" } },
			required: ["project"],
		},
	},
	{
		name: "slugify",
		description: "Turn text into a lowercase URL slug.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "create_note",
		description: "Create a note. Demo only: validates the write but does not persist it.",
		inputSchema: {
			type: "object",
			properties: { project: { type: "string" }, text: { type: "string" } },
			required: ["project", "text"],
		},
	},
];

function ok(value: unknown): ToolCallResult {
	return {
		structuredContent: value,
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
	switch (name) {
		case "list_projects":
			return ok({ projects });
		case "get_project": {
			const project = projects.find((item) => item.id === String(args.id));
			return project
				? ok(project)
				: { isError: true, content: [{ type: "text", text: `Unknown project: ${args.id}` }] };
		}
		case "find_notes": {
			const query = String(args.query).toLowerCase();
			return ok({ notes: notes.filter((note) => note.text.toLowerCase().includes(query)) });
		}
		case "get_project_notes":
			return ok({ notes: notes.filter((note) => note.project === String(args.project)) });
		case "slugify":
			return ok({
				slug: String(args.text)
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, ""),
			});
		case "create_note":
			return ok({ accepted: true, persisted: false, project: args.project, text: args.text });
		default:
			return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
	}
}

const server = new Server(
	{ name: "mcp-code-mode-playground", version: "0.0.1" },
	{ capabilities: { tools: {} } },
);

wrapServer(
	server,
	{
		listTools: async () => catalog,
		callTool,
	},
	{
		keepNative: ["create_note"],
	},
);

await server.connect(new StdioServerTransport());
