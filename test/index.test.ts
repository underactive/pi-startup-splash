import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import piStartupGreeter from "../index.ts";
import { readMenuGate } from "../src/preferences.ts";
import { stopTaglineReveal } from "../src/reveal.ts";
import { headerRenderState, state } from "../src/state.ts";
import { setArgv, setEnv, tempAgentDir, type TempAgentEnv } from "./helpers/env.ts";
import { createFakeCtx, makeModel, type FakeCtxHarness } from "./helpers/fake-ctx.ts";
import { createFakePi, type FakePiHarness } from "./helpers/fake-api.ts";
import { createFakeTui, type FakeTuiHarness } from "./helpers/fake-tui.ts";
import { resetModuleState } from "./helpers/reset.ts";
import { bootstrapGlobalTheme, makeTheme } from "./helpers/theme.ts";
import { until } from "./helpers/wait.ts";

bootstrapGlobalTheme();

let env: TempAgentEnv;
let restoreArgv: () => void;
let restoreGateEnv: () => void;
beforeEach(() => {
	env = tempAgentDir();
	restoreArgv = setArgv([], "");
	restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", undefined);
	resetModuleState();
});
afterEach(() => {
	stopTaglineReveal();
	restoreGateEnv();
	restoreArgv();
	env.restore();
});

interface Wired {
	pi: FakePiHarness;
	ctx: FakeCtxHarness;
	tui: FakeTuiHarness;
}

function wire(options: { mode?: string; hasUI?: boolean } = {}): Wired {
	const tui = createFakeTui({ rows: 40, columns: 100 });
	const ctx = createFakeCtx({
		cwd: env.cwd,
		theme: makeTheme(),
		tui: tui.tui,
		model: makeModel("anthropic", "claude-opus-4"),
		systemPrompt: "p".repeat(2000),
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
	});
	const pi = createFakePi({ thinkingLevel: "medium" });
	piStartupGreeter(pi.pi);
	return { pi, ctx, tui };
}

function startup(wired: Wired, reason = "startup"): Promise<void> {
	return wired.pi.emit("session_start", { type: "session_start", reason }, wired.ctx.ctx);
}

/** Persist a menuGate choice through the real slash command, into this test's temp agent dir. */
async function persist(mode: string): Promise<void> {
	const wired = wire();
	await wired.pi.commands.get("startup-splash")!.handler(mode, wired.ctx.ctx as never);
	resetModuleState();
}

describe("registration (I-01)", () => {
	it("registers no flags, three handlers and the startup-splash command", () => {
		const { pi } = wire();
		assert.deepEqual(pi.registeredFlags, [], "the slash command is the only toggle — no CLI flags");
		for (const event of ["model_select", "before_agent_start", "session_start"]) {
			assert.ok(pi.handlers.has(event), `handler for ${event}`);
		}
		assert.ok(pi.commands.has("startup-splash"));
	});
});

describe("session_start gating (I-02, I-03, I-10)", () => {
	it("shows header and gate on a genuine TUI startup; Esc proceeds", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.ok(wired.ctx.setHeaderCalls.length >= 1, "splash header installed");
		assert.equal(wired.ctx.customComponents.length, 1, "gate shown");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(wired.ctx.shutdownCount, 0, "proceed must not shut down");
		assert.equal(state.quietStartupEnsured, true, "quietStartup ensured once per process (I-10)");
	});

	it("Quit in the gate shuts pi down (I-04)", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("q");
		await emitted;
		assert.equal(wired.ctx.shutdownCount, 1);
	});

	it("no UI: no gate", async () => {
		const wired = wire({ hasUI: false, mode: "print" });
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0);
	});

	it("non-TUI mode with UI: no gate", async () => {
		const wired = wire({ mode: "rpc" });
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0);
	});

	it("non-startup reasons: no gate", async () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const wired = wire();
			await startup(wired, reason);
			assert.equal(wired.ctx.customComponents.length, 0, `reason=${reason}`);
		}
	});

	// Source comment: "Non-gated sessions start clean, without the splash."
	// README wording is looser — flagged as F-8 in the report.
	it("PI_SPLASH_GATE_DONE=1 starts clean: no gate, no splash", async () => {
		restoreGateEnv();
		restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", "1");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.customComponents.length, 0, "gate skipped");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "non-gated sessions start without the splash");
	});

	it("proceed tears the splash down for a clean session start", async () => {
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
		assert.equal(wired.ctx.setHeaderCalls.length, 2, "splash header swapped for an empty one");
		assert.equal(headerRenderState.requestRender, null, "render callbacks released");
		assert.equal(headerRenderState.invalidate, null);
	});
});

describe("splash without the gate menu (I-11, I-12)", () => {
	it("menuGate:off keeps the splash and mounts no gate", async () => {
		await persist("menuGate:off");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 1, "splash installed and never swapped out");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate menu");
		assert.equal(wired.ctx.shutdownCount, 0);
		// Mount the still-installed factory the way the TUI would; teardown would have nulled these.
		const factory = wired.ctx.setHeaderCalls[0] as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.equal(typeof headerRenderState.requestRender, "function", "header callbacks stay wired");
		assert.equal(typeof headerRenderState.invalidate, "function");
	});

	it("PI_SPLASH_GATE_DONE=1 wins: relaunched children get no splash (I-12)", async () => {
		await persist("menuGate:off");
		restoreGateEnv();
		restoreGateEnv = setEnv("PI_SPLASH_GATE_DONE", "1");
		const wired = wire();
		await startup(wired);
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "no splash");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
	});

	it("reason=reload still shows nothing (I-12)", async () => {
		await persist("menuGate:off");
		const wired = wire();
		await startup(wired, "reload");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "no splash");
		assert.equal(wired.ctx.customComponents.length, 0, "no gate");
	});
});

describe("model_select (I-08) and before_agent_start (I-09)", () => {
	/** Splash-only mode leaves the header installed and its callbacks wired, unlike the gate's proceed path. */
	async function wireWithHeader(): Promise<Wired> {
		await persist("menuGate:off");
		const wired = wire();
		await startup(wired);
		const factory = wired.ctx.setHeaderCalls.at(-1) as (tui: unknown, theme: unknown) => unknown;
		factory(wired.tui.tui, makeTheme());
		assert.equal(typeof headerRenderState.requestRender, "function");
		return wired;
	}

	it("updates the prompt size and requests a header refresh", async () => {
		const wired = await wireWithHeader();
		wired.ctx.bag.systemPrompt = "z".repeat(3333);
		const before = wired.tui.renderRequests.length;
		await wired.pi.emit("model_select", { type: "model_select" }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 3333);
		assert.ok(wired.tui.renderRequests.length > before, "header refresh requested");
	});

	it("a throwing getSystemPrompt preserves the previous size and does not crash", async () => {
		const wired = await wireWithHeader();
		const initial = state.systemPromptSize;
		assert.equal(initial, 2000);
		wired.ctx.bag.systemPrompt = () => {
			throw new Error("not available");
		};
		await wired.pi.emit("model_select", { type: "model_select" }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 2000, "previous size preserved");
	});

	it("before_agent_start records the prompt byte size", async () => {
		const wired = wire();
		await wired.pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "y".repeat(1234) }, wired.ctx.ctx);
		assert.equal(state.systemPromptSize, 1234);
	});
});

describe("commands (I-06, I-07)", () => {
	it("/startup-splash menuGate:off persists the opt-out and notifies", async () => {
		const wired = wire();
		const command = wired.pi.commands.get("startup-splash");
		assert.ok(command);
		await command.handler("menuGate:off", wired.ctx.ctx as never);
		assert.equal(readMenuGate(), "off", "choice written to disk");
		assert.equal(wired.ctx.setHeaderCalls.length, 0, "header untouched — the gate is decided at startup");
		assert.ok(wired.ctx.notifications.length >= 1, "user notified");
	});

	it("/startup-splash menuGate:on persists the opt-in and notifies", async () => {
		const wired = wire();
		await wired.pi.commands.get("startup-splash")!.handler("menuGate:off", wired.ctx.ctx as never);
		await wired.pi.commands.get("startup-splash")!.handler("menuGate:on", wired.ctx.ctx as never);
		assert.equal(readMenuGate(), "on");
		assert.ok(wired.ctx.notifications.length >= 2);
	});

	it("a failing preference write notifies an error instead of success (I-06, I-07)", async () => {
		const wired = wire();
		const blocker = join(env.agentDir, "not-a-dir");
		writeFileSync(blocker, "occupied");
		const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", blocker);
		try {
			await wired.pi.commands.get("startup-splash")!.handler("menuGate:off", wired.ctx.ctx as never);
		} finally {
			restoreAgentDir();
		}
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "failure reported to the user");
		assert.ok(!wired.ctx.notifications.some((n) => n.type === "info"), "no false success notification");
		assert.equal(readMenuGate(), "on", "preference unchanged after the failed write");
	});

	it("/startup-splash with an unrecognized argument notifies an error and writes nothing", async () => {
		const wired = wire();
		await wired.pi.commands.get("startup-splash")!.handler("bogus", wired.ctx.ctx as never);
		assert.ok(wired.ctx.notifications.some((n) => n.type === "error"), "user notified of bad usage");
		assert.equal(existsSync(join(env.agentDir, "pi-startup-splash.json")), false, "preference file untouched");
	});
});

describe("menuGate persistence (I-14)", () => {
	/** Re-run the extension the way a fresh pi process would, keeping the temp agent dir. */
	async function relaunch(): Promise<Wired> {
		resetModuleState();
		const wired = wire();
		await startup(wired);
		return wired;
	}

	it("defaults to on (gate shown) with no preference file written yet", () => {
		assert.equal(readMenuGate(), "on");
		assert.equal(existsSync(join(env.agentDir, "pi-startup-splash.json")), false);
	});

	it("menuGate:off keeps the splash and drops the gate on every later launch", async () => {
		await persist("menuGate:off");

		for (const attempt of [1, 2]) {
			const next = await relaunch();
			assert.equal(next.ctx.setHeaderCalls.length, 1, `launch ${attempt}: splash installed and never swapped out`);
			assert.equal(next.ctx.customComponents.length, 0, `launch ${attempt}: no gate`);
			assert.equal(next.ctx.shutdownCount, 0, `launch ${attempt}: no shutdown`);
		}
	});

	it("menuGate:off leaves the quietStartup write in place (I-10)", async () => {
		await persist("menuGate:off");
		await relaunch();
		assert.equal(state.quietStartupEnsured, true);
	});

	it("menuGate:on brings the gate back on the next launch", async () => {
		await persist("menuGate:off");
		await persist("menuGate:on");

		const next = wire();
		const emitted = startup(next);
		await until(() => next.ctx.customComponents.length > 0);
		assert.equal(next.ctx.customComponents.length, 1, "gate restored");
		(next.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});

	it("a corrupt preference file falls back to the gate instead of throwing", async () => {
		writeFileSync(join(env.agentDir, "pi-startup-splash.json"), "{not json", "utf8");
		assert.equal(readMenuGate(), "on");
		const wired = wire();
		const emitted = startup(wired);
		await until(() => wired.ctx.customComponents.length > 0);
		assert.equal(wired.ctx.customComponents.length, 1, "gate still shown");
		(wired.ctx.customComponents[0] as { handleInput(data: string): void }).handleInput("\x1b");
		await emitted;
	});
});
