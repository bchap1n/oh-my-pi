import { describe, expect, it } from "bun:test";
import { isLocalExecutionDraft } from "../src/extensibility/skill-tokens";

describe("isLocalExecutionDraft", () => {
	it("treats a `%`/`%%` draft followed by whitespace or nothing as a PowerShell run", () => {
		expect(isLocalExecutionDraft("%")).toBe(true);
		expect(isLocalExecutionDraft("% Get-Process")).toBe(true);
		expect(isLocalExecutionDraft("%% $secret = 1")).toBe(true);
		expect(isLocalExecutionDraft("%\tWrite-Host")).toBe(true);
	});

	it("keeps `%` prose (printf-style placeholders) out of the PowerShell run", () => {
		expect(isLocalExecutionDraft("%d items failed")).toBe(false);
		expect(isLocalExecutionDraft("%{0}")).toBe(false);
	});

	it("keeps `!` and `$`/`$$` behavior unchanged, and `$VAR`/`${VAR}` as prose", () => {
		expect(isLocalExecutionDraft("!ls")).toBe(true);
		expect(isLocalExecutionDraft("$$")).toBe(true);
		expect(isLocalExecutionDraft("$ print(1)")).toBe(true);
		expect(isLocalExecutionDraft("$HOME")).toBe(false);
		expect(isLocalExecutionDraft("${VAR}")).toBe(false);
	});
});
