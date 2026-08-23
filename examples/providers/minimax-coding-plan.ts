// Fallback-only direct provider for MiniMax Coding Plan web search.
// Copy to ~/.pi/websearch/providers/minimax-coding-plan.ts and set
// MINIMAX_API_KEY plus MINIMAX_API_HOST (https://api.minimaxi.com for China or
// https://api.minimax.io internationally).

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default {
	provider: "minimax-mcp",
	async search({ request }: { request: { query: string } }, signal: AbortSignal) {
		const apiKey = process.env["MINIMAX_API_KEY"];
		const apiHost = process.env["MINIMAX_API_HOST"];
		if (!apiKey || !apiHost) throw new Error("MINIMAX_API_KEY and MINIMAX_API_HOST are required");
		const endpoint = new URL("/v1/coding_plan/search", apiHost);
		if (endpoint.protocol !== "https:" || !["api.minimaxi.com", "api.minimax.io"].includes(endpoint.hostname)) {
			throw new Error("MINIMAX_API_HOST must be https://api.minimaxi.com or https://api.minimax.io");
		}
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"MM-API-Source": "pi-websearch",
			},
			body: JSON.stringify({ q: request.query }),
			signal,
			redirect: "error",
		});
		if (!response.ok) throw new Error(`MiniMax search failed with HTTP ${response.status}`);
		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
		const organic = (payload as Record<string, unknown>)["organic"];
		if (!Array.isArray(organic)) return [];
		return organic.flatMap((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const entry = item as Record<string, unknown>;
			const title = text(entry["title"]);
			const url = text(entry["link"]);
			if (!title || !url) return [];
			const snippet = text(entry["snippet"]);
			return [{ title, url, ...(snippet ? { snippet } : {}) }];
		});
	},
};
