import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";

function createContext() {
	const handlePowerShellCommand = vi.fn(async (_command: string, _isExcluded: boolean) => {});
	const onInputCallback = vi.fn();
	const submitted: unknown[] = [];
	const prompt = vi.fn(async () => {});
	const composer = new Composer();
	const ctx = {
		composer,
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			isPowerShellRunning: false,
			extensionRunner: undefined,
			prompt,
			queuedMessageCount: 0,
			messages: [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			hasInterruptibleInput: false,
			hasPendingDeferredExtensions: false,
			loadDeferredExtensions: vi.fn(),
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "named-session",
			getSessionId: () => "test-session",
		} as unknown as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback: (input: unknown) => {
			submitted.push(input);
			onInputCallback(input);
		},
		startPendingSubmission: vi.fn((submission: unknown) => submission),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingExecRuns: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		isPowerShellMode: false,
		isBtwFocused: false,
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		handlePowerShellCommand,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		focusedAgentId: undefined,
		approvalOwnsComposer: false,
		isGuidedGoalInterviewActive: () => false,
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;

	return { ctx, composer, handlePowerShellCommand, onInputCallback, submitted };
}

describe("InputController PowerShell prompt prefix", () => {
	it("routes a spaced % draft to the PowerShell runner", async () => {
		const { ctx, composer, handlePowerShellCommand, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await composer.onSubmit?.("% Get-Process");

		expect(handlePowerShellCommand).toHaveBeenCalledWith("Get-Process", false);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("marks a spaced %% draft as excluded from context", async () => {
		const { ctx, composer, handlePowerShellCommand } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await composer.onSubmit?.("%% $secret = 1");

		expect(handlePowerShellCommand).toHaveBeenCalledWith("$secret = 1", true);
	});

	it("submits printf-style prose starting with % as a normal prompt", async () => {
		const { ctx, composer, handlePowerShellCommand, onInputCallback, submitted } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await composer.onSubmit?.("%d items failed");

		expect(handlePowerShellCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual([
			{ text: "%d items failed", images: undefined, imageLinks: undefined, streamingBehavior: "steer" },
		]);
	});

	it("submits a lone % as a normal prompt", async () => {
		const { ctx, composer, handlePowerShellCommand, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await composer.onSubmit?.("%");

		expect(handlePowerShellCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledTimes(1);
	});
});
