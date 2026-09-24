# Changelog

## 0.2.0

- Add **Edit model pool** to `/subagent-entropy [agent]`, including agents currently pinned to a single native model.
- Select available chat models directly in the TUI, preserve retained weights, and save the pool, mode, and weights atomically in project-local routing configuration.
- Add **Use native model pool** with a working save path back to a single-model native pin. Both picker and main-editor cancellation leave persisted configuration untouched.
- Add the optional agent-only `models` field. An explicit pool replaces the native candidate list and per-spawn fallback order; existing configurations without this field keep their previous behavior.
- Verify explicit pools through real task/eval dispatch, clean-package installation, and actual terminal interaction.

## 0.1.0

Initial public release.

### Features

- Weighted random and smooth weighted round-robin starting-model selection for omp subagents, using native agent and role model lists.
- `/subagent-entropy [agent]` for interactive agent routing mode and weights, normalized percentages, Save/Cancel, and override removal.
- Agent-over-role precedence, per-parent-session rotation, single-model pins, and immediate application of editor saves to subsequent spawns.
- Original model selectors and remaining candidates preserved for omp retry fallback; weights affect initial selection only.

### Correctness and security

- Reset routing caches across session switches and reloads, including transitions with no intervening spawn.
- Refuse stale editor saves after session or working-directory changes, including same-ID project moves.
- Project-confined atomic persistence with same-agent conflict detection and preservation of unrelated edits.
- Terminal-safe diagnostics and routing notes; configuration reads restricted to bounded regular files (1 MiB).

### Distribution and verification

- MIT license, GitHub installation, versioned release artifact and SHA-256 checksum.
- Pinned Docker-only development and CI with formatting, strict types, unit tests, real omp dispatch and session-lifecycle checks.
- Clean-package installation verification through the real omp plugin manager without source-tree or development-dependency fallback.
