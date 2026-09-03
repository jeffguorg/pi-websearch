/** Built-in search providers. External/provider-specific providers are plain
 *  strings (see SearchProviderExtension), so this union is only the known set. */
export type SearchProvider =
	| "exa"
	| "tavily"
	| "brave"
	| "duckduckgo-html"
	| "searxng"
	| "serper"
	| "google-cse"
	| "z-ai"
	| "openai"
	| "codex"
	| "openrouter"
	| "anthropic"
	| "perplexity"
	| "xai"
	| "kimi"
	| "deepseek";

export type SearchContextSize = "low" | "medium" | "high";
export type CodexSearchMode = "cached" | "live";
export type RoutingStrategy = "priority" | "round-robin" | "fill-first";

export interface SearchProviderConfig {
	id?: string;
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	/** Extra request headers merged into every call (e.g. reverse-proxy auth
	 *  in front of a self-hosted SearXNG). Overrides adapter-generated headers. */
	headers?: Record<string, string>;
	searchEngineId?: string;
	maxResults?: number;
	model?: string;
	codexMode?: CodexSearchMode;
	searchContextSize?: SearchContextSize;
	allowedDomains?: string[];
	blockedDomains?: string[];
	userLocation?: SearchUserLocation;
	openRouterRouting?: JsonObject;
	timeoutMs?: number;
}

export interface SearchProviderEntry extends SearchProviderConfig {
	priority?: number;
	weight?: number;
	/** Omit this chain entry when its plugin or credentials are unavailable. */
	optional?: boolean;
}

/** A provider entry resolved for execution. Native routes keep the active model
 * provider as provenance while adapter selects the wire protocol implementation. */
export interface SearchRoute extends SearchProviderEntry {
	source: "native" | "configured";
	adapter: string;
	headers?: Record<string, string>;
}

export interface WebsearchConfig {
	strategy: RoutingStrategy;
	fallback: boolean;
	auto: boolean;
	providers: SearchProviderEntry[];
}

export interface SearchUserLocation {
	country?: string;
	region?: string;
	city?: string;
	timezone?: string;
}

export interface SearchRequest {
	query: string;
	maxResults: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface SearchExecutionPolicy {
	useFallback: boolean;
	retryOnEmpty: boolean;
}

export interface BuiltSearchRequest {
	url: string;
	init: {
		method: "GET" | "POST";
		headers: Record<string, string>;
	};
	body?: JsonObject;
}

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	score?: number;
	source?: string;
	route?: string;
	publishedAt?: string;
}

export interface SearchDetails {
	provider: string;
	entryId?: string;
	query: string;
	results: SearchResultItem[];
	durationMs: number;
	truncated: boolean;
	strategy?: RoutingStrategy;
	attempts?: SearchAttempt[];
	answer?: string;
	error?: string;
}

export interface SearchProgressDetails {
	phase: "searching";
	query: string;
	providerLabels: string[];
	maxResults: number;
	currentProvider?: string;
	attempts?: SearchAttempt[];
	routeLabels?: string[];
	strategy?: RoutingStrategy;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export type ConfigLoadFailureReason = "missing_config" | "invalid_config" | "missing_api_key";

export interface SearchErrorDetails {
	phase: "error";
	query: string;
	error: string;
	reason?: ConfigLoadFailureReason;
}

export type SearchRenderDetails = SearchDetails | SearchProgressDetails | SearchErrorDetails;

export interface SearchAttempt {
	provider: string;
	entryId?: string;
	durationMs: number;
	resultsCount: number;
	error?: string;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type ConfigLoadResult =
	| { ok: true; config: WebsearchConfig; source: string }
	| {
			ok: false;
			reason: ConfigLoadFailureReason;
			message: string;
			source?: string;
	  };

export type ProviderValidationResult =
	| { ok: true; config: SearchProviderEntry }
	| { ok: false; reason: "invalid_config" | "missing_api_key" | "missing_config"; message: string };
