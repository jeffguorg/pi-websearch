import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchProviderConfig, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerToken,
	clamp,
	collect,
	contentHeaders,
	getArray,
	getNumber,
	getObject,
	getString,
	result,
} from "./shared.js";

const SEARCH_PATH = "/v1/tools/search";

/** DeepSeek documents the Search API at the account origin. Native routes
 *  inject the model's chat baseUrl, so anything not exactly the Search
 *  endpoint path is rebased onto its origin. */
function searchUrl(config: SearchProviderConfig): string {
	const configured = config.baseUrl;
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.pathname === SEARCH_PATH) return configured;
			return `${url.origin}${SEARCH_PATH}`;
		} catch {
			// fall through to the provider default
		}
	}
	return providerUrl(config);
}

function xApiKey(headers: Record<string, string> | undefined): string | undefined {
	const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "x-api-key")?.[1];
	return value?.trim() || undefined;
}

function apiKeyFor(config: SearchProviderConfig): string {
	return config.apiKey ?? bearerToken(config.headers) ?? xApiKey(config.headers) ?? "";
}

/**
 * DeepSeek web search via the standalone Search API
 * (https://api.deepseek.com/v1/tools/search), backed by DeepSeek's own search
 * engine and billed per request — no LLM tokens involved.
 */
export const deepseekProvider: ProviderModule = {
	maxResultsLimit: 50,
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		return {
			url: searchUrl(config),
			init: {
				method: "POST",
				headers: contentHeaders({ Authorization: `Bearer ${apiKeyFor(config)}` }),
			},
			body: {
				query: appendDomainFilters(request.query, allowedDomains, blockedDomains),
				count: clamp(maxResults, 1, 50),
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				const built = result(
					getString(item?.["title"]) ?? getString(item?.["snippet"]),
					getString(item?.["url"]),
					getString(item?.["snippet"]) ?? getString(item?.["summary"]),
					getString(item?.["site_name"]),
					getNumber(item?.["rerank_score"]),
				);
				const date = getString(item?.["date"]);
				if (built && date) built.publishedAt = date;
				return built;
			}),
		);
	},
};
