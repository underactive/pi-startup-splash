import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeSkillName, uniqueSorted } from "./text.ts";


/**
 * Extract a human-readable extension name from its source path.
 *
 * Resolution order:
 * 1. Inline extension: `<inline:name>` → verbatim (a sentinel, not a real path)
 * 2. npm scoped package: `node_modules/@scope/name/...` → `@scope/name`
 * 3. npm unscoped package: `node_modules/name/...` → `name`
 * 4. index.ts/js under a generic holder dir: `.../pkg-name/src/index.ts` → `pkg-name`
 * 5. index.ts/js in a dir: `.../ext-name/index.ts` → `ext-name`
 * 6. Named file: `.../ext-name.ts` → `ext-name`
 */
export function extensionNameFromPath(filePath: string): string {
	// parse() would read `.cpp>` in `<inline:llama.cpp>` as a file extension and drop it.
	if (filePath.startsWith("<inline:") && filePath.endsWith(">")) return filePath;

	// Check for npm package pattern (scoped or unscoped)
	const nmIdx = filePath.indexOf("node_modules/");
	if (nmIdx !== -1) {
		const after = filePath.slice(nmIdx + "node_modules/".length);
		const parts = after.split("/");
		if (parts[0].startsWith("@") && parts.length >= 2) {
			// Scoped package: @scope/name
			return `${parts[0]}/${parts[1]}`;
		}
		// Unscoped package: name
		return parts[0];
	}

	// Standard path extraction
	const parsed = parse(filePath);
	if (parsed.base === "index.ts" || parsed.base === "index.js") {
		return packageNameForEntryHolder(parsed.dir) ?? basename(parsed.dir);
	}
	return parsed.name;
}


/**
 * Parse this process's argv for `--no-extensions` and the explicit `--extension`/`-e`
 * sources. Under `--no-extensions` only explicitly-passed extensions are loaded, so
 * filesystem discovery must not report other on-disk extensions as loaded.
 */
export function cliExtensionArgs(): { noExtensions: boolean; explicit: Set<string> } {
	const argv = process.argv.slice(2);
	const explicit = new Set<string>();
	let noExtensions = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-extensions" || arg === "-ne") { noExtensions = true; continue; }
		if (arg === "--extension" || arg === "-e") {
			if (i + 1 < argv.length) explicit.add(argv[++i]);
			continue;
		}
		if (arg.startsWith("--extension=")) explicit.add(arg.slice("--extension=".length));
	}
	return { noExtensions, explicit };
}

/**
 * Read the npm package name from a package.json at `packageRoot`.
 * Returns undefined when the file is missing or unparseable.
 */
export function readNpmPackageName(packageRoot: string): string | undefined {
	try {
		const pkgPath = join(packageRoot, "package.json");
		if (!existsSync(pkgPath)) return undefined;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return typeof pkg.name === "string" && /^[\x20-\x7E]+$/.test(pkg.name) ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

/** Directory names that hold an entry file without naming the extension that owns it. */
export const ENTRY_HOLDER_DIRS = new Set(["src", "dist", "lib", "build", "out"]);

/**
 * Package name owning an entry file that sits in a generic holder directory, so an extension
 * declaring `"pi": { "extensions": ["./src/index.ts"] }` is labeled by package rather than `src`.
 * Directories that already name their extension are left alone, since a dir name and its
 * `package.json` name can legitimately differ and the dir name is what pi loads by.
 */
export function packageNameForEntryHolder(entryDir: string): string | undefined {
	let dir = entryDir;
	while (ENTRY_HOLDER_DIRS.has(basename(dir))) {
		const parent = dirname(dir);
		if (parent === dir) break;
		const name = readNpmPackageName(parent);
		if (name) return name;
		dir = parent;
	}
	return undefined;
}

/**
 * Read the list of explicitly-installed pi extension package names from the
 * npm-style `package.json` at `~/.pi/agent/npm/package.json`. Only packages
 * listed as direct dependencies are actual extensions — everything else in
 * `node_modules/` is a transitive dependency or core SDK package.
 */
export function readInstalledExtensionNames(): Set<string> {
	const names = new Set<string>();
	try {
		const agentDir = getAgentDir();
		const pkgPath = join(agentDir, "npm", "package.json");
		if (!existsSync(pkgPath)) return names;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (pkg.dependencies && typeof pkg.dependencies === "object") {
			for (const depName of Object.keys(pkg.dependencies)) {
				names.add(depName);
			}
		}
	} catch { /* ignore */ }
	return names;
}

/**
 * Discover extension names from well-known locations on the filesystem. This catches
 * event-only extensions that register neither commands nor tools. Each entry carries the
 * CLI `--extension` source alongside its name so `--no-extensions` launches can be filtered
 * down to the extensions actually passed on the command line.
 */
export function discoverExtensionNamesFromFilesystem(): string[] {
	const discovered: { name: string; source: string }[] = [];
	const installedExtensions = readInstalledExtensionNames();

	const agentDir = getAgentDir();

	// 1. Global extensions dir: ~/.pi/agent/extensions/
	// Each subdirectory or file is an extension; the source is a loadable filesystem path.
	const globalExtDir = join(agentDir, "extensions");
	try {
		if (existsSync(globalExtDir)) {
			const entries = readdirSync(globalExtDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const entryPath = join(globalExtDir, entry.name);
				let isDir = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						const realPath = realpathSync(entryPath);
						// Skip symlinks pointing to a non-existent target.
						if (!existsSync(realPath)) continue;
						isDir = statSync(entryPath).isDirectory();
					} catch { continue; }
				}
				if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
					// Single-file extension: ext-name.ts → ext-name, source is the file itself
					discovered.push({ name: extensionNameFromPath(entryPath), source: entryPath });
				} else if (isDir) {
					// Directory extension: check for index.ts or index.js
					const indexTs = join(entryPath, "index.ts");
					const indexJs = join(entryPath, "index.js");
					if (existsSync(indexTs)) {
						discovered.push({ name: extensionNameFromPath(indexTs), source: indexTs });
					} else if (existsSync(indexJs)) {
						discovered.push({ name: extensionNameFromPath(indexJs), source: indexJs });
					} else {
						// Fallback: use the directory name and path
						discovered.push({ name: entry.name, source: entryPath });
					}
				}
			}
		}
	} catch { /* ignore */ }

	// 2. NPM-installed extensions: ~/.pi/agent/npm/node_modules/
	// Only include packages listed as direct dependencies in the npm package.json
	// (transitive deps and core SDK packages like @earendil-works/* are excluded).
	const npmDir = join(agentDir, "npm", "node_modules");
	try {
		if (existsSync(npmDir)) {
			const entries = readdirSync(npmDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const pkgPath = join(npmDir, entry.name);
				let isDir = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try { isDir = statSync(pkgPath).isDirectory(); } catch { continue; }
				}
				if (!isDir) continue;

				// Unscoped package: directly under node_modules/
				if (!entry.name.startsWith("@")) {
					if (installedExtensions.has(entry.name)) {
						discovered.push({ name: entry.name, source: `npm:${entry.name}` });
					}
				} else {
					// Scoped package: @scope/name — check subdirectories
					try {
						const scopedEntries = readdirSync(pkgPath, { withFileTypes: true });
						for (const scoped of scopedEntries) {
							if (scoped.name.startsWith(".")) continue;
							const scopedName = `${entry.name}/${scoped.name}`;
							if (installedExtensions.has(scopedName)) {
								discovered.push({ name: scopedName, source: `npm:${scopedName}` });
							}
						}
					} catch { /* ignore */ }
				}
			}
		}
	} catch { /* ignore */ }

	// Under --no-extensions only explicitly-passed extensions are actually loaded, so
	// restrict the on-disk findings to those; otherwise every installed-but-unloaded
	// extension would still be reported as loaded.
	const cli = cliExtensionArgs();
	const visible = cli.noExtensions ? discovered.filter((item) => cli.explicit.has(item.source)) : discovered;
	return visible.map((item) => item.name);
}

/**
 * Names of every currently loaded skill and extension, for the splash info panel. Combines
 * command-registering, tool-registering and event-only (filesystem-discovered) sources.
 */
export function getLoadedHeaderItems(pi: ExtensionAPI): { skills: string[]; extensions: string[] } {
	const commands = pi.getCommands();

	const skills = commands
		.filter((command) => command.source === "skill")
		.map((command) => normalizeSkillName(command.name));

	const extensionCommands = commands
		.filter((command) => command.source === "extension")
		.map((command) => extensionNameFromPath(command.sourceInfo.path));

	// Extensions that register tools. SourceInfo.source is "local" for filesystem extensions
	// (not "extension"!). Built-in SDK tools have source "sdk" or "builtin" — exclude those.
	const extensionTools = pi
		.getAllTools()
		.filter((tool) => tool.sourceInfo.source !== "sdk" && tool.sourceInfo.source !== "builtin")
		.map((tool) => extensionNameFromPath(tool.sourceInfo.path));

	return {
		skills: uniqueSorted(skills),
		extensions: uniqueSorted([...extensionCommands, ...extensionTools, ...discoverExtensionNamesFromFilesystem()]),
	};
}
