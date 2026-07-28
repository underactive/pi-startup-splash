import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { headerRenderState, state } from "./src/state.ts";
import { stopTaglineReveal } from "./src/reveal.ts";
import { ensureQuietStartup, installHeader } from "./src/header.ts";
import { readMenuGate, writeMenuGate } from "./src/preferences.ts";
import { GATE_DONE_ENV } from "./src/relaunch.ts";
import { runStartupGate } from "./src/gate.ts";

export default function piStartupGreeter(pi: ExtensionAPI) {
	pi.on("model_select", (_event, ctx) => {
		// Model rotation may change the base system prompt — refresh the size.
		// Guard against calls before the model is fully initialized.
		try {
			const newSize = Buffer.byteLength(ctx.getSystemPrompt(), "utf8");
			if (newSize !== state.systemPromptSize) {
				state.systemPromptSize = newSize;
			}
		} catch {
			// Model not ready yet; keep the previous size.
		}
		headerRenderState.invalidate?.();
		headerRenderState.requestRender?.();
	});

	pi.on("before_agent_start", (event) => {
		const newSize = Buffer.byteLength(event.systemPrompt, "utf8");
		if (newSize !== state.systemPromptSize) {
			state.systemPromptSize = newSize;
			headerRenderState.invalidate?.();
			headerRenderState.requestRender?.();
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		if (!state.quietStartupEnsured) {
			state.quietStartupEnsured = true;
			const changed = ensureQuietStartup(ctx.cwd);
			if (changed) {
				ctx.ui.notify("Enabled quietStartup for future Pi launches", "info");
			}
		}

		// Only gate a genuine fresh startup: never on reload, and never on a relaunched child
		// (GATE_DONE_ENV guard). Non-gated sessions start clean, without the splash.
		const shouldGate = event.reason === "startup" && process.env[GATE_DONE_ENV] !== "1";
		if (!shouldGate) return;

		// Install the splash header so it renders at the top during the gate (a non-overlay
		// custom component replaces only the editor region below it), then clear the terminal
		// so the splash starts at the very top of the window instead of inline below leftover
		// shell output.
		installHeader(pi, ctx);
		headerRenderState.forceRedraw?.();

		// Splash-only mode: keep the header wired (model/prompt-size lines keep refreshing)
		// and open the editor beneath it. The tagline reveal stops itself when the wipe ends.
		if (readMenuGate() === "off") return;

		const resolution = await runStartupGate(pi, ctx);
		if (resolution === "quit") {
			ctx.shutdown();
			return;
		}
		// "proceed" (New session / esc): swap the splash for an empty header and clear again
		// so the session itself starts at the top of a clean screen, without the logo.
		stopTaglineReveal();
		const clearScreen = headerRenderState.forceRedraw;
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		headerRenderState.invalidate = null;
		headerRenderState.requestRender = null;
		headerRenderState.forceRedraw = null;
		clearScreen?.();
	});

	const MENU_GATE_OPTIONS = ["menuGate:on", "menuGate:off"] as const;

	pi.registerCommand("startup-splash", {
		description: "Configure the startup splash header (menuGate:on|off)",
		getArgumentCompletions: (argumentPrefix) =>
			MENU_GATE_OPTIONS.filter((option) => option.startsWith(argumentPrefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim();

			// The gate is decided during session_start, so both choices land on the next launch.
			if (arg === "menuGate:off") {
				if (writeMenuGate("off")) {
					ctx.ui.notify("Startup gate menu disabled from the next launch onward", "info");
				} else {
					ctx.ui.notify("Could not save the startup splash preference", "error");
				}
				return;
			}

			if (arg === "menuGate:on") {
				if (writeMenuGate("on")) {
					ctx.ui.notify("Startup gate menu enabled from the next launch onward", "info");
				} else {
					ctx.ui.notify("Could not save the startup splash preference", "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /startup-splash menuGate:on|off", "error");
		},
	});
}
