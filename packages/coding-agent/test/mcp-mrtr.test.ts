import { describe, expect, it } from "bun:test";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMockConnection } from "./mcp-test-utils";

/** A transport that records every request id + params and feeds queued responses. */
function sequenceTransport(queued: Array<Record<string, unknown>>) {
	const calls: Array<{ id: string | number; method: string; params: Record<string, unknown> }> = [];
	const transport: MCPTransport = {
		connected: true,
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			const id = calls.length + 1;
			calls.push({ id, method, params: params ?? {} });
			const next = queued[calls.length - 1];
			if (!next) throw new Error(`No queued response for call #${calls.length}`);
			return next as T;
		},
		async notify() {},
		async close() {},
	};
	return { transport, calls };
}

describe("MCP MRTR (input_required)", () => {
	it("fulfills roots/list + requestState and retries with a new id before returning the complete result", async () => {
		const { transport, calls } = sequenceTransport([
			{
				resultType: "input_required",
				requestState: "abc",
				inputRequests: { r1: { method: "roots/list" } },
			},
			{ content: [{ type: "text", text: "done" }] },
		]);
		const connection = createMockConnection({ tools: {} }, transport);

		const result = await callTool(connection, "my_tool", { q: "x" });

		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		// Two network calls: the original, then the MRTR retry.
		expect(calls.length).toBe(2);
		// Second call carries the fulfillment + a fresh JSON-RPC id.
		expect(calls[1].params).toMatchObject({ name: "my_tool" });
		expect(calls[1].params.inputResponses).toBeDefined();
		expect(calls[1].params.requestState).toBe("abc");
		expect((calls[1].params.inputResponses as Record<string, unknown>)["r1"]).toBeDefined();
		const r1 = (calls[1].params.inputResponses as Record<string, { roots: unknown }>)["r1"];
		expect(Array.isArray(r1.roots)).toBe(true);
		expect((r1.roots as Array<{ uri: string }>)[0].uri).toMatch(/^file:\/\//);
		// The JSON-RPC request id must differ between retries.
		expect(calls[1].id).not.toBe(calls[0].id);
	});

	it("stops after MAX_MRTR_ROUNDS and throws when the server keeps asking", async () => {
		const rounds = 5; // > MAX_MRTR_ROUNDS (4)
		const { transport } = sequenceTransport(
			Array.from({ length: rounds }, () => ({
				resultType: "input_required",
				inputRequests: { r1: { method: "roots/list" } },
			})),
		);
		const connection = createMockConnection({ tools: {} }, transport);

		await expect(callTool(connection, "my_tool")).rejects.toThrow(/MRTR exceeded 4 rounds/);
	});
});
