# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-01

### Changed

- `[extensions]` list now mirrors pi's own startup screen exactly: extensions are discovered with
  pi's package-manager logic (settings `packages`/`extensions` entries and overrides, agent and
  project `.pi/extensions` auto-discovery, `--extension`/`--no-extensions` honored) and labeled
  with pi's compact labels (`pkg:src` for package entries, shortest unique path suffix
  otherwise). Previously the list over-reported — every npm-manifest dependency (the
  `@juicesharp/rpiv-*` packages pi never loads), disabled extensions, and hidden `<inline:…>`
  built-ins — and labeled entries from command/tool paths instead of pi's own labels

### Added

- `[context] N` section on the splash info panel listing every source pi's `/loaded` Context
  section counts — SYSTEM.md/APPEND_SYSTEM.md system-prompt sources (project `.pi/` when
  trusted, else agent dir, honoring `--system-prompt`/`--append-system-prompt`) plus the
  AGENTS.md/CLAUDE.md context files (global agent-dir file and every ancestor of the session
  cwd, honoring `--no-context-files`) — discovered via pi's own loaders and displayed like pi's
  `/loaded` Context listing

## [0.1.1] - 2026-07-28

### Changed

- Highlight session count and date on the selected gate row

### Security

- Harden the TUI text sanitizer to strip all escape sequences (CSI including 8-bit, OSC/DCS/SOS/PM/APC) and C0/C1 control bytes, closing remaining terminal-injection paths

## [0.1.0] - 2026-07-28

### Added

- Full-bleed rainbow splash screen replacing the default startup header
- Pi text art logo with shimmer effect on truecolor terminals
- Info panel displaying version, model, system prompt size, skills, and extensions
- Interactive startup gate menu with hotkeys (New session, Resume session, Model, Skills and Extensions, Theme, Quit)
- `/startup-splash menuGate:on|off` command to toggle the gate menu
- Responsive layout that collapses skill/extension lists on small terminals
