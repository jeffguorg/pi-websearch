import { afterEach, describe, expect, it, vi } from "vitest";

import { createSearchRoutingState, formatSearchText, performSearch } from "../src/websearch/search.js";
import type { SearchDetails, SearchRoute, WebsearchConfig } from "../src/websearch/types.js";

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function nativeRoute(): SearchRoute {
	return {
		id: "native",
		source: "native",
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
			strategy: "priority",
			fallback: true,
			auto: true,
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
		const details = await performSearch(
			config,
			{ query: "route test", maxResults: 3 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

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

	it("#given round robin providers #when searching twice #then rotates starting provider", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			const title = url.includes("one") ? "One" : "Two";
			return jsonResponse({ results: [{ title, url: `https://${title.toLowerCase()}.example.com`, text: title }] });
		});
		const config: WebsearchConfig = {
			strategy: "round-robin",
			fallback: false,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};
		const state = createSearchRoutingState(config.providers.length);

		// when
		const first = await performSearch(config, { query: "rr", maxResults: 1 }, undefined, state);
		const second = await performSearch(config, { query: "rr", maxResults: 1 }, undefined, state);

		// then
		expect(requestedUrls).toEqual(["https://gateway.example.com/one", "https://gateway.example.com/two"]);
		expect(first.entryId).toBe("one");
		expect(second.entryId).toBe("two");
	});

	it("#given fill first providers #when first provider has insufficient unique results #then aggregates fallback results", async () => {
		// given
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("one")) {
				return jsonResponse({ results: [{ title: "Shared", url: "https://shared.example.com", text: "first" }] });
			}
			return jsonResponse({
				results: [
					{ title: "Shared duplicate", url: "https://shared.example.com", text: "duplicate" },
					{ title: "Second", url: "https://second.example.com", text: "second" },
				],
			});
		});
		const config: WebsearchConfig = {
			strategy: "fill-first",
			fallback: true,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};

		// when
		const details = await performSearch(
			config,
			{ query: "fill", maxResults: 2 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

		// then
		expect(details.strategy).toBe("fill-first");
		expect(details.provider).toBe("multiple");
		expect(details.results.map((result) => ({ url: result.url, route: result.route }))).toEqual([
			{ url: "https://shared.example.com", route: "exa/one" },
			{ url: "https://second.example.com", route: "exa/two" },
		]);
		expect(details.attempts?.map((attempt) => attempt.entryId)).toEqual(["one", "two"]);
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
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "primary", provider: "exa", baseUrl: "https://gateway.example.com/primary", priority: 0 },
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback", priority: 1 },
			],
		};

		// when
		const details = await performSearch(
			config,
			{ query: "empty route", maxResults: 3 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

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
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};

		// when
		const details = await performSearch(
			config,
			{ query: "nothing", maxResults: 2 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: true,
			},
		);

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
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [
				{ id: "empty", provider: "exa", baseUrl: "https://gateway.example.com/empty" },
				{ id: "failed", provider: "exa", baseUrl: "https://gateway.example.com/failed" },
			],
		};

		const details = await performSearch(
			config,
			{ query: "nothing", maxResults: 2 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: true,
			},
		);

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
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [{ id: "only", provider: "exa", baseUrl: "https://gateway.example.com/only" }],
		};

		// when
		const details = await performSearch(config, { query: "nothing", maxResults: 2 });

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
			strategy: "priority",
			fallback: false,
			auto: false,
			providers: [
				{ id: "direct", provider: "empty-error-direct" },
				{ id: "fallback", provider: "exa", baseUrl: "https://gateway.example.com/fallback" },
			],
		};

		const details = await performSearch(
			config,
			{ query: "empty error", maxResults: 1 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

		expect(requestedUrls).toEqual(["https://gateway.example.com/fallback"]);
		expect(details.entryId).toBe("fallback");
		expect(details.attempts?.[0]?.error).toBe("Search provider failed");
	});

	it("#given direct provider ignores abort #when timeout expires #then search returns a timeout failure", async () => {
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: false,
			auto: false,
			providers: [{ id: "direct", provider: "never-direct", timeoutMs: 20 }],
		};
		const { registerProviderExtension } = await import("../src/websearch/providers.js");
		registerProviderExtension({
			provider: "never-direct",
			search: async () => new Promise(() => undefined),
		});

		const details = await performSearch(config, { query: "timeout", maxResults: 1 });

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
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "hang", provider: "exa", baseUrl: "https://gateway.example.com/hang", timeoutMs: 50 },
				{ id: "quick", provider: "exa", baseUrl: "https://gateway.example.com/quick" },
			],
		};

		// when
		const details = await performSearch(
			config,
			{ query: "timeout route", maxResults: 1 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

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
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};

		// when / then
		await expect(
			performSearch(config, { query: "abort route", maxResults: 1 }, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchCalls).toBe(1);
	});

	it("#given http error with nested error message #when fetch fails #then surfaces the message", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({ error: { message: "max_tokens must be at least 1024" } }, 400);
		});
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test", maxResults: 1 });

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
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test", maxResults: 1 });

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
			strategy: "priority",
			fallback: false,
			auto: true,
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
		const details = await performSearch(config, { query: "test", maxResults: 1 });

		// then
		expect(details.error).toContain("HTTP 530");
		expect(details.error).toContain("error code: 530");
	});

	it("#given http error with empty body #when fetch fails #then keeps a minimal error", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => new Response("", { status: 502 }));
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test", maxResults: 1 });

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
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [
				{ id: "primary", provider: "exa", apiKey: "exa-test", baseUrl: "https://gateway.example.com/exa" },
			],
		};

		// when
		const details = await performSearch(config, { query: "test", maxResults: 1 });

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
			strategy: "priority",
			fallback: true,
			auto: true,
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
		const details = await performSearch(
			config,
			{ query: "test", maxResults: 1 },
			undefined,
			undefined,
			undefined,
			undefined,
			{
				useFallback: true,
				retryOnEmpty: false,
			},
		);

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
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "low", provider: "exa", baseUrl: "https://gateway.example.com/low", priority: 5 },
				{ id: "high", provider: "exa", baseUrl: "https://gateway.example.com/high", priority: 0 },
			],
		};

		// when
		await performSearch(
			reorderedConfig,
			{ query: "resolved order", maxResults: 1 },
			undefined,
			undefined,
			(providerLabel, attempts, routeLabels) => {
				listenerCalls.push({
					label: providerLabel,
					attempts: attempts.length,
					routeLabels: [...routeLabels],
				});
			},
			undefined,
			{ useFallback: true, retryOnEmpty: false },
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

	it("#given native success and round-robin configured routes #when searching repeatedly #then unused fallback does not rotate", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("native")) {
				return jsonResponse({
					output: [{ type: "web_search_call", action: { sources: [{ url: "https://native.example.com" }] } }],
				});
			}
			return jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example.com", text: "ok" }] });
		});
		const config: WebsearchConfig = {
			strategy: "round-robin",
			fallback: false,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};
		const state = createSearchRoutingState(config.providers.length);

		await performSearch(config, { query: "one", maxResults: 1 }, undefined, state, undefined, nativeRoute(), {
			useFallback: true,
			retryOnEmpty: false,
		});
		await performSearch(config, { query: "two", maxResults: 1 }, undefined, state);

		expect(requestedUrls).toEqual(["https://gateway.example.com/native", "https://gateway.example.com/one"]);
	});

	it("#given native and round-robin configured routes without explicit fallback #when searching repeatedly #then native remains exclusive", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse({
				results: [{ title: "Fallback", url: `https://result.example.com/${requestedUrls.length}`, text: "ok" }],
			});
		});
		const config: WebsearchConfig = {
			strategy: "round-robin",
			fallback: true,
			auto: true,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://gateway.example.com/one" },
				{ id: "two", provider: "exa", baseUrl: "https://gateway.example.com/two" },
			],
		};
		const state = createSearchRoutingState(config.providers.length);

		await performSearch(config, { query: "one", maxResults: 1 }, undefined, state, undefined, nativeRoute());
		await performSearch(config, { query: "two", maxResults: 1 }, undefined, state, undefined, nativeRoute());

		expect(requestedUrls).toEqual(["https://gateway.example.com/native", "https://gateway.example.com/native"]);
	});

	it("#given a native adapter throws without explicit fallback #when searching #then does not use configured routes", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example", text: "ok" }] });
		});
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [{ id: "manual", provider: "exa", baseUrl: "https://gateway.example.com/manual" }],
		};
		const brokenNative = { ...nativeRoute(), adapter: "missing-adapter" };

		const details = await performSearch(
			config,
			{ query: "adapter fallback", maxResults: 1 },
			undefined,
			undefined,
			undefined,
			brokenNative,
		);

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
			strategy: "priority",
			fallback: false,
			auto: true,
			providers: [{ id: "manual", provider: "exa", baseUrl: "https://gateway.example.com/manual" }],
		};

		const details = await performSearch(
			config,
			{ query: "no fallback", maxResults: 1 },
			undefined,
			undefined,
			undefined,
			nativeRoute(),
		);

		expect(requestedUrls).toEqual(["https://gateway.example.com/native"]);
		expect(details.attempts?.map((attempt) => `${attempt.provider}/${attempt.entryId}`)).toEqual(["openai/native"]);
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
			strategy: "priority",
			attempts: [{ provider: "openai", entryId: "native", durationMs: 7, resultsCount: 1 }],
		};

		expect(formatSearchText(details)).toContain("via openai/native (priority)");
	});
});
