import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** "on" shows the startup gate menu below the splash; "off" opens the editor directly beneath it. */
export type MenuGateMode = "on" | "off";

// Resolved per call rather than cached: PI_CODING_AGENT_DIR can point somewhere else by the
// time the extension runs (tests redirect it after import).
function preferencesPath(): string {
	return join(getAgentDir(), "pi-startup-splash.json");
}

/** Anything missing, unreadable or unrecognized falls back to "on" — the gate menu is the default. */
export function readMenuGate(): MenuGateMode {
	try {
		const parsed: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
		const mode = (parsed as { menuGate?: unknown } | null)?.menuGate;
		return mode === "off" ? "off" : "on";
	} catch {
		return "on";
	}
}

/** Returns false when the preference could not be persisted, so the caller can report it. */
export function writeMenuGate(mode: MenuGateMode): boolean {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(preferencesPath(), `${JSON.stringify({ menuGate: mode }, null, 2)}\n`, "utf8");
		return true;
	} catch {
		// Swallowed, not thrown: console output would corrupt the TUI.
		return false;
	}
}
