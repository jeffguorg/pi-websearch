import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModelInfo, NativeModelRegistry } from "../src/websearch/native.js";
import { createWebSearchTool, web_search } from "../src/websearch/tool.js";
import type {
	SearchDetails,
	SearchErrorDetails,
	SearchProgressDetails,
	SearchProviderEntry,
	WebsearchConfig,
} from "../src/websearch/types.js";

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function config(auto: boolean, maxResults?: number): WebsearchConfig {
	const provider: SearchProviderEntry = {
		id: "manual",
		provider: "exa",
		apiKey: "exa-test",
		baseUrl: "https://gateway.example.com/exa",
	};
	return {
		strategy: "priority",
		fallback: true,
		auto,
		providers: [maxResults === undefined ? provider : { ...provider, maxResults }],
	};
}

function codexToken(accountId = "account-test"): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function context(model: NativeModelInfo, apiKey = "native-test") {
	const modelRegistry: NativeModelRegistry = {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey };
		},
	};
	return { model, modelRegistry };
}

type NativeExecutionContext = ReturnType<typeof context>;
type ToolUpdate = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};
type NativeExecutable = {
	execute(
		toolCallId: string,
		params: {
			query: string;
			allowed_domains?: string[];
			blocked_domains?: string[];
			use_fallback?: boolean;
			retry_on_empty?: boolean;
		},
		signal: AbortSignal | undefined,
		onUpdate: ((update: ToolUpdate) => void) | undefined,
		ctx: NativeExecutionContext,
	): ReturnType<typeof web_search.execute>;
};

function withNativeExecutionContext(tool: ReturnType<typeof createWebSearchTool>): NativeExecutable {
	return tool as NativeExecutable;
}

describe("web_search tool definition", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("#given web search tool #when inspecting metadata #then exposes expected name and label", () => {
		// given / when / then
		expect(web_search.name).toBe("web_search");
		expect(web_search.label).toBe("Web Search");
		expect(web_search.description).toContain("Search the web");
	});

	it("#given web search parameters #when inspecting schema #then matches free-code shape", () => {
		// given
		const parameters = web_search.parameters;

		// when / then
		expect(parameters.required).toEqual(["query"]);
		expect(parameters.properties).toHaveProperty("query");
		expect(parameters.properties).toHaveProperty("allowed_domains");
		expect(parameters.properties).toHaveProperty("blocked_domains");
		expect(parameters.properties).toHaveProperty("use_fallback");
		expect(parameters.properties).toHaveProperty("retry_on_empty");
		expect(parameters.properties).not.toHaveProperty("maxResults");
		expect(parameters.additionalProperties).toBe(false);
	});

	it("#given auto enabled and matching active model #when executing #then prepends native provider", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			return jsonResponse({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ url: "https://native.example.com" }] },
					},
				],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "native route" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/v1/responses"]);
		expect(details.provider).toBe("openai");
		expect(details.entryId).toBe("native");
		expect(details.attempts?.map((attempt) => attempt.entryId)).toEqual(["native"]);
	});

	it("#given native failure and explicit fallback #when executing #then continues to the configured chain", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("responses")) return jsonResponse({ error: "native down" }, 503);
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback" }],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		const result = await tool.execute(
			"tool-call",
			{ query: "explicit fallback", use_fallback: true },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/v1/responses", "https://gateway.example.com/exa"]);
		expect(details.entryId).toBe("manual");
		expect(details.attempts?.map((attempt) => attempt.entryId)).toEqual(["native", "manual"]);
	});

	it("#given native empty result and retry_on_empty #when executing #then continues without marking native failed", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("responses")) return jsonResponse({ output: [] });
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback" }],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		const result = await tool.execute(
			"tool-call",
			{ query: "empty fallback", use_fallback: true, retry_on_empty: true },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/v1/responses", "https://gateway.example.com/exa"]);
		expect(details.entryId).toBe("manual");
		expect(details.attempts?.[0]).toMatchObject({ entryId: "native", resultsCount: 0 });
		expect(details.attempts?.[0]?.error).toBeUndefined();
	});

	it("#given native auth resolution failure and explicit fallback #when executing #then starts the configured chain", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback" }],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);
		const ctx = context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" });
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "not logged in" });

		const result = await tool.execute(
			"tool-call",
			{ query: "auth fallback", use_fallback: true },
			undefined,
			undefined,
			ctx,
		);

		expect(requestedUrls).toEqual(["https://gateway.example.com/exa"]);
		expect((result.details as SearchDetails).entryId).toBe("manual");
	});

	it("#given native auth lookup throws and explicit fallback #when executing #then starts the configured chain", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({
				results: [{ title: "Fallback", url: "https://fallback.example.com", text: "fallback" }],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);
		const ctx = context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" });
		ctx.modelRegistry.getApiKeyAndHeaders = async () => {
			throw new Error("credential store unavailable");
		};

		const result = await tool.execute(
			"tool-call",
			{ query: "thrown auth fallback", use_fallback: true },
			undefined,
			undefined,
			ctx,
		);

		expect(requestedUrls).toEqual(["https://gateway.example.com/exa"]);
		expect((result.details as SearchDetails).entryId).toBe("manual");
	});

	it("#given active OpenAI Codex model #when executing #then uses only the Codex SSE endpoint", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestedUrls.push(String(input));
			const headers = new Headers(init?.headers);
			expect(headers.get("chatgpt-account-id")).toBe("account-test");
			const response = {
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ url: "https://codex.example.com" }] },
					},
				],
			};
			return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		const result = await tool.execute(
			"tool-call",
			{ query: "Codex native route" },
			undefined,
			undefined,
			context(
				{
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					baseUrl: "https://chatgpt.com/backend-api",
					api: "openai-codex-responses",
				},
				codexToken(),
			),
		);

		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
		expect(details.provider).toBe("openai-codex");
		expect(details.entryId).toBe("native");
		expect(details.results).toEqual([{ title: "https://codex.example.com", url: "https://codex.example.com" }]);
	});

	it("#given native route and configured max results #when executing #then preserves configured limit", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({
				output: [
					{
						type: "web_search_call",
						action: {
							sources: [
								{ url: "https://one.example.com" },
								{ url: "https://two.example.com" },
								{ url: "https://three.example.com" },
							],
						},
					},
				],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true, 2), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "native route" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchDetails;
		expect(details.entryId).toBe("native");
		expect(details.results.map((item) => item.url)).toEqual(["https://one.example.com", "https://two.example.com"]);
	});

	it("#given auto disabled and matching active model #when executing #then does not prepend native provider", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			return jsonResponse({ results: [{ title: "Manual", url: "https://manual.example.com", text: "manual" }] });
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(false), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "manual route" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/exa"]);
		expect(details.provider).toBe("exa");
		expect(details.entryId).toBe("manual");
	});

	it("#given configured provider #when execution starts #then emits route progress details for the TUI", async () => {
		// given
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse({ results: [{ title: "Manual", url: "https://manual.example.com", text: "manual" }] });
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(false, 4), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "route progress" },
			undefined,
			(update) => updates.push(update),
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchDetails;
		expect(details.provider).toBe("exa");
		expect(updates[0]).toMatchObject({
			content: [{ type: "text", text: 'Searching "route progress" via exa/manual (max 4)' }],
			details: {
				phase: "searching",
				query: "route progress",
				providerLabels: ["exa/manual"],
				maxResults: 4,
			},
		});
		const progressUpdate = updates.find((u) => (u.details as SearchProgressDetails | undefined)?.currentProvider);
		expect(progressUpdate?.details).toMatchObject({ currentProvider: "exa/manual" });
		for (const update of updates) {
			for (const entry of update.content) {
				expect(entry.text ?? "").not.toMatch(/\[\d+\/\d+\]/);
			}
		}
	});

	it("#given an active native route #when emitting progress #then labels the active transport provider", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse({ search_results: [{ title: "Kimi", url: "https://kimi.example.com", summary: "result" }] }),
		);
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		await tool.execute(
			"tool-call",
			{ query: "native label" },
			undefined,
			(update) => updates.push(update),
			context({ provider: "kimi-coding", id: "k3", baseUrl: "https://api.kimi.com/coding" }),
		);

		const first = updates[0]?.details as SearchProgressDetails | undefined;
		expect(first?.providerLabels).toEqual(["kimi-coding/native"]);
		const progress = updates.find((u) => (u.details as SearchProgressDetails | undefined)?.currentProvider);
		expect(progress?.details).toMatchObject({ currentProvider: "kimi-coding/native" });
	});

	it("#given invalid domain filters #when executing #then returns error details without spoofing a provider", async () => {
		// given
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(false), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "bad filters", allowed_domains: ["example.com"], blocked_domains: ["example.org"] },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchErrorDetails;
		expect(details).toEqual({
			phase: "error",
			query: "bad filters",
			error: "Error: Cannot specify both allowed_domains and blocked_domains in the same request",
		});
		expect("provider" in details).toBe(false);
	});

	it("#given config load failure #when executing #then returns load error details without provider attribution", async () => {
		// given
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({
				ok: false,
				reason: "invalid_config",
				message: "Invalid provider config in .pi/websearch.json",
			})),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "config failure" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchErrorDetails;
		expect(details).toEqual({
			phase: "error",
			query: "config failure",
			error: "Invalid provider config in .pi/websearch.json",
			reason: "invalid_config",
		});
		expect("provider" in details).toBe(false);
	});

	it("#given unsupported active model and unrelated authenticated models #when executing #then uses only configured fallback", async () => {
		const requestedUrls: string[] = [];
		const getAvailable = vi.fn(() => {
			throw new Error("registry discovery must not run");
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			requestedUrls.push(String(input));
			return jsonResponse({ results: [{ title: "Manual", url: "https://manual.example.com", text: "manual" }] });
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);
		const ctx = context({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			baseUrl: "https://chatgpt.com/backend-api/codex",
		});
		Object.assign(ctx.modelRegistry, { getAvailable });

		const result = await tool.execute("tool-call", { query: "active only" }, undefined, undefined, ctx);

		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/exa"]);
		expect(details.provider).toBe("exa");
		expect(getAvailable).not.toHaveBeenCalled();
	});

	it("#given one tool instance switches models #when executing #then every call resolves only the current model", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			requests.push({ url, authorization: headers.get("authorization") ?? headers.get("x-api-key") });
			if (url.includes("responses")) {
				return jsonResponse({
					output: [{ type: "web_search_call", action: { sources: [{ url: "https://openai.example.com" }] } }],
				});
			}
			return jsonResponse({
				content: [
					{
						type: "web_search_tool_result",
						content: [{ title: "Claude", url: "https://anthropic.example.com", page_age: "today" }],
					},
				],
			});
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		const first = await tool.execute(
			"one",
			{ query: "one" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-5.5", baseUrl: "https://openai.gateway.example/v1" }, "openai-key"),
		);
		const second = await tool.execute(
			"two",
			{ query: "two" },
			undefined,
			undefined,
			context(
				{ provider: "anthropic", id: "claude-opus-5", baseUrl: "https://anthropic.gateway.example/v1" },
				"anthropic-key",
			),
		);

		expect(requests).toEqual([
			{ url: "https://openai.gateway.example/v1/responses", authorization: "Bearer openai-key" },
			{ url: "https://anthropic.gateway.example/v1/messages", authorization: "anthropic-key" },
		]);
		expect((first.details as SearchDetails).provider).toBe("openai");
		expect((second.details as SearchDetails).provider).toBe("anthropic");
	});

	it("#given auto enabled and unsupported active model #when executing #then does not prepend native provider", async () => {
		// given
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requestedUrls.push(url);
			return jsonResponse({ results: [{ title: "Manual", url: "https://manual.example.com", text: "manual" }] });
		});
		const tool = withNativeExecutionContext(
			createWebSearchTool(() => ({ ok: true, config: config(true), source: "test" })),
		);

		// when
		const result = await tool.execute(
			"tool-call",
			{ query: "manual route" },
			undefined,
			undefined,
			context({ provider: "openai", id: "gpt-3.5", baseUrl: "https://gateway.example.com/v1" }),
		);

		// then
		const details = result.details as SearchDetails;
		expect(requestedUrls).toEqual(["https://gateway.example.com/exa"]);
		expect(details.provider).toBe("exa");
		expect(details.entryId).toBe("manual");
	});
});
