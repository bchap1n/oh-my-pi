/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { fulfillInputRequired, MAX_MRTR_ROUNDS } from "./mrtr";
import { isModernJsonRpcError, MCP_CLIENT_INFO, supportedVersionsFromError } from "./request-meta";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import { createHttpTransport } from "./transports/http";
import { collectXMcpParamHeaders } from "./transports/mcp-headers";
import { LegacySseConnectionTimeoutError, createSseTransport } from "./transports/sse";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPDiscoverResult,
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPImplementation,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPInputRequiredResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";
import {
	MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_META_SERVER_INFO,
	MCP_PROTOCOL_VERSION,
} from "./types";

/**
 * Resolve the project root as `{ uri, name }`, reading `getProjectDir()` at
 * call time so the root stays stable even if the process cwd changes during
 * tool execution. Shared by the default `roots/list` server-request handler and
 * MRTR's `roots/list` fulfillment.
 */
async function listProjectRoots(): Promise<{ roots: Array<{ uri: string; name: string }> }> {
	const cwd = getProjectDir();
	return {
		roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
	};
}

/** True when a result is an MRTR `input_required` payload awaiting fulfillment. */
function isInputRequired<T>(result: T): result is T & MCPInputRequiredResult {
	const r = result as { resultType?: string };
	return r.resultType === "input_required";
}

/**
 * Default handler for standard MCP server-to-client requests.
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list":
			return listProjectRoots();
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

/**
 * Create a transport for the given server config.
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
			return createHttpTransport(config as MCPHttpServerConfig);
		case "sse":
			return createSseTransport(config as MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Initialize connection with MCP server.
 */
async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		/** Called after notifications/initialized succeeds. */
		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: MCP_CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	// Echo the negotiated protocol version on every subsequent request. The MCP
	// Streamable HTTP spec requires the MCP-Protocol-Version header after
	// initialize; transports that don't need it ignore this.
	transport.setProtocolVersion?.(result.protocolVersion);

	// Send initialized before opening the optional GET SSE stream. Servers may
	// reject or terminate sessions that receive session traffic before this
	// notification; POST response streams already carry messages during setup.
	await transport.notify("notifications/initialized");

	await options?.onInitialized?.();

	return result;
}

/** Identifies an MCP server whose initial handshake exceeded its configured timeout. */
export class MCPConnectionTimeoutError extends Error {
	readonly serverName: string;
	readonly timeoutMs: number;

	constructor(serverName: string, timeoutMs: number) {
		super(`Connection to MCP server "${serverName}" timed out after ${describeMCPTimeout(timeoutMs)}`);
		this.name = "MCPConnectionTimeoutError";
		this.serverName = serverName;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Pick the modern protocol version to negotiate with a server, from the
 * versions it advertises. OMP's only modern RPC version is `2026-07-28`; if it
 * is not in `supported`, there is no mutually-known modern version to use.
 */
function pickModernVersion(supportedVersions: string[] | undefined): string {
	if (supportedVersions?.includes(MCP_PROTOCOL_VERSION)) return MCP_PROTOCOL_VERSION;
	throw new Error(
		`MCP server does not support protocol version ${MCP_PROTOCOL_VERSION} (advertised: ${
			supportedVersions?.join(", ") ?? "none"
		})`,
	);
}

/**
 * Probe a transport for modern (`2026-07-28`) support via `server/discover`.
 * The caller must have set `setEra("modern")` first so the probe carries modern
 * `_meta` (and HTTP headers).
 *
 * Returns `{ kind: "modern", discover, protocolVersion }` when the server
 * negotiated modern (retrying once on `-32022` with an advertised version), or
 * `{ kind: "legacy" }` when the server has no modern support. A modern
 * negotiation error we could not resolve (-32020/-32021, or -32022 with no
 * mutually-known version) is re-thrown so the caller does not misclassify a
 * live modern server as legacy.
 */
async function probeModern(
	transport: MCPTransport,
	options?: { signal?: AbortSignal },
): Promise<{ kind: "modern"; discover: MCPDiscoverResult; protocolVersion: string } | { kind: "legacy" }> {
	try {
		const discover = await transport.request<MCPDiscoverResult>("server/discover", {}, { signal: options?.signal });
		// A real modern `server/discover` MUST return a `supportedVersions`
		// array. A response without it (e.g. a legacy server that answers every
		// method with `{}`) is not a DiscoverResult — classify it legacy rather
		// than throwing.
		if (!Array.isArray(discover.supportedVersions)) {
			return { kind: "legacy" };
		}
		const protocolVersion = pickModernVersion(discover.supportedVersions);
		return { kind: "modern", discover, protocolVersion };
	} catch (error) {
		if (isModernJsonRpcError(error)) {
			// Retry once on `-32022` with an advertised mutually-known version.
			if ((error as { code?: number }).code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION) {
				const retryVersion = pickModernVersion(supportedVersionsFromError(error));
				transport.setProtocolVersion?.(retryVersion);
				const discover = await transport.request<MCPDiscoverResult>(
					"server/discover",
					{},
					{ signal: options?.signal },
				);
				return { kind: "modern", discover, protocolVersion: retryVersion };
			}
			// -32020/-32021 are client/header errors — the server is modern but
			// unreachable; propagate rather than falling back to legacy.
			throw error;
		}
		// Not a modern JSON-RPC error (e.g. -32601 method-not-found, or a legacy
		// 400/404/405, or a timeout) — treat as a legacy server.
		return { kind: "legacy" };
	}
}

/** Open the long-lived GET SSE listener on transports that support it. */
async function startSseIfSupported(transport: MCPTransport): Promise<void> {
	if ("startSSEListener" in transport && typeof transport.startSSEListener === "function") {
		await (transport as { startSSEListener(): Promise<void> }).startSSEListener();
	}
}

/**
 * Connect to an MCP server.
 * Has a 30 second timeout by default to prevent blocking startup.
 * Set OMP_MCP_TIMEOUT_MS=0 to disable MCP client-side timeouts.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	const timeoutError = new MCPConnectionTimeoutError(name, timeoutMs);
	let transport: MCPTransport | undefined;

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createTransport(config);
		if (options?.onNotification) {
			transport.onNotification = options.onNotification;
		}

		// Always handle standard MCP server-to-client requests (ping, roots/list).
		// The initialize request declares roots capability, so we must respond to
		// roots/list — even for short-lived test connections.
		transport.onRequest = options?.onRequest ?? defaultRequestHandler;

		try {
			// Modern era probe: HTTP + stdio servers get `server/discover` first
			// with modern `_meta`. A 2026-07-28 server answers with a
			// DiscoverResult; a legacy server answers with a method-not-found
			// error or a non-modern HTTP error, and we fall back to the legacy
			// initialize handshake. The deprecated legacy SSE transport
			// (2024-11-05) is legacy-only and never probed.
			const isLegacySse = config.type === "sse";
			if (!isLegacySse) transport.setEra?.("modern");
			const discoverResult = isLegacySse
				? { kind: "legacy" as const }
				: await probeModern(transport, { signal: options?.signal });

			if (discoverResult.kind === "modern") {
				const { discover, protocolVersion } = discoverResult;
				transport.setProtocolVersion?.(protocolVersion);
				const meta = (discover._meta ?? {}) as Record<string, unknown>;
				const metaInfo = meta[MCP_META_SERVER_INFO];
				const serverInfo: MCPImplementation =
					typeof metaInfo === "object" &&
					metaInfo !== null &&
					typeof (metaInfo as { name?: unknown }).name === "string"
						? {
								name: (metaInfo as { name: string }).name,
								version:
									typeof (metaInfo as { version?: unknown }).version === "string"
										? (metaInfo as { version: string }).version
										: "unknown",
							}
						: { name, version: "unknown" };
				return {
					name,
					config,
					transport,
					era: "modern" as const,
					protocolVersion,
					serverInfo,
					capabilities: discover.capabilities,
					instructions: discover.instructions,
				};
			}

			// Legacy fallback: era is legacy, so initialize with the legacy
			// protocol version.
			transport.setEra?.("legacy");
			const initResult = await initializeConnection(transport, {
				signal: options?.signal,
				async onInitialized() {
					// Open the SSE stream before sending initialized, so server-to-client
					// requests triggered by on_initialized (e.g. roots/list) are delivered.
					await startSseIfSupported(transport!);
				},
			});

			return {
				name,
				config,
				transport,
				era: "legacy" as const,
				protocolVersion: initResult.protocolVersion,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
			};
		} catch (error) {
			await transport.close();
			throw error;
		}
	};

	try {
		if (!isMCPTimeoutEnabled(timeoutMs)) {
			return await connect();
		}
		return await withTimeout(connect(), timeoutMs, timeoutError, options?.signal);
	} catch (error) {
		// If withTimeout rejected (timeout/abort) while connect() was still pending,
		// the transport may be alive with an open SSE listener. Close it.
		if (transport) {
			void transport.close().catch(() => {});
		}
		throw error instanceof LegacySseConnectionTimeoutError ? timeoutError : error;
	}
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	// Check if server supports tools
	if (!connection.capabilities.tools) {
		return [];
	}

	// Honor a modern `ttlMs` hint: tools are fresh until then; a `list_changed`
	// notification still clears `connection.tools` in the manager and forces a
	// refetch.
	const now = Date.now();
	if (connection.tools && connection.toolsCachedUntil !== undefined && now < connection.toolsCachedUntil) {
		return connection.tools;
	}
	// Fall back to today's "cache until list_changed / reconnect" behavior.
	if (connection.tools && connection.toolsCachedUntil === undefined) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;
	let ttlMs: number | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPToolsListResult>("tools/list", params, options);
		allTools.push(...result.tools);
		ttlMs = result.ttlMs;
		cursor = result.nextCursor;
	} while (cursor);

	// On HTTP, drop tools carrying an invalid `x-mcp-header` annotation (the
	// HTTP transport cannot encode them as `Mcp-Param-*` headers).
	const isHttp = connection.config.type === "http";
	const kept: MCPToolDefinition[] = [];
	for (const tool of allTools) {
		if (isHttp && collectXMcpParamHeaders(tool.inputSchema, {}).invalid) {
			logger.warn("Dropping MCP tool with invalid x-mcp-header annotation", { tool: tool.name });
			continue;
		}
		kept.push(tool);
	}

	// Cache tools
	connection.tools = kept;
	connection.toolsCachedUntil = ttlMs !== undefined ? now + ttlMs : undefined;

	return kept;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	const baseOptions: MCPRequestOptions = {
		...options,
		name: options?.name ?? toolName,
	};

	// On HTTP, compute `Mcp-Param-*` headers from the cached tool's schema so
	// the server can route on invocation parameters.
	if (connection.config.type === "http" && connection.tools) {
		const tool = connection.tools.find(t => t.name === toolName);
		if (tool) {
			const { headers } = collectXMcpParamHeaders(tool.inputSchema, args);
			if (Object.keys(headers).length > 0) {
				baseOptions.paramHeaders = { ...baseOptions.paramHeaders, ...headers };
			}
		}
	}

	let result = await connection.transport.request<MCPToolCallResult>(
		"tools/call",
		params as unknown as Record<string, unknown>,
		baseOptions,
	);

	// MRTR: a modern server may ask for input before completing the request.
	let rounds = 0;
	while (isInputRequired(result) && rounds < MAX_MRTR_ROUNDS) {
		const { inputResponses, requestState } = await fulfillInputRequired(result, {
			listRoots: listProjectRoots,
		});
		const params2: Record<string, unknown> = {
			name: toolName,
			arguments: args,
			inputResponses,
			...(requestState !== undefined ? { requestState } : {}),
		};
		result = await connection.transport.request<MCPToolCallResult>("tools/call", params2, baseOptions);
		rounds++;
	}

	if (result.resultType === "input_required") {
		throw new Error("MCP MRTR exceeded 4 rounds");
	}

	return result;
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourcesListResult>("resources/list", params, options);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

/** True when an error is a JSON-RPC "method not found" (-32601) response. */
function isMethodNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("-32601") || /method not found/i.test(message);
}

/**
 * List resource templates from a connected server.
 *
 * A server MAY advertise the `resources` capability without implementing the
 * optional `resources/templates/list` method (it is optional in the MCP spec).
 * Such servers reject the request with JSON-RPC -32601 ("Method not found").
 * Treat that as "no templates" and return `[]` rather than throwing — otherwise
 * a caller that loads resources and templates together (see `MCPManager`'s
 * `Promise.all([listResources, listResourceTemplates])`) would discard the
 * server's concrete resources too. Any other error still propagates.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	try {
		do {
			const params: Record<string, unknown> = {};
			if (cursor) {
				params.cursor = cursor;
			}

			const result = await connection.transport.request<MCPResourceTemplatesListResult>(
				"resources/templates/list",
				params,
				options,
			);
			allTemplates.push(...result.resourceTemplates);
			cursor = result.nextCursor;
		} while (cursor);
	} catch (error) {
		// A server that doesn't implement the optional templates method answers
		// -32601; cache an empty list so we neither retry nor let the failure
		// bubble up and discard the server's concrete resources.
		if (isMethodNotFoundError(error)) {
			connection.resourceTemplates = [];
			return [];
		}
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	const baseOptions: MCPRequestOptions = { ...options, name: options?.name ?? uri };
	let result = await connection.transport.request<MCPResourceReadResult>(
		"resources/read",
		params as unknown as Record<string, unknown>,
		baseOptions,
	);
	let rounds = 0;
	while (isInputRequired(result) && rounds < MAX_MRTR_ROUNDS) {
		const { inputResponses, requestState } = await fulfillInputRequired(result, {
			listRoots: listProjectRoots,
		});
		result = await connection.transport.request<MCPResourceReadResult>(
			"resources/read",
			{ uri, inputResponses, ...(requestState !== undefined ? { requestState } : {}) } as unknown as Record<
				string,
				unknown
			>,
			baseOptions,
		);
		rounds++;
	}
	if (isInputRequired(result)) {
		throw new Error("MCP MRTR exceeded 4 rounds");
	}
	return result;
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	// Modern-era `2026-07-28` servers manage resource subscriptions through the
	// `subscriptions/listen` filter (`resourceSubscriptions`), not per-URI
	// `resources/subscribe` RPCs. The manager owns the modern listen stream and
	// re-opens it with the updated URI list; here we no-op for modern.
	if (connection.era === "modern") return;
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	// Modern-era subscriptions are managed via the manager-owned listen stream.
	if (connection.era === "modern") return;
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPPromptsListResult>("prompts/list", params, options);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

/**
 * Get a specific prompt from a connected server.
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	const baseOptions: MCPRequestOptions = { ...options, name: options?.name ?? name };
	let result = await connection.transport.request<MCPGetPromptResult>(
		"prompts/get",
		params as unknown as Record<string, unknown>,
		baseOptions,
	);
	let rounds = 0;
	while (isInputRequired(result) && rounds < MAX_MRTR_ROUNDS) {
		const { inputResponses, requestState } = await fulfillInputRequired(result, {
			listRoots: listProjectRoots,
		});
		result = await connection.transport.request<MCPGetPromptResult>(
			"prompts/get",
			{
				name,
				...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
				inputResponses,
				...(requestState !== undefined ? { requestState } : {}),
			} as unknown as Record<string, unknown>,
			baseOptions,
		);
		rounds++;
	}
	if (isInputRequired(result)) {
		throw new Error("MCP MRTR exceeded 4 rounds");
	}
	return result;
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
