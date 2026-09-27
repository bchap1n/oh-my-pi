/**
 * MCP MRTR (Multistep Request-Through-Response) helper.
 *
 * When a modern (`2026-07-28`) server completes a request with `resultType:
 * "input_required"`, the client must answer the server's `inputRequests` and
 * re-issue the original request with the responses. This module fulfills the
 * input requests OMP can answer (roots and optionally elicitation), declines
 * the ones it cannot, and returns the `inputResponses` map + echoed
 * `requestState` to splice back into the retried params.
 */
import type { MCPInputRequiredResult } from "./types";

/** Cap on MRTR rounds before giving up. */
export const MAX_MRTR_ROUNDS = 4;

interface ElicitRequest {
	method: string;
	params?: Record<string, unknown>;
}

export interface MCPMrtrHandlers {
	/** Resolve `roots/list` — same project-root as the default request handler. */
	listRoots: () => Promise<{ roots: Array<{ uri: string; name: string }> }>;
	/**
	 * Optional `elicitation/create` handler. When absent, elicitation requests
	 * are declined (OMP has no interactive MCP elicitation UI in this change).
	 */
	elicit?: (req: ElicitRequest) => Promise<unknown>;
}

export interface MCPFulfillResult {
	inputResponses: Record<string, unknown>;
	/** Echoed verbatim from the server when present. */
	requestState?: string;
}

/**
 * Fulfill the server's `inputRequests` for one MRTR round. Returns the
 * `inputResponses` map (keyed by the request ids the server supplied) plus the
 * echoed `requestState`, ready to splice into the retried request params.
 */
export async function fulfillInputRequired(
	result: MCPInputRequiredResult,
	handlers: MCPMrtrHandlers,
): Promise<MCPFulfillResult> {
	const inputResponses: Record<string, unknown> = {};

	for (const [inputId, request] of Object.entries(result.inputRequests ?? {})) {
		switch (request.method) {
			case "roots/list": {
				const { roots } = await handlers.listRoots();
				inputResponses[inputId] = { roots };
				break;
			}
			case "elicitation/create": {
				if (handlers.elicit) {
					inputResponses[inputId] = await handlers.elicit({ method: request.method, params: request.params });
				} else {
					inputResponses[inputId] = { action: "decline" };
				}
				break;
			}
			case "sampling/createMessage": {
				// `sampling` is not a declared client capability, so servers MUST NOT
				// send this. If one does, decline with a JSON-RPC-shaped error rather
				// than hanging — the server can fall back or surface its own error.
				inputResponses[inputId] = { code: -32021, message: "sampling not supported" };
				break;
			}
			default:
				// Unknown method — omit the key; the server may re-ask or error.
				break;
		}
	}

	return {
		inputResponses,
		...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
	};
}
