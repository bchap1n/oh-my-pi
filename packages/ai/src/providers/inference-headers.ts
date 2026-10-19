/** Shared inference request identity headers. */

import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";

/**
 * User agent the OpenCode CLI sends (format `opencode/<channel>/<version>/cli`,
 * pinned to the wire format captured from CLI v2.0.32). OpenCode's gateways
 * admit free-tier models only from this identity.
 */
export const OPENCODE_CLI_USER_AGENT = "opencode/latest/2.0.32/cli";

/** Options controlling provider and protocol inference headers. */
export interface InferenceHeaderOptions {
	provider: string;
	protocol: "anthropic" | "google" | "openai";
	sessionId?: string;
	/** Resolved model compat carrying the OpenCode CLI-gate axes. */
	compat?: object;
}

/** Read a resolved boolean compat flag; absent keys are false. */
function compatFlag(compat: object | undefined, key: string): boolean {
	return compat !== undefined && key in compat && Reflect.get(compat, key) === true;
}

/**
 * Mint a session id in the exact format the OpenCode CLI generates (`ses_` +
 * 12 hex chars derived from an embedded timestamp + 14 base62 random chars;
 * mirrored from the CLI v2.0.32 `packages/schema/src/identifier.ts`).
 * The gateways' free tier validates this structure, so ids of arbitrary
 * shape (like omp's conversation UUIDs) are rejected with a FreeTierError.
 * Only the shape is checked; the low 12 bits are a constant epoch, not a
 * per-request counter.
 */
export function createOpenCodeSessionId(): string {
	const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const value = ~(BigInt(Date.now()) * 0x1000n + 1n);
	const time = Array.from({ length: 6 }, (_, i) =>
		Number((value >> BigInt(40 - 8 * i)) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
	const bytes = crypto.getRandomValues(new Uint8Array(14));
	return "ses_" + time + Array.from(bytes, byte => chars[byte % 62]).join("");
}

/** Set a header unless the map already contains that field under any casing. */
export function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

/**
 * Label a request with the conversation id under the model's resolved
 * `compat.sessionHeader` (KDL `session-header`). A header the caller or config
 * already set wins; without a conversation id nothing is sent.
 */
export function applySessionHeader(
	headers: Record<string, string> | Headers,
	compat: object | undefined,
	sessionId: string | undefined,
): void {
	const name = compat && "sessionHeader" in compat ? compat.sessionHeader : undefined;
	if (typeof name !== "string" || !sessionId) return;
	if (headers instanceof Headers) {
		if (!headers.has(name)) headers.set(name, sessionId);
		return;
	}
	setHeaderIfAbsent(headers, name, sessionId);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() !== normalizedName) continue;
		if (existingName === name && headers[existingName] === value) return;
		delete headers[existingName];
	}
	headers[name] = value;
}

/**
 * Project omp's identity and authoritative conversation id onto the headers
 * understood by the active inference protocol and host.
 */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	if (options.provider === "vercel-ai-gateway") {
		// Vercel AI Gateway app attribution; caller/config headers take precedence.
		setHeaderIfAbsent(headers, "http-referer", APP_URL);
		setHeaderIfAbsent(headers, "x-title", APP_NAME);
	}

	const cliIdentity = compatFlag(options.compat, "opencodeCliIdentity");
	const freeTier = compatFlag(options.compat, "opencodeFreeTier");
	if (cliIdentity) {
		// OpenCode's gateways admit free-tier models only from requests that
		// read as the OpenCode CLI, so every OpenCode request wears the CLI
		// identity instead of omp's (the openai-completions free-tier tool
		// gate is the other half of that requirement).
		setHeaderIfAbsent(headers, "User-Agent", OPENCODE_CLI_USER_AGENT);
	}
	const sessionId = options.sessionId;
	if (freeTier) {
		// The gateways validate the session id's structure, so each request
		// carries a freshly minted CLI-format id (the CLI does the same for
		// its title-generation calls).
		setHeader(headers, "x-opencode-session", createOpenCodeSessionId());
	}
	if (!sessionId) return;

	if (options.protocol === "anthropic") {
		setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai") {
		setHeader(headers, "session_id", sessionId);
		setHeader(headers, "x-client-request-id", sessionId);
	}

	if (cliIdentity && !freeTier) {
		setHeader(headers, "x-opencode-session", sessionId);
	}
}

function isHeaderRecord(headers: RequestInit["headers"]): headers is Record<string, string> {
	return headers !== undefined && !(headers instanceof Headers) && !Array.isArray(headers);
}

/**
 * Return `init` with omp's process-wide inference User-Agent default applied.
 * Any explicit header, including Anthropic and Codex OAuth fingerprints,
 * remains authoritative. Called per request by `transportFetch`.
 *
 * Plain-object headers stay plain objects: custom `fetch` implementations
 * (proxies, tests) index `init.headers` by name and must not be handed a
 * `Headers` instance instead.
 */
export function withInferenceUserAgent(
	input: string | URL | Request,
	init: RequestInit | undefined,
): RequestInit | undefined {
	const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
	if (isHeaderRecord(sourceHeaders)) {
		const headers = { ...sourceHeaders };
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		return { ...init, headers };
	}
	const headers = new Headers(sourceHeaders);
	if (headers.has("User-Agent")) return init;
	headers.set("User-Agent", USER_AGENT);
	return { ...init, headers };
}
