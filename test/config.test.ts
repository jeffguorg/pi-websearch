import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadWebsearchConfig, validateProviderConfig, validateWebsearchConfig } from "../src/websearch/config.js";

async function makeTempHome(): Promise<string> {
	const root = join(tmpdir(), `pi-websearch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("loadWebsearchConfig", () => {
	it("#given no config files #when loading config #then returns duckduckgo html default", async () => {
		// given
		const root = await makeTempHome();

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.source).toBe("default:duckduckgo-html");
				expect(result.config).toEqual({
					strategy: "priority",
					fallback: false,
					auto: true,
					providers: [{ id: "default", provider: "duckduckgo-html", maxResults: 10 }],
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given project and global config #when loading config #then project config wins", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		const globalPi = join(root, ".pi-home");
		await mkdir(projectPi, { recursive: true });
		await mkdir(globalPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ provider: "exa", apiKey: "exa-project", maxResults: 3 }),
			"utf8",
		);
		await writeFile(
			join(globalPi, "websearch.json"),
			JSON.stringify({ provider: "tavily", apiKey: "global" }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: globalPi });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.strategy).toBe("priority");
				expect(result.config.fallback).toBe(false);
				expect(result.config.auto).toBe(true);
				expect(result.config.providers).toEqual([{ provider: "exa", apiKey: "exa-project", maxResults: 3 }]);
				expect(result.source).toBe(join(projectPi, "websearch.json"));
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given malformed auto field in file #when loading #then rejects instead of enabling native routing", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ auto: "false", provider: "duckduckgo-html" }),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given backend alias config #when loading config #then preserves explicit override", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ backend: "brave", apiKey: "brave-test" }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.source).toBe(join(projectPi, "websearch.json"));
				expect(result.config.providers).toEqual([{ provider: "brave", apiKey: "brave-test" }]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given fallback_chain #when loading config #then normalizes it into the executable provider chain", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				fallback_chain: [
					{ id: "tavily", provider: "tavily", apiKey: "tavily-test" },
					{ id: "ddg", provider: "duckduckgo-html" },
				],
			}),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.fallback).toBe(false);
				expect(result.config.providers.map((entry) => entry.id)).toEqual(["tavily", "ddg"]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given optional uninstalled plugin in fallback_chain #when loading #then skips it and keeps available entries", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				fallback_chain: [
					{ id: "zhipu-mcp", provider: "zhipu-mcp", optional: true },
					{ id: "ddg", provider: "duckduckgo-html" },
				],
			}),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.providers.map((entry) => entry.id)).toEqual(["ddg"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given optional provider without credentials #when loading #then skips it and keeps the final DDG route", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				fallback_chain: [
					{ id: "tavily", provider: "tavily", optional: true },
					{ id: "ddg", provider: "duckduckgo-html" },
				],
			}),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.providers.map((entry) => entry.id)).toEqual(["ddg"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given malformed non-optional fallback entry #when loading #then rejects the whole chain", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ fallback_chain: [{ id: "missing-provider" }, { provider: "duckduckgo-html" }] }),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given providers and fallback_chain together #when loading config #then rejects ambiguous chains", async () => {
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				providers: [{ provider: "duckduckgo-html" }],
				fallback_chain: [{ provider: "duckduckgo-html" }],
			}),
			"utf8",
		);

		try {
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given multiple providers #when loading config #then preserves routing policy", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				strategy: "round-robin",
				fallback: true,
				providers: [
					{
						id: "anthropic-gateway",
						provider: "anthropic",
						apiKey: "anthropic-test",
						baseUrl: "https://anthropic.gateway.example.com/v1/messages",
						weight: 2,
					},
					{ id: "exa-search", provider: "exa", apiKey: "exa-test", priority: 10 },
				],
			}),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.strategy).toBe("round-robin");
				expect(result.config.providers).toHaveLength(2);
				expect(result.config.providers[0]).toMatchObject({
					id: "anthropic-gateway",
					provider: "anthropic",
					weight: 2,
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given legacy config with auto false #when loading config #then disables native auto route", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ provider: "exa", apiKey: "exa-test", auto: false }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.auto).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given multi-provider config with auto false #when loading config #then disables native auto route", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				auto: false,
				providers: [{ provider: "exa", apiKey: "exa-test" }],
			}),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.auto).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given empty provider list #when loading config #then config is invalid", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(join(projectPi, "websearch.json"), JSON.stringify({ providers: [] }), "utf8");

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain("at least one provider");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("validateWebsearchConfig", () => {
	it("#given malformed recognized fields #when validating #then config is invalid", () => {
		const invalidConfig = JSON.parse(
			JSON.stringify({
				strategy: "not-a-strategy",
				fallback: false,
				auto: true,
				providers: [{ provider: "duckduckgo-html" }],
			}),
		);

		const result = validateWebsearchConfig(invalidConfig);

		expect(result.ok).toBe(false);
	});

	it("#given config with non-boolean auto #when validating #then config is invalid", () => {
		// given
		const invalidConfig = JSON.parse(
			JSON.stringify({
				strategy: "priority",
				fallback: true,
				auto: "yes",
				providers: [{ provider: "exa", apiKey: "exa-test" }],
			}),
		);

		// when
		const result = validateWebsearchConfig(invalidConfig);

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("auto");
	});
});

it("#given provider entry with timeoutMs #when loading config #then preserves timeout", async () => {
	// given
	const root = await makeTempHome();
	const projectPi = join(root, ".pi");
	await mkdir(projectPi, { recursive: true });
	await writeFile(
		join(projectPi, "websearch.json"),
		JSON.stringify({
			providers: [{ id: "slow", provider: "exa", apiKey: "exa-test", timeoutMs: 15000 }],
		}),
		"utf8",
	);

	try {
		// when
		const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.providers[0]).toMatchObject({ id: "slow", timeoutMs: 15000 });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

describe("validateProviderConfig", () => {
	it("#given non-positive timeoutMs #when validating provider #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test", timeoutMs: 0 });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("timeoutMs");
		}
	});

	it("#given exa without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given exa with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given tavily without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "tavily" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given google without search engine id #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "google-cse", apiKey: "key" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("searchEngineId");
		}
	});

	it("#given z-ai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "z-ai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given perplexity with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "perplexity", apiKey: "pplx-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given xai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "xai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given kimi without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kimi" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given kimi with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kimi", apiKey: "kimi-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given codex without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "codex" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("apiKey");
		}
	});

	it("#given openai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "openai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("apiKey");
		}
	});

	it("#given anthropic without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "anthropic" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("apiKey");
		}
	});

	it("#given codex command in config file without api key #when loading #then provider is invalid", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ provider: "codex", codexCommand: "codex" }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain("apiKey");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given both config domain filter modes #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "brave",
			apiKey: "brave-test",
			allowedDomains: ["docs.example.com"],
			blockedDomains: ["spam.example.com"],
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid_config");
		}
	});

	it("#given unsafe base url #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "http://127.0.0.1:8080",
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid_config");
			expect(result.message).toContain("public HTTPS URL");
		}
	});

	it("#given public https base url override #when validating #then config is valid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "https://search-gateway.example.com/tavily",
		});

		// then
		expect(result.ok).toBe(true);
	});

	it("#given exa with private base url override #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", baseUrl: "https://localhost/search" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid_config");
		}
	});

	it("#given base url with credentials #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "https://user:pass@search-gateway.example.com/tavily",
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid_config");
		}
	});

	it("#given private ipv6 base url override #when validating #then config is invalid", () => {
		// given / when
		const loopback = validateProviderConfig({ provider: "exa", baseUrl: "https://[::1]/search" });
		const uniqueLocal = validateProviderConfig({ provider: "exa", baseUrl: "https://[fd00::1]/search" });
		const linkLocal = validateProviderConfig({ provider: "exa", baseUrl: "https://[fe80::1]/search" });
		const linkLocalUpperRange = validateProviderConfig({ provider: "exa", baseUrl: "https://[febf::1]/search" });
		const mappedLoopback = validateProviderConfig({ provider: "exa", baseUrl: "https://[::ffff:127.0.0.1]/search" });

		// then
		expect(loopback.ok).toBe(false);
		expect(uniqueLocal.ok).toBe(false);
		expect(linkLocal.ok).toBe(false);
		expect(linkLocalUpperRange.ok).toBe(false);
		expect(mappedLoopback.ok).toBe(false);
	});

	it("#given searxng without baseUrl #when validating #then provider reports missing_config", () => {
		// given / when
		const result = validateProviderConfig({ provider: "searxng" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_config");
			expect(result.message).toContain("baseUrl");
		}
	});

	it("#given searxng with private http baseUrl #when validating #then provider is valid without apiKey", () => {
		// given / when
		const result = validateProviderConfig({ provider: "searxng", baseUrl: "http://100.64.0.12:8888" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given searxng baseUrl with embedded credentials #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "searxng", baseUrl: "http://user:pass@100.64.0.12:8888" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid_config");
	});

	it("#given optional searxng without baseUrl in fallback_chain #when loading #then skips it and keeps other entries", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				fallback_chain: [
					{ id: "lan-searx", provider: "searxng", optional: true },
					{ id: "ddg", provider: "duckduckgo-html" },
				],
			}),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.providers.map((entry) => entry.id)).toEqual(["ddg"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given provider entry with headers #when loading config #then preserves headers", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({
				providers: [
					{
						id: "searx",
						provider: "searxng",
						baseUrl: "http://100.64.0.12:8888",
						headers: { Authorization: "Basic cGk6c2VjcmV0", "X-Empty": "  " },
					},
				],
			}),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.providers[0]).toMatchObject({
					id: "searx",
					headers: { Authorization: "Basic cGk6c2VjcmV0" },
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given non-object headers field #when loading config #then config is invalid", async () => {
		// given
		const root = await makeTempHome();
		const projectPi = join(root, ".pi");
		await mkdir(projectPi, { recursive: true });
		await writeFile(
			join(projectPi, "websearch.json"),
			JSON.stringify({ provider: "searxng", baseUrl: "http://100.64.0.12:8888", headers: "nope" }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
