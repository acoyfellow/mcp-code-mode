import type { ToolSchema } from "./types.js";

/**
 * Tiny keyword-overlap ranker over a tool catalog. Deliberately dumb — no
 * embeddings, no index, no I/O. Good enough for a few hundred tools per server,
 * which is the realistic ceiling for a single MCP.
 *
 * If you want better recall, replace it with `searchTool.handler`.
 */
export function searchCatalog(
	catalog: ToolSchema[],
	query: string,
	limit = 10,
): ToolSchema[] {
	const terms = tokenize(query);
	if (terms.length === 0) return catalog.slice(0, limit);

	const scored = catalog.map((tool) => {
		const haystack = tokenize(
			`${tool.name} ${tool.description ?? ""}`,
		);
		const hits = terms.reduce(
			(acc, t) => acc + (haystack.includes(t) ? 1 : 0),
			0,
		);
		return { tool, score: hits };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((s) => s.tool);
}

function tokenize(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter((t) => t.length > 1);
}
