import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensureQuietStartup, installHeader, withSettings } from "../src/header.ts";
import { stopTaglineReveal, taglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { sanitizeTuiText } from "../src/text.ts";
import { tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { makeTheme } from "./helpers/theme.ts";
import { assertLinesExact } from "./helpers/width.ts";

let env: TempAgentEnv;
beforeEach(() => {
	env = tempAgentDir();
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
	env.restore();
});

describe("withSettings (H-01)", () => {
	it("runs the callback with a settings manager", () => {
		let ran = false;
		withSettings(env.cwd, () => {
			ran = true;
		});
		assert.equal(ran, true);
	});
	it("swallows callback errors", () => {
		withSettings(env.cwd, () => {
			throw new Error("boom");
		});
	});
});

describe("ensureQuietStartup (H-02, H-03)", () => {
	it("enables quietStartup and persists it (write is queued asynchronously)", async () => {
		// The once-per-process guard lives at the caller (state.quietStartupEnsured, tested
		// via index.ts); this function reports whether it changed the setting.
		assert.equal(ensureQuietStartup(env.cwd), true, "first call changes the setting");
		const deadline = Date.now() + 2000;
		while (!SettingsManager.create(env.cwd).getQuietStartup() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(SettingsManager.create(env.cwd).getQuietStartup(), true, "queued write must land");
		assert.ok(existsSync(join(env.agentDir, "settings.json")), "must persist under the temp agent dir");
	});
});

describe("installHeader (H-04, H-05)", () => {
	function install(): { tui: FakeTuiHarness; ctx: FakeCtxHarness; component: Component } {
		const tui = createFakeTui({ rows: 40, columns: 120 });
		const ctx = createFakeCtx({
			cwd: env.cwd,
			theme: makeTheme(),
			tui: tui.tui,
			model: makeModel("anthropic", "claude-opus-4"),
			systemPrompt: "x".repeat(4000),
		});
		const pi = createFakePi({
			commandsInfo: [
				{
					name: "my-skill",
					source: "skill",
					sourceInfo: { path: "/skills/my-skill/SKILL.md", source: "skill", scope: "user", origin: "top-level" },
				},
			],
		});
		installHeader(pi.pi, ctx.ctx);
		assert.equal(ctx.setHeaderCalls.length, 1, "must install a header factory");
		const factory = ctx.setHeaderCalls[0] as (tui: TUI, theme: Theme) => Component;
		const component = factory(tui.tui, makeTheme());
		return { tui, ctx, component };
	}

	it("wires render callbacks, populates state and starts the reveal", () => {
		const { tui, component } = install();
		assert.equal(state.systemPromptSize, 4000);
		assert.ok(state.loadedSkills.includes("my-skill"), JSON.stringify(state.loadedSkills));
		assert.notEqual(taglineReveal.timer, null, "tagline reveal should be running");
		assert.equal(typeof headerRenderState.requestRender, "function");
		assert.equal(typeof headerRenderState.invalidate, "function");
		const before = tui.renderRequests.length;
		headerRenderState.requestRender?.();
		assert.equal(tui.renderRequests.length, before + 1);
		assert.ok(component, "factory must build a component");
	});

	it("renders full-bleed splash lines at every width", () => {
		const { component } = install();
		for (let width = 1; width <= 200; width += 3) {
			assertLinesExact(component.render(width), width, `header render(width=${width})`);
		}
	});

	it("a model change is reflected after invalidation (commit 1a88a1c)", () => {
		const { ctx, component } = install();
		// Mid-reveal the tagline shows the placeholder, not the model — settle it first.
		stopTaglineReveal();
		assert.ok(component.render(120).map(sanitizeTuiText).join("\n").includes("claude-opus-4"));
		ctx.bag.model = makeModel("other", "different-model");
		headerRenderState.invalidate?.();
		const text = component.render(120).map(sanitizeTuiText).join("\n");
		assert.ok(text.includes("different-model"), "fresh render must show the new model");
	});
});
