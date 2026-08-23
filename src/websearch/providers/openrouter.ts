import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { appendDomainFilters, collect, contentHeaders, getArray, getObject, getString, result } from "./shared.js";

export const openRouterProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const query = appendDomainFilters(request.query, allowedDomains, blockedDomains);
		const body: JsonObject = {
			model: config.model ?? "openrouter/auto",
			messages: [{ role: "user", content: query }],
			plugins: [{ id: "web", search_prompt: query }],
		};
		if (config.openRouterRouting) body["provider"] = config.openRouterRouting;
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const choice = getObject(getArray(data["choices"])[0]);
		const message = getObject(choice?.["message"]);
		const annotations = collect(
			getArray(message?.["annotations"]).map((raw) => {
				const annotation = getObject(raw);
				const citation = getObject(annotation?.["url_citation"]) ?? annotation;
				const url = getString(citation?.["url"]);
				return result(getString(citation?.["title"]) ?? url, url, getString(citation?.["content"]));
			}),
		);
		if (annotations.length > 0) return annotations;
		const webSearch = collect(
			getArray(message?.["web_search"]).map((raw) => {
				const item = getObject(raw);
				const url = getString(item?.["url"]) ?? getString(item?.["link"]);
				return result(getString(item?.["title"]) ?? url, url, getString(item?.["snippet"]));
			}),
		);
		if (webSearch.length > 0) return webSearch;
		return collect(
			getArray(data["citations"]).map((raw) => {
				const url = getString(raw);
				return result(url, url);
			}),
		);
	},
};
