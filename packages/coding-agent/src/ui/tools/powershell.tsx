/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * PowerShell calls (`powershell`): one run box with the command line, the
 * output's tail and a foot with the state and run time.
 *
 * Terminal look: `bash` (`src/ui/styles/tools/bash.ts`), fed by {@link BashTerm}.
 */
import { shellPresenter } from "./bash";
import { registerToolPresenter } from "./registry";

/** PowerShell args of the `powershell` tool. */
export interface PowerShellArgs {
	readonly command?: string;
	readonly cwd?: string;
	readonly host?: "session" | "ephemeral" | "new-session";
	readonly edition?: "pwsh" | "powershell";
}

export const powershellPresenter = shellPresenter<PowerShellArgs>({
	title: args => {
		const edition = args?.edition ?? "pwsh";
		const title = edition === "powershell" ? "Windows PowerShell" : "PowerShell";
		return args?.host && args.host !== "session" ? `${title} · ${args.host}` : title;
	},
	command: args => args?.command,
	cwd: args => args?.cwd,
	header: false,
});

registerToolPresenter("powershell", powershellPresenter);
