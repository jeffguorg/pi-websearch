import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAllowedConfiguredBaseUrl } from "./provider-endpoints.js";
import { isExternalProvider, isRegisteredProvider } from "./providers.js";
import type {
	CodexSearchMode,
	ConfigLoadFailureReason,
	ConfigLoadResult,
	JsonObject,
	JsonValue,
	ProviderValidationResult,
	RoutingStrategy,
	SearchContextSize,
	SearchProviderConfig,
	SearchProviderEntry,
	SearchUserLocation,
	WebsearchConfig,
} from "./types.js";

const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const CODEX_MODES: readonly CodexSearchMode[] = ["cached", "live"];
const STRATEGIES: readonly RoutingStrategy[] = ["priority", "round-robin", "fill-first"];
const DEFAULT_FREE_CONFIG: WebsearchConfig = {
	strategy: "priority",
	fallback: false,
	auto: true,
	providers: [{ id: "default", provider: "duckduckgo-html", maxResults: 10 }],
};

export interface ConfigLoadOptions {
	cwd: string;
	homeDir?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<TValue extends string>(values: readonly TValue[], value: unknown): value is TValue {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isStringArray(value: JsonValue | undefined): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function optionalProvider(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalContextSize(value: JsonValue | undefined): SearchContextSize | undefined {
	return oneOf(CONTEXT_SIZES, value) ? value : undefined;
}

function optionalCodexMode(value: JsonValue | undefined): CodexSearchMode | undefined {
	return oneOf(CODEX_MODES, value) ? value : undefined;
}

function optionalStrategy(value: JsonValue | undefined): RoutingStrategy | undefined {
	return oneOf(STRATEGIES, value) ? value : undefined;
}

function validOptionalString(raw: JsonObject, key: string): boolean {
	return !(key in raw) || (typeof raw[key] === "string" && raw[key].length > 0);
}

function validOptionalNumber(raw: JsonObject, key: string): boolean {
	return !(key in raw) || (typeof raw[key] === "number" && Number.isFinite(raw[key]));
}

function validOptionalStringArray(raw: JsonObject, key: string): boolean {
	return !(key in raw) || isStringArray(raw[key]);
}

function optionalHeaders(value: JsonValue | undefined): Record<string, string> | undefined {
	if (!isJsonObject(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function optionalLocation(value: JsonValue | undefined): SearchUserLocation | undefined {
	if (!isJsonObject(value)) return undefined;
	const location: SearchUserLocation = {};
	const country = optionalString(value["country"]);
	const region = optionalString(value["region"]);
	const city = optionalString(value["city"]);
	const timezone = optionalString(value["timezone"]);
	if (country) location.country = country;
	if (region) location.region = region;
	if (city) location.city = city;
	if (timezone) location.timezone = timezone;
	return Object.keys(location).length > 0 ? location : undefined;
}

function parseJsonObject(content: string): JsonObject | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	return isJsonObject(parsed) ? parsed : null;
}

function providerEntryFromObject(raw: JsonObject): SearchProviderEntry | null {
	const stringFields = ["id", "apiKey", "baseUrl", "searchEngineId", "model"];
	const numberFields = ["maxResults", "timeoutMs", "priority", "weight"];
	if (
		stringFields.some((key) => !validOptionalString(raw, key)) ||
		numberFields.some((key) => !validOptionalNumber(raw, key)) ||
		!["allowedDomains", "blockedDomains"].every((key) => validOptionalStringArray(raw, key)) ||
		("optional" in raw && typeof raw["optional"] !== "boolean") ||
		("headers" in raw && !isJsonObject(raw["headers"])) ||
		("codexMode" in raw && !oneOf(CODEX_MODES, raw["codexMode"])) ||
		("searchContextSize" in raw && !oneOf(CONTEXT_SIZES, raw["searchContextSize"])) ||
		("userLocation" in raw && !isJsonObject(raw["userLocation"])) ||
		("openRouterRouting" in raw && !isJsonObject(raw["openRouterRouting"]))
	) {
		return null;
	}
	const provider = optionalProvider(raw["provider"]) ?? optionalProvider(raw["backend"]);
	if (!provider) return null;

	const config: SearchProviderEntry = { provider };
	const id = optionalString(raw["id"]);
	const apiKey = optionalString(raw["apiKey"]);
	const baseUrl = optionalString(raw["baseUrl"]);
	const searchEngineId = optionalString(raw["searchEngineId"]);
	const maxResults = optionalNumber(raw["maxResults"]);
	const model = optionalString(raw["model"]);
	const codexMode = optionalCodexMode(raw["codexMode"]);
	const searchContextSize = optionalContextSize(raw["searchContextSize"]);
	const rawAllowedDomains = raw["allowedDomains"];
	const rawBlockedDomains = raw["blockedDomains"];
	const allowedDomains = isStringArray(rawAllowedDomains) ? rawAllowedDomains : undefined;
	const blockedDomains = isStringArray(rawBlockedDomains) ? rawBlockedDomains : undefined;
	const userLocation = optionalLocation(raw["userLocation"]);
	const headers = optionalHeaders(raw["headers"]);
	const openRouterRouting = isJsonObject(raw["openRouterRouting"]) ? raw["openRouterRouting"] : undefined;
	const timeoutMs = optionalNumber(raw["timeoutMs"]);
	const priority = optionalNumber(raw["priority"]);
	const weight = optionalNumber(raw["weight"]);
	const optional = optionalBoolean(raw["optional"]);

	if (id) config.id = id;
	if (apiKey) config.apiKey = apiKey;
	if (baseUrl) config.baseUrl = baseUrl;
	if (searchEngineId) config.searchEngineId = searchEngineId;
	if (maxResults) config.maxResults = maxResults;
	if (model) config.model = model;
	if (codexMode) config.codexMode = codexMode;
	if (searchContextSize) config.searchContextSize = searchContextSize;
	if (allowedDomains) config.allowedDomains = allowedDomains;
	if (blockedDomains) config.blockedDomains = blockedDomains;
	if (userLocation) config.userLocation = userLocation;
	if (headers) config.headers = headers;
	if (openRouterRouting) config.openRouterRouting = openRouterRouting;
	if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
	if (priority !== undefined) config.priority = priority;
	if (weight !== undefined) config.weight = weight;
	if (optional !== undefined) config.optional = optional;

	return config;
}

function configFromObject(raw: JsonObject): WebsearchConfig | null {
	if (
		("auto" in raw && typeof raw["auto"] !== "boolean") ||
		("fallback" in raw && typeof raw["fallback"] !== "boolean") ||
		("strategy" in raw && !oneOf(STRATEGIES, raw["strategy"])) ||
		("providers" in raw && !Array.isArray(raw["providers"])) ||
		("fallback_chain" in raw && !Array.isArray(raw["fallback_chain"]))
	) {
		return null;
	}
	const auto = optionalBoolean(raw["auto"]) ?? true;
	const providersValue = raw["providers"];
	const fallbackChainValue = raw["fallback_chain"];
	if (providersValue !== undefined && fallbackChainValue !== undefined) return null;
	const chainValue = fallbackChainValue ?? providersValue;
	const rawProviders = Array.isArray(chainValue) ? chainValue : undefined;
	if (rawProviders) {
		if (optionalProvider(raw["provider"]) || optionalProvider(raw["backend"])) return null;
		const parsedProviders = rawProviders.map((value) =>
			isJsonObject(value) ? providerEntryFromObject(value) : null,
		);
		if (parsedProviders.some((entry) => entry === null)) return null;
		const providers = parsedProviders
			.filter((entry): entry is SearchProviderEntry => entry !== null)
			.filter((entry) => isRegisteredProvider(entry.provider) || !entry.optional);
		const strategy = optionalStrategy(raw["strategy"]) ?? "priority";
		const fallback = optionalBoolean(raw["fallback"]) ?? false;
		return { strategy, fallback, auto, providers };
	}

	const provider = providerEntryFromObject(raw);
	return provider ? { strategy: "priority", fallback: false, auto, providers: [provider] } : null;
}

function hasApiKey(config: SearchProviderConfig): boolean {
	return typeof config.apiKey === "string" && config.apiKey.length > 0;
}

export function validateProviderConfig(config: SearchProviderEntry): ProviderValidationResult {
	if (!isRegisteredProvider(config.provider)) {
		return { ok: false, reason: "invalid_config", message: `Unsupported provider: ${config.provider}` };
	}

	if (config.allowedDomains && config.blockedDomains) {
		return {
			ok: false,
			reason: "invalid_config",
			message: "Provider config cannot specify both allowedDomains and blockedDomains.",
		};
	}

	if (config.weight !== undefined && config.weight <= 0) {
		return { ok: false, reason: "invalid_config", message: "Provider weight must be greater than 0." };
	}

	if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
		return { ok: false, reason: "invalid_config", message: "Provider timeoutMs must be greater than 0." };
	}

	if (config.baseUrl && !isAllowedConfiguredBaseUrl(config.provider, config.baseUrl)) {
		const selfHosted = config.provider === "searxng";
		return {
			ok: false,
			reason: "invalid_config",
			message: selfHosted
				? `Provider ${config.provider} baseUrl must be an HTTP(S) URL without embedded credentials.`
				: `Provider ${config.provider} baseUrl must be a public HTTPS URL without credentials.`,
		};
	}

	if (config.provider === "searxng" && !config.baseUrl) {
		return { ok: false, reason: "missing_config", message: "Provider searxng requires baseUrl." };
	}

	if (config.provider === "google-cse" && !config.searchEngineId) {
		return { ok: false, reason: "missing_api_key", message: "Provider google-cse requires searchEngineId." };
	}

	if ((config.provider === "codex" || config.provider === "openai") && !hasApiKey(config)) {
		return {
			ok: false,
			reason: "missing_api_key",
			message: `Provider ${config.provider} requires apiKey for hosted Responses API search.`,
		};
	}

	// Providers whose key is resolved at request time from the active model
	// (native routing) don't need an explicit apiKey in config; keyless
	// providers never need one.
	const NATIVE_KEY_PROVIDERS = new Set(["codex", "openai"]);
	const KEYLESS_PROVIDERS = new Set(["duckduckgo-html", "searxng"]);
	if (
		!NATIVE_KEY_PROVIDERS.has(config.provider) &&
		!KEYLESS_PROVIDERS.has(config.provider) &&
		!isExternalProvider(config.provider) &&
		!hasApiKey(config)
	) {
		return { ok: false, reason: "missing_api_key", message: `Provider ${config.provider} requires apiKey.` };
	}

	return { ok: true, config };
}

export function validateWebsearchConfig(
	config: WebsearchConfig,
): { ok: true; config: WebsearchConfig } | { ok: false; reason: ConfigLoadFailureReason; message: string } {
	if (!STRATEGIES.includes(config.strategy)) {
		return { ok: false, reason: "invalid_config", message: `Unsupported routing strategy: ${config.strategy}` };
	}
	if (typeof config.auto !== "boolean") {
		return { ok: false, reason: "invalid_config", message: "Websearch config auto must be a boolean." };
	}
	if (typeof config.fallback !== "boolean") {
		return { ok: false, reason: "invalid_config", message: "Websearch config fallback must be a boolean." };
	}
	if (config.providers.length === 0) {
		return { ok: false, reason: "invalid_config", message: "Websearch config requires at least one provider." };
	}

	const availableProviders: SearchProviderEntry[] = [];
	for (const provider of config.providers) {
		const validation = validateProviderConfig(provider);
		if (!validation.ok) {
			if (provider.optional && (validation.reason === "missing_api_key" || validation.reason === "missing_config"))
				continue;
			return validation;
		}
		availableProviders.push(provider);
	}
	if (availableProviders.length === 0) {
		return { ok: false, reason: "invalid_config", message: "Websearch config has no available providers." };
	}

	return { ok: true, config: { ...config, providers: availableProviders } };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function loadWebsearchConfig(options: ConfigLoadOptions): Promise<ConfigLoadResult> {
	const home = options.homeDir ?? homedir();
	const paths = [
		join(options.cwd, ".pi", "websearch.json"),
		join(home, "websearch.json"),
		join(home, ".pi", "websearch.json"),
	];

	for (const path of paths) {
		if (!(await fileExists(path))) continue;
		const raw = parseJsonObject(await readFile(path, "utf8"));
		if (!raw) {
			return { ok: false, reason: "invalid_config", message: `Invalid JSON object in ${path}`, source: path };
		}
		const config = configFromObject(raw);
		if (!config) {
			return { ok: false, reason: "invalid_config", message: `Invalid provider config in ${path}`, source: path };
		}
		const validation = validateWebsearchConfig(config);
		if (!validation.ok) return { ...validation, source: path };
		return { ok: true, config: validation.config, source: path };
	}

	return { ok: true, config: DEFAULT_FREE_CONFIG, source: "default:duckduckgo-html" };
}
