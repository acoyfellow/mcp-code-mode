import type { ToolSchema } from "./types.js";

/**
 * Small lexical ranker over a tool catalog. It favors tool-name matches over
 * descriptions and input-schema terms, normalizes common identifier shapes,
 * and expands a deliberately short set of task-language aliases.
 *
 * There is no index, I/O, or model dependency. This remains fast enough for
 * catalogs with thousands of tools. Replace it with `searchTool.handler` when
 * your domain needs semantic or policy-aware retrieval.
 */
export function searchCatalog(
	catalog: ToolSchema[],
	query: string,
	limit = 10,
): ToolSchema[] {
	const terms = expandAliases(tokenize(query));
	if (terms.length === 0) return catalog.slice(0, limit);

	const scored = catalog.map((tool, index) => {
		const name = new Set(tokenize(tool.name));
		const description = new Set(tokenize(tool.description ?? ""));
		const schema = new Set(tokenize(stringifySchema(tool.inputSchema)));
		const score = terms.reduce((total, term) => {
			if (name.has(term)) return total + 4;
			if (description.has(term)) return total + 2;
			if (schema.has(term)) return total + 1;
			return total;
		}, 0);
		return { tool, score, index };
	});

	return scored
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.tool);
}

const ALIASES: Record<string, string[]> = {
	find: ["search"],
	search: ["find"],
	show: ["get", "list"],
	read: ["get", "fetch"],
	remove: ["delete"],
	comment: ["note", "discussion"],
	email: ["gmail", "mail"],
	gmail: ["email", "mail"],
	ci: ["pipeline", "job"],
};

function expandAliases(tokens: string[]): string[] {
	const expanded = new Set(tokens);
	for (const token of tokens) {
		for (const alias of ALIASES[token] ?? []) expanded.add(alias);
	}
	return [...expanded];
}

function tokenize(input: string): string[] {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map(normalizeToken)
		.filter((token) => token.length > 1);
}

function normalizeToken(token: string): string {
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
	return token;
}

function stringifySchema(schema: unknown): string {
	try {
		return JSON.stringify(schema ?? "");
	} catch {
		return "";
	}
}
