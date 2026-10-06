# omp-subagent-entropy

[![CI](https://github.com/Fjx-dylanZ/omp-subagent-entropy/actions/workflows/ci.yml/badge.svg)](https://github.com/Fjx-dylanZ/omp-subagent-entropy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Weighted random and round-robin model routing for [omp](https://github.com/can1357/oh-my-pi) subagents.

omp starts a subagent on the first available model in its agent or role model list. This extension spreads spawns across that list, or across a project-local model pool, by weights you choose, including for agents natively pinned to a single model. It only hooks `before_subagent_spawn`: the main session's model and omp's own settings are never changed.

## Features

- **Random** or **smooth weighted round-robin** selection, per agent or per model role.
- **Project-local model pools** that replace an agent's native model list, including a single-model pin.
- **Interactive editor**, `/subagent-entropy`, to pick models, mode, and weights without editing YAML.
- **Fallback preserved**: weights pick only the starting model; the rest of the pool remains omp's retry fallback.
- **Per-call models respected**: a `model` passed to a task, eval `agent()`, or `workpool()` is never rerouted.

## Requirements

- omp. Tested with 18.3.1, 18.4.0, and 18.6.1; for omp 18.3.0 use `v0.2.0`.
- Bun 1.4.2 or newer on `PATH`, used by `omp plugin install`.

## Installation

```sh
omp plugin install 'github:Fjx-dylanZ/omp-subagent-entropy#v0.3.0'
```

Use the latest [release tag](https://github.com/Fjx-dylanZ/omp-subagent-entropy/releases), and start a new omp session after installing or updating. To uninstall:

```sh
omp plugin uninstall omp-subagent-entropy
```

Routing files stay in your projects after uninstalling. To try a local checkout in a single session instead, run `omp --extension /path/to/omp-subagent-entropy`.

## Usage

Open the editor for an agent in your project:

```text
/subagent-entropy reviewer
```

1. Choose **Edit model pool**, toggle at least two models with Enter, then choose **Done**.
2. Choose **random** or **round-robin** and set relative weights; the editor shows the resulting percentages.
3. Choose **Save**. The next spawn uses the new rule; no `/reload` is needed.

## Configuration

Rules live in `.omp/subagent-entropy.json` in the project. Set `OMP_SUBAGENT_ENTROPY_CONFIG` to use another file, either absolute or relative to the session's working directory.

```json
{
  "agents": {
    "reviewer": {
      "mode": "round-robin",
      "models": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"],
      "weights": { "openai/gpt-5.4": 3, "anthropic/claude-sonnet-4-5": 1 }
    }
  },
  "roles": {
    "review": { "mode": "random" }
  }
}
```

| Field     | Rules         | Description                                                                                                                                                                             |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | agents, roles | Required. `random` picks independently per spawn; `round-robin` rotates with the same target proportions.                                                                               |
| `weights` | agents, roles | Relative, finite, nonnegative weights keyed by exact model selector, including any `:thinking` suffix. Unlisted models weigh `1`. `3` and `1` give a 75% / 25% split of starting models. |
| `models`  | agents only   | At least two distinct selectors, in fallback order. Replaces the agent's native model list. Omit it to route the native list.                                                         |

Without `models`, candidates come from omp's own configuration: the agent's `model` list, `task.agentModelOverrides`, or a model role, for example in `.omp/config.yml`:

```yaml
modelRoles:
  review: [openai/gpt-5.4, anthropic/claude-sonnet-4-5]
task:
  agentModelOverrides:
    reviewer: "@review"
```

Role keys omit the `@`. An agent rule takes precedence over its role's rule; rules are not merged. Editor saves apply immediately; after editing the file by hand, run `/reload` or start a new session.

## Routing behavior

- **Starting model only.** The chosen model moves to the front and the rest of the pool keeps its order as omp's retry fallback, so a zero-weight model can still serve as a fallback.
- **Pins stay pins.** Without `models`, a native list with a single model is not routed.
- **Per-call models win.** When the caller passes `model` to a task item, eval `agent()`, or `workpool()` (omp 18.5.0+), routing is skipped and the rotation does not advance. omp does not report where a spawn's models came from, so a request identical to the agent's configured models is still routed.
- **Unavailable models are skipped** for the initial pick and listed in the routing note shown in the task result (`unavailable: …`).
- **Round-robin state** is kept per parent session and per rule; agents sharing a role rule share its rotation. It resets on session switch, `/reload`, or a rule change.
- **Errors block the spawn** instead of silently using omp's default: a malformed or missing config file, a weight for a model outside the list, or a pool with no available positive-weight model.
- **Scope:** task-tool spawns, eval `agent()`, and the first `workpool()` worker (follow-up items reuse it). The main session, advisor and memory helpers, other model roles, and Vibe workers are not routed. If several extensions return a model from `before_subagent_spawn`, omp uses the last one.

## Development

Development and tests run in Docker (linux/arm64) so nothing is installed on the host. The image pins Bun 1.4.2 and the omp 18.6.1 release binary by checksum.

```sh
docker compose build dev                                  # requires network
docker compose run --build --rm dev                       # format check, typecheck, unit + integration tests (offline)
docker compose run --rm dev bun tests/runtime.ts --list   # integration scenarios; pass names to run a subset
```

Integration tests drive the real omp binary against a loopback OpenAI-compatible fixture: no credentials, no external network. Other build targets:

```sh
# Apply formatting to src/, tests/, and config files
docker buildx build --platform linux/arm64 --target formatted --output type=local,dest=. .

# Regenerate bun.lock after dependency changes
docker buildx build --platform linux/arm64 --target lockfile --output type=local,dest=. .

# Install the packed tarball with `omp plugin install` in a clean image (also run by CI)
docker build --platform linux/arm64 --target install-smoke -t omp-subagent-entropy-install .
docker run --rm --init --network none omp-subagent-entropy-install

# Release tarball and SHA256SUMS in ./dist
docker buildx build --platform linux/arm64 --target package --output type=local,dest=dist .
```

### Contributing

Issues and pull requests are welcome. Run the checks above before submitting, and add an integration scenario when changing spawn routing or editor behavior. Releases are tagged `vX.Y.Z` to match `package.json`; published tags are never moved.

## Security

Extensions run in-process with your user permissions; install only code you trust. Weights are routing preferences, not an access policy: every model in a pool, and any retry fallback, may receive subagent context. Restrict providers with omp's own settings.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Fjx-dylanZ/omp-subagent-entropy/security/advisories/new), not public issues.

## License

[MIT](LICENSE)
