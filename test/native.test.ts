import { describe, expect, it, vi } from "vitest";

import {
	buildNativeEntry,
	type NativeModelInfo,
	type NativeModelRegistry,
	nativeMapping,
} from "../src/websearch/native.js";

function model(
	provider: string,
	id: string,
	baseUrl = "https://gateway.example.com/v1",
	api?: string,
): NativeModelInfo {
	return { provider, id, baseUrl, ...(api ? { api } : {}) };
}

function registry(
	result: Awaited<ReturnType<NativeModelRegistry["getApiKeyAndHeaders"]>> = {
		ok: true,
		apiKey: "native-test",
	},
): NativeModelRegistry {
	return {
		async getApiKeyAndHeaders() {
			return result;
		},
	};
}

describe("active native route", () => {
	it("#given supported active models #when resolving #then preserves transport provenance and selects an adapter", async () => {
		const cases: Array<{
			model: NativeModelInfo;
			adapter: string;
			baseUrl: string;
			id: string;
		}> = [
			{
				model: model("openai", "gpt-5.5"),
				adapter: "openai",
				baseUrl: "https://gateway.example.com/v1/responses",
				id: "subrequest",
			},
			{
				model: model("anthropic", "claude-opus-5"),
				adapter: "anthropic",
				baseUrl: "https://gateway.example.com/v1/messages",
				id: "subrequest",
			},
			{
				model: model("xai", "grok-4.3"),
				adapter: "xai",
				baseUrl: "https://gateway.example.com/v1/responses",
				id: "subrequest",
			},
			{
				model: model("perplexity", "sonar-pro"),
				adapter: "perplexity",
				baseUrl: "https://gateway.example.com/v1/chat/completions",
				id: "subrequest",
			},
			{
				model: model("zai", "glm-5"),
				adapter: "z-ai",
				baseUrl: "https://gateway.example.com/v1/chat/completions",
				id: "subrequest",
			},
			{
				model: model("kimi-coding", "k3", "https://api.kimi.com/coding"),
				adapter: "kimi",
				baseUrl: "https://api.kimi.com/coding/v1/search",
				id: "api",
			},
			{
				model: model("deepseek", "deepseek-v4", "https://api.deepseek.com/anthropic/v1", "anthropic-messages"),
				adapter: "deepseek",
				baseUrl: "https://api.deepseek.com/anthropic/v1/tools/search",
				id: "api",
			},
			{
				model: model("minimax-cn", "minimax-M2.5", "https://api.minimaxi.com/anthropic/v1"),
				adapter: "minimax-cn",
				baseUrl: "https://api.minimaxi.com/anthropic/v1/messages",
				id: "subrequest",
			},
			{
				model: model("zai-coding-cn", "glm-4.7", "https://open.bigmodel.cn/api/coding/paas/v4"),
				adapter: "zai-coding-cn",
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/mcp/web_search_prime/mcp",
				id: "mcp",
			},
		];

		for (const testCase of cases) {
			const entry = await buildNativeEntry(testCase.model, registry());
			expect(entry).toEqual({
				id: testCase.id,
				provider: testCase.model.provider,
				adapter: testCase.adapter,
				apiKey: "native-test",
				baseUrl: testCase.baseUrl,
				model: testCase.model.id,
				priority: -1,
			});
		}
	});

	it("#given a MiniMax token plan key #when resolving #then labels the route as api", async () => {
		const entry = await buildNativeEntry(
			model("minimax-cn", "minimax-M2.5", "https://api.minimaxi.com/anthropic/v1"),
			registry({ ok: true, apiKey: "sk-cp-test" }),
		);

		expect(entry).toMatchObject({ id: "api", provider: "minimax-cn", adapter: "minimax-cn" });
	});

	it("#given an OpenRouter upstream alias #when resolving #then uses OpenRouter transport and provenance", async () => {
		const entry = await buildNativeEntry(
			model("openrouter", "anthropic/claude-opus-5", "https://openrouter.ai/api/v1"),
			registry(),
		);

		expect(entry).toMatchObject({
			provider: "openrouter",
			adapter: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/chat/completions",
			model: "anthropic/claude-opus-5",
		});
	});

	it("#given resolved provider headers #when resolving #then preserves them without requiring an api key", async () => {
		const headers = { Authorization: "Bearer gateway-token", "x-tenant": "team" };
		const entry = await buildNativeEntry(model("openai", "gpt-5.5"), registry({ ok: true, headers }));

		expect(entry).toMatchObject({ provider: "openai", adapter: "openai", headers });
		expect(entry).not.toHaveProperty("apiKey");
	});

	it("#given OpenAI Codex Responses #when resolving #then uses the Codex backend route", async () => {
		const entry = await buildNativeEntry(
			model("openai-codex", "gpt-5.6-sol", "https://chatgpt.com/backend-api", "openai-codex-responses"),
			registry(),
		);

		expect(entry).toMatchObject({
			provider: "openai-codex",
			adapter: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
			model: "gpt-5.6-sol",
		});
	});

	it("#given Codex OAuth supplied as an Authorization header #when resolving #then extracts its bearer token", async () => {
		const token = "header.payload.signature";
		const entry = await buildNativeEntry(
			model("openai-codex", "gpt-5.6-sol", "https://chatgpt.com/backend-api", "openai-codex-responses"),
			registry({ ok: true, headers: { Authorization: `Bearer ${token}`, "x-tenant": "ignored" } }),
		);

		expect(entry).toMatchObject({ apiKey: token });
		expect(entry).not.toHaveProperty("headers");
	});

	it("#given Codex OAuth with a non-ChatGPT endpoint #when resolving #then rejects the native route", async () => {
		const entry = await buildNativeEntry(
			model("openai-codex", "gpt-5.6-sol", "https://gateway.example.com", "openai-codex-responses"),
			registry(),
		);

		expect(entry).toBeNull();
	});

	it("#given unsupported or unverified models #when resolving #then skips native search", async () => {
		const auth = registry();
		expect(await buildNativeEntry(model("openai-codex", "gpt-5.6-sol"), auth)).toBeNull();
		expect(await buildNativeEntry(model("openai", "gpt-5.3-codex"), auth)).toBeNull();
		expect(await buildNativeEntry(model("openai", "o3"), auth)).toBeNull();
		expect(await buildNativeEntry(model("openrouter", "no-slash"), auth)).toBeNull();
		expect(await buildNativeEntry(model("custom", "gpt-5.5"), auth)).toBeNull();
	});

	it("#given unavailable authentication #when resolving #then returns null", async () => {
		expect(await buildNativeEntry(model("openai", "gpt-5.5"), registry({ ok: true }))).toBeNull();
		expect(
			await buildNativeEntry(
				model("openai", "gpt-5.5"),
				registry({ ok: true, headers: { "x-tenant": "team", "openai-beta": "responses" } }),
			),
		).toBeNull();
		expect(
			await buildNativeEntry(model("openai", "gpt-5.5"), registry({ ok: true, headers: { "x-api-key": "" } })),
		).toBeNull();
		expect(await buildNativeEntry(model("openai", "gpt-5.5"), registry({ ok: false, error: "missing" }))).toBeNull();
	});

	it("#given a trusted local active-model endpoint #when resolving #then preserves the local gateway", async () => {
		const entry = await buildNativeEntry(model("openai", "gpt-5.5", "http://127.0.0.1:8080/v1"), registry());

		expect(entry?.baseUrl).toBe("http://127.0.0.1:8080/v1/responses");
	});

	it("#given an invalid or credential-bearing endpoint #when resolving #then rejects it before authentication", async () => {
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "native-test" }));
		const unsafe = ["https://user:pass@gateway.example.com/v1", "ftp://gateway.example.com/v1", "not-a-url"];

		for (const baseUrl of unsafe) {
			expect(await buildNativeEntry(model("openai", "gpt-5.5", baseUrl), { getApiKeyAndHeaders })).toBeNull();
		}
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("#given a registry with legacy discovery surface #when resolving #then never scans available models", async () => {
		const getAvailable = vi.fn(() => {
			throw new Error("must not be called");
		});
		const modelRegistry = {
			getAvailable,
			async getApiKeyAndHeaders() {
				return { ok: true as const, apiKey: "native-test" };
			},
		};

		const entry = await buildNativeEntry(model("openai", "gpt-5.5"), modelRegistry);

		expect(entry?.provider).toBe("openai");
		expect(getAvailable).not.toHaveBeenCalled();
	});
});

describe("nativeMapping", () => {
	it("#given provider aliases #when matching #then adapter is separate from transport provenance", () => {
		expect(nativeMapping(model("zai", "glm-5"))).toEqual({
			adapter: "z-ai",
			resource: "chat/completions",
			id: "subrequest",
		});
		expect(nativeMapping(model("kimi-coding", "k3"))).toEqual({ adapter: "kimi", resource: "search", id: "api" });
		expect(nativeMapping(model("openrouter", "openai/gpt-5.5"))).toEqual({
			adapter: "openrouter",
			resource: "chat/completions",
			id: "subrequest",
		});
	});

	it("#given any minimax-cn model #when matching #then routes to minimax-cn adapter regardless of model id", () => {
		expect(nativeMapping(model("minimax-cn", "minimax-M2.5"))).toEqual({
			adapter: "minimax-cn",
			resource: "messages",
			id: "subrequest",
		});
		expect(nativeMapping(model("minimax-cn", "minimax-M3", "https://api.minimaxi.com/anthropic/v1"))).toEqual({
			adapter: "minimax-cn",
			resource: "messages",
			id: "subrequest",
		});
		expect(nativeMapping(model("minimax", "MiniMax-M3", "https://api.minimax.io/anthropic"))).toEqual({
			adapter: "minimax-cn",
			resource: "messages",
			id: "subrequest",
		});
	});

	it("#given any zai-coding-cn model #when matching #then routes to the web-search-prime MCP adapter regardless of model id", () => {
		expect(nativeMapping(model("zai-coding-cn", "glm-4.7"))).toEqual({
			adapter: "zai-coding-cn",
			resource: "mcp/web_search_prime/mcp",
			id: "mcp",
		});
		expect(nativeMapping(model("zai-coding", "glm-5"))).toEqual({
			adapter: "zai-coding-cn",
			resource: "mcp/web_search_prime/mcp",
			id: "mcp",
		});
	});
	it("#given any deepseek model #when matching #then routes to the standalone search api regardless of chat api", () => {
		expect(
			nativeMapping(model("deepseek", "deepseek-v4", "https://api.deepseek.com/anthropic/v1", "anthropic-messages")),
		).toEqual({
			adapter: "deepseek",
			resource: "tools/search",
			id: "api",
		});
		expect(nativeMapping(model("deepseek", "deepseek-v4", "https://api.deepseek.com", "openai-completions"))).toEqual(
			{
				adapter: "deepseek",
				resource: "tools/search",
				id: "api",
			},
		);
	});
});
