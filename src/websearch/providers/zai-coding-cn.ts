import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { JsonValue, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { bearerToken, getObject, getString, result } from "./shared.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const TOOL_NAME = "web_search_prime";

/** The web-search-prime server double-encodes its result array: content[0].text
 *  is the JSON serialization of a JSON string. Parse twice to reach the array. */
function parseToolPayload(text: string): JsonValue[] {
	let payload: unknown = JSON.parse(text);
	if (typeof payload === "string") payload = JSON.parse(payload);
	if (!Array.isArray(payload)) throw new Error("zai-coding-cn returned a non-array payload");
	return payload as JsonValue[];
}

/** Native routes resolve baseUrl from the model's chat endpoint, which is not
 *  the MCP endpoint. Trust config.baseUrl only when it explicitly targets the
 *  MCP server path (manual fallback_chain entries, api.z.ai global host). */
function resolveBaseUrl(configured: string | undefined): string {
	return configured?.includes("/api/mcp/") ? configured : DEFAULT_BASE_URL;
}

function textOf(value: JsonValue | undefined): string | undefined {
	return getString(value);
}

export const zaiCodingCnProvider: ProviderModule = {
	async search(ctx: BuildContext, signal: AbortSignal): Promise<SearchResultItem[]> {
		const apiKey = ctx.config.apiKey ?? bearerToken((ctx.config as { headers?: Record<string, string> }).headers);
		if (!apiKey) throw new Error("zai-coding-cn requires an apiKey");
		const baseUrl = resolveBaseUrl(ctx.config.baseUrl);

		const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
			requestInit: {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal,
			},
		});
		const client = new Client({ name: "pi-websearch", version: "0.0.0" }, { capabilities: {} });

		try {
			await client.connect(transport as unknown as Transport); // SDK 1.30 declares Transport.sessionId?: string while StreamableHTTPClientTransport implements string | undefined; incompatible under exactOptionalPropertyTypes.
			const response = await client.callTool({
				name: TOOL_NAME,
				arguments: { search_query: ctx.request.query },
			});

			const content = Array.isArray(response.content) ? response.content : [];
			const textPart = content.find(
				(part): part is { type: "text"; text: string } =>
					part && typeof part === "object" && part["type"] === "text",
			);

			if (response.isError) {
				throw new Error(`zai-coding-cn tool reported an error: ${textPart?.text ?? "tool error"}`);
			}

			const rawText = textPart?.["text"];
			if (typeof rawText !== "string") throw new Error("zai-coding-cn returned no text content");

			const payload = parseToolPayload(rawText);

			const items: SearchResultItem[] = [];
			for (const raw of payload) {
				const item = getObject(raw);
				if (!item) continue;
				const title = textOf(item["title"]);
				const url = textOf(item["link"]);
				if (!title || !url) continue;
				const snippet = textOf(item["content"]);
				const built = result(title, url, snippet);
				if (built) items.push(built);
			}
			return items;
		} finally {
			await client.close().catch(() => undefined);
		}
	},
};
