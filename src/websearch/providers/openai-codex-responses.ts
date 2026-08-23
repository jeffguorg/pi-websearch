import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import { normalizeResponsesPayload } from "./openai-responses.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { appendDomainFilters, isJsonObject } from "./shared.js";

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

function searchOnlyPrompt(query: string): string {
	return `Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: ${query}`;
}

function decodeJwtPayload(token: string): JsonObject {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) throw new Error("Invalid OpenAI Codex OAuth token");
	try {
		const decoded: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isJsonObject(decoded)) throw new Error("JWT payload is not an object");
		return decoded;
	} catch (error) {
		throw new Error(`Invalid OpenAI Codex OAuth token: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function accountIdFromToken(token: string): string {
	const payload = decodeJwtPayload(token);
	const auth = payload[ACCOUNT_CLAIM];
	if (!isJsonObject(auth) || typeof auth["chatgpt_account_id"] !== "string" || !auth["chatgpt_account_id"]) {
		throw new Error("OpenAI Codex OAuth token does not contain a ChatGPT account ID");
	}
	return auth["chatgpt_account_id"];
}

function safeUpstreamError(value: unknown, fallback: string): string {
	let message = fallback;
	if (typeof value === "string") message = value;
	if (isJsonObject(value) && typeof value["message"] === "string") message = value["message"];
	return message
		.replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted-jwt>")
		.slice(0, 500);
}

function parseEventData(block: string): string | undefined {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

export function parseCodexResponsesSse(bodyText: string): JsonObject {
	let completed: JsonObject | undefined;
	const output: JsonObject[] = [];
	let sawTerminalEvent = false;
	const normalizedBody = bodyText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

	for (const block of normalizedBody.split("\n\n")) {
		const data = parseEventData(block);
		if (!data) continue;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch (error) {
			throw new Error(`Invalid OpenAI Codex SSE JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isJsonObject(event)) continue;
		const type = event["type"];
		if (type === "error") {
			throw new Error(safeUpstreamError(event["error"] ?? event["message"], "OpenAI Codex web search failed"));
		}
		if (type === "response.failed") {
			const response = event["response"];
			const rawError = isJsonObject(response) ? response["error"] : event["error"];
			throw new Error(safeUpstreamError(rawError, "OpenAI Codex web search failed"));
		}
		if (type === "response.output_item.done") {
			const item = event["item"];
			if (isJsonObject(item)) output.push(item);
		}
		if (type === "response.completed" || type === "response.done") {
			sawTerminalEvent = true;
			const response = event["response"];
			if (isJsonObject(response)) {
				const status = response["status"];
				if (typeof status === "string" && status !== "completed") {
					throw new Error(
						safeUpstreamError(response["error"], `OpenAI Codex web search ended with status ${status}`),
					);
				}
				completed = response;
			}
		}
		if (type === "response.incomplete") {
			throw new Error("OpenAI Codex web search response was incomplete");
		}
	}

	if (!sawTerminalEvent) throw new Error("OpenAI Codex SSE stream ended before response.completed");
	if (completed) {
		const completedOutput = completed["output"];
		return Array.isArray(completedOutput) && completedOutput.length > 0 ? completed : { ...completed, output };
	}
	return { output };
}

export const openAiCodexResponsesProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (!config.apiKey) throw new Error("OpenAI Codex native search requires an OAuth access token");
		const query = blockedDomains ? appendDomainFilters(request.query, undefined, blockedDomains) : request.query;
		const webSearchTool: JsonObject = {
			type: "web_search",
			external_web_access: (config.codexMode ?? "live") === "live",
		};
		if (config.searchContextSize) webSearchTool["search_context_size"] = config.searchContextSize;
		if (allowedDomains) webSearchTool["filters"] = { allowed_domains: allowedDomains };

		return {
			url: config.baseUrl ?? "",
			init: {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"chatgpt-account-id": accountIdFromToken(config.apiKey),
					originator: "pi",
					"OpenAI-Beta": "responses=experimental",
					Accept: "text/event-stream",
					"Content-Type": "application/json",
				},
			},
			body: {
				model: config.model ?? "gpt-5.6-sol",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: searchOnlyPrompt(query) }],
					},
				],
				tools: [webSearchTool],
				include: ["web_search_call.action.sources"],
				tool_choice: "required",
				store: false,
				stream: true,
			},
		};
	},
	parseResponseBody: parseCodexResponsesSse,
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: false });
	},
};
