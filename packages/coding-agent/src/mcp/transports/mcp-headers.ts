/**
 * MCP 2026-07-28 HTTP header helpers: `Mcp-Name`, `Mcp-Method`, and
 * `Mcp-Param-*` encoding, plus the `x-mcp-header` → `Mcp-Param-*` collector.
 *
 * Used only by the HTTP transport. Stdio ignores `x-mcp-header`.
 */
import type { MCPToolDefinition } from "../types";

/**
 * Encode a single header value per the MCP header encoding rule: characters in
 * visible ASCII (0x21–0x7E) plus space and tab are passed through raw;
 * anything else is wrapped as `=?base64?<b64>?=`. A value that itself already
 * looks encoded is also wrapped, so the encoding stays unambiguous.
 */
export function encodeMcpHeaderValue(value: string): string {
	const isPlain = [...value].every(ch => {
		const code = ch.codePointAt(0)!;
		return code === 0x20 || code === 0x09 || (code >= 0x21 && code <= 0x7e);
	});
	if (isPlain && !/^=\?base64\?.+\?=$/.test(value)) {
		return value;
	}
	return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Mcp-Method` header name/value for a JSON-RPC method. */
export function mcpMethodHeader(method: string): string {
	return method;
}

/** Prefix applied to `x-mcp-header` annotations to form the wire header. */
const PARAM_HEADER_PREFIX = "Mcp-Param-";

/**
 * Walk `inputSchema.properties` (statically reachable chains only — no
 * `items`/`oneOf`/`anyOf`/`allOf`/`not`/`if`/`$ref`) and collect `Mcp-Param-*`
 * headers for any property annotated with `x-mcp-header`. An annotation is
 * valid only on a primitive `string` | `integer` | `boolean` property. When an
 * invalid annotation is present, returns `invalid: true` so the HTTP caller
 * can drop the tool from `tools/list`. Nested `properties` are walked
 * recursively; the annotation's value is read from the matching nested path in
 * `args`.
 */
export function collectXMcpParamHeaders(
	inputSchema: MCPToolDefinition["inputSchema"],
	args: Record<string, unknown>,
): { headers: Record<string, string>; invalid: boolean } {
	const headers: Record<string, string> = {};
	let invalid = false;

	const walk = (schemaObj: unknown, argObj: unknown): void => {
		if (!schemaObj || typeof schemaObj !== "object") return;
		const properties = (schemaObj as Record<string, unknown>).properties;
		if (!properties || typeof properties !== "object") return;

		for (const [propName, propSchema] of Object.entries(properties)) {
			if (!propSchema || typeof propSchema !== "object") continue;
			const schema = propSchema as Record<string, unknown>;

			// Recurse into nested object properties (statically reachable chain).
			if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
				const nestedArg =
					argObj && typeof argObj === "object" && propName in (argObj as Record<string, unknown>)
						? (argObj as Record<string, unknown>)[propName]
						: undefined;
				walk(schema, nestedArg);
				continue;
			}

			const annotation = schema["x-mcp-header"];
			if (typeof annotation !== "string" || annotation.length === 0) continue;

			const type = schema.type;
			if (type !== "string" && type !== "integer" && type !== "boolean") {
				invalid = true;
				continue;
			}
			const argValue =
				argObj && typeof argObj === "object" && propName in (argObj as Record<string, unknown>)
					? (argObj as Record<string, unknown>)[propName]
					: undefined;
			if (argValue === undefined) continue;
			headers[PARAM_HEADER_PREFIX + annotation] = encodeMcpHeaderValue(String(argValue));
		}
	};

	walk(inputSchema, args);
	return { headers, invalid };
}
