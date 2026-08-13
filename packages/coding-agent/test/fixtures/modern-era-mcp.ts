#!/usr/bin/env bun
/**
 * Test fixture: a modern (2026-07-28) stdio MCP server that answers
 * `server/discover` with `supportedVersions` + capabilities and stays stateless.
 * Used by `mcp-era-detect.test.ts` to prove the dual-era client talks to a
 * `server/discover`-based server without ever sending `initialize`.
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
		if (msg.id === undefined || msg.id === null) return;
		const response = { jsonrpc: "2.0" as const, id: msg.id, result: modernResult(msg.method ?? "") };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

function modernResult(method: string): Record<string, unknown> {
	switch (method) {
		case "server/discover":
			return {
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
			};
		case "tools/list":
			return { tools: [{ name: "modern_tool", inputSchema: { type: "object", properties: {} } }] };
		default:
			return {};
	}
}

if (import.meta.main) {
	startServer();
}
