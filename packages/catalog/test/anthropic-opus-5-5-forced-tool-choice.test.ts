import { describe, expect, test } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Anthropic's Opus 5.5 rejects forced tool use outright:
//   400 "tool_choice: type "tool" and "any" are not supported for this model."
// Same lineage contract as Fable/Mythos 5, so the downgrade must keep the tool
// available and let the caller's prompt steer the model instead.
// `classes/anthropic.kdl` scopes the disable to revision >=5.5: the Opus 5.0
// line still accepts forced tool choice and must keep requesting it.

function spec(id: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic Opus forced-tool-choice rules", () => {
	test("the 5.5 revision downgrades any/tool to auto", () => {
		expect(resolveModelPolicy(spec("claude-opus-5-5")).compat.supportsForcedToolChoice).toBe(false);
	});

	test("the 5.0 revision still accepts forced tool choice", () => {
		expect(resolveModelPolicy(spec("claude-opus-5")).compat.supportsForcedToolChoice).toBe(true);
	});
});
