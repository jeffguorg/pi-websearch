import { describe, expect, it } from "vitest";

import { isAllowedConfiguredBaseUrl, isAllowedProviderBaseUrl } from "../src/websearch/provider-endpoints.js";

describe("provider endpoint safety", () => {
	it("#given localhost names with terminal DNS dots #when validating provider URLs #then rejects private hosts", () => {
		// given
		const privateBaseUrls = [
			"https://localhost./search",
			"https://sub.localhost./search",
			"https://127.1../search",
			"https://0177.0.0.1../search",
			"https://2130706433../search",
			"https://0x7f000001../search",
			"https://10.1../search",
		];

		for (const baseUrl of privateBaseUrls) {
			// when
			const allowed = isAllowedProviderBaseUrl(baseUrl);

			// then
			expect(allowed).toBe(false);
		}
	});

	it("#given a public FQDN with a terminal DNS dot #when validating the provider URL #then allows it", () => {
		// given
		const baseUrl = "https://search-gateway.example.com./search";

		// when
		const allowed = isAllowedProviderBaseUrl(baseUrl);

		// then
		expect(allowed).toBe(true);
	});

	it("#given a public hostname with repeated terminal dots #when validating the provider URL #then rejects it", () => {
		// given
		const baseUrl = "https://search-gateway.example.com../search";

		// when
		const allowed = isAllowedProviderBaseUrl(baseUrl);

		// then
		expect(allowed).toBe(false);
	});

	it("#given self-hosted provider with private http URL #when validating #then allows it", () => {
		// given
		const baseUrls = ["http://100.64.0.12:8888", "http://192.168.1.10:8080/searxng", "https://searx.lan"];

		for (const baseUrl of baseUrls) {
			// when
			const allowed = isAllowedConfiguredBaseUrl("searxng", baseUrl);

			// then
			expect(allowed).toBe(true);
		}
	});

	it("#given self-hosted provider URL with credentials #when validating #then rejects it", () => {
		// given / when
		const allowed = isAllowedConfiguredBaseUrl("searxng", "http://user:pass@100.64.0.12:8888");

		// then
		expect(allowed).toBe(false);
	});

	it("#given hosted provider with private http URL #when validating #then still rejects it", () => {
		// given / when
		const allowed = isAllowedConfiguredBaseUrl("tavily", "http://192.168.1.10:8080");

		// then
		expect(allowed).toBe(false);
	});
});
