import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { uniqueSorted } from "./text.ts";

/**
 * Extension discovery and display, ported from pi's own package manager (`package-manager.js`)
 * and startup resource listing (`interactive-mode.js`). The `ExtensionAPI` does not expose the
 * resource loader, so the splash replicates what pi loads — settings `packages` (npm:, git: and
 * local paths), settings `extensions` entries and overrides, auto-discovery of the agent and
 * project `.pi/extensions` dirs, and CLI `--extension` sources — and labels them with pi's own
 * compact-label algorithm so the `[extensions]` list matches pi's startup screen exactly.
 */

/** A loaded extension entry, mirroring the resource loader's `{path, sourceInfo}` items. */
export interface DiscoveredExtension {
	path: string;
	/** The `sourceInfo.source` pi would attach: `npm:…`, `git:…`, `auto`, `local` or the CLI source string. */
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	/** Package root for package sources, agent dir / `.pi` for auto sources; `undefined` for CLI. */
	baseDir?: string;
}

interface ResourceMetadata {
	source: string;
	scope: DiscoveredExtension["scope"];
	origin: DiscoveredExtension["origin"];
	baseDir?: string;
}

interface ResourceEntry {
	metadata: ResourceMetadata;
	enabled: boolean;
}

type ResourceMap = Map<string, ResourceEntry>;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

// ---------------------------------------------------------------------------
// Ignore rules — port of the `ignore` package (v7) pi feeds `.gitignore`/`.ignore`/`.fdignore`
// lines into, reduced to the `ignored` outcome pi consumes. Semantics: last matching rule wins,
// a negated rule re-includes, and a path under an ignored parent stays ignored.
// ---------------------------------------------------------------------------

const ESCAPE = "\\";

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;

function sanitizeRange(range: string): string {
	return range.replace(REGEX_REGEXP_RANGE, (match, from: string, to: string) =>
		from.charCodeAt(0) <= to.charCodeAt(0) ? match : "",
	);
}

function cleanRangeBackSlash(slashes: string): string {
	const length = slashes.length;
	return slashes.slice(0, length - (length % 2));
}

/** Transcribes the `ignore` package's REPLACERS pipeline into a regex prefix. */
function makeRegexPrefix(pattern: string): string {
	const starting = pattern.replace(/^\uFEFF/, "");
	let out = starting.replace(/((?:\\\\)*?)(\\?\s+)$/, (_, m1: string, m2: string) =>
		m1 + (m2.startsWith("\\") ? " " : ""),
	);
	out = out.replace(/(\\+?)\s/g, (_, m1: string) => {
		const length = m1.length;
		return m1.slice(0, length - (length % 2)) + " ";
	});
	out = out.replace(/[\\$.|*+(){^]/g, (match) => `\\${match}`);
	out = out.replace(/(?!\\)\?/g, () => "[^/]");
	out = out.replace(/^\//, () => "^");
	out = out.replace(/\//g, () => "\\/");
	out = out.replace(/^\^*\\\*\\\*\\\//, () => "^(?:.*\\/)?");
	out = out.replace(/^(?=[^^])/, function (this: string) {
		return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
	}.bind(pattern));
	out = out.replace(/\\\/\\\*\\\*(?=\\\/|$)/g, (match, index: number, str: string) =>
		index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+",
	);
	out = out.replace(/(^|[^\\]+)(\\\*)+(?=.+)/g, (_, p1: string, p2: string) =>
		p1 + p2.replace(/\\\*/g, "[^\\/]*"),
	);
	out = out.replace(/\\\\\\(?=[$.|*+(){^])/g, () => ESCAPE);
	out = out.replace(/\\\\/g, () => ESCAPE);
	out = out.replace(/(\\)?\[([^\]/]*?)(\\*)($|\])/g, (match, leadEscape: string, range: string, endEscape: string, close: string) =>
		leadEscape === ESCAPE
			? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`
			: close === "]"
				? endEscape.length % 2 === 0
					? `[${sanitizeRange(range)}${endEscape}]`
					: "[]"
				: "[]",
	);
	out = out.replace(/(?:[^*])$/, (match) =>
		/\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`,
	);
	return out;
}

/** Trailing-wildcard handling: `abc/*` in check mode matches `abc/` itself, in ignore mode it does not. */
function withTrailingWildcard(regexPrefix: string, check: boolean): string {
	return regexPrefix.replace(/(^|\\\/)?\\\*$/, (_, p1: string | undefined) => {
		const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
		const checkPrefix = p1 ? `${p1}[^/]*` : "[^/]*";
		return `${check ? checkPrefix : prefix}(?=$|\\/$)`;
	});
}

interface IgnoreRuleEntry {
	regex: RegExp;
	checkRegex: RegExp;
	negative: boolean;
}

function compileIgnorePattern(pattern: string): IgnoreRuleEntry | undefined {
	// pi's checkPattern runs on the original line: blank, invalid trailing backslash, or `#` comment.
	if (/^\s+$/.test(pattern) || /(?:[^\\]|^)\\$/.test(pattern) || pattern.startsWith("#")) return undefined;
	let negative = false;
	let body = pattern;
	if (body.startsWith("!")) {
		negative = true;
		body = body.slice(1);
	}
	body = body.replace(/^\\!/, "!").replace(/^\\#/, "#");
	const regexPrefix = makeRegexPrefix(body);
	return {
		regex: new RegExp(withTrailingWildcard(regexPrefix, false)),
		checkRegex: new RegExp(withTrailingWildcard(regexPrefix, true)),
		negative,
	};
}

class IgnoreRules {
	private rules: IgnoreRuleEntry[] = [];

	addPatterns(patterns: string[]): void {
		for (const pattern of patterns) {
			const rule = compileIgnorePattern(pattern);
			if (rule) this.rules.push(rule);
		}
	}

	/** Last matching rule wins; `ignored = !negative`. */
	private rulesTest(path: string, check: boolean): boolean {
		let ignored = false;
		for (const rule of this.rules) {
			if ((check ? rule.checkRegex : rule.regex).test(path)) ignored = !rule.negative;
		}
		return ignored;
	}

	/** Parent-first walk: a path under an ignored parent stays ignored. */
	private t(path: string): boolean {
		const slices = path.split("/").filter(Boolean);
		slices.pop();
		if (slices.length === 0) return this.rulesTest(path, false);
		const parent = this.t(`${slices.join("/")}/`);
		return parent || this.rulesTest(path, false);
	}

	ignores(path: string): boolean {
		if (!/\/$/.test(path)) return this.t(path);
		const slices = path.split("/").filter(Boolean);
		slices.pop();
		if (slices.length > 0 && this.t(`${slices.join("/")}/`)) return true;
		return this.rulesTest(path, true);
	}
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreRules, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.addPatterns(patterns);
		} catch {
			// Ignore unreadable ignore files.
		}
	}
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/** Resolves settings/CLI paths like pi's `resolvePath`: `~` expansion, `file:` URLs, base-relative. */
function resolvePathFromBase(input: string, baseDir: string): string {
	let normalized = input.trim();
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			// Fall through to path resolution.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

/** pi's `readPiManifest`: the `pi` field of a package.json, null when absent. */
function readPiManifest(dir: string): { extensions?: string[] } | null {
	try {
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) return null;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pi?: { extensions?: unknown } };
		const manifest = pkg.pi;
		if (!manifest) return null;
		const extensions = manifest.extensions;
		if (extensions === undefined) return { extensions: undefined };
		if (Array.isArray(extensions) && extensions.every((entry) => typeof entry === "string")) {
			return { extensions: extensions as string[] };
		}
		return { extensions: undefined };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Discovery — port of pi's `package-manager.js` extension resolution
// ---------------------------------------------------------------------------

/** Extension entries of a directory: package.json `pi.extensions` paths that exist, else index.*. */
function resolveExtensionEntries(dir: string): string[] | null {
	const manifest = readPiManifest(dir);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = resolve(dir, extPath);
			if (existsSync(resolvedExtPath)) entries.push(resolvedExtPath);
		}
		if (entries.length > 0) return entries;
	}
	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) return [indexTs];
	if (existsSync(indexJs)) return [indexJs];
	return null;
}

/**
 * Auto-discovery of one extensions dir: package.json `pi.extensions` when present, else
 * per-entry single `.ts`/`.js` files or subdirectories with their own entries. Honors
 * ignore files and skips dotfiles and `node_modules`, like pi.
 */
function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;
	const ig = new IgnoreRules();
	addIgnoreRules(ig, dir, dir);
	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}
			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;
			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) entries.push(...resolvedEntries);
			}
		}
	} catch {
		// Ignore unreadable directories.
	}
	return entries;
}

/** Files and (recursively) auto-discovered entries from a list of paths, like pi's collectFilesFromPaths. */
function collectExtensionFilesFromPaths(paths: string[]): string[] {
	const files: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const stats = statSync(p);
			if (stats.isFile()) {
				files.push(p);
			} else if (stats.isDirectory()) {
				files.push(...collectAutoExtensionEntries(p));
			}
		} catch {
			// Ignore unreadable paths.
		}
	}
	return files;
}

function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/**
 * Regex for one glob segment (`*`, `?`; dotfiles never match wildcards, like minimatch's
 * `dot: false`). `**` segments are handled by callers.
 */
function globSegmentToRegex(segment: string): string {
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (ch === "*") out += "(?!\\.)[^/]*";
		else if (ch === "?") out += "(?!\\.)[^/]";
		else out += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	return out;
}

/** `**` matches zero or more path segments, none starting with a dot. */
function globStarRegex(): string {
	return "(?!\\.)[^/]*(?:\\/(?!\\.)[^/]*)*";
}

/** Glob expansion mirroring pi's `globSync(entry, {cwd: root, absolute: true, dot: false, nodir: false})`. */
function globFiles(pattern: string, root: string): string[] {
	const segments = toPosixPath(pattern).split("/").filter((s) => s.length > 0);
	const results: string[] = [];
	const walk = (dir: string, index: number): void => {
		if (index === segments.length) {
			if (existsSync(dir)) results.push(dir);
			return;
		}
		const segment = segments[index]!;
		if (segment === "**") {
			walk(dir, index + 1);
			let sub: Dirent[];
			try {
				sub = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of sub) {
				if (entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				let isDir = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						isDir = statSync(full).isDirectory();
					} catch {
						continue;
					}
				}
				if (isDir) walk(full, index);
			}
			return;
		}
		const literal = !segment.includes("*") && !segment.includes("?");
		const regex = new RegExp(`^${globSegmentToRegex(segment)}$`);
		let sub: Dirent[];
		try {
			sub = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of sub) {
			if (!literal && entry.name.startsWith(".")) continue;
			if (literal ? entry.name === segment : regex.test(entry.name)) {
				walk(join(dir, entry.name), index + 1);
			}
		}
	};
	walk(root, 0);
	return results;
}

/** pi's `collectFilesFromManifestEntries`: plain entries resolved against the package root, globs expanded. */
function collectFilesFromManifestEntries(entries: string[], root: string): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved: string[] = [];
	for (const entry of sourceEntries) {
		if (!hasGlobPattern(entry)) {
			resolved.push(resolve(root, entry));
		} else {
			resolved.push(...globFiles(entry, root));
		}
	}
	return collectExtensionFilesFromPaths(resolved);
}

/** pi's `matchesAnyPattern`: glob subset against the base-relative path, basename and absolute path. */
function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	return patterns.some((pattern) => {
		const normalized = toPosixPath(pattern);
		const source = normalized
			.split("/")
			.filter(Boolean)
			.map((segment) => (segment === "**" ? globStarRegex() : globSegmentToRegex(segment)))
			.join("/");
		const regex = new RegExp(`^${source}$`);
		return regex.test(rel) || regex.test(name) || regex.test(filePathPosix);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

/** pi's `matchesAnyExactPattern`: exact match against the base-relative path, basename or absolute path. */
function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		return normalized === rel || normalized === filePathPosix || normalized === name;
	});
}

/** pi's `applyPatterns`: includes, `!` excludes, `+` force-includes (exact) and `-` force-excludes. */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];
	for (const p of patterns) {
		if (p.startsWith("+")) forceIncludes.push(p.slice(1));
		else if (p.startsWith("-")) forceExcludes.push(p.slice(1));
		else if (p.startsWith("!")) excludes.push(p.slice(1));
		else includes.push(p);
	}
	let result = includes.length === 0 ? [...allPaths] : allPaths.filter((f) => matchesAnyPattern(f, includes, baseDir));
	if (excludes.length > 0) result = result.filter((f) => !matchesAnyPattern(f, excludes, baseDir));
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}
	if (forceExcludes.length > 0) result = result.filter((f) => !matchesAnyExactPattern(f, forceExcludes, baseDir));
	return new Set(result);
}

/** pi's `isEnabledByOverrides`: `!` glob excludes, `+`/`-` exact force overrides on auto-discovered entries. */
function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = patterns.filter((p) => isOverridePattern(p));
	const excludes = overrides.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
	const forceIncludes = overrides.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
	const forceExcludes = overrides.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) enabled = false;
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) enabled = true;
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) enabled = false;
	return enabled;
}

function addResource(map: ResourceMap, path: string, metadata: ResourceMetadata, enabled: boolean): void {
	if (!path) return;
	if (!map.has(path)) map.set(path, { metadata, enabled });
}

/** pi's `addManifestEntries` for a package's `pi.extensions` list (globs and `+`/`-`/`!` overrides). */
function addManifestEntries(entries: string[] | undefined, root: string, metadata: ResourceMetadata, target: ResourceMap): void {
	if (!entries) return;
	const allFiles = collectFilesFromManifestEntries(entries, root);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);
	for (const f of allFiles) {
		if (enabledPaths.has(f)) addResource(target, f, metadata, true);
	}
}

/**
 * pi's `collectPackageResources` for extensions: a `pi` manifest (its `pi.extensions` entries),
 * else the conventional `extensions/` subdirectory, else nothing — the caller then treats the
 * root itself as the extension.
 */
function collectPackageResources(packageRoot: string, metadata: ResourceMetadata, target: ResourceMap): boolean {
	const manifest = readPiManifest(packageRoot);
	if (manifest) {
		addManifestEntries(manifest.extensions, packageRoot, metadata, target);
		return true;
	}
	const dir = join(packageRoot, "extensions");
	if (existsSync(dir)) {
		for (const f of collectAutoExtensionEntries(dir)) addResource(target, f, metadata, true);
		return true;
	}
	return false;
}

/** pi's `resolveLocalExtensionSource` for local path packages: a file is the extension, a dir is a package. */
function resolveLocalExtensionSource(sourcePath: string, baseDir: string, metadata: ResourceMetadata, target: ResourceMap): void {
	const resolved = resolvePathFromBase(sourcePath, baseDir);
	if (!existsSync(resolved)) return;
	try {
		const stats = statSync(resolved);
		if (stats.isFile()) {
			addResource(target, resolved, { ...metadata, baseDir: dirname(resolved) }, true);
			return;
		}
		if (stats.isDirectory()) {
			const dirMetadata = { ...metadata, baseDir: resolved };
			if (!collectPackageResources(resolved, dirMetadata, target)) {
				addResource(target, resolved, dirMetadata, true);
			}
		}
	} catch {
		// Ignore unreadable paths.
	}
}

function parseNpmSpec(spec: string): { name: string } {
	const trimmed = spec.trim();
	if (trimmed.startsWith("@")) {
		const match = /^(@[^/]+\/[^@]+)(?:@.+)?$/.exec(trimmed);
		return match ? { name: match[1]! } : { name: trimmed };
	}
	const at = trimmed.indexOf("@");
	return { name: at === -1 ? trimmed : trimmed.slice(0, at) };
}

function parseGitSource(source: string): { host: string; path: string } | undefined {
	const spec = source.slice("git:".length).trim();
	const slash = spec.indexOf("/");
	if (slash === -1) return undefined;
	return { host: spec.slice(0, slash), path: spec.slice(slash + 1) };
}

/**
 * pi's `resolvePackageSources` for one settings `packages` entry. Packages not installed yet are
 * skipped: pi installs them during startup, so a missing install means pi does not list them either.
 */
function resolvePackageSource(source: string, scope: "user" | "project", agentDir: string, cwd: string, target: ResourceMap): void {
	const metadata: ResourceMetadata = { source, scope, origin: "package" };
	if (source.startsWith("npm:")) {
		const { name } = parseNpmSpec(source.slice("npm:".length));
		const installPath = scope === "project"
			? join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", name)
			: join(agentDir, "npm", "node_modules", name);
		if (!existsSync(installPath)) return;
		collectPackageResources(installPath, { ...metadata, baseDir: installPath }, target);
		return;
	}
	if (source.startsWith("git:")) {
		const parsed = parseGitSource(source);
		if (!parsed) return;
		const installPath = scope === "project"
			? join(cwd, CONFIG_DIR_NAME, "git", parsed.host, parsed.path)
			: join(agentDir, "git", parsed.host, parsed.path);
		if (!existsSync(installPath)) return;
		collectPackageResources(installPath, { ...metadata, baseDir: installPath }, target);
		return;
	}
	resolveLocalExtensionSource(source, scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir, metadata, target);
}

/**
 * pi's `resolveExtensionSources` for CLI `--extension` values (temporary scope). `<inline:…>`
 * sources are pi's hidden built-ins and are never shown in its `[Extensions]` list. Temporary
 * npm/git installs live under the agent `tmp` dir, which the splash does not enumerate; those
 * fall back to the user/project install locations.
 */
function resolveCliExtensionSource(source: string, agentDir: string, cwd: string, target: ResourceMap): void {
	if (source.startsWith("<inline:")) return;
	const metadata: ResourceMetadata = { source, scope: "temporary", origin: "package" };
	if (source.startsWith("npm:")) {
		const { name } = parseNpmSpec(source.slice("npm:".length));
		for (const candidate of [join(agentDir, "npm", "node_modules", name), join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", name)]) {
			if (existsSync(candidate)) {
				collectPackageResources(candidate, { ...metadata, baseDir: candidate }, target);
				return;
			}
		}
		return;
	}
	if (source.startsWith("git:")) return;
	resolveLocalExtensionSource(source, cwd, metadata, target);
}

/** pi's `resolveLocalEntries` for settings `extensions` entries: plain paths plus `+`/`-`/`!`/glob patterns. */
function resolveLocalEntries(entries: string[], baseDir: string, metadata: ResourceMetadata, target: ResourceMap): void {
	if (entries.length === 0) return;
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isOverridePattern(entry) || hasGlobPattern(entry)) patterns.push(entry);
		else plain.push(entry);
	}
	const resolvedPlain = plain.map((p) => resolvePathFromBase(p, baseDir));
	const allFiles = collectExtensionFilesFromPaths(resolvedPlain);
	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);
	for (const f of allFiles) {
		addResource(target, f, metadata, enabledPaths.has(f));
	}
}

/** pi's `addAutoDiscoveredResources` for extensions: project `.pi/extensions` (when trusted) and the agent extensions dir. */
function addAutoDiscoveredResources(
	target: ResourceMap,
	agentDir: string,
	cwd: string,
	projectTrusted: boolean,
	globalExtensions: string[],
	projectExtensions: string[],
): void {
	if (projectTrusted) {
		const projectBaseDir = join(cwd, CONFIG_DIR_NAME);
		const metadata: ResourceMetadata = { source: "auto", scope: "project", origin: "top-level", baseDir: projectBaseDir };
		for (const path of collectAutoExtensionEntries(join(projectBaseDir, "extensions"))) {
			addResource(target, path, metadata, isEnabledByOverrides(path, projectExtensions, projectBaseDir));
		}
	}
	const metadata: ResourceMetadata = { source: "auto", scope: "user", origin: "top-level", baseDir: agentDir };
	for (const path of collectAutoExtensionEntries(join(agentDir, "extensions"))) {
		addResource(target, path, metadata, isEnabledByOverrides(path, globalExtensions, agentDir));
	}
}

/** pi's `resourcePrecedenceRank`; lower wins when two paths canonicalize to the same file. */
function precedenceRank(metadata: ResourceMetadata): number {
	if (metadata.origin === "package") return 4;
	const scopeBase = metadata.scope === "project" ? 0 : 2;
	return scopeBase + (metadata.source === "local" ? 0 : 1);
}

/**
 * Dedupe by canonical (real) path with pi's precedence order, then drop disabled entries —
 * mirroring pi's `mapToResolved` plus the loader's enabled filter. A disabled entry therefore
 * shadows a lower-precedence enabled entry for the same file, exactly as in pi.
 */
function enabledExtensions(map: ResourceMap): DiscoveredExtension[] {
	const entries = Array.from(map.entries()).map(([path, entry]) => ({ path, metadata: entry.metadata, enabled: entry.enabled }));
	entries.sort((a, b) => precedenceRank(a.metadata) - precedenceRank(b.metadata));
	const seen = new Set<string>();
	const out: DiscoveredExtension[] = [];
	for (const entry of entries) {
		let canonical: string;
		try {
			canonical = realpathSync(entry.path);
		} catch {
			canonical = entry.path;
		}
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		if (!entry.enabled) continue;
		out.push({ ...entry.metadata, path: entry.path });
	}
	return out;
}

export interface CliExtensionArgs {
	noExtensions: boolean;
	explicit: Set<string>;
}

/**
 * Parse this process's argv for `--no-extensions` and the explicit `--extension`/`-e` sources.
 * Under `--no-extensions` only explicitly-passed extensions are loaded, so discovery must not
 * report other on-disk extensions as loaded.
 */
export function cliExtensionArgs(): CliExtensionArgs {
	const argv = process.argv.slice(2);
	const explicit = new Set<string>();
	let noExtensions = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-extensions" || arg === "-ne") {
			noExtensions = true;
			continue;
		}
		if (arg === "--extension" || arg === "-e") {
			if (i + 1 < argv.length) explicit.add(argv[++i]!);
			continue;
		}
		if (arg.startsWith("--extension=")) explicit.add(arg.slice("--extension=".length));
	}
	return { noExtensions, explicit };
}

/**
 * The extensions pi loads for this launch, mirroring its package manager: settings `packages`
 * (npm:/git:/local), settings `extensions` entries and `+`/`-`/`!` overrides, auto-discovery of
 * the agent and (when trusted) project `.pi/extensions` dirs, and CLI `--extension` sources —
 * which are the only extensions under `--no-extensions`. Each entry carries the metadata pi's
 * label logic needs (`source`, `baseDir`).
 */
export function discoverLoadedExtensions(cwd: string, agentDir: string, projectTrusted: boolean): DiscoveredExtension[] {
	try {
		const target: ResourceMap = new Map();
		const settings = SettingsManager.create(cwd, agentDir);
		const globalSettings = settings.getGlobalSettings();
		const projectSettings = settings.getProjectSettings();
		const projectPackages = projectTrusted ? projectSettings.packages ?? [] : [];
		const packageSources: PackageSource[] = [...projectPackages, ...(globalSettings.packages ?? [])];
		const seen = new Set<string>();
		for (const entry of packageSources) {
			const source = typeof entry === "string" ? entry : entry.source;
			if (!source || seen.has(source)) continue;
			seen.add(source);
			const projectScope = projectPackages.some((p) => (typeof p === "string" ? p : p.source) === source);
			resolvePackageSource(source, projectScope ? "project" : "user", agentDir, cwd, target);
		}

		if (projectTrusted) {
			resolveLocalEntries(projectSettings.extensions ?? [], join(cwd, CONFIG_DIR_NAME), { source: "local", scope: "project", origin: "top-level" }, target);
		}
		resolveLocalEntries(globalSettings.extensions ?? [], agentDir, { source: "local", scope: "user", origin: "top-level" }, target);

		addAutoDiscoveredResources(
			target,
			agentDir,
			cwd,
			projectTrusted,
			globalSettings.extensions ?? [],
			projectSettings.extensions ?? [],
		);

		const cli = cliExtensionArgs();
		const cliEntries: ResourceMap = new Map();
		for (const source of cli.explicit) resolveCliExtensionSource(source, agentDir, cwd, cliEntries);
		if (cli.noExtensions) return enabledExtensions(cliEntries);
		for (const [path, entry] of cliEntries) {
			if (!target.has(path)) target.set(path, entry);
		}
		return enabledExtensions(target);
	} catch {
		// A settings/read failure must not corrupt the TUI with console output.
		return [];
	}
}

// ---------------------------------------------------------------------------
// Compact labels — port of pi's interactive-mode startup listing
// ---------------------------------------------------------------------------

function isPackageSource(source: string): boolean {
	return source.startsWith("npm:") || source.startsWith("git:");
}

function formatDisplayPath(p: string): string {
	const home = homedir();
	let result = p;
	if (result.startsWith(home)) result = `~${result.slice(home.length)}`;
	return result;
}

function getShortPath(fullPath: string, sourceInfo: { source: string; baseDir?: string }): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo.baseDir;
	if (baseDir && isPackageSource(sourceInfo.source)) {
		const normalizedBaseDir = baseDir.replace(/\\/g, "/");
		const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
			return posix.relative(normalizedBaseDir, normalizedFullPath);
		}
		const relativePath = relative(resolve(baseDir), resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}
	const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && sourceInfo.source.startsWith("npm:")) return npmMatch[2]!;
	const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && sourceInfo.source.startsWith("git:")) return gitMatch[1]!;
	return formatDisplayPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo: { source: string; baseDir?: string }): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const segments = shortPath.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) return segments[segments.length - 1]!;
	return shortPath;
}

function getCompactPackageSourceLabel(source: string): string {
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	const git = parseGitSource(source);
	return git?.path || source;
}

function getCompactExtensionLabel(resourcePath: string, sourceInfo: { source: string; baseDir?: string }): string {
	if (!isPackageSource(sourceInfo.source)) return getCompactPathLabel(resourcePath, sourceInfo);
	const sourceLabel = getCompactPackageSourceLabel(sourceInfo.source);
	if (!sourceLabel) return getCompactPathLabel(resourcePath, sourceInfo);
	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = posix.parse(packagePath);
	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}
	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(resourcePath: string, index: number, allPaths: { segments: string[] }[]): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) return getCompactPathLabel(resourcePath, { source: "" });
	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) return true;
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});
		if (isUnique) return candidate;
	}
	return segments.join("/");
}

/**
 * The compact labels pi shows under `[Extensions]`: for package sources the package name with
 * the entry path relative to the package root (`pkg:src`), for everything else the shortest
 * unique suffix of the `~`-shortened path (trailing `index.ts`/`index.js` stripped).
 */
export function getExtensionLabels(extensions: DiscoveredExtension[]): string[] {
	const items = extensions.map((extension) => ({
		path: extension.path,
		sourceInfo: { source: extension.source, baseDir: extension.baseDir },
	}));
	const nonPackageExtensions = items
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return { path: extension.path, sourceInfo: extension.sourceInfo, segments };
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo.source));
	return uniqueSorted(
		items.map((extension) => {
			if (isPackageSource(extension.sourceInfo.source)) {
				return getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}
			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) return getCompactPathLabel(extension.path, extension.sourceInfo);
			return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		}),
	);
}

/** Convenience: discover and label, mirroring pi's `getCompactExtensionLabels` on its loaded set. */
export function getLoadedExtensionLabels(cwd: string, agentDir: string, projectTrusted: boolean): string[] {
	return getExtensionLabels(discoverLoadedExtensions(cwd, agentDir, projectTrusted));
}
