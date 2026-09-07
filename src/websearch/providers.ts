import { anthropicProvider } from "./providers/anthropic.js";
import { braveProvider } from "./providers/brave.js";
import { deepseekProvider } from "./providers/deepseek.js";
import { duckDuckGoHtmlProvider } from "./providers/duckduckgo-html.js";
import { exaProvider } from "./providers/exa.js";
import { googleCseProvider } from "./providers/google-cse.js";
import { kimiProvider } from "./providers/kimi.js";
import { minimaxCnProvider } from "./providers/minimax-cn.js";
import { openAiCodexResponsesProvider } from "./providers/openai-codex-responses.js";
import { openAiResponsesProvider } from "./providers/openai-responses.js";
import { openRouterProvider } from "./providers/openrouter.js";
import { perplexityProvider } from "./providers/perplexity.js";
import { searxngProvider } from "./providers/searxng.js";
import { serperProvider } from "./providers/serper.js";
import type { ProviderModule, SearchProviderExtension } from "./providers/shared.js";
import { DEFAULT_MAX_RESULTS, isJsonObject, parseObjectPayload, resolveDomainFilters } from "./providers/shared.js";
import { tavilyProvider } from "./providers/tavily.js";
import { xaiProvider } from "./providers/xai.js";
import { zAiProvider } from "./providers/z-ai.js";
import { zaiCodingCnProvider } from "./providers/zai-coding-cn.js";
import type {
	BuiltSearchRequest,
	JsonObject,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
	SearchRoute,
} from "./types.js";

const PROVIDER_MODULES: Record<string, ProviderModule> = {
	exa: exaProvider,
	tavily: tavilyProvider,
	brave: braveProvider,
	"duckduckgo-html": duckDuckGoHtmlProvider,
	searxng: searxngProvider,
	serper: serperProvider,
	"google-cse": googleCseProvider,
	"z-ai": zAiProvider,
	openai: openAiResponsesProvider,
	codex: openAiResponsesProvider,
	openrouter: openRouterProvider,
	anthropic: anthropicProvider,
	perplexity: perplexityProvider,
	xai: xaiProvider,
	kimi: kimiProvider,
	deepseek: deepseekProvider,
	"openai-codex-responses": openAiCodexResponsesProvider,
	"minimax-cn": minimaxCnProvider,
	minimax: minimaxCnProvider,
	"zai-coding-cn": zaiCodingCnProvider,
};

/** External provider names registered via loadExternalProviderExtensions(). */
const EXTERNAL_PROVIDERS = new Set<string>();

/** Native auto-route bindings contributed by external scripts. */
const EXTERNAL_BINDINGS: SearchProviderExtension[] = [];

/** Per-provider API cap for result counts, undefined when the provider takes no count parameter. */
export function providerMaxResultsLimit(provider: string): number | undefined {
	return PROVIDER_MODULES[provider]?.maxResultsLimit;
}

export function isKnownProvider(provider: string): boolean {
	return provider in PROVIDER_MODULES;
}

export function isRegisteredProvider(provider: string): boolean {
	return isKnownProvider(provider) || EXTERNAL_PROVIDERS.has(provider);
}

/** True for providers registered by an external (scriptable) extension. */
export function isExternalProvider(provider: string): boolean {
	return EXTERNAL_PROVIDERS.has(provider);
}

export function getExternalBindings(): SearchProviderExtension[] {
	return EXTERNAL_BINDINGS;
}

export function registerProviderExtension(extension: SearchProviderExtension): void {
	if (!extension?.provider) return;
	const hasDirectSearch = typeof extension.search === "function";
	const hasHttpAdapter =
		typeof extension.buildRequest === "function" && typeof extension.normalizeResponse === "function";
	if (!hasDirectSearch && !hasHttpAdapter) {
		throw new Error(`Search provider ${extension.provider} must implement search or an HTTP adapter`);
	}
	if ((extension.match === undefined) !== (extension.resource === undefined)) {
		throw new Error(`Search provider ${extension.provider} must define both match and resource for native routing`);
	}
	if (isRegisteredProvider(extension.provider)) {
		throw new Error(`Search provider already registered: ${extension.provider}`);
	}
	PROVIDER_MODULES[extension.provider] = extension;
	EXTERNAL_PROVIDERS.add(extension.provider);
	EXTERNAL_BINDINGS.push(extension);
}

const AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

function mergeResolvedHeaders(
	base: Record<string, string>,
	overrides: Record<string, string>,
	dropGeneratedAuthentication: boolean,
): Record<string, string> {
	const merged = Object.fromEntries(
		Object.entries(base).filter(
			([name, value]) =>
				value.trim().length > 0 && !(dropGeneratedAuthentication && AUTH_HEADER_NAMES.has(name.toLowerCase())),
		),
	);
	for (const [overrideName, value] of Object.entries(overrides)) {
		const existingName = Object.keys(merged).find((name) => name.toLowerCase() === overrideName.toLowerCase());
		if (existingName) delete merged[existingName];
		merged[overrideName] = value;
	}
	return merged;
}

export function buildSearchRequest(
	config: SearchProviderConfig | SearchRoute,
	request: SearchRequest,
): BuiltSearchRequest {
	const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
	const { allowedDomains, blockedDomains } = resolveDomainFilters(config, request);
	const adapter = "adapter" in config ? config.adapter : config.provider;
	const module = PROVIDER_MODULES[adapter];
	if (!module) {
		throw new Error(`Unknown search adapter: ${adapter}`);
	}
	if (!module.buildRequest) {
		throw new Error(`Search adapter ${adapter} does not use the HTTP transport`);
	}
	const built = module.buildRequest({
		config,
		request,
		maxResults,
		allowedDomains,
		blockedDomains,
	});
	if (!("headers" in config) || !config.headers) return built;
	const headerAuthentication = Object.entries(config.headers).some(
		([name, value]) => AUTH_HEADER_NAMES.has(name.toLowerCase()) && value.trim().length > 0,
	);
	return {
		...built,
		init: {
			...built.init,
			headers: mergeResolvedHeaders(built.init.headers, config.headers, !config.apiKey && headerAuthentication),
		},
	};
}

function isSearchResultItem(value: unknown): value is SearchResultItem {
	if (!isJsonObject(value)) return false;
	const item = value;
	if (typeof item["title"] !== "string" || typeof item["url"] !== "string") return false;
	for (const key of ["snippet", "source", "route", "publishedAt"] as const) {
		if (item[key] !== undefined && typeof item[key] !== "string") return false;
	}
	return item["score"] === undefined || typeof item["score"] === "number";
}

export function parseSearchResponseBody(adapter: string, bodyText: string): JsonObject {
	const module = PROVIDER_MODULES[adapter];
	if (!module) throw new Error(`Unknown search adapter: ${adapter}`);
	if (module.parseResponseBody) return module.parseResponseBody(bodyText);
	if (!bodyText) return {};
	try {
		return parseObjectPayload(JSON.parse(bodyText));
	} catch {
		return {};
	}
}

export function normalizeSearchResponse(provider: string, payload: unknown): SearchResultItem[] {
	const module = PROVIDER_MODULES[provider];
	if (!module) {
		throw new Error(`Unknown search provider: ${provider}`);
	}
	if (!module.normalizeResponse) {
		throw new Error(`Search adapter ${provider} does not normalize HTTP responses`);
	}
	const results: unknown = module.normalizeResponse(parseObjectPayload(payload));
	if (!Array.isArray(results) || !results.every(isSearchResultItem)) {
		throw new Error(`Search adapter ${provider} returned invalid results`);
	}
	return results;
}

export async function executeDirectProviderSearch(
	config: SearchProviderConfig | SearchRoute,
	request: SearchRequest,
	signal: AbortSignal,
): Promise<SearchResultItem[] | undefined> {
	const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
	const { allowedDomains, blockedDomains } = resolveDomainFilters(config, request);
	const adapter = "adapter" in config ? config.adapter : config.provider;
	const module = PROVIDER_MODULES[adapter];
	if (!module?.search) return undefined;
	const results = await module.search({ config, request, maxResults, allowedDomains, blockedDomains }, signal);
	if (!Array.isArray(results) || !results.every(isSearchResultItem)) {
		throw new Error(`Search adapter ${adapter} returned invalid results`);
	}
	return results.slice(0, Math.max(1, maxResults));
}

export async function loadExternalProviderExtensions(directory: string): Promise<string[]> {
	type Dirent = import("node:fs").Dirent;
	const { readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { pathToFileURL } = await import("node:url");

	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return []; // directory doesn't exist yet
	}

	const loaded: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
		if (/\.(d\.ts)$/.test(entry.name)) continue;
		const filePath = join(directory, entry.name);
		try {
			const mod = await import(pathToFileURL(filePath).href);
			const extension = (mod.default ?? mod.extension ?? mod.providerExtension) as
				| SearchProviderExtension
				| undefined;
			if (!extension || typeof extension !== "object" || !extension.provider) {
				continue;
			}
			registerProviderExtension(extension);
			loaded.push(filePath);
		} catch (error) {
			console.error(`[pi-websearch] failed to load external provider ${filePath}:`, error);
		}
	}
	return loaded;
}
