import { beforeEach, describe, expect, it, vi } from "vitest";
import websearchExtension from "../src/index.js";
import type { ConfigLoadResult } from "../src/websearch/types.js";

type SessionHandler = (event: object, ctx: object) => Promise<void> | void;
type LoadWebsearchConfig = (options: { readonly cwd: string }) => Promise<ConfigLoadResult>;
type CommandHandler = (rawArgs: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;

const loadWebsearchConfig = vi.hoisted(() => vi.fn<LoadWebsearchConfig>());
vi.mock("../src/websearch/config.js", () => ({ loadWebsearchConfig }));

const activeConfig: ConfigLoadResult = {
	ok: true,
	source: "test",
	config: {
		strategy: "priority",
		fallback: true,
		auto: true,
		providers: [{ id: "default", provider: "duckduckgo-html" }],
	},
};

function createPi() {
	let sessionStart: SessionHandler | undefined;
	let statusCommand: CommandHandler | undefined;
	const pi = {
		registerTool: vi.fn(),
		registerCommand(_name: string, definition: { handler: CommandHandler }) {
			statusCommand = definition.handler;
		},
		on(eventName: string, handler: unknown) {
			if (eventName === "session_start") sessionStart = handler as SessionHandler;
		},
	};
	return { pi, getSessionStart: () => sessionStart, getStatusCommand: () => statusCommand };
}

function context(provider: string, notify = vi.fn()) {
	return {
		cwd: "/tmp/websearch",
		model: { provider, api: "openai-responses" },
		hasUI: true,
		ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify },
	};
}

describe("websearch extension state", () => {
	beforeEach(() => {
		loadWebsearchConfig.mockReset();
		loadWebsearchConfig.mockResolvedValue(activeConfig);
	});

	it.each(["local", "openai", "anthropic"])(
		"#given %s active provider #when session starts #then always loads provider-independent configuration",
		async (provider) => {
			const harness = createPi();
			await websearchExtension(harness.pi as never);
			const ctx = context(provider);

			await harness.getSessionStart()?.({}, ctx);

			expect(loadWebsearchConfig).toHaveBeenCalledWith({ cwd: "/tmp/websearch" });
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-websearch", undefined);
			expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-websearch", undefined);
		},
	);

	it("#given invalid config #when session starts #then reports the configuration error", async () => {
		const failure: ConfigLoadResult = {
			ok: false,
			reason: "invalid_config",
			message: "Invalid provider config",
		};
		loadWebsearchConfig.mockResolvedValue(failure);
		const harness = createPi();
		await websearchExtension(harness.pi as never);
		const notify = vi.fn();

		await harness.getSessionStart()?.({}, context("openai", notify));

		expect(notify).toHaveBeenCalledWith(failure.message, "error");
	});

	it("#given active config #when status runs #then reports only explicitly configured providers", async () => {
		loadWebsearchConfig.mockResolvedValue({
			ok: true,
			source: "test",
			config: {
				strategy: "priority",
				fallback: true,
				auto: true,
				providers: [
					{ id: "primary", provider: "exa", apiKey: "test-key" },
					{ id: "backup", provider: "duckduckgo-html" },
				],
			},
		});
		const harness = createPi();
		await websearchExtension(harness.pi as never);
		await harness.getSessionStart()?.({}, context("openai-codex"));
		const notify = vi.fn();

		await harness.getStatusCommand()?.("status", { ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("providers=exa/primary, duckduckgo-html/backup"),
			"info",
		);
	});
});
