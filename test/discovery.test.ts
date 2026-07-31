import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	cliExtensionArgs,
	discoverExtensionNamesFromFilesystem,
	ENTRY_HOLDER_DIRS,
	extensionNameFromPath,
	getLoadedHeaderItems,
	packageNameForEntryHolder,
	readInstalledExtensionNames,
	readNpmPackageName,
} from "../src/discovery.ts";
import { setArgv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakePi } from "./helpers/fake-api.ts";

let env: TempAgentEnv;
let restoreArgv: () => void;

beforeEach(() => {
	env = tempAgentDir();
	restoreArgv = setArgv([]);
});
afterEach(() => {
	restoreArgv();
	env.restore();
});

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

describe("extensionNameFromPath (D-01)", () => {
	it("1. inline sentinels pass through verbatim", () => {
		assert.equal(extensionNameFromPath("<inline:llama.cpp>"), "<inline:llama.cpp>");
	});
	it("2. scoped npm packages", () => {
		assert.equal(
			extensionNameFromPath("/x/node_modules/@scope/pkg-name/dist/index.js"),
			"@scope/pkg-name",
		);
	});
	it("3. unscoped npm packages", () => {
		assert.equal(extensionNameFromPath("/x/node_modules/pkg-name/dist/index.js"), "pkg-name");
	});
	it("4. index under a generic holder dir is labeled by its package", () => {
		const pkgRoot = join(env.cwd, "my-extension");
		mkdirSync(join(pkgRoot, "src"), { recursive: true });
		writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "real-package-name" }));
		writeFileSync(join(pkgRoot, "src", "index.ts"), "");
		assert.equal(extensionNameFromPath(join(pkgRoot, "src", "index.ts")), "real-package-name");
	});
	it("5. index.ts in a named dir uses the dir name", () => {
		assert.equal(extensionNameFromPath("/somewhere/ext-name/index.ts"), "ext-name");
	});
	it("6. a named file uses its basename", () => {
		assert.equal(extensionNameFromPath("/somewhere/cool-ext.ts"), "cool-ext");
	});
});

describe("cliExtensionArgs (D-02)", () => {
	it("defaults to extensions enabled with no explicit sources", () => {
		const { noExtensions, explicit } = cliExtensionArgs();
		assert.equal(noExtensions, false);
		assert.equal(explicit.size, 0);
	});
	it("parses --no-extensions", () => {
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions"]);
		assert.equal(cliExtensionArgs().noExtensions, true);
	});
	it("collects --extension and -e sources", () => {
		restoreArgv();
		restoreArgv = setArgv(["-e", "/a.ts", "--extension", "/b.ts", "--other", "x"]);
		const { explicit } = cliExtensionArgs();
		assert.ok(explicit.has("/a.ts"));
		assert.ok(explicit.has("/b.ts"));
		assert.equal(explicit.has("x"), false);
	});
});

describe("readNpmPackageName (D-03)", () => {
	it("reads a valid name", () => {
		const root = join(env.cwd, "pkg");
		writeJson(join(root, "package.json"), { name: "@scope/thing" });
		assert.equal(readNpmPackageName(root), "@scope/thing");
	});
	it("undefined for a non-string name", () => {
		const root = join(env.cwd, "pkg-num");
		writeJson(join(root, "package.json"), { name: 42 });
		assert.equal(readNpmPackageName(root), undefined);
	});
	it("undefined for malformed JSON", () => {
		const root = join(env.cwd, "pkg-bad");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), "{not json");
		assert.equal(readNpmPackageName(root), undefined);
	});
	it("undefined when the file is missing", () => {
		assert.equal(readNpmPackageName(join(env.cwd, "nowhere")), undefined);
	});
});

describe("packageNameForEntryHolder (D-04)", () => {
	it("holder dirs resolve to the owning package name", () => {
		const pkgRoot = join(env.cwd, "holder-pkg");
		writeJson(join(pkgRoot, "package.json"), { name: "the-package" });
		for (const holder of ENTRY_HOLDER_DIRS) {
			const entryDir = join(pkgRoot, holder);
			mkdirSync(entryDir, { recursive: true });
			assert.equal(packageNameForEntryHolder(entryDir), "the-package", holder);
		}
	});
	it("dirs that name their extension are left alone", () => {
		const pkgRoot = join(env.cwd, "named-pkg");
		writeJson(join(pkgRoot, "package.json"), { name: "the-package" });
		const entryDir = join(pkgRoot, "custom-dir");
		mkdirSync(entryDir, { recursive: true });
		assert.equal(packageNameForEntryHolder(entryDir), undefined);
	});
});

describe("readInstalledExtensionNames (D-05)", () => {
	it("reads direct dependencies from the agent npm manifest", () => {
		writeJson(join(env.agentDir, "npm", "package.json"), {
			dependencies: { "@scope/ext-one": "1.0.0", "plain-ext": "2.0.0" },
			devDependencies: { "dev-only": "1.0.0" },
		});
		const names = readInstalledExtensionNames();
		assert.ok(names.has("@scope/ext-one"));
		assert.ok(names.has("plain-ext"));
		assert.equal(names.has("dev-only"), false);
	});
	it("empty when the manifest is missing or malformed", () => {
		assert.equal(readInstalledExtensionNames().size, 0);
		mkdirSync(join(env.agentDir, "npm"), { recursive: true });
		writeFileSync(join(env.agentDir, "npm", "package.json"), "{oops");
		assert.equal(readInstalledExtensionNames().size, 0);
	});
});

describe("discoverExtensionNamesFromFilesystem (D-06, D-08)", () => {
	function seedExtensionsDir(): void {
		const extDir = join(env.agentDir, "extensions");
		mkdirSync(join(extDir, "dir-ext"), { recursive: true });
		mkdirSync(join(extDir, "bare-dir"), { recursive: true });
		writeFileSync(join(extDir, "single.ts"), "");
		writeFileSync(join(extDir, "dir-ext", "index.ts"), "");
		writeFileSync(join(extDir, ".hidden.ts"), "");
	}

	it("finds file and dir/index extensions, skipping dotfiles", () => {
		// UNSPECIFIED: a dir without an entry file (bare-dir) is also reported — whether
		// that over-reports is an open question in the report; not asserted either way.
		seedExtensionsDir();
		const names = discoverExtensionNamesFromFilesystem();
		assert.ok(names.includes("single"), `got ${JSON.stringify(names)}`);
		assert.ok(names.includes("dir-ext"), `got ${JSON.stringify(names)}`);
		assert.equal(names.some((n) => n.includes("hidden")), false);
	});

	it("includes npm-installed extensions declared as dependencies", () => {
		writeJson(join(env.agentDir, "npm", "package.json"), { dependencies: { "npm-ext": "1.0.0" } });
		writeJson(join(env.agentDir, "npm", "node_modules", "npm-ext", "package.json"), {
			name: "npm-ext",
		});
		const names = discoverExtensionNamesFromFilesystem();
		assert.ok(names.includes("npm-ext"), `got ${JSON.stringify(names)}`);
	});

	it("under --no-extensions reports only explicitly-passed sources", () => {
		seedExtensionsDir();
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions"]);
		assert.deepEqual(discoverExtensionNamesFromFilesystem(), []);
		restoreArgv();
		restoreArgv = setArgv(["--no-extensions", "-e", join(env.agentDir, "extensions", "single.ts")]);
		const names = discoverExtensionNamesFromFilesystem();
		assert.deepEqual(names, ["single"], `got ${JSON.stringify(names)}`);
	});

	it("INFERRED (D-08): a symlink to an existing target outside the agent dir is followed", () => {
		seedExtensionsDir();
		const outside = join(env.cwd, "outside-ext.ts");
		writeFileSync(outside, "");
		symlinkSync(outside, join(env.agentDir, "extensions", "escapee.ts"));
		const names = discoverExtensionNamesFromFilesystem();
		assert.ok(names.includes("escapee"), `got ${JSON.stringify(names)}`);
	});

	it("INFERRED (D-08): a broken symlink is skipped without throwing", () => {
		seedExtensionsDir();
		symlinkSync(join(env.cwd, "missing-target.ts"), join(env.agentDir, "extensions", "broken.ts"));
		const names = discoverExtensionNamesFromFilesystem();
		assert.equal(names.includes("broken"), false, `got ${JSON.stringify(names)}`);
	});
});

describe("getLoadedHeaderItems (D-07)", () => {
	it("merges skill commands, extension commands/tools and filesystem discovery, sorted", () => {
		const extDir = join(env.agentDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "fs-ext.ts"), "");
		const sourceInfo = (path: string) => ({ path, source: "extension", scope: "user", origin: "top-level" });
		const harness = createFakePi({
			commandsInfo: [
				{ name: "my-skill", source: "skill", sourceInfo: sourceInfo("/skills/my-skill/SKILL.md") },
				{ name: "some-cmd", source: "extension", sourceInfo: sourceInfo("/exts/cmd-ext/index.ts") },
			],
			toolsInfo: [{ name: "a-tool", sourceInfo: sourceInfo("/exts/node_modules/@scope/tool-pkg/dist/index.js") }],
		});
		const { skills, extensions } = getLoadedHeaderItems(harness.pi);
		assert.ok(skills.includes("my-skill"), `skills: ${JSON.stringify(skills)}`);
		assert.ok(extensions.includes("cmd-ext"), `extensions: ${JSON.stringify(extensions)}`);
		assert.ok(extensions.includes("@scope/tool-pkg"), `extensions: ${JSON.stringify(extensions)}`);
		assert.ok(extensions.includes("fs-ext"), `extensions: ${JSON.stringify(extensions)}`);
		assert.deepEqual(skills, [...skills].sort());
		assert.deepEqual(extensions, [...extensions].sort());
	});
});
