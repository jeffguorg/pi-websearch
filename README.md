# pi-websearch

Provider-backed `web_search` tool for pi. It starts with zero configuration: supported active models use their own provider-native search, and all other models use DuckDuckGo HTML unless a config file overrides the fallback backend.

## Tool Schema

The public tool schema matches free-code:

```json
{
	"query": "The search query to use",
	"allowed_domains": ["example.com"],
	"blocked_domains": ["spam.example.com"],
	"use_fallback": false,
	"retry_on_empty": false
}
```

Only `query` is required. `allowed_domains` and `blocked_domains` are mutually exclusive for a single tool call. Result limits are configured per provider, not exposed in the tool schema.

Fallback is explicitly authorized per call. `use_fallback` defaults to `false`; when true, an operational failure advances to the next configured route. A successful empty response is returned immediately and is never labeled as a failure. Set both `use_fallback: true` and `retry_on_empty: true` to continue after an empty response.

## Configuration

The loader checks these files in order:

1. `.pi/websearch.json` in the current project
2. `~/websearch.json`
3. `~/.pi/websearch.json`

No config file is required for the default backend. For non-native providers, pi-websearch uses DuckDuckGo's HTML endpoint (`https://html.duckduckgo.com/html/`) because it is free and does not require an API key. Create a config file only when you want a different backend or routing policy.

Example override:

```json
{
	"backend": "perplexity",
	"apiKey": "pplx-...",
	"maxResults": 8,
	"allowedDomains": ["docs.example.com"]
}
```

Legacy configs that use `"provider"` instead of `"backend"` continue to work.

`fallback_chain` is the ordered set of configured routes considered after native search, or as the primary chain when no native route matches:

```json
{
	"strategy": "priority",
	"auto": true,
	"fallback_chain": [
		{
			"id": "tavily",
			"provider": "tavily",
			"apiKey": "<local-only-key>",
			"priority": 10,
			"maxResults": 8
		},
		{
			"id": "zai-coding-cn",
			"provider": "zai-coding-cn",
			"optional": true,
			"priority": 20
		},
		{
			"id": "minimax-cn",
			"provider": "minimax-cn",
			"optional": true,
			"priority": 30,
			"maxResults": 8
		},
		{
			"id": "external-command",
			"provider": "external-command",
			"optional": true,
			"priority": 40
		},
		{
			"id": "ddg",
			"provider": "duckduckgo-html",
			"priority": 50
		}
	]
}
```

### Native auto-route

When `auto` is `true` (the default) and the active pi model exposes a server-hosted search tool, the extension resolves one implicit `{ id: "native", ... }` route from `ExtensionContext.model` and its credentials from `ExtensionContext.modelRegistry.getApiKeyAndHeaders`. It never scans other available models and never borrows another provider's credentials. Switching models changes the route on the next tool call without a reload.

A matched native route is always attempted first. By default it remains exclusive because `use_fallback` defaults to `false`. A call with `use_fallback: true` may continue through `fallback_chain` after a native authentication, endpoint, adapter, timeout, or request failure. Empty native results stop successfully unless that same call also sets `retry_on_empty: true`. When no native route matches, the first available configured entry is the primary route.

Models that activate native routing (Q1 2026):

- `openai`: any id matching `/^gpt-(4o|4\.1|5)/` that does not contain `codex` — e.g. `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`, `gpt-5-pro`, `gpt-4.1-mini`, `gpt-4o-mini`; excludes `gpt-5.3-codex` / `gpt-5.3-codex-spark` and non-matching ids such as `gpt-4-turbo` or the o-series.
- `openai-codex`: models using `api: "openai-codex-responses"`. Requests use the active Pi OAuth token and ChatGPT account ID against `/backend-api/codex/responses`, with `store: false`, `stream: true`, and the hosted `web_search` tool.
- `anthropic`: any `claude-*` id (opus/sonnet/haiku/fable, dated or undated).
- `xai`: any `grok-*`.
- `perplexity`: any `sonar*` (search is intrinsic to Sonar models).
- `z-ai` or `zai`: any `glm-*`.
- `kimi-coding`: the `kimi-coding` provider (routes to the Kimi search endpoint).
- `deepseek`: the `deepseek` provider only when the model API is `anthropic-messages`. It routes to DeepSeek's Anthropic-compatible endpoint using `web_search_20260209`.
- `minimax-cn` (and its global alias `minimax`): any model registered under the `minimax-cn` / `minimax` pi providers. The adapter inspects the resolved API key: `sk-cp-…` (Token Plan / Coding Plan subscription) posts to the bundled `/v1/coding_plan/search` REST endpoint and consumes the plan's bundled search quota; any other prefix (e.g. `sk-api-…` pay-as-you-go) hits the Anthropic-compatible `/anthropic/v1/messages` endpoint with the `web_search_20250305` server tool (Beta) and is billed per request. The regional host is derived from the model's baseUrl (`minimax-cn` → `https://api.minimaxi.com`, `minimax` → `https://api.minimax.io`); no `uvx` subprocess is needed.
- `zai-coding-cn`: any model registered under the `zai-coding-cn` provider. The adapter connects to the GLM Coding Plan remote `web-search-prime` MCP server (`https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`) and consumes the plan's bundled MCP quota; it ignores the chat endpoint baseUrl derived from the model registry.
- `openrouter`: any `<provider>/<model>` whose upstream provider and model match one of the supported rows above. Requests stay on the active OpenRouter Chat Completions transport and use its `web` plugin; output is labeled `openrouter/native`, not as the upstream provider.

The native entry inherits `model.baseUrl` from `ExtensionContext.model`, so any local gateway override registered in the pi model registry is honored. Standard endpoints append `/v1/<resource>` when needed; Codex endpoints append `/codex/responses` without inserting `/v1`.

Routing strategies order `fallback_chain`; native search, when present, is prepended to that order:

- `priority`: try configured providers by ascending `priority`.
- `round-robin`: rotate configured providers.
- `fill-first`: collect unique results from configured providers until the limit is filled.

### Progress rendering

While a search is in flight, the TUI shows a single collapsed line for the provider currently being tried — no step counter, just the active source:

```
Searching "q" via duckduckgo-html/backup (max 10)
```

When expanded, a three-state route line is appended so you can see which sources already ran, which one is running, and which are still pending. Each entry is `provider/id` followed by its state: `failed`, the result count, `searching` (the entry at the current attempt index), or `pending`:

```
Searching "q" via duckduckgo-html/backup (max 10)
route exa/primary:failed -> duckduckgo-html/backup:searching -> brave/extra:pending
```

The active native route renders as `<active-provider>/native`, while configured routes render as `provider/id`. The finished render keeps the same spelling, e.g. `5 results via duckduckgo-html/backup (priority) in 320ms`, plus a `route ...` line of completed attempt states when expanded.

An optional entry can use `"optional": true`. If its provider plugin is not installed or its required API key is absent, the entry is omitted instead of invalidating the whole config. This is useful for machine-specific MCP or command bridges before a final `duckduckgo-html` entry.

Supported providers:

- `duckduckgo-html`: DuckDuckGo HTML search endpoint. Requires no `apiKey`; used as the zero-config default.
- `searxng`: self-hosted SearXNG metasearch. Requires `baseUrl` (plain HTTP and private/LAN hosts are allowed for this provider only); no `apiKey`. The instance must enable `formats: [json]` in `settings.yml`, otherwise it answers with HTTP 403. Reverse-proxy auth can be supplied via `headers`.
- `exa`: direct Exa search. Requires `apiKey`.
- `tavily`: direct Tavily search. Requires `apiKey`.
- `brave`: Brave Search API. Requires `apiKey`.
- `serper`: Serper Google search API. Requires `apiKey`.
- `google-cse`: Google Custom Search JSON API. Requires `apiKey` and `searchEngineId`.
- `z-ai`: Z.ai web search endpoint. Requires `apiKey`.
- `zai-coding-cn`: GLM Coding Plan 联网搜索 MCP (`web-search-prime` streamable HTTP server). Consumes the plan's bundled MCP quota instead of pay-per-use billing; requires a Coding Plan `apiKey` when configured explicitly. The default baseUrl is `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`; set `baseUrl` to `https://api.z.ai/api/mcp/web_search_prime/mcp` for the global host.
- `openai`: OpenAI Responses API hosted `web_search` tool. Requires `apiKey`.
- `codex`: OpenAI Responses API hosted `web_search` tool for explicitly configured API keys; this is separate from `openai-codex` OAuth auto-routing.
- `openrouter`: OpenRouter Chat Completions with the `web` plugin. Requires `apiKey` when configured explicitly.
- `anthropic`: Anthropic Messages API with server `web_search_20250305` tool. Requires `apiKey`.
- `perplexity`: Perplexity Search API. Requires `apiKey`.
- `xai`: xAI Responses API hosted `web_search` tool. Requires `apiKey`.
- `minimax-cn` / `minimax`: MiniMax web search (CN and global hosts). Dispatches by API key prefix: `sk-cp-…` posts to the bundled `/v1/coding_plan/search` REST endpoint (Token Plan bundled quota); any other key (typically `sk-api-…` for pay-as-you-go) hits the Anthropic-compatible `/anthropic/v1/messages` endpoint with the `web_search_20250305` server tool. Requires `apiKey`. The default baseUrl is `https://api.minimaxi.com/anthropic/v1/messages` for `minimax-cn` and `https://api.minimax.io/anthropic/v1/messages` for `minimax`; only the origin is used to pick the regional host.
- `deepseek`: DeepSeek's Anthropic-compatible endpoint with the server-side `web_search_20260209` tool. The key is resolved automatically from the active DeepSeek model, so no config entry is required.

Provider-specific optional fields include `id`, `baseUrl`, `headers`, `model`, `maxResults`, `priority`, `weight`, `searchContextSize`, `codexMode`, `allowedDomains`, `blockedDomains`, and `userLocation` where supported. `baseUrl` is supported for every provider and must be a public HTTPS URL without embedded credentials; self-hosted providers (`searxng`) may use plain HTTP and private hosts instead. `headers` is a string map merged into every request of that entry — use it for reverse-proxy authentication in front of self-hosted instances; it is stored in plaintext like `apiKey`.

Tool text and TUI output include the selected provider entry, routing strategy, and fallback attempts so the agent can see which provider produced the result.

### Scriptable provider extensions

In addition to the built-in providers, pi-websearch scans a directory of external provider scripts and registers them as first-class providers. A native binding is considered only for the current active model; it cannot trigger discovery of another model or provider.

The default scan directory is `~/.pi/websearch/providers/`. Every `*.ts` / `*.js` file there is dynamically imported; a module that exports a default object (or a named `extension` / `providerExtension`) with the following shape is registered:

```ts
export default {
	// Matches the active model to auto-route search to this provider.
	provider: "myprovider",
	resource: "chat/completions", // endpoint segment appended to the model baseUrl
	match: (model) => model.provider === "myprovider", // model: { provider, id, baseUrl, api }

	// Build the HTTP request. ctx.config has baseUrl/apiKey/model; ctx.request has query/domains.
	buildRequest: ({ config, request }) => ({
		url: config.baseUrl,
		init: { method: "POST", headers: { "Content-Type": "application/json" } },
		body: { model: config.model, messages: [{ role: "user", content: request.query }], /* ... */ },
	}),
	// Turn the JSON response into SearchResultItem[] ({ title, url, snippet }).
	normalizeResponse: (data) => [],
};
```

External scripts should be dependency-free (no imports) so they load in any runtime. A native binding supplies both `match` and `resource`; its predicate should check both the provider and, when needed, the model's `api` protocol (`anthropic-messages`, `openai-responses`, `openai-completions`, ...). Built-in native routing is checked before external `match` predicates, so a built-in row always wins for overlapping models.

A fallback-only plugin may omit `match`, `resource`, `buildRequest`, and `normalizeResponse` and implement `async search(ctx, signal)` instead. This direct adapter is the supported bridge for an MCP client or a safely bounded external command. Pi 0.84 exposes registered MCP tool metadata but no public API for one extension to invoke another tool, so pi-websearch cannot reuse `mcp_<server>_<tool>` registrations directly; an MCP plugin must own its MCP client and call `tools/call` itself. Command plugins should use a fixed executable and argv (`shell: false`), bounded JSON over stdin/stdout, a timeout/abort signal, and no model-controlled command string.

Examples:

- `examples/providers/nutstore.ts`: native Nutstore/OpenRouter bridge.
- `examples/providers/external-command.ts`: fallback-only, fixed-executable JSON-stdin bridge. Copy it into `~/.pi/websearch/providers/` and set `PI_WEBSEARCH_EXECUTABLE` to an absolute, trusted executable path.

The built-in `z-ai` HTTP adapter targets the pay-per-use Zhipu web_search REST API; `zai-coding-cn` targets the GLM Coding Plan bundled 联网搜索 MCP and consumes plan quota instead.

## Commands

```bash
npm test
npm run typecheck
npm run check
pi -e ./src/index.ts
```

Inside pi, run `/websearch status` to inspect activation state.

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.
