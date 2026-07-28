import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { headerRenderState, state } from "./state.ts";
import { startTaglineReveal, taglineReveal } from "./reveal.ts";
import { getLoadedHeaderItems } from "./discovery.ts";
import { buildHeader } from "./splash.ts";

/** Runs `fn` with a `SettingsManager` for `cwd`, swallowing errors to avoid corrupting the TUI with console output. */
export function withSettings(cwd: string, fn: (settings: SettingsManager) => void): void {
	try {
		const settings = SettingsManager.create(cwd);
		fn(settings);
	} catch {
		// Avoid corrupting the TUI with console output.
	}
}

export function ensureQuietStartup(cwd: string): boolean {
	let changed = false;
	withSettings(cwd, (settings) => {
		if (!settings.getQuietStartup()) {
			settings.setQuietStartup(true);
			changed = true;
		}
	});
	return changed;
}

export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext) {
	({ skills: state.loadedSkills, extensions: state.loadedExtensions } = getLoadedHeaderItems(pi));
	ctx.ui.setHeader((tui: TUI, theme: Theme) => {
		headerRenderState.requestRender = () => tui.requestRender();
		// force=true resets the differential renderer and repaints from a cleared screen
		// (the TUI emits \x1b[2J\x1b[H\x1b[3J before redrawing all content at the top).
		headerRenderState.forceRedraw = () => tui.requestRender(true);
		let cachedWidth = -1;
		let cachedRows = -1;
		let cachedModelKey = "";
		let cachedSystemPromptSize: number | undefined = undefined;
		let cachedTick = -1;
		let cachedLines: string[] = [];
		const component = {
			render: (width: number) => {
				const rows = tui.terminal.rows;
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
				if (width !== cachedWidth || rows !== cachedRows || modelKey !== cachedModelKey || state.systemPromptSize !== cachedSystemPromptSize || taglineReveal.tick !== cachedTick) {
					cachedWidth = width;
					cachedRows = rows;
					cachedModelKey = modelKey;
					cachedSystemPromptSize = state.systemPromptSize;
					cachedTick = taglineReveal.tick;
					cachedLines = buildHeader(width, rows, theme, state.loadedSkills, state.loadedExtensions, ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined, state.systemPromptSize);
				}
				return cachedLines;
			},
			invalidate() {
				cachedWidth = -1;
				cachedRows = -1;
				cachedModelKey = "";
				cachedSystemPromptSize = undefined;
				cachedTick = -1;
			},
		};
		headerRenderState.invalidate = () => component.invalidate();
		return component;
	});
	// Capture the initial system prompt size so the line appears on the first splash render.
	state.systemPromptSize = Buffer.byteLength(ctx.getSystemPrompt(), "utf8");
	// Started last: the first tick needs the wired requestRender and the size captured above.
	startTaglineReveal();
}
