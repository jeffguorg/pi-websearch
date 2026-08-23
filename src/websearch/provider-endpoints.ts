import type { SearchProviderConfig } from "./types.js";

const DEFAULT_PROVIDER_URLS: Record<string, string> = {
	exa: "https://api.exa.ai/search",
	tavily: "https://api.tavily.com/search",
	brave: "https://api.search.brave.com/res/v1/web/search",
	"duckduckgo-html": "https://html.duckduckgo.com/html/",
	serper: "https://google.serper.dev/search",
	"google-cse": "https://customsearch.googleapis.com/customsearch/v1",
	"z-ai": "https://api.z.ai/api/paas/v4/web_search",
	openai: "https://api.openai.com/v1/responses",
	codex: "https://api.openai.com/v1/responses",
	openrouter: "https://openrouter.ai/api/v1/chat/completions",
	anthropic: "https://api.anthropic.com/v1/messages",
	perplexity: "https://api.perplexity.ai/search",
	xai: "https://api.x.ai/v1/responses",
	kimi: "https://api.kimi.com/coding/v1/search",
	deepseek: "https://api.deepseek.com/anthropic/v1/messages",
};

export function defaultProviderUrl(provider: string): string | undefined {
	return DEFAULT_PROVIDER_URLS[provider];
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const first = parts[0] ?? -1;
	const second = parts[1] ?? -1;
	if (first === 10 || first === 127 || first === 0 || (first === 169 && second === 254)) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return first === 192 && second === 168;
}

function isPrivateHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.includes(":") ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab][0-9a-f]:/.test(normalized) ||
		isPrivateIpv4(normalized)
	);
}

function parseCredentialFreeHttpUrl(baseUrl: string): URL | null {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return null;
	}
	if (
		(configured.protocol !== "https:" && configured.protocol !== "http:") ||
		configured.username !== "" ||
		configured.password !== "" ||
		configured.hostname.endsWith("..")
	) {
		return null;
	}
	return configured;
}

/** Strict policy for endpoints supplied by websearch configuration. */
export function isAllowedProviderBaseUrl(baseUrl: string): boolean {
	const configured = parseCredentialFreeHttpUrl(baseUrl);
	return configured !== null && configured.protocol === "https:" && !isPrivateHostname(configured.hostname);
}

/** Active model endpoints come from Pi's trusted model registry and may be local. */
export function isAllowedNativeProviderBaseUrl(baseUrl: string): boolean {
	return parseCredentialFreeHttpUrl(baseUrl) !== null;
}

export function providerUrl(config: SearchProviderConfig): string {
	return config.baseUrl ?? defaultProviderUrl(config.provider) ?? "";
}
