// Example external pi-websearch provider extension.
//
// Copy the *content* of this file to ~/.pi/websearch/providers/nutstore.ts
// (or any provider id you want) to register it. It is dependency-free on
// purpose so it loads in any runtime without module resolution.
//
// This example routes an OpenRouter-compatible proxy (Nutstore / Jianguoyun)
// through the `plugins: [{ id: "web" }]` mechanism, consuming the proxy
// account's own credits. The API key is resolved automatically from the active
// model, so no key is configured here.
//
// Expected export shape (default or named `extension`):
//   provider: string          - search provider id used in routing
//   resource: string          - endpoint resource appended to the model baseUrl
//   match(model)              - boolean; true when this handles the active model
//   buildRequest(ctx)         -> { url, init, body }
//   normalizeResponse(data)   -> SearchResultItem[]
//
// `ctx.config` carries { provider, baseUrl, apiKey, model, maxResults, ... }.
// `ctx.request` carries { query, allowedDomains, blockedDomains }.

function pick(obj: any, keys: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	for (const key of keys) {
		if (obj && obj[key] !== undefined) out[key] = obj[key];
	}
	return out;
}

export default {
	provider: "nutstore",
	resource: "chat/completions",
	match: (model: any) => model.provider === "nutstore",
	buildRequest: ({ config, request }: any) => ({
		// config.baseUrl is the active model endpoint + resource, e.g.
		// .../openrouter/v1/chat/completions.
		url: config.baseUrl,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey ?? ""}`,
			},
		},
		body: {
			model: config.model,
			messages: [{ role: "user", content: request.query }],
			plugins: [{ id: "web", search_prompt: request.query }],
		},
	}),
	normalizeResponse: (data: any) => {
		const message = data?.choices?.[0]?.message;
		const citations = Array.isArray(message?.web_search) ? message.web_search : [];
		return citations
			.filter((c: any) => c && c.url)
			.map((c: any) => pick(c, ["title", "url", "snippet"]));
	},
};