import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { collectXMcpParamHeaders, encodeMcpHeaderValue } from "@oh-my-pi/pi-coding-agent/mcp/transports/mcp-headers";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";

const REQUEST_TIMEOUT_MS = 50;
const GUARD_TIMEOUT_MS = 500;

let server: Bun.Server<undefined> | null = null;

type SeenHeaders = {
	protocolVersion: string | null;
	method: string | null;
	name: string | null;
	sessionId: string | null;
	paramRegion: string | null;
	meta: Record<string, unknown> | null;
	body: unknown;
};

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function withPendingGuard<T>(promise: Promise<T>, label: string): Promise<T> {
	const result = await Promise.race([
		promise,
		Bun.sleep(GUARD_TIMEOUT_MS).then(() => Promise.reject(new Error(`timeout: ${label}`))),
	]);
	return result;
}

/** Start a fake modern-era HTTP server capturing request headers/body. */
async function startModernServer(): Promise<SeenHeaders> {
	const seen: SeenHeaders = {
		protocolVersion: null,
		method: null,
		name: null,
		sessionId: null,
		paramRegion: null,
		meta: null,
		body: null,
	};
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			seen.protocolVersion = req.headers.get("MCP-Protocol-Version");
			seen.method = req.headers.get("Mcp-Method");
			seen.name = req.headers.get("Mcp-Name");
			seen.sessionId = req.headers.get("Mcp-Session-Id");
			seen.paramRegion = req.headers.get("Mcp-Param-Region");
			seen.body = await req.json().catch(() => null);
			seen.meta = (seen.body as { params?: { _meta?: Record<string, unknown> } }).params?._meta ?? null;
			return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
		},
	});
	return seen;
}

async function connectedModernTransport(): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout: REQUEST_TIMEOUT_MS,
	});
	await transport.connect();
	transport.setEra("modern");
	transport.setProtocolVersion("2026-07-28");
	return transport;
}

describe("MCP modern-era HTTP request headers", () => {
	it("sends MCP-Protocol-Version, Mcp-Method, Mcp-Name, and _meta on tools/call, with no Mcp-Session-Id", async () => {
		const seen = await startModernServer();
		const transport = await connectedModernTransport();

		await withPendingGuard(
			transport.request("tools/call", { name: "search", arguments: { q: "x" } }, { name: "search" }),
			"request",
		);

		expect(seen.protocolVersion).toBe("2026-07-28");
		expect(seen.method).toBe("tools/call");
		expect(seen.name).toBe("search");
		expect(seen.sessionId).toBeNull();
		expect(seen.meta).not.toBeNull();
		expect(seen.meta!["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
		expect(seen.meta!["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "omp-coding-agent", version: "1.0.0" });
		expect(seen.meta!["io.modelcontextprotocol/clientCapabilities"]).toBeDefined();
	});

	it("merges param headers from options.paramHeaders into Mcp-Param-*", async () => {
		const seen = await startModernServer();
		const transport = await connectedModernTransport();

		await withPendingGuard(
			transport.request(
				"tools/call",
				{ name: "t" },
				{ name: "t", paramHeaders: { "Mcp-Param-Region": "us-west1" } },
			),
			"request",
		);
		expect(seen.paramRegion).toBe("us-west1");
	});

	it("encodes a non-ASCII Mcp-Name value with the base64 sentinel form", async () => {
		expect(encodeMcpHeaderValue("café")).toBe("=?base64?Y2Fmw6k=?=");
		expect(encodeMcpHeaderValue("plain-name")).toBe("plain-name");
	});
});

describe("collectXMcpParamHeaders", () => {
	const tool = (schema: MCPToolDefinition["inputSchema"]): MCPToolDefinition => ({
		name: "t",
		inputSchema: schema,
	});

	it("collects a valid string annotation into an Mcp-Param-* header", () => {
		const { headers, invalid } = collectXMcpParamHeaders(
			tool({ type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } }).inputSchema,
			{ region: "us-west1" },
		);
		expect(invalid).toBe(false);
		expect(headers["Mcp-Param-Region"]).toBe("us-west1");
		expect(headers["Region"]).toBeUndefined();
	});

	it("walks nested properties and reads the value from the nested arg path", () => {
		const { headers, invalid } = collectXMcpParamHeaders(
			tool({
				type: "object",
				properties: {
					meta: {
						type: "object",
						properties: { region: { type: "string", "x-mcp-header": "Region" } },
					},
				},
			}).inputSchema,
			{ meta: { region: "eu-2" } },
		);
		expect(invalid).toBe(false);
		expect(headers["Mcp-Param-Region"]).toBe("eu-2");
	});

	it("flags an invalid annotation on a non-primitive property", () => {
		const { invalid } = collectXMcpParamHeaders(
			tool({ type: "object", properties: { list: { type: "array", "x-mcp-header": "X-List" } } }).inputSchema,
			{},
		);
		expect(invalid).toBe(true);
	});

	it("ignores missing argument values and non-string annotations", () => {
		const { headers, invalid } = collectXMcpParamHeaders(
			tool({
				type: "object",
				properties: {
					region: { type: "string", "x-mcp-header": "Region" },
					flag: { type: "boolean" },
				},
			}).inputSchema,
			{},
		);
		expect(invalid).toBe(false);
		expect(headers["Mcp-Param-Region"]).toBeUndefined();
	});
});
