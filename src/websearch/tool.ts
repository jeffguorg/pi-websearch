import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type NativeModelInfo, type NativeModelRegistry, resolveNativeEntry } from "./native.js";
import { renderSearchCall, renderSearchResult } from "./renderers.js";
import { formatSearchText, performSearch, providerEntryLabel, resolveRoutes } from "./search.js";
import type { ConfigLoadResult, SearchErrorDetails, SearchProgressDetails, SearchRenderDetails } from "./types.js";

const Params = Type.Object(
	{
		query: Type.String({ minLength: 2, maxLength: 2000, description: "The search query to use" }),
		allowed_domains: Type.Optional(
			Type.Array(Type.String({ maxLength: 253 }), {
				maxItems: 100,
				description: "Only include search results from these domains",
			}),
		),
		blocked_domains: Type.Optional(
			Type.Array(Type.String({ maxLength: 253 }), {
				maxItems: 100,
				description: "Never include search results from these domains",
			}),
		),
		retry_on_empty: Type.Optional(
			Type.Boolean({
				description: "Continue to the next fallback after a successful empty result (default: false)",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ConfigProvider = () => ConfigLoadResult;
type WebSearchTool = ReturnType<typeof defineTool<typeof Params, SearchRenderDetails>>;

interface WebSearchToolContext {
	model: NativeModelInfo | undefined;
	modelRegistry: NativeModelRegistry;
}

function formatSearchProgressText(details: SearchProgressDetails): string {
	const suffix = details.maxResults === undefined ? "" : ` (max ${details.maxResults})`;
	if (details.currentProvider) {
		return `Searching "${details.query}" via ${details.currentProvider}${suffix}`;
	}
	const route = details.providerLabels.length > 0 ? details.providerLabels.join(" -> ") : "configured providers";
	return `Searching "${details.query}" via ${route}${suffix}`;
}

function searchErrorDetails(query: string, error: string, reason?: SearchErrorDetails["reason"]): SearchErrorDetails {
	return { phase: "error", query, error, ...(reason ? { reason } : {}) };
}

export function createWebSearchTool(getConfig: ConfigProvider): WebSearchTool {
	return defineTool<typeof Params, SearchRenderDetails>({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for current information and return source URLs for citation.",
		promptSnippet: "Search the web for current information, documentation, news, or external facts.",
		promptGuidelines: ["After using web_search, cite relevant returned URLs in the final answer."],
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx?: WebSearchToolContext) {
			if (params.allowed_domains?.length && params.blocked_domains?.length) {
				const message = "Error: Cannot specify both allowed_domains and blocked_domains in the same request";
				const details = searchErrorDetails(params.query, message);
				return { content: [{ type: "text", text: message }], details };
			}

			const loaded = getConfig();
			if (!loaded.ok) {
				const details = searchErrorDetails(params.query, loaded.message, loaded.reason);
				return { content: [{ type: "text", text: loaded.message }], details };
			}

			const config = loaded.config;
			const retryOnEmpty = params.retry_on_empty ?? false;
			const nativeResolution = config.enableNative
				? await resolveNativeEntry(ctx?.model, ctx?.modelRegistry)
				: { kind: "unmatched" as const };
			const warnings: string[] = [];
			if (nativeResolution.kind === "error" && !config.appendProvidersAsFallback) {
				const message = nativeResolution.message;
				const details = searchErrorDetails(params.query, message);
				return { content: [{ type: "text", text: message }], details };
			}
			if (nativeResolution.kind === "error") warnings.push(nativeResolution.message);
			const nativeRoute = nativeResolution.kind === "ready" ? nativeResolution.route : null;
			const routes = resolveRoutes(config, nativeRoute ?? undefined);
			const providerLabels = (config.appendProvidersAsFallback ? routes : routes.slice(0, 1)).map(
				providerEntryLabel,
			);
			const progressDetails: SearchProgressDetails = {
				phase: "searching",
				query: params.query,
				providerLabels,
				...(params.allowed_domains ? { allowedDomains: params.allowed_domains } : {}),
				...(params.blocked_domains ? { blockedDomains: params.blocked_domains } : {}),
			};
			onUpdate?.({
				content: [{ type: "text", text: formatSearchProgressText(progressDetails) }],
				details: progressDetails,
			});

			const request = {
				query: params.query,
				...(params.allowed_domains === undefined ? {} : { allowedDomains: params.allowed_domains }),
				...(params.blocked_domains === undefined ? {} : { blockedDomains: params.blocked_domains }),
			};
			const details = await performSearch(
				config,
				request,
				signal,
				(providerLabel, attempts, routeLabels, maxResults) => {
					const attemptProgress: SearchProgressDetails = {
						...progressDetails,
						currentProvider: providerLabel,
						attempts: [...attempts],
						routeLabels: [...routeLabels],
						...(maxResults === undefined ? {} : { maxResults }),
					};
					onUpdate?.({
						content: [{ type: "text", text: formatSearchProgressText(attemptProgress) }],
						details: attemptProgress,
					});
				},
				nativeRoute ?? undefined,
				retryOnEmpty,
			);
			const result = warnings.length > 0 ? { ...details, warnings } : details;
			return { content: [{ type: "text", text: formatSearchText(details) }], details: result };
		},
		renderCall: (args, theme) => renderSearchCall(args, theme),
		renderResult: (result, options, theme) => renderSearchResult(result, options, theme),
	});
}

export const web_search = createWebSearchTool(() => ({
	ok: false,
	reason: "missing_config",
	message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
}));
