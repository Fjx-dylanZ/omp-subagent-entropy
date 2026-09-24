# omp-subagent-entropy

Weighted random and weighted round-robin selection for **omp subagent spawns**. Tested with omp **18.3.0**.

omp already supports ordered model lists on agents and model roles. This extension chooses the starting model from those lists instead of always starting with the first candidate. It uses `before_subagent_spawn`; it does not replace the task tool, change the parent's model, or write omp settings.

## Install

Requires **omp 18.3.0** and **Bun 1.4.2 or newer** on PATH for omp's plugin installer. Other omp versions are not yet verified.

```sh
omp plugin install github:Fjx-dylanZ/omp-subagent-entropy#v0.1.0
```

Start a new omp session in your work project. Existing sessions do not need to be restarted. Once an agent has a native model pool configured below, open its routing editor:

```text
/subagent-entropy reviewer
```

There is no extension build step and no runtime npm dependency to install separately. The package contains TypeScript sources and uses the host APIs bundled in omp. No npm publication is required.

To update or return to another version, repeat the install command with the desired [release tag](https://github.com/Fjx-dylanZ/omp-subagent-entropy/releases). To uninstall:

```sh
omp plugin uninstall omp-subagent-entropy
```

Installation changes omp's user plugin registry. Routing rules remain project-local and are not removed by uninstalling the plugin.

## Configure a model pool

Keep candidates in native omp configuration. For example, in your project's `.omp/config.yml`:

```yaml
modelRoles:
  review:
    - openai/gpt-5.4
    - anthropic/claude-sonnet-4-5

task:
  agentModelOverrides:
    reviewer: "@review"
```

Use model selectors available to your omp installation and credentials. Alternatively, put a list directly in an agent's Markdown frontmatter:

```yaml
model:
  - openai/gpt-5.4
  - anthropic/claude-sonnet-4-5
```

For agent routing, use `/subagent-entropy reviewer` to create the rule interactively. For a file-based role rule, create `.omp/subagent-entropy.json` in that project:

```json
{
  "roles": {
    "review": {
      "mode": "random",
      "weights": {
        "openai/gpt-5.4": 3,
        "anthropic/claude-sonnet-4-5": 1
      }
    }
  }
}
```

This gives each invocation a **75% / 25%** starting-model probability, assuming both candidates are available. Change `mode` to `"round-robin"` for deterministic smooth weighted rotation with the same target proportions. Equal weights produce ordinary round-robin.

For a rule attached directly to an agent instead of its role:

```json
{
  "agents": {
    "reviewer": {
      "mode": "round-robin",
      "weights": {
        "openai/gpt-5.4": 3,
        "anthropic/claude-sonnet-4-5": 1
      }
    }
  }
}
```

`agents` and `roles` can coexist. An agent-specific rule takes precedence over its role's rule; rules are not merged. Role keys omit `@`.

## Load a local checkout

For development, or to try the extension in only one session without registering it globally:

```sh
omp --extension /absolute/path/to/omp-subagent-entropy
```

The package manifest loads `src/index.ts`. The extension uses omp's bundled runtime APIs for native agent discovery and model resolution; this project's development dependencies do not need to be installed on the host. You can also add the package directory to that project's native `extensions` setting.

**No host installation or configuration change is performed by the Docker commands below.** During development, do not place example `.omp/config.yml` files in this repository unless you intentionally want the host session working here to discover them.

## Interactive agent configuration

After loading the extension, run:

```text
/subagent-entropy
```

Pick an agent, or open one directly:

```text
/subagent-entropy reviewer
```

The editor shows the agent's effective native model list, inherited role policy, and current routing override. Use arrow keys and Enter to:

- Switch between **random** and **round-robin**.
- Edit relative weights and see normalized initial-selection percentages immediately.
- **Save** the agent override, or **Cancel** / Escape to discard the draft.
- **Remove agent override** to restore the existing role rule or native model order, after confirmation.

For example, weights `3` and `1` display `75.0%` and `25.0%`. Unavailable candidates are marked and excluded from these percentages. Negative/non-finite weights are rejected; saving requires at least one available positive-weight candidate. A zero weight affects the initial pick, not retry fallback.

**This editor changes agent routing mode and weights, not model-pool membership or role rules.** Define at least two candidate models in native omp configuration first (see above). Single-model pins remain native; an obsolete agent override can still be removed.

Changes are saved to the project's `.omp/subagent-entropy.json` and apply to **the next spawn in the current session without `/reload`**. Running children keep their models. Saving or removing an override refreshes the current session's routing configuration and resets its round-robin balances. Other sessions retain their cached configuration until reloaded.

The editor preserves role rules and other agents. It merges unrelated file edits made while the dialog was open, rejects concurrent edits to the same agent, and refuses a weighted save if that agent's native model list changed. A draft is also refused if its session or working directory changed, including a same-session `/move`. Malformed files are not overwritten. Saves use atomic replacement; they are not cross-process locked, so avoid simultaneous saves from multiple sessions.

Only project-local paths are writable. An active `OMP_SUBAGENT_ENTROPY_CONFIG` path outside the project, escaping directory symlinks, and config-file symlinks are refused. Native agent definitions, native model settings, and global configuration are never written by the editor.

## Routing contract

- Only an explicitly configured agent or role with **two or more distinct native candidate patterns** is routed. Missing default configuration, unmatched rules, and single-model pins retain native behavior.
- Native omp override precedence applies before this hook. A single-model override remains a pin. Role rules match the originating role supplied by omp, not other roles that happen to use the same model.
- Weights are finite, nonnegative, relative numbers. `3:1`, `75:25`, and `0.75:0.25` describe the same split. Unspecified candidate weights are `1`; omitting `weights` makes the pool uniform.
- Weight keys match **exact expanded selector strings**, including any thinking suffix. They are not fuzzy matches or role aliases. An unknown weight key in an active multi-model pool blocks the spawn rather than silently changing the intended probabilities.
- Initial selection excludes zero-weight candidates and candidates that `ctx.models.resolve` cannot resolve from the session's available models. Remaining weights are renormalized. Availability is not a provider health check or a guarantee that credentials will refresh successfully.
- Random selection is independent per invocation; its proportions are statistical, not batch quotas. Round-robin uses smooth weighted allocation, with equal-score ties following native candidate order.
- Round-robin state is shared by a routing rule within the **parent session**. Agents using the same role rule share its rotation. Agent-specific rules have independent rotations. A changed eligible pool or weights resets that rule's balances. State is not persisted or coordinated across sessions/processes; switching sessions or reloading starts a fresh rotation.
- Selection and state updates are synchronous. Concurrent dispatches reserve choices in hook execution order, not completion order. A canceled dispatch may consume a rotation slot.
- Selection occurs once at child creation, not per model request, tool call, or continuation. Workpool follow-up items keep the existing worker; they do not consume another selection.
- **Weights control only the starting model.** The selected pattern moves to the front; all remaining native patterns keep their original relative order for omp's retry fallback. **A zero-weight model can still be used as a fallback.** Configure omp's retry policy separately if that is not desired.
- Thinking suffixes remain attached to their selectors. Effort, permissions, output schemas, service tiers, retry rules, and the parent model remain owned by omp.
- The task UI receives a routing note with the policy, rule, chosen selector, and target share. Core reports the actual serving model separately; retries can make that model differ from the original routing note.

Configuration is loaded lazily at the first spawn in a session and cached. After **manual file edits**, use omp's `/reload` or start a fresh session; saves made through the interactive agent editor apply immediately. To use a different file, set `OMP_SUBAGENT_ENTROPY_CONFIG` to an absolute path or a path relative to the session working directory. An explicitly selected missing file is an error; it does not fall back to the default file.

Malformed configuration blocks subagent spawning with a `subagent-entropy` error. Routing configuration must be a regular file no larger than **1 MiB**; FIFOs, devices, and oversized inputs are refused rather than read into the host process. A matched pool with no available positive-weight candidate also blocks. The extension returns an explicit refusal because omp treats a thrown spawn-hook exception as no override. Displayed diagnostics and routing notes strip terminal controls.

### Scope

Supported: task-tool dispatch, eval `agent()`, and initial workpool worker creation. Nested dispatch is routed where the extension is loaded in the spawning parent.

Not intercepted: main-session model selection, main-session turns, advisor/memory helpers, image/web/speech/dictation/judge roles, or Vibe workers. This is not an ensemble runner: each spawn starts one child on one model.

If other extensions also return a model from `before_subagent_spawn`, omp uses the last such result in extension order. Avoid stacking competing routers.

## Docker development and verification

Requirements: Docker Engine with Linux ARM64 support, Docker Compose, and Buildx. The development image pins Bun **1.4.2** by digest and the omp **18.3.0** Linux ARM64 binary by SHA-256. It does not build the omp monorepo.

```sh
# Build dependencies and the development image; this step requires network access.
docker compose build dev

# Type-check, run policy tests, and exercise real omp dispatch. Runtime is offline.
docker compose run --rm dev

# Rebuild and check after editing source/tests.
docker compose run --build --rm dev

# Individual checks or selected integration scenarios.
docker compose run --rm dev bun run typecheck
docker compose run --rm dev bun run test
docker compose run --rm dev bun tests/runtime.ts round-robin weighted-batch workpool

docker compose run --rm dev omp --version
docker compose run --rm dev bash
```

Sources are copied into the image and read-only to the non-root runtime user. Edit source in the project, then rebuild; there is no writable host bind mount. For interactive experiments, create a workspace under `/tmp` inside the container. Such changes disappear when the container exits.

Container isolation:

- No host home, auth database, credentials, Docker socket, ports, or bind mounts.
- No runtime external networking; loopback is available for the protocol fixture.
- Fresh container-local HOME, omp state, sessions, and caches; writable temporary filesystems.
- Non-root user, dropped capabilities, no privilege escalation, 2 CPU / 2 GiB memory limits.
- Default-deny build context excludes `.env`, `.npmrc`, host dependencies, and unrelated files.
- Dependency installation and lockfile generation run only in Docker. Optional heavy native dependencies are omitted from the npm development package; the integration target is the checksum-verified release executable, not the npm CLI.

The committed `bun.lock` is used with a frozen install. To intentionally regenerate it inside Docker:

```sh
docker buildx build --platform linux/arm64 --target lockfile --output type=local,dest=. .
```

That export writes only `bun.lock`. It does not run a host package manager.

### What verification covers

`bun run check` runs:

1. Prettier formatting checks and strict TypeScript checking against omp 18.3.0's published types, including unused-symbol checks.
2. Deterministic unit tests for probability boundaries, normalization, weighted rotation, availability changes, precedence, pins, terminal-safe diagnostics, bounded file reads, and agent-rule persistence (conflicts, unrelated edits, permissions, safe paths, and failed-write cleanup).
3. Nine integration scenarios against the **real omp binary** using a **test-only loopback OpenAI-compatible protocol fixture**. Assertions inspect actual child provider requests and omp's routing/result metadata, not just returned fixture text.
4. Real RPC session-lifecycle regressions: session-switch/reload rotation resets, stale-draft refusal across same-ID project moves, and terminal-safe command errors.

Integration covers mixed task/eval rotation, concurrent 3:1 routing, agent-versus-role precedence, zero-weight initial exclusion, workpool reuse, real core retry fallback after a fixture 429, malformed/absent configuration, blocked spawns, and unchanged native routing. Child continuations and parent requests are checked for unintended model changes.

Separately, the interactive editor was exercised through keyboard input in a real omp terminal inside Docker: agent selection, mode changes, invalid weight rejection, live 75%/25% display, Save, Cancel, and removal. Actual child provider requests in the same session changed to `A, A, B, A` after saving 3:1 round-robin, then returned to the inherited role policy after removal. This terminal smoke is not part of `bun run check`.

No real provider inference or external credentials are used. These checks verify routing and omp integration, not provider availability or model quality. Live-provider behavior has not been exercised.

Useful smoke controls:

```sh
docker compose run --rm dev bun tests/runtime.ts --list
docker compose run --rm -e ENTROPY_SMOKE_KEEP_TMP=1 dev bun tests/runtime.ts fallback
```

`ENTROPY_SMOKE_KEEP_TMP` preserves diagnostic files only inside that container; `--rm` still removes the container afterward. `OMP_BIN` can select another binary already available inside the container; the smoke enforces the tested 18.3.0 version.

### Clean package installation

CI runs on `ubuntu-24.04-arm`, with read-only repository permissions and a commit-pinned checkout action. It runs the checks above, then installs the packed release through the real omp plugin manager in a second image containing **no source checkout or development dependencies**. A loopback-only npm registry supplies the artifact without internet access during the smoke. The check verifies installed command discovery and actual task/eval routing.

```sh
docker build --platform linux/arm64 --target install-smoke -t omp-subagent-entropy-install .
docker run --rm --init --network none \
  --cpus 2 --memory 3g --memory-swap 3g --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /home/dev:uid=10001,gid=10001,mode=0700,size=1g,exec \
  --tmpfs /tmp:mode=1777,size=1g,exec \
  --tmpfs /run/user/10001:uid=10001,gid=10001,mode=0700,size=16m \
  omp-subagent-entropy-install
```

The clean-package check runs separately from `bun run check`. Published GitHub installation is also verified when cutting a release; the offline CI registry is not a substitute for that distribution check.

## Contributing

Keep development and checks in Docker; do not install the npm host package globally or copy host `node_modules` into the image. Changes should preserve native omp model-selection precedence and retry behavior. Include a regression for a consumer-visible bug, and exercise actual omp dispatch or terminal interaction when changing those paths.

Apply formatting in Docker without a writable checkout mount:

```sh
docker buildx build --platform linux/arm64 --target formatted --output type=local,dest=. .
docker compose run --build --rm -T dev
```

The formatter export updates only `src/`, `tests/`, the package/TypeScript/Prettier configuration, and the CI workflow. Save your edits before running it. Dependency changes require regenerating `bun.lock` with the Docker command above.

To produce the distribution artifact and its checksum:

```sh
docker buildx build --platform linux/arm64 --target package --output type=local,dest=dist .
```

Release tags must match `package.json`'s version. Run both development and clean-package checks, verify the GitHub installation, and publish the matching tarball and `SHA256SUMS`. Do not move a published tag; fixes get a new version.

## Security

An omp extension runs in-process with the user's permissions; this is **not a sandbox**. Only install trusted extension code and use trusted projects. The editor's project-path checks prevent ordinary accidental writes outside the project, not attacks by another local process racing filesystem changes. Atomic saves do not provide a cross-process lock.

Every configured model or core retry fallback may receive subagent context. Weights are routing preferences, not a provider-access or data-residency policy. Use omp's provider and retry controls for those restrictions.

Report vulnerabilities using [GitHub private vulnerability reporting](https://github.com/Fjx-dylanZ/omp-subagent-entropy/security/advisories/new). Do not post credentials, private prompts, or session transcripts in public issues.

## License

[MIT](LICENSE).
