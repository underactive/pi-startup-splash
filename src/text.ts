
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export const ELLIPSIS = "...";

/** Visible terminal columns, measured with the renderer's own ruler (wide chars, graphemes, SGR/OSC). */
export function visibleLength(text: string): number {
	return visibleWidth(text);
}

/**
 * Formats a byte count as an estimated token count (~4 bytes per token).
 * - Under 1000 tokens: `~512 tokens`
 * - 1000 tokens and above: `~10.5k tokens` (one decimal place)
 *
 * ~4 bytes/token is a rough approximation — actual tokens vary by model tokenizer
 * (CJK/code content tokenizes differently), and this estimate should not be used
 * for cost-critical calculations.
 */
export function formatPromptSize(bytes: number): string {
	if (!Number.isFinite(bytes)) return "unknown";
	const tokens = bytes / 4;
	if (tokens < 1000) return `~${Math.round(tokens)} tokens`;
	return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

export function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

export function padCenter(text: string, width: number): string {
	const total = Math.max(0, width - visibleLength(text));
	const leftPad = Math.floor(total / 2);
	return `${" ".repeat(leftPad)}${text}${" ".repeat(total - leftPad)}`;
}

/** Wrap items comma-separated to `width` visible columns. Adds a trailing comma on line breaks. Returns [] for empty items. */
export function wrapCommaDelimited(items: string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const chunk = current.length === 0 ? item : `, ${item}`;
		// Reserve one column for the trailing comma added when the line breaks.
		if (current.length > 0 && visibleWidth(current) + visibleWidth(chunk) + 1 > safeWidth) {
			lines.push(`${current},`);
			current = item;
			continue;
		}
		current += chunk;
	}
	if (current) lines.push(current);
	return lines;
}

export function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/** Strip ANSI escape sequences (SGR `\x1b[...m` and OSC `\x1b]...` with BEL or ST terminator) to prevent terminal injection. */
export function sanitizeTuiText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

export function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.filter(Boolean).map(sanitizeTuiText))].sort((a, b) => a.localeCompare(b));
}

/**
 * Truncates `text` to at most `maxWidth` visible columns. Escape sequences never count
 * against the width budget and are never split mid-sequence; a wide character straddling
 * the cut is dropped rather than allowed to overflow it.
 */
export function truncateVisible(text: string, maxWidth: number): string {
	return sliceByColumn(text, 0, maxWidth, true);
}

/**
 * Truncates `text` to `width` visible columns, closing any color span the cut landed inside
 * (foreground only, so a surrounding panel background survives) and marking it with an ellipsis.
 */
export function fitCell(text: string, width: number): string {
	if (visibleLength(text) <= width) return text;
	return `${truncateVisible(text, Math.max(0, width - ELLIPSIS.length))}\x1b[39m${ELLIPSIS}`;
}

/** Joins the parts that are actually present, so absent metadata leaves no dangling separator. */
export function joinParts(parts: (string | undefined | null | false)[], separator = " · "): string {
	return parts.filter((part): part is string => Boolean(part)).join(separator);
}

/** The first candidate that fits `width`, else the last one truncated to fit. */
export function pickFitting(candidates: string[], width: number): string {
	return candidates.find((candidate) => visibleLength(candidate) <= width) ?? fitCell(candidates[candidates.length - 1], width);
}
