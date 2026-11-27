import { describe, expect, it } from "bun:test";
import { applyFormattedEdits } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { TextEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";

/**
 * Regression coverage for line-ending corruption in the LSP format-on-write path.
 *
 * Formatters return whole-document text in their own line-ending style. On
 * Windows, PowerShell Editor Services joins with `Environment.NewLine`, so it
 * answers CRLF no matter what the document used. The old code wrote that answer
 * back verbatim, which had two consequences:
 *
 *   1. An LF file flipped to CRLF on its first format, producing a whole-file
 *      diff that had nothing to do with the edit.
 *   2. A formatter that echoed a trailing carriage return produced `\r\r\n` on
 *      every line, corrupting the file on its second format.
 *
 * The contract these tests defend: formatting changes code, never line endings.
 * The result is normalized to LF and then re-encoded with the line ending the
 * document already had, so the operation is byte-stable and idempotent.
 */
const wholeFile = (text: string): TextEdit[] => [
	{ range: { start: { line: 0, character: 0 }, end: { line: 999, character: 0 } }, newText: text },
];

describe("applyFormattedEdits", () => {
	it("keeps LF line endings when the formatter answers CRLF", () => {
		const original = "function A {\n    Write-Host 'x'\n}\n";
		const formatted = "function A {\r\n    Write-Host 'x'\r\n}\r\n";

		expect(applyFormattedEdits(original, wholeFile(formatted))).toBe(original);
	});

	it("keeps CRLF line endings when the formatter answers CRLF", () => {
		const original = "function A {\r\n    Write-Host 'x'\r\n}\r\n";
		const formatted = "function A {\r\n    Write-Host 'x'\r\n}\r\n";

		expect(applyFormattedEdits(original, wholeFile(formatted))).toBe(original);
	});

	it("is idempotent across repeated formats of a CRLF document", () => {
		const original = "function A {\r\n    Write-Host 'x'\r\n}\r\n";
		const formatted = "function A {\r\n    Write-Host 'x'\r\n}\r\n";

		const once = applyFormattedEdits(original, wholeFile(formatted));
		const twice = applyFormattedEdits(once, wholeFile(formatted));

		expect(once).not.toContain("\r\r");
		expect(twice).toBe(once);
	});

	it("repairs doubled carriage returns echoed by a formatter", () => {
		const original = "function A {\r\n    Write-Host 'x'\r\n}\r\n";
		const corrupted = "function A {\r\r\n    Write-Host 'x'\r\r\n}\r\r\n";

		const result = applyFormattedEdits(original, wholeFile(corrupted));

		expect(result).not.toContain("\r\r");
		expect(result).toBe(original);
	});

	it("still applies the formatter's code changes", () => {
		const original = 'function A {\r\n    Write-Host "x"\r\n}\r\n';
		const formatted = "function A {\r\n    Write-Host 'x'\r\n}\r\n";

		expect(applyFormattedEdits(original, wholeFile(formatted))).toBe(formatted);
	});
});
