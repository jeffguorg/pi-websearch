import type {
	BuiltSearchRequest,
	JsonObject,
	JsonValue,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "../types.js";

const EMPTY_DOMAIN_SENTINEL = "invalid.invalid";

export interface BuildContext {
	config: SearchProviderConfig;
	request: SearchRequest;
	maxResults: number;
	allowedDomains: string[] | undefined;
	blockedDomains: string[] | undefined;
}

export interface ProviderModule {
	buildRequest?(ctx: BuildContext): BuiltSearchRequest;
	parseResponseBody?(bodyText: string): JsonObject;
	normalizeResponse?(data: JsonObject): SearchResultItem[];
	/** Execute without the built-in HTTP transport. Intended for trusted global
	 * plugins that own an MCP client or a bounded subprocess protocol. */
	search?(ctx: BuildContext, signal: AbortSignal): Promise<SearchResultItem[]>;
}

/** Model info passed to a native binding's `match()` for auto-routing. */
export interface NativeModelInfoFull {
	provider: string;
	id: string;
	baseUrl: string;
	/** The protocol pi uses for this provider (e.g. "openai-completions", "anthropic-messages"). */
	api?: string;
}

/**
 * A pluggable native-search binding. Lets an external script declare which
 * models it auto-routes for and which endpoint resource to hit.
 */
export interface NativeProviderBinding {
	/** The search provider id this binding powers (e.g. "deepseek", "nutstore"). */
	provider: string;
	/** Endpoint resource appended to the model's baseUrl (e.g. "messages", "chat/completions"). */
	resource: string;
	/** Return true when this binding should handle the given active model. */
	match(model: NativeModelInfoFull): boolean;
}

/**
 * Complete external provider definition. A script in the external providers
 * directory (default ~/.pi/websearch/providers/) exports this (default or
 * named `extension`) to register both the search module and the auto-routing.
 */
export interface SearchProviderExtension extends ProviderModule {
	provider: string;
	/** Optional native binding. Fallback-only plugins omit both fields. */
	resource?: string;
	match?(model: NativeModelInfoFull): boolean;
	/** Optional default base URL when the model doesn't provide one. */
	defaultBaseUrl?: string;
}

export function contentHeaders(extra?: Record<string, string>): Record<string, string> {
	return { Accept: "application/json", "Content-Type": "application/json", ...(extra ?? {}) };
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function appendDomainFilters(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	const parts = [query];
	for (const domain of allowedDomains ?? []) parts.push(`site:${domain}`);
	for (const domain of blockedDomains ?? []) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

export function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function nonEmptyDomains(values: string[]): string[] {
	return values.length > 0 ? values : [EMPTY_DOMAIN_SENTINEL];
}

export function resolveDomainFilters(
	config: SearchProviderConfig,
	request: SearchRequest,
): { allowedDomains?: string[]; blockedDomains?: string[] } {
	const configAllowed = config.allowedDomains;
	const configBlocked = config.blockedDomains;
	const requestAllowed = request.allowedDomains;
	const requestBlocked = request.blockedDomains;

	if (configAllowed) {
		const narrowed = requestAllowed
			? configAllowed.filter((domain) => requestAllowed.includes(domain))
			: configAllowed;
		const allowed = requestBlocked ? narrowed.filter((domain) => !requestBlocked.includes(domain)) : narrowed;
		return { allowedDomains: nonEmptyDomains(unique(allowed)) };
	}

	if (configBlocked) {
		const blocked = unique([...configBlocked, ...(requestBlocked ?? [])]);
		if (requestAllowed) {
			return { allowedDomains: nonEmptyDomains(requestAllowed.filter((domain) => !blocked.includes(domain))) };
		}
		return { blockedDomains: blocked };
	}

	if (requestAllowed) return { allowedDomains: unique(requestAllowed) };
	if (requestBlocked) return { blockedDomains: unique(requestBlocked) };
	return {};
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getObject(value: JsonValue | undefined): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function getArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

export function getString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function getNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function result(
	title: string | undefined,
	url: string | undefined,
	snippet?: string,
	source?: string,
	score?: number,
): SearchResultItem | null {
	if (!title || !url) return null;
	const item: SearchResultItem = { title, url };
	if (snippet) item.snippet = snippet;
	if (source) item.source = source;
	if (score !== undefined) item.score = score;
	return item;
}

export function collect(items: Array<SearchResultItem | null>, max = 50): SearchResultItem[] {
	return items.filter((item): item is SearchResultItem => item !== null).slice(0, max);
}

export function parseObjectPayload(payload: unknown): JsonObject {
	if (isJsonObject(payload)) return payload;
	return {};
}
