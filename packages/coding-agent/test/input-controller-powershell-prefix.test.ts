import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

function createContext() {
	let editorText = "";
	const submitted: unknown[] = [];
	const handlePowerShellCommand = vi.fn(async (_command: string, _isExcluded: boolean) => {});
	const onInputCallback = vi.fn((submission: unknown) => submitted.push(submission));
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});

	const editor: FakeEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
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
		} as unknown as InteractiveModeContext["session"],
		sessionManager: { getSessionName: () => "named-session" } as unknown as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		startPendingSubmission: vi.fn((submission: unknown) => submission),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		isPowerShellMode: false,
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		handlePowerShellCommand,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, handlePowerShellCommand, onInputCallback, submitted };
}

describe("InputController PowerShell prompt prefix", () => {
	it("routes a spaced % draft to the PowerShell runner", async () => {
		const { ctx, editor, handlePowerShellCommand, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("% Get-Process");

		expect(handlePowerShellCommand).toHaveBeenCalledWith("Get-Process", false);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("marks a spaced %% draft as excluded from context", async () => {
		const { ctx, editor, handlePowerShellCommand } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("%% $secret = 1");

		expect(handlePowerShellCommand).toHaveBeenCalledWith("$secret = 1", true);
	});

	it("submits printf-style prose starting with % as a normal prompt", async () => {
		const { ctx, editor, handlePowerShellCommand, onInputCallback, submitted } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("%d items failed");

		expect(handlePowerShellCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual([
			{ text: "%d items failed", images: undefined, imageLinks: undefined, streamingBehavior: "steer" },
		]);
	});

	it("submits a lone % as a normal prompt", async () => {
		const { ctx, editor, handlePowerShellCommand, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("%");

		expect(handlePowerShellCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledTimes(1);
	});
});
