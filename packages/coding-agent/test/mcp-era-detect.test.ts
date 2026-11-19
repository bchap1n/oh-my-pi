import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const GUARD_TIMEOUT_MS = 5000;

interface SeenHttp {
	methods: string[];
	jsonMethods: string[];
}

/** Drive a request against a fake HTTP server and assert the negotiated era. */
async function connectHttp(
	handler: (req: Request, seen: SeenHttp) => Response | Promise<Response>,
): Promise<{ connection: Awaited<ReturnType<typeof connectToServer>>; seen: SeenHttp }> {
	const seen: SeenHttp = { methods: [], jsonMethods: [] };
	const srv = Bun.serve({
		port: 0,
		async fetch(req) {
			// Must await the body so Bun completes the request lifecycle before the
			// response is returned (fire-and-forget body reads abort the connection
			// in this Bun runtime).
			const text = await req.text();
			seen.methods.push(req.headers.get("Mcp-Method") ?? "(none)");
			try {
				const parsed = JSON.parse(text) as { method?: string };
				if (parsed.method) seen.jsonMethods.push(parsed.method);
			} catch {
				// Non-JSON body.
			}
			return handler(req, seen);
		},
	});
	const config: MCPServerConfig = {
		type: "http",
		url: `http://127.0.0.1:${srv.port}/mcp`,
		timeout: 5000,
	};
	try {
		const connection = await Promise.race([
			connectToServer("fake", config),
			Bun.sleep(GUARD_TIMEOUT_MS).then(() => Promise.reject(new Error("connectToServer timed out"))),
		]);
		return { connection, seen };
	} finally {
		srv.stop(true);
	}
}

describe("MCP era detection", () => {
	it("classifies an HTTP server answering server/discover with a DiscoverResult as modern, never sending initialize", async () => {
		const { connection, seen } = await connectHttp(() => {
			return Response.json({
				jsonrpc: "2.0",
				id: 1,
				result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
			});
		});

		expect(connection.era).toBe("modern");
		expect(connection.protocolVersion).toBe("2026-07-28");
		expect(seen.jsonMethods).not.toContain("initialize");
	});

	it("classifies an HTTP server that 400s server/discover and answers initialize as legacy", async () => {
		const { connection, seen } = await connectHttp((_req, seen) => {
			// First call (server/discover) → plain 400, no modern error body.
			if (seen.methods.length === 1) {
				return new Response("Bad Request", { status: 400 });
			}
			return Response.json({
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "legacy", version: "1.0" },
					capabilities: { tools: {} },
				},
			});
		});

		expect(connection.era).toBe("legacy");
		expect(connection.protocolVersion).toBe("2025-11-25");
		expect(seen.jsonMethods).toContain("initialize");
	});

	it("retries server/discover on -32022 with an advertised version instead of falling back to initialize", async () => {
		const discoverCalls: number[] = [];
		const { connection, seen } = await connectHttp(() => {
			discoverCalls.push(discoverCalls.length);
			if (discoverCalls.length === 1) {
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32022, message: "unsupported version", data: { supported: ["2026-07-28"] } },
				});
			}
			return Response.json({
				jsonrpc: "2.0",
				id: 1,
				result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
			});
		});

		expect(connection.era).toBe("modern");
		expect(connection.protocolVersion).toBe("2026-07-28");
		expect(discoverCalls.length).toBe(2);
		expect(seen.jsonMethods).not.toContain("initialize");
	});

	it("classifies a stdio server without server/discover support as legacy", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "legacy-era-mcp.ts");
		const config: MCPServerConfig = { type: "stdio", command: process.execPath, args: [fixture], timeout: 5000 };
		const connection = await Promise.race([
			connectToServer("legacy-stdio", config),
			Bun.sleep(GUARD_TIMEOUT_MS).then(() => Promise.reject(new Error("connectToServer timed out"))),
		]);
		expect(connection.era).toBe("legacy");
		expect(connection.protocolVersion).toBe("2025-11-25");
	});

	it("classifies a stdio server answering server/discover as modern and sends _meta protocolVersion on tools/list", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "modern-era-mcp.ts");
		const config: MCPServerConfig = { type: "stdio", command: process.execPath, args: [fixture], timeout: 5000 };
		const connection = await Promise.race([
			connectToServer("modern-stdio", config),
			Bun.sleep(GUARD_TIMEOUT_MS).then(() => Promise.reject(new Error("connectToServer timed out"))),
		]);
		expect(connection.era).toBe("modern");
		expect(connection.protocolVersion).toBe("2026-07-28");
	});
});
