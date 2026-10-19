/**
 * The OpenCode gateways admit free-tier ids only from requests that read as
 * the OpenCode CLI. These tests pin the rule side of that contract: the
 * `opencode-cli-identity` axis covers every model of `opencode-zen` and
 * `opencode-go`, and `opencode-free-tier` covers only their `*-free` and
 * `*-contributor` ids. pi-ai reads those compat flags to wear the CLI user
 * agent, mint a CLI-format session id, and inject the gate tool.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function compatOf(spec: Pick<ModelSpec<Api>, "provider" | "id" | "api" | "baseUrl">) {
	return buildModel({
		name: spec.id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
		...spec,
	}).compat as { opencodeCliIdentity?: boolean; opencodeFreeTier?: boolean };
}

describe("OpenCode CLI-gate axes", () => {
	it("gates the free tier by id suffix and identifies every model of the provider", () => {
		const free = compatOf({
			provider: "opencode-zen",
			id: "mimo-v2.6-flash-free",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(free.opencodeFreeTier).toBe(true);
		expect(free.opencodeCliIdentity).toBe(true);

		const paid = compatOf({
			provider: "opencode-zen",
			id: "mimo-v2.6-flash",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/v1",
		});
		expect(paid.opencodeFreeTier).toBeUndefined();
		expect(paid.opencodeCliIdentity).toBe(true);
	});

	it("gates the -contributor lanes as free tier", () => {
		const compat = compatOf({
			provider: "opencode-go",
			id: "muse-spark-1.3-contributor",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		expect(compat.opencodeFreeTier).toBe(true);
		expect(compat.opencodeCliIdentity).toBe(true);
	});

	it("carries the identity axis on the anthropic and google records too", () => {
		const anthropic = compatOf({
			provider: "opencode-go",
			id: "qwen3.7-max",
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen/go",
		});
		const google = compatOf({
			provider: "opencode-go",
			id: "gemini-2.5-flash",
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		expect(anthropic.opencodeCliIdentity).toBe(true);
		expect(google.opencodeCliIdentity).toBe(true);
	});

	it("assigns neither axis outside the OpenCode providers", () => {
		const compat = compatOf({
			provider: "litellm",
			id: "gpt-5.6-sol",
			api: "openai-responses",
			baseUrl: "https://litellm.example/v1",
		});
		expect(compat.opencodeFreeTier).toBeUndefined();
		expect(compat.opencodeCliIdentity).toBeUndefined();
	});
});
