import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { collect, contentHeaders, getArray, getObject, getString, result } from "./shared.js";

/**
 * DeepSeek native web search via DeepSeek's Anthropic-compatible endpoint
 * (https://api.deepseek.com/anthropic). Search runs through the server-side
 * `web_search_20260209` tool, consuming the DeepSeek account's own credits.
 *
 * Only valid when the active provider is `deepseek` with an
 * `anthropic-messages` (or `openai-responses`) API — see native.ts.
 */
export const deepseekProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const webSearchTool: JsonObject = {
			type: "server-tool",
			name: "web_search_20260209",
			tool_config: {
				search_provider: "you",
				edu_context: false,
			},
		};
		if (allowedDomains) webSearchTool["allowed_domains"] = allowedDomains;
		if (blockedDomains) webSearchTool["blocked_domains"] = blockedDomains;
		return {
			url: providerUrl(config),
			init: {
				method: "POST",
				headers: contentHeaders({
					"x-api-key": config.apiKey ?? "",
					"anthropic-version": "2023-06-01",
				}),
			},
			body: {
				model: config.model ?? "deepseek-v4-flash",
				max_tokens: 2048,
				messages: [{ role: "user", content: request.query }],
				tools: [webSearchTool],
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const content = getArray(data["content"]);
		const text = content
			.map(getObject)
			.map((item) => getString(item?.["text"]))
			.filter((value): value is string => value !== undefined)
			.join("\n");
		return collect(
			content.flatMap((raw) => {
				const item = getObject(raw);
				if (item?.["type"] !== "web_search_tool_result") return [];
				if (item?.["is_error"]) return [];
				return getArray(item["content"]).map((searchRaw) => {
					const searchItem = getObject(searchRaw);
					return result(
						getString(searchItem?.["title"]) ?? getString(searchItem?.["snippet"]),
						getString(searchItem?.["url"]),
						getString(searchItem?.["snippet"]) ?? text,
					);
				});
			}),
		);
	},
};
