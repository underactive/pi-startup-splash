import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { RESET, panelBg, sgrBg, sgrFg, swatchColor } from "./color.ts";
import type { Rgb } from "./color.ts";
import { LOGO_INK, LOGO_LINES, LOGO_SHADOW, LOGO_SHADOW_OFFSET, LOGO_WIDTH } from "./logo.ts";
import { fitCell, formatPromptSize, joinParts, padCenter, padRight, pickFitting, truncateVisible, visibleLength, wrapCommaDelimited } from "./text.ts";
import { renderTagline } from "./reveal.ts";

/**
 * Upper half block: every splash cell carries two vertical color samples (fg = top half,
 * bg = bottom half), doubling the backdrop's vertical resolution.
 */
export const SWATCH_CELL = "▀";

/** Columns kept clear of content at both edges of the splash. */
export const SPLASH_MARGIN_X = 3;
/** Columns between the logo and the info panel when they sit side by side. */
export const LOGO_GAP = 4;
export const PANEL_PADDING_X = 2;
export const PANEL_MAX_WIDTH = 72;
/** Narrower than this and the panel drops below the logo instead of sitting beside it. */
export const PANEL_MIN_WIDTH = 34;
/** Rows of bare swatch above and below the panel, so the rainbow reads as an unbroken band there. */
export const PANEL_MARGIN_Y = 1;
/**
 * Ceiling on how much of the terminal the splash may occupy, so the startup gate below it still
 * fits. Past this the two lists collapse to a counts line.
 */
export const MAX_SPLASH_ROW_SHARE = 0.6;

/** A heading row, then the items wrapped as a block beneath it across the panel's full width. */
export function buildLabeledWrappedSection(theme: Theme, label: string, items: string[], width: number, count?: number): string[] {
	const wrapped = wrapCommaDelimited(items.length > 0 ? items : ["none"], width);
	// Items carry an explicit color: on the panel plate there is no default foreground to fall
	// back on, only whatever the swatch cell to the left of the panel happened to set.
	const heading = count === undefined ? theme.fg("warning", label) : `${theme.fg("warning", label)} ${theme.fg("text", String(count))}`;
	return [heading, ...wrapped.map((line) => theme.fg("text", line))];
}

/** All three lists collapsed to `[context] 2 · [skills] 22 · [extensions] 33`, for panels too small to spell them out. */
export function buildCountsLine(theme: Theme, context: string[], skills: string[], extensions: string[], width: number): string {
	const count = (label: string, items: string[]) => `${theme.fg("warning", label)} ${theme.fg("text", String(items.length))}`;
	const line = `${count("[context]", context)}${theme.fg("dim", " · ")}${count("[skills]", skills)}${theme.fg("dim", " · ")}${count("[extensions]", extensions)}`;
	return padCenter(fitCell(line, width), width);
}

/**
 * Interior lines of the info panel, mirroring the splash's rule/tagline/body rhythm: the pi
 * version as a titled rule, the active model as a centered tagline, then `body` (the loaded
 * skills and extensions, either listed in full or collapsed to counts).
 */
export function buildPanelLines(theme: Theme, innerWidth: number, body: string[], model?: { id: string; provider: string }, systemPromptSize?: number): string[] {
	const title = `pi v${VERSION}`;
	const rule = Math.max(0, innerWidth - title.length - 2);
	const leftRule = Math.floor(rule / 2);
	const heading = `${theme.fg("border", "─".repeat(leftRule))} ${theme.fg("accent", title)} ${theme.fg("border", "─".repeat(rule - leftRule))}`;
	const prompt = systemPromptSize === undefined ? "" : formatPromptSize(systemPromptSize);
	const tagline = pickFitting(
		[
			joinParts([model && `${model.id} (${model.provider})`, prompt]),
			joinParts([model?.id, prompt]),
			joinParts([model?.id]),
		],
		// The tagline is wrapped in "- " and " -".
		innerWidth - 4,
	);
	return [
		heading,
		...(tagline ? [padCenter(renderTagline(theme, tagline), innerWidth)] : []),
		"",
		...body,
	];
}

/** A logo cell painted over the swatch backdrop. */
export interface Ink {
	ch: string;
	color: Rgb;
	/** What shows through the glyph's unpainted half; the swatch when absent. */
	backdrop?: Rgb;
}

/** The plate and its pre-styled interior lines, positioned within the splash. */
export interface PanelPlacement {
	x: number;
	y: number;
	width: number;
	bg: Rgb;
	lines: string[];
}

/**
 * Writes the logo into `ink` (keyed by row-major cell index) as two whole layers: the shadow
 * offset down-right, then the logo over it. The art's Powerline glyphs paint only half their
 * cell, so each layer keeps whatever sits beneath it as its backdrop — shadow under the logo's
 * angled edges, swatch everywhere else. Compositing per layer rather than per glyph is what
 * keeps the diagonals smooth instead of stepping through the shadow color.
 */
export function stampLogo(ink: Map<number, Ink>, width: number, height: number, originX: number, originY: number): void {
	const place = (dx: number, dy: number): Map<number, string> => {
		const layer = new Map<number, string>();
		LOGO_LINES.forEach((line, row) => {
			for (let col = 0; col < line.length; col++) {
				const ch = line[col];
				if (ch === " ") continue;
				const x = originX + col + dx;
				const y = originY + row + dy;
				if (x >= 0 && x < width && y >= 0 && y < height) layer.set(y * width + x, ch);
			}
		});
		return layer;
	};

	const shadow = place(LOGO_SHADOW_OFFSET, LOGO_SHADOW_OFFSET);
	const logo = place(0, 0);
	for (const [index, ch] of shadow) ink.set(index, { ch, color: LOGO_SHADOW });
	for (const [index, ch] of logo) {
		ink.set(index, { ch, color: LOGO_INK, backdrop: shadow.has(index) ? LOGO_SHADOW : undefined });
	}
}

/** Renders the panel's slice of row `y`: one padded interior line on the plate. */
export function paintPanelRow(panel: PanelPlacement, y: number): string {
	const text = `${" ".repeat(PANEL_PADDING_X)}${panel.lines[y - panel.y] ?? ""}`;
	return `${sgrBg(panel.bg)}${padRight(truncateVisible(text, panel.width), panel.width)}${RESET}`;
}

/**
 * Paints one splash row: the swatch backdrop with logo ink and the panel composited on top.
 * Color codes are emitted only where a cell actually changes color.
 */
export function paintRow(y: number, width: number, height: number, ink: Map<number, Ink>, panel: PanelPlacement): string {
	let row = "";
	let currentFg = "";
	let currentBg = "";
	for (let x = 0; x < width; x++) {
		if (x === panel.x && y >= panel.y && y < panel.y + panel.lines.length) {
			row += paintPanelRow(panel, y);
			currentFg = "";
			currentBg = "";
			x += panel.width - 1;
			continue;
		}
		const cell = ink.get(y * width + x);
		const cellFg = cell ? cell.color : swatchColor(x, width, (height - y) / height);
		const cellBg = cell?.backdrop ?? swatchColor(x, width, (height - y - 0.5) / height);
		if (cellFg !== currentFg) {
			row += sgrFg(cellFg);
			currentFg = cellFg;
		}
		if (cellBg !== currentBg) {
			row += sgrBg(cellBg);
			currentBg = cellBg;
		}
		row += cell ? cell.ch : SWATCH_CELL;
	}
	return `${row}${RESET}`;
}

/** Paints the whole splash: the swatch, the logo stamped into it, and the panel on top. */
export function paintSplash(width: number, height: number, logoX: number, logoY: number, panel: PanelPlacement): string[] {
	const ink = new Map<number, Ink>();
	stampLogo(ink, width, height, logoX, logoY);
	return Array.from({ length: height }, (_, y) => paintRow(y, width, height, ink, panel));
}

/**
 * Builds the splash: a full-bleed rainbow swatch carrying the pi logo on the left and the dark
 * info panel beside it. Terminals too narrow for both stack the panel under the logo. The splash
 * grows to whatever height the panel needs so every entry is listed in full; when that would
 * either overrun the row budget or cut off the longest name, the lists collapse to counts.
 *
 * The info panel lists the loaded context files (AGENTS.md/CLAUDE.md), skills and extensions,
 * each under a `[context] N`/`[skills] N`/`[extensions] N` heading, mirroring pi's /loaded
 * ordering. Every layout keeps a spare row below the logo, where its drop shadow lands.
 */
export function buildHeader(width: number, termRows: number, theme: Theme, context: string[], skills: string[], extensions: string[], model?: { id: string; provider: string }, systemPromptSize?: number): string[] {
	const logoRows = LOGO_LINES.length;
	const roomBesideLogo = width - SPLASH_MARGIN_X * 2 - LOGO_WIDTH - LOGO_GAP;
	const sideBySide = roomBesideLogo >= PANEL_MIN_WIDTH;
	const panelWidth = sideBySide
		? Math.min(PANEL_MAX_WIDTH, roomBesideLogo)
		: Math.min(width, Math.max(PANEL_PADDING_X * 2 + 1, width - SPLASH_MARGIN_X * 2));
	const innerWidth = Math.max(1, panelWidth - PANEL_PADDING_X * 2);

	const frame = (body: string[]) => ["", ...buildPanelLines(theme, innerWidth, body, model, systemPromptSize), ""];
	const splashHeight = (panelLines: string[]) => {
		const band = panelLines.length + PANEL_MARGIN_Y * 2;
		return sideBySide ? Math.max(logoRows + 2, band) : logoRows + 1 + band;
	};

	// The budget never drops below what the logo alone needs, since nothing can shrink past that.
	const rowBudget = Math.max(logoRows + 2, Math.floor(termRows * MAX_SPLASH_ROW_SHARE));
	const widestItem = Math.max(0, ...context.map(visibleLength), ...skills.map(visibleLength), ...extensions.map(visibleLength));
	const listed = widestItem <= innerWidth
		? frame([
			...buildLabeledWrappedSection(theme, "[context]", context, innerWidth, context.length),
			"",
			...buildLabeledWrappedSection(theme, "[skills]", skills, innerWidth, skills.length),
			"",
			...buildLabeledWrappedSection(theme, "[extensions]", extensions, innerWidth, extensions.length),
		])
		: undefined;
	const lines = listed && splashHeight(listed) <= rowBudget
		? listed
		: frame([buildCountsLine(theme, context, skills, extensions, innerWidth)]);
	const height = splashHeight(lines);
	const panelX = sideBySide ? width - SPLASH_MARGIN_X - panelWidth : Math.max(0, Math.floor((width - panelWidth) / 2));
	return paintSplash(
		width,
		height,
		sideBySide ? Math.max(SPLASH_MARGIN_X, Math.floor((panelX - LOGO_WIDTH) / 2)) : Math.max(0, Math.floor((width - LOGO_WIDTH) / 2)),
		sideBySide ? Math.floor((height - logoRows) / 2) : 0,
		{
			x: panelX,
			y: sideBySide ? Math.floor((height - lines.length) / 2) : logoRows + 1 + PANEL_MARGIN_Y,
			width: panelWidth,
			bg: panelBg(theme),
			lines,
		},
	);
}
