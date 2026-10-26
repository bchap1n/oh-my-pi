/** Shared inference request identity headers. */

import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";

/**
 * User agent the OpenCode CLI sends (format `opencode/<channel>/<version>/cli`,
 * pinned to the wire format captured from CLI v2.0.32). OpenCode's gateways
 * admit free-tier models only from this identity.
 */
export const OPENCODE_CLI_USER_AGENT = "opencode/latest/2.0.32/cli";

/** Options controlling provider and protocol inference headers. */
export interface InferenceHeaderOptions {
	/**
	 * Credential-bearing provider id. Wire decisions (protocol session
	 * headers, OpenCode attribution) resolve against the declared backend
	 * instead — see {@link providerType}.
	 */
	provider: string;
	/**
	 * Declared backend identity for a custom provider (`providerType ?? provider`,
	 * the same target the catalog policy cascade resolves). Carried through so
	 * a credential-bearing custom provider declared as an OpenCode backend
	 * gets that backend's wire headers while auth and registry keep using
	 * {@link provider}.
	 */
	providerType?: string;
	protocol: "anthropic" | "google" | "openai";
	sessionId?: string;
	/** Resolved model compat carrying the OpenCode CLI-gate axes. */
	compat?: object;
	/**
	 * Shared prompt-cache affinity key (see {@link resolveOpenCodeGoCacheAffinity}).
	 * Carried only by `x-opencode-session` on the `opencode-go` backend;
	 * protocol-native session headers and every other backend keep `sessionId`.
	 */
	cacheAffinity?: string;
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

/**
 * Shared prompt-cache affinity for the OpenCode Go backend: on lanes opted
 * into KDL `shared-prompt-cache`, related requests (Task siblings, forks,
 * explicit-key callers) warm and hit the gateway's prefix cache under one
 * shared key, so Go's session header carries that key instead of the
 * conversation id.
 *
 * `promptCacheKey` MUST be an explicit, already retention-gated cache key —
 * never the sessionId-derived fallback. The backend identity is
 * `providerType ?? provider`; catalog policy is the only opt-in authority.
 */
export function resolveOpenCodeGoCacheAffinity(
	model: CatalogPolicyInputs,
	promptCacheKey: string | undefined,
): string | undefined {
	if ((model.providerType ?? model.provider) !== "opencode-go") return undefined;
	// An empty key must never replace a known real conversation header.
	if (!promptCacheKey) return undefined;
	return resolveCatalogPolicy(model).sharedPromptCache === true ? promptCacheKey : undefined;
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
	// Wire identity: what the endpoint is, not which credential reaches it.
	// A custom provider declaring `providerType` is that backend on the wire
	// while its provider id stays authoritative for auth and the registry.
	const backend = options.providerType ?? options.provider;
	if (backend === "vercel-ai-gateway") {
		// Vercel AI Gateway app attribution; caller/config headers take precedence.
		setHeaderIfAbsent(headers, "http-referer", APP_URL);
		setHeaderIfAbsent(headers, "x-title", APP_NAME);
	}

	const cliIdentity = compatFlag(options.compat, "opencodeCliIdentity");
	const freeTier = compatFlag(options.compat, "opencodeFreeTier");
	const isOpenCode = backend === "opencode-go" || backend === "opencode-zen";
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
	// The conversation id and the explicit cache key are independently
	// optional: a Go sibling lane can carry its family affinity with no
	// conversation session in hand (V1 compaction, direct client-options
	// builds), while every other lane still needs the conversation id.
	if (!sessionId && !options.cacheAffinity) return;

	if (sessionId) {
		if (options.protocol === "anthropic") {
			setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
		} else if (options.protocol === "openai" && backend === "openai") {
			setHeader(headers, "session_id", sessionId);
			setHeader(headers, "x-client-request-id", sessionId);
		}
	}

	if (freeTier) {
		// The freshly minted free-tier id set above stays authoritative: the
		// gateway rejects unstructured session/affinity keys, so no other
		// session header applies on those lanes.
	} else if (cliIdentity) {
		// An opted-in Go family key doubles as the session handle even under
		// the CLI identity; without one the conversation id is the handle.
		const sessionKey = options.cacheAffinity ?? sessionId;
		if (sessionKey) setHeader(headers, "x-opencode-session", sessionKey);
	} else if (isOpenCode) {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		// Go's session header doubles as the gateway's cache-affinity handle:
		// opted-in sibling lanes (see resolveOpenCodeGoCacheAffinity) share one
		// task cache key there; every other lane keeps the conversation id.
		const goSession = backend === "opencode-go" ? (options.cacheAffinity ?? sessionId) : sessionId;
		if (goSession) setHeader(headers, "x-opencode-session", goSession);
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
