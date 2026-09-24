import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { RoutingConfig } from "./config";
import { listModelChoices, loadAgentPools } from "./agents";
import { editAgentRouting } from "./editor";
import { ModelRouter } from "./router";
import { readRoutingDocument, saveAgentRule } from "./store";
import { plain } from "./display";

interface SessionRouting {
  id: string;
  path: string;
  router: ModelRouter;
  config?: RoutingConfig;
  error?: string;
}

export default function subagentEntropy(pi: ExtensionAPI): void {
  let state: SessionRouting | undefined;
  let editing = false;
  let generation = 0;
  const resetSessionRouting = () => {
    state = undefined;
    generation++;
  };
  pi.on("session_start", resetSessionRouting);
  pi.on("session_switch", resetSessionRouting);
  pi.on("session_branch", resetSessionRouting);
  pi.on("session_shutdown", resetSessionRouting);

  pi.registerCommand("subagent-entropy", {
    description: "Configure an agent's model pool, routing mode, and weights (project-local)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Agent routing configuration requires an interactive UI.", "warning");
        return;
      }
      if (editing) {
        ctx.ui.notify("An agent routing editor is already open.", "warning");
        return;
      }
      editing = true;
      try {
        // Context.cwd is a snapshot. Own this command before its first await and
        // use the session manager's live cwd plus the lifecycle generation afterward.
        const id = ctx.sessionManager.getSessionId();
        const cwd = ctx.cwd;
        const ownerGeneration = generation;
        const override = process.env.OMP_SUBAGENT_ENTROPY_CONFIG;
        const path = resolve(cwd, override || ".omp/subagent-entropy.json");
        const assertOwner = () => {
          if (
            generation !== ownerGeneration ||
            ctx.sessionManager.getSessionId() !== id ||
            ctx.sessionManager.getCwd() !== cwd ||
            resolve(
              ctx.sessionManager.getCwd(),
              process.env.OMP_SUBAGENT_ENTROPY_CONFIG || ".omp/subagent-entropy.json",
            ) !== path
          ) {
            throw new Error("The active session or routing file changed. Reopen the editor.");
          }
        };
        assertOwner();
        await ctx.waitForIdle();
        assertOwner();
        const localPath = relative(cwd, path);
        if (isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`)) {
          throw new Error(
            "The agent editor only saves project-local routing files. The active config is outside this project.",
          );
        }
        let document = readRoutingDocument(path, !override);
        const pools = await loadAgentPools(ctx);
        assertOwner();
        const catalog = listModelChoices(ctx);
        for (const pool of pools) {
          const explicit = document.config.agents.get(pool.name)?.models;
          if (explicit) {
            pool.available = new Set([
              ...pool.available,
              ...explicit.filter((pattern) => ctx.models.resolve(pattern) !== undefined),
            ]);
          }
        }
        for (const name of document.config.agents.keys()) {
          if (!pools.some((pool) => pool.name === name)) {
            pools.push({
              name,
              description: "Not currently discovered. Its saved routing override can be removed.",
              patterns: [],
              available: new Set(),
            });
          }
        }
        await editAgentRouting(
          ctx.ui,
          pools,
          document.config,
          catalog,
          async (agent, rule) => {
            assertOwner();
            if (rule) {
              const original = pools.find((pool) => pool.name === agent);
              const latest = (await loadAgentPools(ctx)).find((pool) => pool.name === agent);
              assertOwner();
              if (
                !latest ||
                JSON.stringify([original?.patterns, original?.modelRole]) !==
                  JSON.stringify([latest.patterns, latest.modelRole])
              ) {
                throw new Error(
                  "This agent's native model list changed while editing. Reopen the editor before saving.",
                );
              }
              const patterns = rule.models ?? latest.patterns;
              if (
                patterns.length >= 2 &&
                !patterns.some(
                  (pattern) =>
                    (rule.weights?.get(pattern) ?? 1) > 0 && ctx.models.resolve(pattern) !== undefined,
                )
              ) {
                throw new Error(
                  "No available model has a positive weight. Reopen the editor to refresh availability.",
                );
              }
            }
            assertOwner();
            document = saveAgentRule(path, document, agent, rule, cwd);
            state = undefined;
          },
          args.trim() || undefined,
        );
      } catch (error) {
        ctx.ui.notify(
          plain(`subagent-entropy: ${error instanceof Error ? error.message : String(error)}`, 600),
          "error",
        );
      } finally {
        editing = false;
      }
    },
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const override = process.env.OMP_SUBAGENT_ENTROPY_CONFIG;
    const path = resolve(ctx.cwd, override || ".omp/subagent-entropy.json");
    const id = ctx.sessionManager.getSessionId();
    if (!state || state.id !== id || state.path !== path) {
      state = { id, path, router: new ModelRouter() };
      try {
        state.config = readRoutingDocument(path, !override).config;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      }
    }

    // Core treats thrown spawn-hook errors as no override. Explicitly refuse bad routing config.
    if (state.error) return { block: true, reason: plain(`subagent-entropy (${path}): ${state.error}`, 600) };
    if (!state.config) return;
    try {
      return state.router.route(
        state.config,
        event,
        (selector) => ctx.models.resolve(selector) !== undefined,
      );
    } catch (error) {
      return {
        block: true,
        reason: plain(`subagent-entropy: ${error instanceof Error ? error.message : String(error)}`, 600),
      };
    }
  });
}
