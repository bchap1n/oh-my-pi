/**
 * Shared modern-era (`2026-07-28`) request `_meta` helpers.
 *
 * Used by the HTTP transport, stdio transport, and lightweight `callMCP` so
 * every modern-era POST/probe carries the same protocol version, client info,
 * and client capabilities.
 */
import type { MCPClientCapabilities, MCPImplementation } from "./types";
import {
	MCP_ERROR_HEADER_MISMATCH,
	MCP_ERROR_MISSING_CLIENT_CAPABILITY,
	MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
} from "./types";

/** Client info sent in `_meta` and the `initialize` request. */
export const MCP_CLIENT_INFO: MCPImplementation = { name: "omp-coding-agent", version: "1.0.0" };

/**
 * Client capabilities advertised on modern-era requests.
 *
 * `elicitation` is declared so modern servers may send `elicitation/create`
 * via MRTR. `sampling` is intentionally NOT declared — OMP has no sampling
 * implementation and servers MUST NOT send `sampling/createMessage` to a
 * client that did not declare it.
 */
export function modernClientCapabilities(): MCPClientCapabilities {
	return { roots: { listChanged: false }, elicitation: { form: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attach the modern-era `_meta` block to request params. Preserves any
 * existing `_meta` keys a caller already set. Returns a new object; does not
 * mutate `params`.
 */
export function attachModernMeta(
	params: Record<string, unknown> | undefined,
	protocolVersion: string = MCP_PROTOCOL_VERSION,
): Record<string, unknown> {
	const next = { ...(params ?? {}) };
	const existing = isRecord(next._meta) ? next._meta : {};
	next._meta = {
		...existing,
		[MCP_META_PROTOCOL_VERSION]: protocolVersion,
		[MCP_META_CLIENT_INFO]: MCP_CLIENT_INFO,
		[MCP_META_CLIENT_CAPABILITIES]: modernClientCapabilities(),
	};
	return next;
}

/**
 * True when a JSON-RPC error is a modern-era negotiation error (`-32020`,
 * `-32021`, or `-32022`). Used to distinguish a modern server that rejects a
 * probe from a legacy 400/404 that means "no 2026-07-28 support".
 */
export function isModernJsonRpcError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return (
		code === MCP_ERROR_HEADER_MISMATCH ||
		code === MCP_ERROR_MISSING_CLIENT_CAPABILITY ||
		code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION
	);
}

/**
 * Extract `data.supported: string[]` from an `UnsupportedProtocolVersionError`
 * (`-32022`) so the caller can retry with an advertised version.
 */
export function supportedVersionsFromError(error: unknown): string[] | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	let data = (error as { data?: unknown }).data;
	// MCPTransportError carries `.data` as a sanitized JSON string.
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch {
			return undefined;
		}
	}
	if (!isRecord(data)) return undefined;
	const supported = data.supported;
	if (!Array.isArray(supported)) return undefined;
	return supported.filter((v): v is string => typeof v === "string");
}
