# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
