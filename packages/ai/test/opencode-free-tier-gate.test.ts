/**
 * OpenCode's gateways admit free-tier models only from requests that read as
 * an OpenCode CLI coding-agent turn: the CLI user agent (inference-headers),
 * `stream: true`, and at least one recognized OpenCode tool name in `tools`.
 * These tests pin the payload side of that contract: the injected `read`
 * gate tool, the `tool_choice: "none"` pin for tool-less turns, and the
 * CLI user agent on the wire.
 */
import { describe, expect, it } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { OPENCODE_CLI_USER_AGENT } from "@oh-my-pi/pi-ai/providers/inference-headers";
import type { FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface Captured {
	headers: Headers;
	body: Record<string, unknown>;
}

function chatSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function recordingFetch(): { fetch: FetchImpl; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : {},
		});
		return chatSse();
	}) as unknown as FetchImpl;
	return { fetch, calls };
}

function makeOpenCodeModel(id: string): Model<"openai-completions"> {
	return buildModel({
		provider: "opencode-zen",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
	});
}

function toolsOn(body: Record<string, unknown> | undefined): Array<{ type: string; function: { name: string } }> {
	return (body?.tools ?? []) as Array<{ type: string; function: { name: string } }>;
}

const READ_TOOL: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const BASH_TOOL: Tool = { name: "bash", description: "Run a command", parameters: { type: "object" } };
const CUSTOM_TOOL: Tool = { name: "custom_tool", description: "A custom tool", parameters: { type: "object" } };

const userHi = { role: "user" as const, content: "hi", timestamp: 0 };

describe("OpenCode free-tier gate on the OpenAI completions wire", () => {
	it("adds the CLI read tool and a none choice to a tool-less free-tier turn", async () => {
		const { fetch, calls } = recordingFetch();
		const response = await completeSimple(
			makeOpenCodeModel("mimo-v2.6-flash-free"),
			{ messages: [userHi] },
			{ apiKey: "key", fetch },
		);

		expect(response.stopReason).toBe("stop");
		const body = calls[0]?.body;
		expect(body?.stream).toBe(true);
		expect(body?.tool_choice).toBe("none");
		expect(toolsOn(body)).toHaveLength(1);
		expect(toolsOn(body)[0]?.function.name).toBe("read");
		expect(calls[0]?.headers.get("User-Agent")).toBe(OPENCODE_CLI_USER_AGENT);
		expect(calls[0]?.headers.get("x-opencode-session")).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});

	it("leaves a turn that already offers a recognized OpenCode tool unchanged", async () => {
		const { fetch, calls } = recordingFetch();
		await completeSimple(
			makeOpenCodeModel("mimo-v2.6-flash-free"),
			{ messages: [userHi], tools: [READ_TOOL, BASH_TOOL] },
			{ apiKey: "key", fetch },
		);

		const body = calls[0]?.body;
		expect(toolsOn(body).map(tool => tool.function.name)).toEqual(["read", "bash"]);
		expect(body?.tool_choice).toBeUndefined();
	});

	it("keeps custom tools and appends the gate tool when none is recognized", async () => {
		const { fetch, calls } = recordingFetch();
		await completeSimple(
			makeOpenCodeModel("mimo-v2.6-flash-free"),
			{ messages: [userHi], tools: [CUSTOM_TOOL] },
			{ apiKey: "key", fetch },
		);

		const body = calls[0]?.body;
		expect(toolsOn(body).map(tool => tool.function.name)).toEqual(["custom_tool", "read"]);
		expect(body?.tool_choice).toBeUndefined();
	});

	it("does not inject into paid opencode models", async () => {
		const { fetch, calls } = recordingFetch();
		await completeSimple(makeOpenCodeModel("mimo-v2.6-flash"), { messages: [userHi] }, { apiKey: "key", fetch });

		const body = calls[0]?.body;
		expect(body?.tools).toBeUndefined();
		expect(body?.tool_choice).toBeUndefined();
	});

	it("keeps an explicit tool choice instead of pinning none", async () => {
		const { fetch, calls } = recordingFetch();
		await completeSimple(
			makeOpenCodeModel("mimo-v2.6-flash-free"),
			{ messages: [userHi] },
			{ apiKey: "key", fetch, toolChoice: "auto" },
		);

		const body = calls[0]?.body;
		expect(body?.tool_choice).toBe("auto");
		expect(toolsOn(body).map(tool => tool.function.name)).toEqual(["read"]);
	});
});
