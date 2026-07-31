import type { Theme } from "@earendil-works/pi-coding-agent";

export const SWATCH_SATURATION = 0.78;
export const SWATCH_VALUE = 0.9;
/** Hue at the left edge: starts on pi's magenta so the logo sits over the sweep's warm end. */
export const SWATCH_HUE_START = 320;
/** Plate colors for the info panel: navy under light-on-dark themes, paper under dark-on-light. */
export const PANEL_BG_DARK = rgbFromHex("#101830");
export const PANEL_BG_LIGHT = rgbFromHex("#eef0f7");
/** Rec.601 luma threshold that separates light-on-dark from dark-on-light themes. */
export const PANEL_LUMINANCE_THRESHOLD = 140;

/** An `r;g;b` triplet, ready to splice into a truecolor SGR sequence. */
export type Rgb = string;

export const RESET = "\x1b[0m";

export function rgbFromHex(hex: string): Rgb {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `${r};${g};${b}`;
}

export function sgrFg(color: Rgb): string {
	return `\x1b[38;2;${color}m`;
}

export function sgrBg(color: Rgb): string {
	return `\x1b[48;2;${color}m`;
}

/** Convert HSV to an r;g;b SGR triplet. Hue in degrees 0-360, saturation and value 0-1. */
export function hsvRgb(hue: number, saturation: number, value: number): Rgb {
	const chroma = value * saturation;
	const sector = (((hue % 360) + 360) % 360) / 60;
	const x = chroma * (1 - Math.abs((sector % 2) - 1));
	const [r, g, b] =
		sector < 1 ? [chroma, x, 0]
		: sector < 2 ? [x, chroma, 0]
		: sector < 3 ? [0, chroma, x]
		: sector < 4 ? [0, x, chroma]
		: sector < 5 ? [x, 0, chroma]
		: [chroma, 0, x];
	const base = value - chroma;
	return `${Math.round((r + base) * 255)};${Math.round((g + base) * 255)};${Math.round((b + base) * 255)}`;
}

/**
 * Picks the plate the panel text can actually be read on. Themes that draw body text light
 * (the usual dark-terminal case) get the navy plate; dark body text gets a paper plate.
 * Themes limited to 256 colors report no rgb triplet and are assumed to be dark-terminal.
 */
export function panelBg(theme: Theme): Rgb {
	const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.getFgAnsi("text"));
	if (!rgb) return PANEL_BG_DARK;
	const luminance = Number(rgb[1]) * 0.299 + Number(rgb[2]) * 0.587 + Number(rgb[3]) * 0.114;
	return luminance > PANEL_LUMINANCE_THRESHOLD ? PANEL_BG_DARK : PANEL_BG_LIGHT;
}

/**
 * Backdrop color for one half-cell: hue sweeps a full turn across the terminal width while
 * `level` (1 at the top row, 0 at the bottom) fades the whole sweep out to black.
 */
export function swatchColor(x: number, width: number, level: number): Rgb {
	const hue = SWATCH_HUE_START + (x / Math.max(1, width)) * 360;
	return hsvRgb(hue, SWATCH_SATURATION, SWATCH_VALUE * Math.max(0, level));
}
