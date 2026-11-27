import { describe, expect, it } from "bun:test";
import { builtinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { createTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

function builtinWith(name: "dark" | "light", colors: Partial<ThemeJson["colors"]> = {}) {
	const json = builtinThemes()[name];
	if (!json) throw new Error(`${name} theme unavailable`);
	return createTheme({ ...json, colors: { ...json.colors, ...colors } }, { depth: "truecolor" });
}

describe("PowerShell edition colors", () => {
	it("derive the logo colors readable on the theme's surface when omitted", () => {
		const dark = builtinWith("dark");
		expect(dark.hex("toolPowerShell").toLowerCase()).toBe("#a9c8ff");
		expect(dark.hex("toolWindowsPowerShell").toLowerCase()).toBe("#5391fe");

		const light = builtinWith("light");
		expect(light.hex("toolPowerShell").toLowerCase()).toBe("#2c5591");
		expect(light.hex("toolWindowsPowerShell").toLowerCase()).toBe("#3e6dbf");
	});

	it("keep explicit theme values", () => {
		const t = builtinWith("dark", { toolPowerShell: "#123456", toolWindowsPowerShell: "#654321" });
		expect(t.hex("toolPowerShell")).toBe("#123456");
		expect(t.hex("toolWindowsPowerShell")).toBe("#654321");
	});
});
