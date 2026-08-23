import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadWebsearchConfig } from "./websearch/config.js";
import { loadExternalProviderExtensions } from "./websearch/providers.js";
import { providerEntryLabel } from "./websearch/search.js";
import { createWebSearchTool } from "./websearch/tool.js";
import type { ConfigLoadResult, WebsearchConfig } from "./websearch/types.js";

/** Directory scanned for external (scriptable) provider extensions. */
const EXTERNAL_PROVIDERS_DIR = join(homedir(), ".pi", "websearch", "providers");

const STATUS_KEY = "pi-websearch";
const WIDGET_KEY = "pi-websearch";

export default async function (pi: ExtensionAPI): Promise<void> {
	// Load external provider scripts (e.g. ~/.pi/websearch/providers/nutstore.ts)
	// before registering the tool so validation + native routing know about them.
	await loadExternalProviderExtensions(EXTERNAL_PROVIDERS_DIR);

	let state: ConfigLoadResult = {
		ok: false,
		reason: "missing_config",
		message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
	};

	function providerList(config: WebsearchConfig): string {
		return config.providers.map(providerEntryLabel).join(", ");
	}

	function clearUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		if (state.ok) {
			clearUi(ctx);
			return;
		}
		clearUi(ctx);
		ctx.ui.notify(state.message, "error");
	}

	pi.registerTool(createWebSearchTool(() => state));

	pi.on("session_start", async (_event, ctx) => {
		state = await loadWebsearchConfig({ cwd: ctx.cwd });
		updateUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUi(ctx);
	});

	pi.registerCommand("websearch", {
		description: "Show web search provider status",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args !== "" && args !== "status") {
				ctx.ui.notify("Usage: /websearch status", "warning");
				return;
			}
			if (state.ok) {
				ctx.ui.notify(
					`Web search active: strategy=${state.config.strategy}, auto=${state.config.auto ? "enabled" : "disabled"}, providers=${providerList(state.config)}`,
					"info",
				);
				return;
			}
			ctx.ui.notify(`Web search inactive: ${state.message}`, "error");
		},
	});
}
