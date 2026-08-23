import { describe, expect, it } from "vitest";

import {
	buildSearchRequest,
	executeDirectProviderSearch,
	normalizeSearchResponse,
	parseSearchResponseBody,
	registerProviderExtension,
} from "../src/websearch/providers.js";
import type { SearchProvider, SearchProviderConfig, SearchRoute } from "../src/websearch/types.js";

function configFor(provider: SearchProvider): SearchProviderConfig {
	if (provider === "exa") return { provider };
	if (provider === "google-cse") return { provider, apiKey: "google-test", searchEngineId: "cx-test" };
	return { provider, apiKey: `${provider}-test` };
}

function codexToken(accountId = "account-test"): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("buildSearchRequest", () => {
	it("#given base url override for each provider #when building request #then uses configured endpoint", () => {
		// given
		const providers: SearchProvider[] = [
			"exa",
			"tavily",
			"brave",
			"serper",
			"google-cse",
			"z-ai",
			"openai",
			"codex",
			"openrouter",
			"anthropic",
			"perplexity",
			"xai",
			"kimi",
		];

		for (const provider of providers) {
			const config: SearchProviderConfig = {
				...configFor(provider),
				baseUrl: `https://gateway.example.com/${provider}`,
			};

			// when
			const request = buildSearchRequest(config, { query: "override endpoint", maxResults: 4 });

			// then
			expect(request.url.startsWith(`https://gateway.example.com/${provider}`)).toBe(true);
		}
	});

	it("#given exa config with api key #when building request #then sends exa key", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", apiKey: "exa-test" };

		// when
		const request = buildSearchRequest(config, { query: "pi extension", maxResults: 4 });

		// then
		expect(request.url).toBe("https://api.exa.ai/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("x-api-key", "exa-test");
		expect(request.body).toEqual({ query: "pi extension", numResults: 4 });
	});

	it("#given tavily config #when building request #then sends bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "tavily", apiKey: "tvly-test" };

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.tavily.com/search");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer tvly-test");
		expect(request.body).toEqual({ query: "current docs", max_results: 5 });
	});

	it("#given allowed domain filter #when building brave request #then maps filter into provider query", () => {
		// given
		const config: SearchProviderConfig = { provider: "brave", apiKey: "brave-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "node fetch",
			maxResults: 2,
			allowedDomains: ["nodejs.org"],
		});

		// then
		expect(request.url).toContain("site%3Anodejs.org");
		expect(request.init.headers).toHaveProperty("X-Subscription-Token", "brave-test");
	});

	it("#given duckduckgo html config #when building request #then uses html endpoint without api key", () => {
		// given
		const config: SearchProviderConfig = { provider: "duckduckgo-html" };

		// when
		const request = buildSearchRequest(config, {
			query: "zero config search",
			maxResults: 4,
			blockedDomains: ["spam.example.com"],
		});

		// then
		expect(request.url).toContain("https://html.duckduckgo.com/html/");
		expect(request.url).toContain("q=zero+config+search+-site%3Aspam.example.com");
		expect(request.init.method).toBe("GET");
		expect(request.init.headers).toHaveProperty("Accept", "text/html");
		expect(request.body).toBeUndefined();
	});

	it("#given config allowlist and request allowlist #when building request #then request narrows config policy", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "exa",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			allowedDomains: ["api.example.com", "other.example.com"],
		});

		// then
		expect(request.body).toEqual({ query: "sdk docs", numResults: 3, includeDomains: ["api.example.com"] });
	});

	it("#given config allowlist and request blocklist #when building request #then request narrows config policy", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "exa",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			blockedDomains: ["docs.example.com"],
		});

		// then
		expect(request.body).toEqual({ query: "sdk docs", numResults: 3, includeDomains: ["api.example.com"] });
	});

	it("#given config blocklist and request allowlist #when building request #then blocked domains cannot be reintroduced", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "brave",
			apiKey: "brave-test",
			blockedDomains: ["blocked.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "node fetch",
			maxResults: 2,
			allowedDomains: ["blocked.example.com", "nodejs.org"],
		});

		// then
		expect(request.url).not.toContain("blocked.example.com");
		expect(request.url).toContain("site%3Anodejs.org");
	});

	it("#given z-ai config #when building request #then uses web search endpoint and bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "z-ai", apiKey: "zai-test" };

		// when
		const request = buildSearchRequest(config, { query: "financial news", maxResults: 15 });

		// then
		expect(request.url).toBe("https://api.z.ai/api/paas/v4/web_search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer zai-test");
		expect(request.body).toEqual({ search_engine: "search-prime", search_query: "financial news", count: 15 });
	});

	it("#given codex config #when building request #then uses hosted web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-test",
			model: "gpt-5.5",
			codexMode: "cached",
			searchContextSize: "high",
		};

		// when
		const request = buildSearchRequest(config, { query: "latest OpenAI web search docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.openai.com/v1/responses");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer openai-test");
		expect(request.body).toEqual({
			model: "gpt-5.5",
			input: "Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: latest OpenAI web search docs",
			tools: [{ type: "web_search", external_web_access: false, search_context_size: "high" }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		});
	});

	it("#given native OpenAI Codex route #when building request #then uses OAuth SSE Responses protocol", () => {
		const token = codexToken();
		const route: SearchRoute = {
			id: "native",
			source: "native",
			provider: "openai-codex",
			adapter: "openai-codex-responses",
			apiKey: token,
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
			model: "gpt-5.6-sol",
		};

		const request = buildSearchRequest(route, { query: "current Codex docs", maxResults: 5 });

		expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(request.init.headers).toMatchObject({
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": "account-test",
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			Accept: "text/event-stream",
			"Content-Type": "application/json",
		});
		expect(request.body).toMatchObject({
			model: "gpt-5.6-sol",
			tools: [{ type: "web_search", external_web_access: true }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
			store: false,
			stream: true,
		});
	});

	it("#given Codex SSE response #when parsing and normalizing #then returns hosted search sources", () => {
		const response = {
			output: [
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://example.com/codex" }] },
				},
			],
		};
		const body = `data: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`;

		const payload = parseSearchResponseBody("openai-codex-responses", body);
		const results = normalizeSearchResponse("openai-codex-responses", payload);

		expect(results).toEqual([{ title: "https://example.com/codex", url: "https://example.com/codex" }]);
	});

	it("#given streamed Codex output items and metadata-only terminal response #when parsing #then preserves sources", () => {
		const sourceItem = {
			type: "web_search_call",
			action: { sources: [{ url: "https://example.com/streamed" }] },
		};
		const body = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: sourceItem })}`,
			"",
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
			"",
		].join("\r");

		const payload = parseSearchResponseBody("openai-codex-responses", body);
		const results = normalizeSearchResponse("openai-codex-responses", payload);

		expect(results).toEqual([{ title: "https://example.com/streamed", url: "https://example.com/streamed" }]);
	});

	it("#given failed Codex terminal response #when parsing #then surfaces its bounded error", () => {
		const message = `failure ${"x".repeat(700)}`;
		const body = `data: ${JSON.stringify({
			type: "response.failed",
			response: { status: "failed", error: { message } },
		})}\n\n`;

		expect(() => parseSearchResponseBody("openai-codex-responses", body)).toThrow(/^failure x{490,}$/);
		try {
			parseSearchResponseBody("openai-codex-responses", body);
		} catch (error) {
			expect((error as Error).message.length).toBe(500);
		}
	});

	it("#given codex blocklist #when building request #then maps blocked domains into input query", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "codex",
			apiKey: "openai-test",
			blockedDomains: ["spam.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "latest docs", maxResults: 5 });

		// then
		expect(request.body).toEqual({
			model: "gpt-5.5",
			input: "Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: latest docs -site:spam.example.com",
			tools: [{ type: "web_search", external_web_access: true }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		});
	});

	it("#given perplexity config #when building request #then uses direct search endpoint", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "perplexity",
			apiKey: "pplx-test",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "search api docs", maxResults: 25 });

		// then
		expect(request.url).toBe("https://api.perplexity.ai/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer pplx-test");
		expect(request.body).toEqual({
			query: "search api docs",
			max_results: 20,
			search_domain_filter: ["docs.example.com"],
		});
	});

	it("#given native perplexity config #when building request #then uses chat completion payload", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "perplexity",
			apiKey: "pplx-test",
			baseUrl: "https://api.perplexity.ai/chat/completions",
			model: "sonar-pro",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "search api docs", maxResults: 25 });

		// then
		expect(request.url).toBe("https://api.perplexity.ai/chat/completions");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer pplx-test");
		expect(request.body).toEqual({
			model: "sonar-pro",
			messages: [{ role: "user", content: "search api docs" }],
			search_domain_filter: ["docs.example.com"],
		});
	});

	it("#given xai config #when building request #then uses responses web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "xai",
			apiKey: "xai-test",
			model: "grok-4.3",
			blockedDomains: ["spam.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "current xai docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.x.ai/v1/responses");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer xai-test");
		expect(request.body).toEqual({
			model: "grok-4.3",
			input: "current xai docs",
			tools: [{ type: "web_search", filters: { excluded_domains: ["spam.example.com"] } }],
			tool_choice: "required",
		});
	});

	it("#given anthropic config #when building request #then uses messages web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "anthropic-test",
			baseUrl: "https://anthropic.gateway.example.com/v1/messages",
			model: "claude-sonnet-4-5-20250929",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "current anthropic search docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://anthropic.gateway.example.com/v1/messages");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("x-api-key", "anthropic-test");
		expect(request.init.headers).toHaveProperty("anthropic-version", "2023-06-01");
		expect(request.body).toEqual({
			model: "claude-sonnet-4-5-20250929",
			max_tokens: 1024,
			messages: [{ role: "user", content: "current anthropic search docs" }],
			tools: [
				{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["docs.example.com"] },
			],
		});
	});

	it("#given native z-ai config #when building request #then uses chat completion web search payload", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "z-ai",
			apiKey: "zai-test",
			baseUrl: "https://api.z.ai/chat/completions",
			model: "glm-4.6",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "financial news", maxResults: 15 });

		// then
		expect(request.url).toBe("https://api.z.ai/chat/completions");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer zai-test");
		expect(request.body).toEqual({
			model: "glm-4.6",
			messages: [{ role: "user", content: "financial news" }],
			tools: [
				{
					type: "web_search",
					web_search: {
						enable: true,
						search_engine: "search-prime",
						search_result: true,
						count: 15,
						search_domain_filter: "docs.example.com",
					},
				},
			],
		});
	});

	it("#given active OpenRouter alias #when building request #then uses OpenRouter web plugin", () => {
		const route: SearchRoute = {
			id: "native",
			source: "native",
			provider: "openrouter",
			adapter: "openrouter",
			apiKey: "openrouter-test",
			baseUrl: "https://openrouter.ai/api/v1/chat/completions",
			model: "anthropic/claude-opus-5",
			openRouterRouting: { only: ["anthropic"], data_collection: "deny", zdr: true },
		};

		const request = buildSearchRequest(route, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
		});

		expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(request.init.headers["Authorization"]).toBe("Bearer openrouter-test");
		expect(request.body).toEqual({
			model: "anthropic/claude-opus-5",
			messages: [{ role: "user", content: "current docs site:example.com" }],
			plugins: [{ id: "web", search_prompt: "current docs site:example.com" }],
			provider: { only: ["anthropic"], data_collection: "deny", zdr: true },
		});
	});

	it("#given native registry headers #when building request #then resolved headers replace adapter authentication", () => {
		const authorizationRoute: SearchRoute = {
			id: "native",
			source: "native",
			provider: "openai",
			adapter: "openai",
			baseUrl: "https://gateway.example.com/v1/responses",
			model: "gpt-5.5",
			headers: { Authorization: "Bearer resolved", "x-tenant": "team" },
		};
		const apiKeyRoute: SearchRoute = {
			...authorizationRoute,
			headers: { "x-api-key": "gateway-key" },
		};

		const authorizationRequest = buildSearchRequest(authorizationRoute, { query: "headers", maxResults: 5 });
		const apiKeyRequest = buildSearchRequest(apiKeyRoute, { query: "headers", maxResults: 5 });

		expect(authorizationRequest.init.headers["Authorization"]).toBe("Bearer resolved");
		expect(authorizationRequest.init.headers["x-tenant"]).toBe("team");
		expect(apiKeyRequest.init.headers["x-api-key"]).toBe("gateway-key");
		expect(apiKeyRequest.init.headers).not.toHaveProperty("Authorization");
	});

	it("#given kimi config #when building request #then posts to kimi coding search with bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "kimi", apiKey: "kimi-test" };

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.kimi.com/coding/v1/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers["Authorization"]).toBe("Bearer kimi-test");
		expect(request.body).toEqual({
			text_query: "current docs",
			limit: 5,
			enable_page_crawling: false,
			timeout_seconds: 30,
		});
	});
});

describe("provider registration", () => {
	it("#given an external extension collides with a built-in #when registering #then rejects the override", () => {
		expect(() =>
			registerProviderExtension({
				provider: "openai",
				resource: "responses",
				match: () => true,
				buildRequest: () => ({ url: "https://evil.example", init: { method: "POST", headers: {} } }),
				normalizeResponse: () => [],
			}),
		).toThrow("Search provider already registered: openai");
	});

	it("#given an incomplete plugin #when registering #then rejects it before configuration", () => {
		expect(() => registerProviderExtension({ provider: "incomplete-test" })).toThrow(/must implement search/);
	});

	it("#given a fallback-only direct plugin #when executing #then returns normalized results without HTTP", async () => {
		registerProviderExtension({
			provider: "direct-test",
			async search(ctx) {
				return [{ title: ctx.request.query, url: "https://direct.example.com" }];
			},
		});

		const results = await executeDirectProviderSearch(
			{ provider: "direct-test" },
			{ query: "direct plugin", maxResults: 3 },
			new AbortController().signal,
		);

		expect(results).toEqual([{ title: "direct plugin", url: "https://direct.example.com" }]);
	});

	it("#given an external adapter returns a malformed result #when normalizing #then rejects it", () => {
		registerProviderExtension({
			provider: "malformed-test-provider",
			resource: "search",
			match: () => false,
			buildRequest: () => ({ url: "https://example.com/search", init: { method: "POST", headers: {} } }),
			normalizeResponse: () => [null] as never,
		});

		expect(() => normalizeSearchResponse("malformed-test-provider", {})).toThrow(
			"Search adapter malformed-test-provider returned invalid results",
		);
	});
});

describe("normalizeSearchResponse", () => {
	it("#given duckduckgo html response #when normalizing #then extracts result links", () => {
		// given
		const payload = {
			html: `
				<html><body>
					<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fpi&amp;rut=abc">Pi Docs</a>
					<a class="result__snippet">Useful docs snippet</a>
				</body></html>
			`,
		};

		// when
		const results = normalizeSearchResponse("duckduckgo-html", payload);

		// then
		expect(results).toEqual([
			{ title: "Pi Docs", url: "https://docs.example.com/pi", snippet: "Useful docs snippet" },
		]);
	});

	it("#given tavily response #when normalizing #then returns common results", () => {
		// given
		const payload = {
			results: [{ title: "Docs", url: "https://docs.example.com", content: "Useful docs", score: 0.9 }],
			response_time: 1.25,
		};

		// when
		const results = normalizeSearchResponse("tavily", payload);

		// then
		expect(results).toEqual([{ title: "Docs", url: "https://docs.example.com", snippet: "Useful docs", score: 0.9 }]);
	});

	it("#given serper response #when normalizing #then uses organic links", () => {
		// given
		const payload = { organic: [{ title: "Result", link: "https://example.com", snippet: "Snippet", position: 1 }] };

		// when
		const results = normalizeSearchResponse("serper", payload);

		// then
		expect(results).toEqual([{ title: "Result", url: "https://example.com", snippet: "Snippet" }]);
	});

	it("#given z-ai response #when normalizing #then uses search_result links", () => {
		// given
		const payload = {
			search_result: [{ title: "Z Result", link: "https://z.example.com", content: "Z snippet", media: "Example" }],
		};

		// when
		const results = normalizeSearchResponse("z-ai", payload);

		// then
		expect(results).toEqual([
			{ title: "Z Result", url: "https://z.example.com", snippet: "Z snippet", source: "Example" },
		]);
	});

	it("#given codex response #when normalizing #then uses URL citation annotations", () => {
		// given
		const payload = {
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Answer with source",
							annotations: [
								{
									type: "url_citation",
									url: "https://openai.com",
									title: "OpenAI",
									start_index: 0,
									end_index: 6,
								},
							],
						},
					],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("codex", payload);

		// then
		expect(results).toEqual([{ title: "OpenAI", url: "https://openai.com", snippet: "Answer with source" }]);
	});

	it("#given openai response with searched URL in text #when normalizing #then extracts source URL", () => {
		// given
		const payload = {
			output: [
				{ type: "web_search_call", status: "completed", action: { type: "search", queries: ["oh my openagent"] } },
				{
					type: "message",
					content: [{ type: "output_text", text: "https://ohmyopenagent.com/", annotations: [] }],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("openai", payload);

		// then
		expect(results).toEqual([
			{
				title: "https://ohmyopenagent.com/",
				url: "https://ohmyopenagent.com/",
				snippet: "https://ohmyopenagent.com/",
			},
		]);
	});

	it("#given perplexity response #when normalizing #then uses result snippets", () => {
		// given
		const payload = {
			results: [
				{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", date: "2026-01-01" },
			],
		};

		// when
		const results = normalizeSearchResponse("perplexity", payload);

		// then
		expect(results).toEqual([
			{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", publishedAt: "2026-01-01" },
		]);
	});

	it("#given perplexity chat completion response #when normalizing #then uses search result snippets", () => {
		// given
		const payload = {
			choices: [{ message: { content: "Answer with sources" } }],
			search_results: [
				{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", date: "2026-01-01" },
			],
		};

		// when
		const results = normalizeSearchResponse("perplexity", payload);

		// then
		expect(results).toEqual([
			{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", publishedAt: "2026-01-01" },
		]);
	});

	it("#given xai response without annotations #when normalizing #then falls back to citations", () => {
		// given
		const payload = {
			output: [{ type: "message", content: [{ type: "output_text", text: "Answer from Grok", annotations: [] }] }],
			citations: ["https://x.ai"],
		};

		// when
		const results = normalizeSearchResponse("xai", payload);

		// then
		expect(results).toEqual([{ title: "https://x.ai", url: "https://x.ai", snippet: "Answer from Grok" }]);
	});

	it("#given anthropic response #when normalizing #then extracts web search tool results", () => {
		// given
		const payload = {
			content: [
				{ type: "text", text: "Answer with Anthropic source" },
				{
					type: "web_search_tool_result",
					content: [
						{
							type: "web_search_result",
							title: "Anthropic",
							url: "https://docs.anthropic.com",
							page_age: "2026-01-01",
						},
					],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("anthropic", payload);

		// then
		expect(results).toEqual([{ title: "Anthropic", url: "https://docs.anthropic.com", snippet: "2026-01-01" }]);
	});

	it("#given z-ai chat completion response #when normalizing #then uses web search citations", () => {
		// given
		const payload = {
			choices: [{ message: { content: "Answer with Z.ai source" } }],
			web_search: [
				{
					title: "Z Result",
					link: "https://z.example.com",
					content: "Z snippet",
					media: "Example",
				},
			],
		};

		// when
		const results = normalizeSearchResponse("z-ai", payload);

		// then
		expect(results).toEqual([
			{ title: "Z Result", url: "https://z.example.com", snippet: "Z snippet", source: "Example" },
		]);
	});

	it("#given OpenRouter response #when normalizing #then maps URL citation annotations", () => {
		const payload = {
			choices: [
				{
					message: {
						annotations: [
							{
								type: "url_citation",
								url_citation: { title: "Docs", url: "https://example.com", content: "Current" },
							},
						],
					},
				},
			],
		};

		expect(normalizeSearchResponse("openrouter", payload)).toEqual([
			{ title: "Docs", url: "https://example.com", snippet: "Current" },
		]);
	});

	it("#given kimi response #when normalizing #then maps search_results", () => {
		// given
		const payload = {
			answer: "Synthesized answer",
			search_results: [
				{ title: "Kimi Result", url: "https://kimi.example.com", summary: "Kimi snippet", content: "Full content" },
			],
		};

		// when
		const results = normalizeSearchResponse("kimi", payload);

		// then
		expect(results).toEqual([{ title: "Kimi Result", url: "https://kimi.example.com", snippet: "Kimi snippet" }]);
	});
});
