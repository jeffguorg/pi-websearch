import { isAllowedNativeProviderBaseUrl } from "./provider-endpoints.js";
import { bearerToken } from "./providers/shared.js";
import { getExternalBindings } from "./providers.js";
import type { JsonObject, SearchRoute } from "./types.js";

export interface NativeModelInfo {
	provider: string;
	id: string;
	baseUrl: string;
	/** The protocol pi uses for this provider (e.g. "openai-completions", "anthropic-messages"). */
	api?: string;
	compat?: object;
}

export type NativeAuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface NativeModelRegistry {
	getApiKeyAndHeaders(model: NativeModelInfo): Promise<NativeAuthResult>;
}

export interface NativeProviderMapping {
	adapter: string;
	resource: string;
}

function directNativeMapping(model: NativeModelInfo): NativeProviderMapping | null {
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return { adapter: "openai-codex-responses", resource: "codex/responses" };
	}

	if (model.provider === "openai" && /^gpt-(4o|4\.1|5)/.test(model.id) && !model.id.includes("codex")) {
		return { adapter: "openai", resource: "responses" };
	}

	if (model.provider === "anthropic" && /^claude-/.test(model.id)) {
		return { adapter: "anthropic", resource: "messages" };
	}

	if ((model.provider === "xai" || model.provider === "x-ai") && /^grok-/.test(model.id)) {
		return { adapter: "xai", resource: "responses" };
	}

	if (model.provider === "perplexity" && /^sonar/.test(model.id)) {
		return { adapter: "perplexity", resource: "chat/completions" };
	}

	if ((model.provider === "z-ai" || model.provider === "zai") && /^glm-/.test(model.id)) {
		return { adapter: "z-ai", resource: "chat/completions" };
	}

	if (model.provider === "kimi-coding") {
		return { adapter: "kimi", resource: "search" };
	}

	// The current DeepSeek adapter emits Anthropic Messages payloads. Do not
	// claim support for OpenAI Responses until a separate adapter exists.
	if (model.provider === "deepseek" && model.api === "anthropic-messages") {
		return { adapter: "deepseek", resource: "messages" };
	}

	// All Zhipu Coding Plan models share the same remote web-search-prime MCP
	// server; the adapter ignores the chat baseUrl and always targets the MCP
	// endpoint, consuming the plan's bundled MCP quota.
	if (model.provider === "zai-coding-cn" || model.provider === "zai-coding") {
		return { adapter: "zai-coding-cn", resource: "mcp/web_search_prime/mcp" };
	}

	// All MiniMax models share the same adapter; the provider module dispatches
	// by key prefix (sk-cp- → bundled coding-plan REST search, otherwise →
	// server-tool web_search on the Anthropic Messages endpoint) and derives the
	// regional host from the model's baseUrl (minimax-cn → api.minimaxi.com,
	// minimax → api.minimax.io).
	if (model.provider === "minimax-cn" || model.provider === "minimax") {
		return { adapter: "minimax-cn", resource: "messages" };
	}

	return null;
}

export function nativeMapping(model: NativeModelInfo): NativeProviderMapping | null {
	if (model.provider === "openrouter") {
		const slashIndex = model.id.indexOf("/");
		if (slashIndex <= 0) return null;
		const effectiveProvider = model.id.slice(0, slashIndex);
		const effectiveId = model.id.slice(slashIndex + 1);
		if (effectiveProvider === "openrouter") return null;
		const upstream = directNativeMapping({ ...model, provider: effectiveProvider, id: effectiveId });
		return upstream ? { adapter: "openrouter", resource: "chat/completions" } : null;
	}

	const direct = directNativeMapping(model);
	if (direct) return direct;

	// External bindings may describe the active provider's native search wire
	// format. They never cause another model/provider to be discovered.
	for (const binding of getExternalBindings()) {
		try {
			if (binding.provider === model.provider && binding.match?.(model) && binding.resource) {
				return { adapter: binding.provider, resource: binding.resource };
			}
		} catch {
			// A broken optional binding must not disable configured fallback routes.
		}
	}

	return null;
}

function buildEndpointUrl(baseUrl: string, resource: string): string {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return baseUrl;
	}
	const trimmedPath = configured.pathname.replace(/\/+$/, "");
	const resourceSlash = `/${resource}`;
	if (trimmedPath.endsWith(resourceSlash)) {
		configured.pathname = trimmedPath;
	} else if (resource === "codex/responses") {
		configured.pathname = trimmedPath.endsWith("/codex")
			? `${trimmedPath}/responses`
			: `${trimmedPath}${resourceSlash}`;
	} else if (/\/v\d+$/.test(trimmedPath)) {
		configured.pathname = `${trimmedPath}${resourceSlash}`;
	} else {
		configured.pathname = `${trimmedPath}/v1${resourceSlash}`;
	}
	configured.hash = "";
	configured.search = "";
	return configured.href;
}

function isAllowedCodexEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/responses";
	} catch {
		return false;
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeOpenRouterRouting(model: NativeModelInfo): JsonObject | undefined {
	const compat = model.compat;
	if (!compat || !("openRouterRouting" in compat)) return undefined;
	return isJsonObject(compat.openRouterRouting) ? compat.openRouterRouting : undefined;
}

const AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

function hasResolvedAuthentication(auth: Extract<NativeAuthResult, { ok: true }>): boolean {
	if (auth.apiKey) return true;
	return Object.entries(auth.headers ?? {}).some(
		([name, value]) => AUTH_HEADER_NAMES.has(name.toLowerCase()) && value.trim().length > 0,
	);
}

export type NativeRouteResolution =
	| { kind: "unmatched" }
	| { kind: "ready"; route: SearchRoute }
	| { kind: "error"; provider: string; message: string };

/** Resolve at most one native route, exclusively from the active model. */
export async function resolveNativeEntry(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
	id = "native",
): Promise<NativeRouteResolution> {
	if (!model) return { kind: "unmatched" };

	const mapping = nativeMapping(model);
	if (!mapping) return { kind: "unmatched" };
	if (!modelRegistry) {
		return { kind: "error", provider: model.provider, message: "Native search authentication is unavailable" };
	}
	const baseUrl = buildEndpointUrl(model.baseUrl, mapping.resource);
	if (
		!isAllowedNativeProviderBaseUrl(baseUrl) ||
		(mapping.adapter === "openai-codex-responses" && !isAllowedCodexEndpoint(baseUrl))
	) {
		return {
			kind: "error",
			provider: model.provider,
			message: `Native search endpoint is invalid for ${model.provider}/${model.id}`,
		};
	}

	let auth: NativeAuthResult;
	try {
		auth = await modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		return {
			kind: "error",
			provider: model.provider,
			message: `Native search authentication could not be resolved for ${model.provider}/${model.id}`,
		};
	}
	if (!auth.ok || !hasResolvedAuthentication(auth)) {
		return {
			kind: "error",
			provider: model.provider,
			message: `Native search authentication could not be resolved for ${model.provider}/${model.id}`,
		};
	}
	const openRouterRouting = model.provider === "openrouter" ? activeOpenRouterRouting(model) : undefined;
	const codexApiKey =
		mapping.adapter === "openai-codex-responses" ? (auth.apiKey ?? bearerToken(auth.headers)) : undefined;
	if (mapping.adapter === "openai-codex-responses" && !codexApiKey) {
		return {
			kind: "error",
			provider: model.provider,
			message: `Native search OAuth token could not be resolved for ${model.provider}/${model.id}`,
		};
	}
	const resolvedApiKey = codexApiKey ?? auth.apiKey;
	const resolvedHeaders = mapping.adapter === "openai-codex-responses" ? undefined : auth.headers;

	return {
		kind: "ready",
		route: {
			id,
			source: "native",
			provider: model.provider,
			adapter: mapping.adapter,
			...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
			...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
			...(openRouterRouting ? { openRouterRouting } : {}),
			baseUrl,
			model: model.id,
			priority: -1,
		},
	};
}

export async function buildNativeEntry(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
	id = "native",
): Promise<SearchRoute | null> {
	const resolution = await resolveNativeEntry(model, modelRegistry, id);
	return resolution.kind === "ready" ? resolution.route : null;
}
