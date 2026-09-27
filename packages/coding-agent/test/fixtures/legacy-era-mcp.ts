#!/usr/bin/env bun
/**
 * Test fixture: a legacy stdio MCP server that does not understand
 * `server/discover` (writes nothing for it, like a pre-2026 server would via
 * -32601 or silence) but answers `initialize` with `2025-11-25`. Used by
 * `mcp-era-detect.test.ts` to prove the dual-era client classifies it legacy.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`).
 */
import * as readline from "node:readline";

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
};

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(trimmed) as JsonRpcMessage;
		} catch {
			return;
		}
		// Notifications (no `id`) get no response.
		if (msg.id === undefined || msg.id === null) return;
		// A legacy server has no `server/discover` — answer -32601 (method
		// not found), the common real-world signal that triggers legacy fallback.
		if (msg.method === "server/discover") {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } })}\n`,
			);
			return;
		}
		const response = { jsonrpc: "2.0" as const, id: msg.id, result: legacyResult(msg.method ?? "") };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

function legacyResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-11-25",
				serverInfo: { name: "legacy-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return { tools: [{ name: "legacy_tool", inputSchema: { type: "object", properties: {} } }] };
		default:
			return {};
	}
}

if (import.meta.main) {
	startServer();
}
