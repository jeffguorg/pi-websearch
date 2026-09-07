import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSearchText, performSearch } from "../src/websearch/search.js";
import type { SearchDetails, SearchRoute, WebsearchConfig } from "../src/websearch/types.js";

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function nativeRoute(): SearchRoute {
	return {
		id: "native",
		provider: "openai",
		adapter: "openai",
		apiKey: "native-test",
		baseUrl: "https://gateway.example.com/native",
		model: "gpt-5.5",
	};
}

describe("performSearch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("#given priority providers and fallback enabled #when primary fails #then returns fallback route details", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("primary")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback result" }],
			});
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{
					id: "primary",
					provider: "tavily",
					apiKey: "tavily-test",
					baseUrl: "https://gateway.example.com/primary",
					priority: 0,
				},
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback", priority: 1 },
			],
		};

		// when
		const details = await performSearch(config, { query: "route test" });

		// then
		expect(requestedUrls).toEqual(["https://gateway.example.com/primary", "https://gateway.example.com/fallback"]);
		expect(details.provider).toBe("exa");
		expect(details.entryId).toBe("fallback");
		expect(details.attempts).toEqual([
			{
				provider: "tavily",
				entryId: "primary",
				durationMs: expect.any(Number),
				resultsCount: 0,
				error: "Search failed with HTTP 503: down",
			},
			{ provider: "exa", entryId: "fallback", durationMs: expect.any(Number), resultsCount: 1 },
		]);
		expect(formatSearchText(details)).toContain("Routing attempts: tavily/primary failed");
	});

	it("#given fallback disabled #when primary fails #then configured fallback routes are not called", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("primary")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback result" }],
			});
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{
					id: "primary",
					provider: "tavily",
					apiKey: "tavily-test",
					baseUrl: "https://gateway.example.com/primary",
				},
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback" },
			],
		};

		// when
		const details = await performSearch(config, { query: "route test" });

		// then
		expect(requestedUrls).toEqual(["https://gateway.example.com/primary"]);
		expect(details.entryId).toBe("primary");
		expect(details.error).toBe("Search failed with HTTP 503: down");
		expect(details.attempts).toHaveLength(1);
	});

	it("#given empty results and retry_on_empty disabled #when searching #then returns successful empty result", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("primary")) return jsonResponse({ results: [] });
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback result" }],
			});
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "primary", provider: "exa", baseUrl: "https://gateway.example.com/primary", priority: 0 },
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback", priority: 1 },
			],
		};

		// when
		const details = await performSearch(config, { query: "empty route" });

		// then
		expect(requestedUrls).toEqual(["https://gateway.example.com/primary"]);
		expect(details.entryId).toBe("primary");
		expect(details.results).toHaveLength(0);
		expect(details.error).toBeUndefined();
		expect(details.attempts?.[0]).toMatchObject({ entryId: "primary", resultsCount: 0 });
		expect(details.attempts?.[0]?.error).toBeUndefined();
	});

	it("#given empty results and retry_on_empty enabled #when searching #then advances without marking empties failed", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({ results: [] }));
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};

		// when
		const details = await performSearch(config, { query: "nothing" }, undefined, undefined, undefined, true);

		// then
		expect(details.results).toHaveLength(0);
		expect(details.error).toBeUndefined();
		expect(details.entryId).toBe("two");
		expect(details.attempts).toHaveLength(2);
		expect(details.attempts?.every((attempt) => attempt.error === undefined)).toBe(true);
	});

	it("#given empty success followed by fallback failure #when retry_on_empty is enabled #then preserves empty success", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			calls += 1;
			return calls === 1 ? jsonResponse({ results: [] }) : jsonResponse({ error: "down" }, 503);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "empty", provider: "exa", baseUrl: "https://gateway.example.com/empty" },
				{ id: "failed", provider: "exa", baseUrl: "https://gateway.example.com/failed" },
			],
		};

		const details = await performSearch(config, { query: "nothing" }, undefined, undefined, undefined, true);

		expect(details.entryId).toBe("empty");
		expect(details.results).toEqual([]);
		expect(details.error).toBeUndefined();
		expect(details.attempts).toHaveLength(2);
		expect(details.attempts?.[1]?.error).toContain("HTTP 503");
	});

	it("#given empty results and fallback disabled #when searching #then returns empty success", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({ results: [] }));
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [{ id: "only", provider: "exa", baseUrl: "https://gateway.example.com/only" }],
		};

		// when
		const details = await performSearch(config, { query: "nothing" });

		// then
		expect(details.results).toHaveLength(0);
		expect(details.error).toBeUndefined();
	});

	it("#given direct provider throws an empty Error #when fallback is enabled #then treats it as failure", async () => {
		const { registerProviderExtension } = await import("../src/websearch/providers.js");
		registerProviderExtension({
			provider: "empty-error-direct",
			search: async () => {
				throw new Error();
			},
		});
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example.com", text: "ok" }] });
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: false,
			providers: [
				{ id: "direct", provider: "empty-error-direct" },
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback" },
			],
		};

		const details = await performSearch(config, { query: "empty error" });

		expect(requestedUrls).toEqual(["https://gateway.example.com/fallback"]);
		expect(details.entryId).toBe("fallback");
		expect(details.attempts?.[0]?.error).toBe("Search provider failed");
	});

	it("#given direct provider ignores abort #when timeout expires #then search returns a timeout failure", async () => {
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: false,
			providers: [{ id: "direct", provider: "never-direct", timeoutMs: 20 }],
		};
		const { registerProviderExtension } = await import("../src/websearch/providers.js");
		registerProviderExtension({
			provider: "never-direct",
			search: async () => new Promise(() => undefined),
		});

		const details = await performSearch(config, { query: "timeout" });

		expect(details.error).toContain("timed out after 20ms");
	});

	it("#given hanging provider with timeoutMs #when searching #then times out and falls through", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("hang")) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
			}
			return Promise.resolve(
				jsonResponse({ results: [{ title: "Quick", url: "https://quick.example.com", text: "quick" }] }),
			);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "hang", provider: "exa", baseUrl: "https://gateway.example.com/hang", timeoutMs: 50 },
				{ id: "quick", provider: "exa", baseUrl: "https://gateway.example.com/quick" },
			],
		};

		// when
		const details = await performSearch(config, { query: "timeout route" });

		// then
		expect(requestedUrls).toEqual(["https://gateway.example.com/hang", "https://gateway.example.com/quick"]);
		expect(details.entryId).toBe("quick");
		expect(details.attempts?.[0]?.error).toMatch(/timed out after 50ms/);
	});

	it("#given user abort mid-request #when aborted #then rethrows abort without trying next provider", async () => {
		// given
		const controller = new AbortController();
		let fetchCalls = 0;
		vi.stubGlobal("fetch", (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			fetchCalls += 1;
			queueMicrotask(() => controller.abort());
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};

		// when / then
		await expect(performSearch(config, { query: "abort route" }, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetchCalls).toBe(1);
	});

	it("#given http error with nested error message #when fetch fails #then surfaces the message", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({ error: { message: "max_tokens must be at least 1024" } }, 400);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toContain("HTTP 400");
		expect(details.error).toContain("max_tokens must be at least 1024");
	});

	it("#given http error with top-level error string #when fetch fails #then surfaces the error string", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({ error: "Bad Request" }, 400);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toContain("HTTP 400");
		expect(details.error).toContain("Bad Request");
	});

	it("#given http error with non-json body #when fetch fails #then surfaces the raw body", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return new Response("error code: 530", { status: 530, headers: { "Content-Type": "text/plain" } });
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{
					id: "primary",
					provider: "openai",
					apiKey: "openai-test",
					baseUrl: "https://gateway.example.com/v1/responses",
					model: "gpt-5.5",
				},
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toContain("HTTP 530");
		expect(details.error).toContain("error code: 530");
	});

	it("#given http error with empty body #when fetch fails #then keeps a minimal error", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => new Response("", { status: 502 }));
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toBe("Search failed with HTTP 502");
	});

	it("#given http error with very long body #when fetch fails #then truncates body in error", async () => {
		// given
		const longMessage = "x".repeat(2000);
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({ error: { message: longMessage } }, 400);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toContain("HTTP 400");
		expect((details.error ?? "").length).toBeLessThan(700);
		expect(details.error).toContain("…");
	});

	it("#given fallback chain all fail with bodies #when aggregating #then per-attempt details surface", async () => {
		// given
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("messages")) {
				return jsonResponse({ error: { message: "model not supported" } }, 400);
			}
			return new Response("origin unreachable", { status: 530, headers: { "Content-Type": "text/plain" } });
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{
					id: "native",
					provider: "anthropic",
					apiKey: "anthropic-test",
					baseUrl: "https://gateway.example.com/v1/messages",
				},
				{
					id: "openai-search",
					provider: "openai",
					apiKey: "openai-test",
					baseUrl: "https://gateway.example.com/v1/responses",
					model: "gpt-5.5",
				},
			],
		};

		// when
		const details = await performSearch(config, { query: "test" });

		// then
		expect(details.error).toContain("anthropic/native");
		expect(details.error).toContain("HTTP 400");
		expect(details.error).toContain("model not supported");
		expect(details.error).toContain("openai/openai-search");
		expect(details.error).toContain("HTTP 530");
		expect(details.error).toContain("origin unreachable");
	});

	it("#given priority reordered providers #when performSearch fires onAttempt #then routeLabels follow resolved order not config order", async () => {
		// given
		const listenerCalls: Array<{ label: string; attempts: number; routeLabels: string[] }> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("high")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback result" }],
			});
		});
		const reorderedConfig: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [
				{ id: "low", provider: "exa", baseUrl: "https://gateway.example.com/low", priority: 5 },
				{ id: "high", provider: "exa", baseUrl: "https://gateway.example.com/high", priority: 0 },
			],
		};

		// when
		await performSearch(
			reorderedConfig,
			{ query: "resolved order" },
			undefined,
			(providerLabel, attempts, routeLabels) => {
				listenerCalls.push({
					label: providerLabel,
					attempts: attempts.length,
					routeLabels: [...routeLabels],
				});
			},
		);

		// then
		// config order is [low, high] but priority resolves to [high, low]
		expect(listenerCalls).toHaveLength(2);
		expect(listenerCalls[0]?.label).toBe("exa/high");
		expect(listenerCalls[0]?.attempts).toBe(0);
		expect(listenerCalls[0]?.routeLabels).toEqual(["exa/high", "exa/low"]);
		expect(listenerCalls[1]?.label).toBe("exa/low");
		expect(listenerCalls[1]?.attempts).toBe(1);
		expect(listenerCalls[1]?.routeLabels).toEqual(["exa/high", "exa/low"]);
		// routeLabels[i] aligns with the i-th attempted provider
		expect(listenerCalls[0]?.routeLabels?.[0]).toBe(listenerCalls[0]?.label);
		expect(listenerCalls[1]?.routeLabels?.[1]).toBe(listenerCalls[1]?.label);
	});
	it("#given providers with and without a result-count parameter #when performSearch fires onAttempt #then reports the effective per-provider max results", async () => {
		// given
		const listenerCalls: Array<{ label: string; maxResults: number | undefined }> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("duckduckgo")) {
				return new Response('<html><body><div class="result"></div></body></html>', {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			return jsonResponse({ error: "down" }, 503);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: false,
			providers: [
				{ id: "capped", provider: "exa", baseUrl: "https://gateway.example.com/exa", maxResults: 30 },
				{ id: "default", provider: "exa", baseUrl: "https://gateway.example.com/exa2" },
				{ id: "no-param", provider: "duckduckgo-html" },
			],
		};

		// when
		await performSearch(
			config,
			{ query: "max results" },
			undefined,
			(providerLabel, _attempts, _routeLabels, maxResults) => {
				listenerCalls.push({ label: providerLabel, maxResults });
			},
		);

		// then
		expect(listenerCalls).toHaveLength(3);
		// exa caps at 20: configured 30 is clamped to the provider limit
		expect(listenerCalls[0]).toEqual({ label: "exa/capped", maxResults: 20 });
		// exa without configuration falls back to the default 10
		expect(listenerCalls[1]).toEqual({ label: "exa/default", maxResults: 10 });
		// duckduckgo-html takes no count parameter: no cap is reported
		expect(listenerCalls[2]).toEqual({ label: "duckduckgo-html/no-param", maxResults: undefined });
	});

	it("#given a native adapter throws and fallback is disabled #when searching #then does not use configured routes", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example", text: "ok" }] });
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [{ id: "manual", provider: "exa", baseUrl: "https://gateway.example.com/manual" }],
		};
		const brokenNative = { ...nativeRoute(), adapter: "missing-adapter" };

		const details = await performSearch(config, { query: "adapter fallback" }, undefined, undefined, brokenNative);

		expect(requestedUrls).toEqual([]);
		expect(details.entryId).toBe("native");
		expect(details.attempts?.[0]?.error).toBe("Unknown search adapter: missing-adapter");
	});

	it("#given native failure and fallback disabled #when searching #then configured routes are not called", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({ error: "down" }, 503);
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: false,
			enableNative: true,
			providers: [{ id: "manual", provider: "exa", baseUrl: "https://gateway.example.com/manual" }],
		};

		const details = await performSearch(config, { query: "no fallback" }, undefined, undefined, nativeRoute());

		expect(requestedUrls).toEqual(["https://gateway.example.com/native"]);
		expect(details.attempts?.map((attempt) => `${attempt.provider}/${attempt.entryId}`)).toEqual(["openai/native"]);
	});

	it("#given native failure and fallback enabled #when searching #then the configured chain runs", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse({
				results: [{ title: "Manual", url: "https://manual.example.com", text: "ok" }],
			});
		});
		const config: WebsearchConfig = {
			appendProvidersAsFallback: true,
			enableNative: true,
			providers: [{ id: "manual", provider: "exa", baseUrl: "https://gateway.example.com/manual" }],
		};

		const details = await performSearch(config, { query: "native walk" }, undefined, undefined, nativeRoute());

		expect(requestedUrls).toEqual(["https://gateway.example.com/native", "https://gateway.example.com/manual"]);
		expect(details.entryId).toBe("manual");
		expect(details.attempts?.map((attempt) => attempt.entryId)).toEqual(["native", "manual"]);
	});
});

describe("formatSearchText native entry label", () => {
	it("#given active native details #when formatting #then reports provider/native", () => {
		const details: SearchDetails = {
			provider: "openai",
			entryId: "native",
			query: "native label",
			results: [{ title: "Native", url: "https://example.com/native", snippet: "snip" }],
			durationMs: 7,
			truncated: false,
			attempts: [{ provider: "openai", entryId: "native", durationMs: 7, resultsCount: 1 }],
		};

		const formatted = formatSearchText(details);
		expect(formatted).toContain("via openai/native");
		expect(formatted).not.toContain("(priority)");
	});
});
