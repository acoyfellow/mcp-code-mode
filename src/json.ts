export function toJsonCompatible(value: unknown, label: string): unknown {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error("value has no JSON representation");
		}
		return JSON.parse(serialized);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} must be JSON-compatible: ${message}`, { cause: error });
	}
}
