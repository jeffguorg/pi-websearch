import {
	buildSearchRequest,
	executeDirectProviderSearch,
	normalizeSearchResponse,
	parseSearchResponseBody,
} from "./providers.js";
import type {
	JsonObject,
	RoutingStrategy,
	SearchAttempt,
	SearchDetails,
	SearchExecutionPolicy,
	SearchProviderEntry,
	SearchRequest,
	SearchRoute,
	WebsearchConfig,
} from "./types.js";

const MAX_ERROR_DETAIL_LENGTH = 500;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const MAX_SEARCH_RESPONSE_BYTES = 5 * 1024 * 1024;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function extractErrorDetail(payload: unknown, bodyText: string): string {
	if (isJsonObject(payload)) {
		const obj = payload;
		const error = obj["error"];
		if (typeof error === "string" && error.length > 0) return truncate(error, MAX_ERROR_DETAIL_LENGTH);
		if (isJsonObject(error)) {
			const message = error["message"];
			if (typeof message === "string" && message.length > 0) return truncate(message, MAX_ERROR_DETAIL_LENGTH);
		}
		const message = obj["message"];
		if (typeof message === "string" && message.length > 0) return truncate(message, MAX_ERROR_DETAIL_LENGTH);
	}
	const trimmed = bodyText.trim();
	if (!trimmed) return "";
	return truncate(trimmed, MAX_ERROR_DETAIL_LENGTH);
}

function httpErrorMessage(status: number, payload: unknown, bodyText: string): string {
	const detail = extractErrorDetail(payload, bodyText);
	return detail ? `Search failed with HTTP ${status}: ${detail}` : `Search failed with HTTP ${status}`;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function timeoutMsFor(config: SearchProviderEntry): number {
	return Math.max(1, Math.trunc(config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
}

function providerTimeoutMessage(timeoutMs: number): string {
	return `Search timed out after ${timeoutMs}ms`;
}

function searchAbortSignal(
	outerSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	if (outerSignal?.aborted) throw abortReason(outerSignal);

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new DOMException(providerTimeoutMessage(timeoutMs), "TimeoutError"));
	}, timeoutMs);
	const onAbort = () => controller.abort(outerSignal ? abortReason(outerSignal) : undefined);
	outerSignal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			outerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortReason(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export interface SearchRoutingState {
	roundRobinCursor: number;
	successCounts: number[];
}

export function createSearchRoutingState(providerCount: number): SearchRoutingState {
	return { roundRobinCursor: 0, successCounts: Array.from({ length: providerCount }, () => 0) };
}

export function providerEntryLabel(entry: {
	readonly provider: string;
	readonly id?: string;
	readonly entryId?: string;
}): string {
	const id = entry.entryId ?? entry.id;
	if (!id || id === entry.provider) return entry.provider;
	return `${entry.provider}/${id}`;
}

function sortedPriorityIndices(providers: SearchProviderEntry[]): number[] {
	return providers
		.map((provider, index) => ({ index, priority: provider.priority ?? index }))
		.sort((left, right) => left.priority - right.priority || left.index - right.index)
		.map((item) => item.index);
}

function weightedIndices(providers: SearchProviderEntry[]): number[] {
	const indices: number[] = [];
	for (const [index, provider] of providers.entries()) {
		const weight = Math.max(1, Math.trunc(provider.weight ?? 1));
		for (let count = 0; count < weight; count += 1) indices.push(index);
	}
	return indices.length > 0 ? indices : providers.map((_provider, index) => index);
}

function rotateUnique(indices: number[], start: number, providerCount: number): number[] {
	const order: number[] = [];
	for (let offset = 0; offset < indices.length; offset += 1) {
		const index = indices[(start + offset) % indices.length];
		if (index !== undefined && !order.includes(index)) order.push(index);
	}
	for (let index = 0; index < providerCount; index += 1) {
		if (!order.includes(index)) order.push(index);
	}
	return order;
}

function selectOrder(
	strategy: RoutingStrategy,
	providers: SearchProviderEntry[],
	state: SearchRoutingState,
	advanceRoundRobin = true,
): number[] {
	if (strategy === "priority") return sortedPriorityIndices(providers);
	if (strategy === "round-robin") {
		const indices = weightedIndices(providers);
		const order = rotateUnique(indices, state.roundRobinCursor % indices.length, providers.length);
		if (advanceRoundRobin) state.roundRobinCursor = (state.roundRobinCursor + 1) % indices.length;
		return order;
	}

	let selected = 0;
	let selectedCount = state.successCounts[0] ?? 0;
	for (let index = 1; index < providers.length; index += 1) {
		const count = state.successCounts[index] ?? 0;
		if (count < selectedCount) {
			selected = index;
			selectedCount = count;
		}
	}
	return [selected, ...providers.map((_provider, index) => index).filter((index) => index !== selected)];
}

function failedProviderDetails(
	config: SearchProviderEntry | SearchRoute,
	request: SearchRequest,
	startedAt: number,
	error: unknown,
): SearchDetails {
	const details: SearchDetails = {
		provider: config.provider,
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: error instanceof Error && error.message ? error.message : "Search provider failed",
	};
	if (config.id !== undefined) details.entryId = config.id;
	return details;
}

async function performProviderSearch(
	config: SearchProviderEntry | SearchRoute,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<SearchDetails> {
	const startedAt = Date.now();
	const timeoutMs = timeoutMsFor(config);
	const directAbort = searchAbortSignal(signal, timeoutMs);
	try {
		const directResults = await raceWithAbort(
			executeDirectProviderSearch(config, request, directAbort.signal),
			directAbort.signal,
		);
		if (directResults) {
			const limitedResults = directResults.slice(0, request.maxResults);
			const details: SearchDetails = {
				provider: config.provider,
				query: request.query,
				results: limitedResults,
				durationMs: Date.now() - startedAt,
				truncated: directResults.length > request.maxResults,
			};
			if (config.id !== undefined) details.entryId = config.id;
			return details;
		}
	} catch (error) {
		if (signal?.aborted) throw abortReason(signal);
		return failedProviderDetails(config, request, startedAt, error);
	} finally {
		directAbort.cleanup();
	}

	let built: ReturnType<typeof buildSearchRequest>;
	try {
		built = buildSearchRequest(config, request);
	} catch (error) {
		return failedProviderDetails(config, request, startedAt, error);
	}
	const abort = searchAbortSignal(signal, timeoutMs);
	let response: Response;
	try {
		const init: RequestInit = {
			...built.init,
			signal: abort.signal,
		};
		if (built.body !== undefined) init.body = JSON.stringify(built.body);
		response = await fetch(built.url, init);
	} catch (error) {
		abort.cleanup();
		if (signal?.aborted) throw abortReason(signal);
		const details: SearchDetails = {
			provider: config.provider,
			query: request.query,
			results: [],
			durationMs: Date.now() - startedAt,
			truncated: false,
			error: error instanceof Error ? error.message : "Search request failed",
		};
		if (config.id !== undefined) details.entryId = config.id;
		return details;
	}

	let bodyText = "";
	try {
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_SEARCH_RESPONSE_BYTES) {
			throw new Error(`Search response exceeds ${MAX_SEARCH_RESPONSE_BYTES} bytes`);
		}
		bodyText = await response.text();
		if (Buffer.byteLength(bodyText, "utf8") > MAX_SEARCH_RESPONSE_BYTES) {
			throw new Error(`Search response exceeds ${MAX_SEARCH_RESPONSE_BYTES} bytes`);
		}
	} catch (error) {
		abort.cleanup();
		if (signal?.aborted) throw abortReason(signal);
		const details: SearchDetails = {
			provider: config.provider,
			query: request.query,
			results: [],
			durationMs: Date.now() - startedAt,
			truncated: false,
			error: error instanceof Error ? error.message : "Search response read failed",
		};
		if (config.id !== undefined) details.entryId = config.id;
		return details;
	} finally {
		abort.cleanup();
	}
	let payload: unknown = {};
	if (config.provider === "duckduckgo-html") {
		payload = { html: bodyText };
	} else if (bodyText.length > 0) {
		try {
			payload = JSON.parse(bodyText);
		} catch {
			payload = {};
		}
	}
	if (!response.ok) {
		const details: SearchDetails = {
			provider: config.provider,
			query: request.query,
			results: [],
			durationMs: Date.now() - startedAt,
			truncated: false,
			error: httpErrorMessage(response.status, payload, bodyText),
		};
		if (config.id !== undefined) details.entryId = config.id;
		return details;
	}

	const adapter = "adapter" in config ? config.adapter : config.provider;
	let results: SearchDetails["results"];
	try {
		if (adapter !== "duckduckgo-html") payload = parseSearchResponseBody(adapter, bodyText);
		const normalized = normalizeSearchResponse(adapter, payload);
		if (!Array.isArray(normalized)) throw new Error(`Search adapter ${adapter} returned invalid results`);
		results = normalized;
	} catch (error) {
		return failedProviderDetails(config, request, startedAt, error);
	}
	const max = request.maxResults;
	const limitedResults = results.slice(0, max);
	const details: SearchDetails = {
		provider: config.provider,
		query: request.query,
		results: limitedResults,
		durationMs: Date.now() - startedAt,
		truncated: results.length > max,
	};
	if (config.id !== undefined) details.entryId = config.id;
	return details;
}

function attemptFromDetails(details: SearchDetails): SearchAttempt {
	const attempt: SearchAttempt = {
		provider: details.provider,
		durationMs: details.durationMs,
		resultsCount: details.results.length,
	};
	if (details.entryId) attempt.entryId = details.entryId;
	if (details.error) attempt.error = details.error;
	return attempt;
}

export type SearchAttemptListener = (
	providerLabel: string,
	attempts: readonly SearchAttempt[],
	routeLabels: readonly string[],
) => void;

export async function performSearch(
	config: WebsearchConfig,
	request: SearchRequest,
	signal?: AbortSignal,
	routingState?: SearchRoutingState,
	onAttempt?: SearchAttemptListener,
	nativeRoute?: SearchRoute,
	policy: SearchExecutionPolicy = { useFallback: false, retryOnEmpty: false },
): Promise<SearchDetails> {
	const startedAt = Date.now();
	const state = routingState ?? createSearchRoutingState(config.providers.length);
	const configuredOrder = selectOrder(config.strategy, config.providers, state, false);
	const configuredRoutes = configuredOrder.flatMap((index) => {
		const provider = config.providers[index];
		return provider ? [{ provider, configuredIndex: index }] : [];
	});
	const allRoutes: Array<{
		provider: SearchProviderEntry | SearchRoute;
		configuredIndex?: number;
	}> = [...(nativeRoute ? [{ provider: nativeRoute }] : []), ...configuredRoutes];
	const routes = policy.useFallback ? allRoutes : allRoutes.slice(0, 1);
	const attempts: SearchAttempt[] = [];
	let configuredAttemptStarted = false;
	const routeLabels = routes.map(({ provider }) => providerEntryLabel(provider));
	const collected = new Map<string, SearchDetails["results"][number]>();
	let selectedDetails: SearchDetails | undefined;
	let selectedSuccessfulDetails: SearchDetails | undefined;
	let lastEmptySuccess: SearchDetails | undefined;
	const successfulRoutes: SearchDetails[] = [];

	for (const route of routes) {
		const { provider, configuredIndex } = route;
		if (configuredIndex !== undefined && !configuredAttemptStarted) {
			configuredAttemptStarted = true;
			if (config.strategy === "round-robin") {
				const weighted = weightedIndices(config.providers);
				state.roundRobinCursor = (state.roundRobinCursor + 1) % weighted.length;
			}
		}
		onAttempt?.(providerEntryLabel(provider), attempts, routeLabels);
		const details = await performProviderSearch(provider, request, signal);
		attempts.push(attemptFromDetails(details));

		if (details.error !== undefined) {
			selectedDetails = details;
			if (!policy.useFallback) {
				if (config.strategy === "fill-first" && collected.size > 0) break;
				return { ...details, strategy: config.strategy, attempts };
			}
			continue;
		}

		if (configuredIndex !== undefined) {
			state.successCounts[configuredIndex] = (state.successCounts[configuredIndex] ?? 0) + 1;
		}

		const isEmpty = details.results.length === 0;
		if (isEmpty) lastEmptySuccess = details;
		if (isEmpty && (!policy.useFallback || !policy.retryOnEmpty)) {
			if (collected.size > 0) break;
			return { ...details, strategy: config.strategy, attempts };
		}
		if (config.strategy !== "fill-first" && !isEmpty) {
			return { ...details, strategy: config.strategy, attempts };
		}

		selectedDetails = details;
		selectedSuccessfulDetails = details;
		successfulRoutes.push(details);
		for (const item of details.results) {
			if (collected.size >= request.maxResults) break;
			if (!collected.has(item.url)) {
				collected.set(item.url, { ...item, route: providerEntryLabel(details) });
			}
		}
		if (collected.size >= request.maxResults) break;
	}

	if (collected.size > 0 && selectedSuccessfulDetails) {
		const results = [...collected.values()];
		const soleSuccessfulRoute = successfulRoutes.length === 1 ? successfulRoutes[0] : undefined;
		const details: SearchDetails = {
			provider: soleSuccessfulRoute?.provider ?? "multiple",
			query: request.query,
			results,
			durationMs: Date.now() - startedAt,
			truncated: results.length >= request.maxResults,
			strategy: config.strategy,
			attempts,
		};
		if (soleSuccessfulRoute?.entryId !== undefined) details.entryId = soleSuccessfulRoute.entryId;
		return details;
	}

	if (lastEmptySuccess) {
		return {
			...lastEmptySuccess,
			durationMs: Date.now() - startedAt,
			strategy: config.strategy,
			attempts,
		};
	}

	if (selectedDetails && !selectedDetails.error) {
		return {
			...selectedDetails,
			durationMs: Date.now() - startedAt,
			strategy: config.strategy,
			attempts,
		};
	}

	const failed = selectedDetails ?? {
		provider: nativeRoute?.provider ?? config.providers[0]?.provider ?? "unknown",
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: "All search providers failed.",
	};
	return {
		...failed,
		durationMs: Date.now() - startedAt,
		strategy: config.strategy,
		attempts,
		error: `All search providers failed: ${attempts.map((attempt) => `${providerEntryLabel(attempt)} ${attempt.error ?? "failed"}`).join("; ")}`,
	};
}

export function formatSearchText(details: SearchDetails): string {
	if (details.error) return details.error;
	if (details.results.length === 0) return `No web search results found for "${details.query}".`;

	const route = details.strategy
		? ` via ${providerEntryLabel(details)} (${details.strategy})`
		: ` via ${details.provider}`;
	const lines = [`Web search results for "${details.query}"${route}:`, ""];
	if (details.attempts && details.attempts.length > 0) {
		lines.push(
			`Routing attempts: ${details.attempts
				.map(
					(attempt) =>
						`${providerEntryLabel(attempt)} ${attempt.error ? `failed: ${attempt.error}` : `${attempt.resultsCount} result${attempt.resultsCount === 1 ? "" : "s"}`}`,
				)
				.join(" -> ")}`,
			"",
		);
	}
	for (const [index, item] of details.results.entries()) {
		lines.push(`${index + 1}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
	}
	lines.push("", "REMINDER: Include relevant sources from the URLs above in the final answer.");
	return lines.join("\n");
}
