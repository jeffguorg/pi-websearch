import type { JsonValue, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { bearerToken, clamp, getArray, getObject, getString, result } from "./shared.js";

const TOKEN_PLAN_KEY_PREFIX = "sk-cp-";
const PAYGO_KEY_PREFIX = "sk-api-";
const DEFAULT_API_HOST = "https://api.minimaxi.com";
const DEFAULT_MODEL = "minimax-M2.5";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const CODING_PLAN_REQUEST_TIMEOUT_MS = 30_000;
const PAYGO_REQUEST_TIMEOUT_MS = 60_000;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True when the key belongs to the Token Plan / Coding Plan subscription,
 *  which carries the bundled coding-plan search quota. */
export function isTokenPlanKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith(TOKEN_PLAN_KEY_PREFIX);
}

/** True when the key belongs to the standard pay-as-you-go plan. */
export function isPayAsYouGoKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith(PAYGO_KEY_PREFIX);
}

/** API host derived from the configured baseUrl (which points at the Anthropic
 *  Messages endpoint; only its origin matters) or the `MINIMAX_API_HOST` env
 *  override. Native routes inject the model's baseUrl, so the minimax
 *  (api.minimax.io) and minimax-cn (api.minimaxi.com) providers resolve their
 *  own regional host without extra config. */
export function apiHostFor(config: BuildContext["config"]): string {
	const explicit = text(config.baseUrl);
	if (explicit) {
		try {
			return new URL(explicit).origin;
		} catch {
			// fall through to env/default
		}
	}
	const fromEnv = text(process.env["MINIMAX_API_HOST"]);
	if (fromEnv) return fromEnv;
	return config.provider === "minimax" ? "https://api.minimax.io" : DEFAULT_API_HOST;
}

/** Token Plan / Coding Plan bundled search: the documented REST endpoint the
 *  official `minimax-coding-plan-mcp` server forwards to (`{"q": query}` →
 *  `{organic: [...], base_resp}`). No subprocess, no MCP handshake. */
async function runCodingPlanSearch(
	apiKey: string,
	apiHost: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<SearchResultItem[]> {
	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timeoutController.abort(new DOMException("MiniMax coding-plan search timed out", "TimeoutError"));
	}, CODING_PLAN_REQUEST_TIMEOUT_MS);
	const onOuterAbort = () => timeoutController.abort(signal.reason);
	signal.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const response = await fetch(`${apiHost}/v1/coding_plan/search`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"MM-API-Source": "pi-websearch",
			},
			body: JSON.stringify({ q: query }),
			signal: timeoutController.signal,
			redirect: "error",
		});
		if (!response.ok) {
			const detail = await safeReadErrorBody(response);
			throw new Error(
				`MiniMax coding-plan search failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			);
		}
		const payload = JSON.parse(await readBoundedBody(response)) as unknown;
		return normalizeCodingPlanPayload(payload, maxResults);
	} finally {
		signal.removeEventListener("abort", onOuterAbort);
		clearTimeout(timeoutHandle);
	}
}

function normalizeCodingPlanPayload(payload: unknown, maxResults: number): SearchResultItem[] {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("MiniMax coding-plan search returned an unexpected payload");
	}
	const record = payload as Record<string, JsonValue | undefined>;
	const baseResp = getObject(record["base_resp"]);
	const statusCode = baseResp?.["status_code"];
	if (statusCode !== 0) {
		const statusMsg = getString(baseResp?.["status_msg"]) ?? `code ${String(statusCode)}`;
		throw new Error(`MiniMax coding-plan search failed: ${statusMsg}`);
	}
	const items: SearchResultItem[] = [];
	for (const raw of getArray(record["organic"])) {
		const item = getObject(raw);
		if (!item) continue;
		const title = getString(item["title"]);
		const url = getString(item["link"]);
		if (!title || !url) continue;
		const snippet = getString(item["snippet"]);
		const publishedAt = getString(item["date"]);
		const built = result(title, url, snippet);
		if (built) items.push(publishedAt ? { ...built, publishedAt } : built);
		if (items.length >= clamp(maxResults, 1, 50)) return items;
	}
	return items;
}

function buildWebSearchTool(allowedDomains: string[] | undefined, blockedDomains: string[] | undefined): object {
	const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
	if (allowedDomains) tool["allowed_domains"] = allowedDomains;
	if (blockedDomains) tool["blocked_domains"] = blockedDomains;
	return tool;
}

/** Pay-as-you-go search: one Anthropic Messages request with the server-side
 *  `web_search_20250305` tool. This is the only documented search path for
 *  paygo keys (Server Tools are Anthropic Messages API only, in Beta). */
async function runPaygoSearch(ctx: BuildContext, signal: AbortSignal): Promise<SearchResultItem[]> {
	const { config, request, maxResults, allowedDomains, blockedDomains } = ctx;
	const apiKey = resolveApiKey(config);
	if (!apiKey) throw new Error("minimax-cn requires an apiKey for pay-as-you-go search");

	const endpoint = text(config.baseUrl) ?? `${apiHostFor(config)}/anthropic/v1/messages`;
	const model = config.model ?? DEFAULT_MODEL;

	const body = JSON.stringify({
		model,
		max_tokens: 2048,
		messages: [{ role: "user", content: request.query }],
		tools: [buildWebSearchTool(allowedDomains, blockedDomains)],
	});

	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timeoutController.abort(new DOMException(`MiniMax pay-as-you-go search timed out`, "TimeoutError"));
	}, PAYGO_REQUEST_TIMEOUT_MS);

	const onOuterAbort = () => timeoutController.abort(signal.reason);
	signal.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body,
			signal: timeoutController.signal,
			redirect: "error",
		});
		if (!response.ok) {
			const detail = await safeReadErrorBody(response);
			throw new Error(
				`MiniMax pay-as-you-go search failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			);
		}
		const bodyText = await readBoundedBody(response);
		const payload = JSON.parse(bodyText) as unknown;
		return normalizeAnthropicPayload(payload, maxResults);
	} finally {
		signal.removeEventListener("abort", onOuterAbort);
		clearTimeout(timeoutHandle);
	}
}

async function readBoundedBody(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error(`MiniMax search response exceeds ${MAX_RESPONSE_BYTES} bytes`);
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
		throw new Error(`MiniMax search response exceeds ${MAX_RESPONSE_BYTES} bytes`);
	}
	return text;
}

async function safeReadErrorBody(response: Response): Promise<string | undefined> {
	try {
		const text = await response.text();
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return undefined;
	}
}

function normalizeAnthropicPayload(payload: unknown, maxResults: number): SearchResultItem[] {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("MiniMax pay-as-you-go search returned an unexpected payload");
	}
	const record = payload as Record<string, JsonValue | undefined>;
	const content = getArray(record["content"]);

	const fallbackText = content
		.map(getObject)
		.map((item) => getString(item?.["text"]))
		.filter((value): value is string => value !== undefined)
		.join("\n");

	const items: SearchResultItem[] = [];
	for (const raw of content) {
		const item = getObject(raw);
		if (item?.["type"] !== "web_search_tool_result" || item["is_error"] === true) continue;
		for (const searchRaw of getArray(item["content"])) {
			const searchItem = getObject(searchRaw);
			if (!searchItem) continue;
			const title = getString(searchItem["title"]) ?? getString(searchItem["snippet"]);
			const url = getString(searchItem["url"]);
			if (!title || !url) continue;
			const snippet = getString(searchItem["snippet"]) ?? fallbackText;
			items.push(result(title, url, snippet) ?? { title, url });
			if (items.length >= maxResults) return items;
		}
	}
	return items;
}

export const minimaxCnProvider: ProviderModule = {
	maxResultsLimit: 50,
	async search(ctx: BuildContext, signal: AbortSignal): Promise<SearchResultItem[]> {
		const apiKey = resolveApiKey(ctx.config);
		if (!apiKey) throw new Error("minimax-cn requires an apiKey");
		if (isTokenPlanKey(apiKey)) {
			return runCodingPlanSearch(apiKey, apiHostFor(ctx.config), ctx.request.query, ctx.maxResults, signal);
		}
		// sk-api- (or any non-sk-cp- MiniMax key) falls through to the
		// pay-as-you-go Anthropic-compatible endpoint with the server-side
		// web_search_20250305 tool. Unknown prefixes are treated the same
		// way to keep new key families working without code changes.
		return runPaygoSearch(ctx, signal);
	},
};

/** Resolved headers from native routes (SearchRoute.headers); absent on plain
 *  provider configs from the providers chain. */
interface AuthHeaders {
	headers?: Record<string, string>;
}

/** Resolved API key: explicit config key, else native-route headers (Bearer
 *  or x-api-key, matching what the branch-specific request needs). */
function resolveApiKey(config: BuildContext["config"] & AuthHeaders): string | undefined {
	if (config.apiKey) return config.apiKey;
	const headers = config.headers;
	if (!headers) return undefined;
	const apiKeyHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-api-key")?.[1];
	return bearerToken(headers) ?? apiKeyHeader;
}

// Re-export the key prefixes so other modules (e.g. tests, docs) can introspect
// the dispatch policy without duplicating the constants.
export const MINIMAX_KEY_PREFIXES = {
	tokenPlan: TOKEN_PLAN_KEY_PREFIX,
	payAsYouGo: PAYGO_KEY_PREFIX,
} as const;
