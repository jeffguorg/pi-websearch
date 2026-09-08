import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { isAllowedConfiguredBaseUrl } from "./provider-endpoints.js";
import { DEFAULT_MAX_RESULTS } from "./providers/shared.js";
import { isExternalProvider, isRegisteredProvider } from "./providers.js";
import type {
	CodexSearchMode,
	ConfigLoadFailureReason,
	ConfigLoadResult,
	JsonObject,
	JsonValue,
	ProviderValidationResult,
	SearchContextSize,
	SearchProviderConfig,
	SearchProviderEntry,
	SearchUserLocation,
	WebsearchConfig,
} from "./types.js";

const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const CODEX_MODES: readonly CodexSearchMode[] = ["cached", "live"];
const DEFAULT_FREE_CONFIG: WebsearchConfig = {
	appendProvidersAsFallback: true,
	enableNative: true,
	providers: [{ id: "default", provider: "duckduckgo-html", maxResults: DEFAULT_MAX_RESULTS }],
};

/** Structural schema for websearch config files. Semantic checks (credentials,
 * provider availability) stay in validateWebsearchConfig; everything about key
 * presence, types, and value ranges is decided here. */
const STRING_FIELD = { type: "string", minLength: 1 };
const STRING_ARRAY_FIELD = { type: "array", items: { type: "string", minLength: 1 } };

const providerEntrySchema = {
	type: "object",
	additionalProperties: false,
	required: ["provider"],
	properties: {
		id: STRING_FIELD,
		provider: STRING_FIELD,
		apiKey: STRING_FIELD,
		baseUrl: STRING_FIELD,
		searchEngineId: STRING_FIELD,
		model: STRING_FIELD,
		maxResults: { type: "integer", minimum: 1, maximum: 50 },
		timeoutMs: { type: "integer", minimum: 1 },
		priority: { type: "integer" },
		optional: { type: "boolean" },
		allowedDomains: STRING_ARRAY_FIELD,
		blockedDomains: STRING_ARRAY_FIELD,
		headers: {
			type: "object",
			propertyNames: { pattern: "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$" },
			additionalProperties: { type: "string", pattern: "\\S" },
		},
		userLocation: {
			type: "object",
			additionalProperties: false,
			properties: {
				country: STRING_FIELD,
				region: STRING_FIELD,
				city: STRING_FIELD,
				timezone: STRING_FIELD,
			},
		},
		openRouterRouting: { type: "object" },
		codexMode: { enum: [...CODEX_MODES] },
		searchContextSize: { enum: [...CONTEXT_SIZES] },
	},
};

const websearchConfigSchema = {
	type: "object",
	additionalProperties: false,
	required: ["providers"],
	properties: {
		appendProvidersAsFallback: { type: "boolean" },
		enableNative: { type: "boolean" },
		providers: { type: "array", minItems: 1, items: providerEntrySchema },
	},
};

/** Config keys from pre-0.3 releases. Rejected with a per-key migration hint
 * instead of being silently ignored, so stale configs fail loudly at startup. */
const LEGACY_ROOT_KEYS = new Set(["auto", "strategy", "weight", "fallback", "fallback_chain", "provider", "backend"]);
const LEGACY_ENTRY_KEYS = new Set(["backend", "weight"]);
const LEGACY_KEY_HINTS: Record<string, string> = {
	auto: `use "enableNative" with the same value`,
	backend: `rename it to "provider"`,
	fallback: `use "appendProvidersAsFallback" with the same value`,
	fallback_chain: `merge its entries into "providers"`,
	provider: `wrap the entry in a "providers" array`,
	strategy: `remove it; routes run in priority order`,
	weight: `remove it; routes run in priority order`,
};

/** Config-side aliases, kept in sync with the names native matching accepts. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { zai: "z-ai" };
const ajv = new Ajv({ allErrors: true });
const validateWebsearchSchema = ajv.compile(websearchConfigSchema);

function formatSchemaError(error: ErrorObject): string {
	const where = error.instancePath === "" ? "config" : error.instancePath.slice(1).replaceAll("/", ".");
	if (error.keyword === "additionalProperties") {
		const key = String(error.params["additionalProperty"]);
		// backend/weight only ever meant something on a providers[] entry; the same
		// words nested deeper (e.g. inside userLocation) are just unknown keys.
		const isEntryPath = /^\/providers\/\d+$/.test(error.instancePath);
		const legacySet = error.instancePath === "" ? LEGACY_ROOT_KEYS : isEntryPath ? LEGACY_ENTRY_KEYS : null;
		if (legacySet?.has(key) === true) {
			return `${where}: legacy key "${key}" is no longer supported; ${LEGACY_KEY_HINTS[key]}`;
		}
		return `${where}: unknown key "${key}" is not allowed`;
	}
	return `${where}: ${error.message ?? "failed schema validation"}`;
}

function schemaErrorsFor(raw: JsonObject): string[] | null {
	if (validateWebsearchSchema(raw)) return null;
	return (validateWebsearchSchema.errors ?? []).map(formatSchemaError);
}
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
	// File loads are gated by the ajv schema above; these guards remain as the
	// type narrowing for direct callers of this private parser.
	const stringFields = ["id", "apiKey", "baseUrl", "searchEngineId", "model"];
	const numberFields = ["maxResults", "timeoutMs", "priority"];
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
	const rawProvider = optionalProvider(raw["provider"]);
	if (!rawProvider) return null;
	// Config-side alias normalization, kept in sync with native matching.
	const provider = PROVIDER_ALIASES[rawProvider] ?? rawProvider;

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
	const optional = optionalBoolean(raw["optional"]);

	if (id) config.id = id;
	if (apiKey) config.apiKey = apiKey;
	if (baseUrl) config.baseUrl = baseUrl;
	if (searchEngineId) config.searchEngineId = searchEngineId;
	if (maxResults !== undefined) config.maxResults = maxResults;
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
	if (optional !== undefined) config.optional = optional;

	return config;
}

function configFromObject(raw: JsonObject): WebsearchConfig | null {
	if (
		("appendProvidersAsFallback" in raw && typeof raw["appendProvidersAsFallback"] !== "boolean") ||
		("enableNative" in raw && typeof raw["enableNative"] !== "boolean") ||
		("providers" in raw && !Array.isArray(raw["providers"]))
	) {
		return null;
	}
	const enableNative = optionalBoolean(raw["enableNative"]) ?? true;
	const rawProviders = raw["providers"];
	if (!Array.isArray(rawProviders)) return null;
	const parsedProviders = rawProviders.map((value) => (isJsonObject(value) ? providerEntryFromObject(value) : null));
	if (parsedProviders.some((entry) => entry === null)) return null;
	const providers = parsedProviders
		.filter((entry): entry is SearchProviderEntry => entry !== null)
		.filter((entry) => isRegisteredProvider(entry.provider) || !entry.optional);
	const appendProvidersAsFallback = optionalBoolean(raw["appendProvidersAsFallback"]) ?? true;
	return { appendProvidersAsFallback, enableNative, providers };
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
		const schemaErrors = schemaErrorsFor(raw);
		if (schemaErrors) {
			return {
				ok: false,
				reason: "invalid_config",
				message: `Invalid websearch config in ${path}: ${schemaErrors.join("; ")}`,
				source: path,
			};
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
