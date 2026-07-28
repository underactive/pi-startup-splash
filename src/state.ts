
/**
 * Module-scoped state that lives for the lifetime of the extension process (not per-session).
 * - `quietStartupEnsured` guards the settings write so it only runs once per process.
 * - `loadedSkills`/`loadedExtensions` cache the most recent header item lists so the header
 *   component's `render()` (invoked on every TUI frame) doesn't need to re-scan commands/tools.
 * Bundled into one object so the intentional shared-state pattern is explicit at a glance.
 */
export const state = {
	quietStartupEnsured: false,
	loadedSkills: [] as string[],
	loadedExtensions: [] as string[],
	systemPromptSize: undefined as number | undefined,
	/** True when the splash header lists every skill and extension inline (terminal is tall enough). */
	skillsExtensionsListed: false,
};

/** Callbacks wired by the active header component so model_select can force a refresh. */
export const headerRenderState = {
	invalidate: null as (() => void) | null,
	requestRender: null as (() => void) | null,
	/** Clears the terminal (screen + scrollback) and repaints all TUI content from the top row. */
	forceRedraw: null as (() => void) | null,
};
