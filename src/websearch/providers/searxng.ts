import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchProviderConfig, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { appendDomainFilters, collect, getArray, getNumber, getObject, getString, result } from "./shared.js";

function searchUrl(config: SearchProviderConfig): string {
	return `${providerUrl(config).replace(/\/+$/, "")}/search`;
}

/** SearXNG metasearch. Self-hosted: requires an explicit baseUrl, needs no
 *  API key. Enable `formats: [json]` in the instance's settings.yml. */
export const searxngProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(searchUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("format", "json");
		return { url: url.toString(), init: { method: "GET", headers: { Accept: "application/json" } } };
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				const engines = getArray(item?.["engines"]).filter(
					(engine): engine is string => typeof engine === "string",
				);
				const parsed = result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["content"]),
					engines.length > 0 ? engines.join(", ") : undefined,
					getNumber(item?.["score"]),
				);
				const published = getString(item?.["publishedDate"]);
				if (parsed && published) parsed.publishedAt = published;
				return parsed;
			}),
		);
	},
};
