import type {
  BeforeSubagentSpawnEvent,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  formatModelStringWithRouting,
  resolveAgentModelSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentPool, AvailableModel } from "./editor";

// Stands in for the parent's live model when an agent inherits it: omp reports that model with the
// parent's current effort suffix, so inherited selections are compared by model identity instead.
const SESSION_MODEL = "subagent-entropy/session-model";

/**
 * The session's agents and their configured model selection (settings override, agent definition, or
 * inherited parent model), ignoring any per-call `model`. Reads the spawning session's settings; never
 * uses or mutates the global settings singleton.
 */
async function configuredAgents(cwd: string) {
  const settings = findScopedSettings(cwd);
  if (!settings) return undefined;
  await settings.reloadFromDisk();
  const { agents } = await discoverAgents(cwd);
  const overrides = cfgTaskAgentModelOverrides.get(settings);
  return {
    settings,
    agents,
    select: (agent: (typeof agents)[number], activeModelPattern: string | undefined) =>
      resolveAgentModelSelection({
        settingsOverride: Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined,
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: settings.getModelRole("default"),
      }),
  };
}

export async function loadAgentPools(ctx: ExtensionCommandContext): Promise<AgentPool[]> {
  const configured = await configuredAgents(ctx.cwd);
  if (!configured) throw new Error("The active session's agent settings are unavailable.");
  const disabled = cfgTaskDisabledAgents.get(configured.settings);
  const current = ctx.models.current();
  const activeModelPattern = current ? formatModelStringWithRouting(current) : undefined;
  return configured.agents
    .map((agent) => {
      const selection = configured.select(agent, activeModelPattern);
      const patterns = [...new Set(selection.patterns)];
      return {
        name: agent.name,
        description: `${disabled.includes(agent.name) ? "Disabled in omp settings. " : ""}${agent.description}`,
        patterns,
        modelRole: selection.role,
        available: new Set(patterns.filter((pattern) => ctx.models.resolve(pattern) !== undefined)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a spawn runs on a per-call `model` (task item, eval `agent()`, or `workpool()`) instead of the
 * agent's configured models. omp does not report the source, so the configured selection is recomputed
 * and compared. A request identical to the configured selection is indistinguishable and counts as
 * configured, as do agents this session's discovery cannot see and unavailable settings.
 */
export async function usesPerCallModel(
  event: BeforeSubagentSpawnEvent,
  ctx: ExtensionContext,
): Promise<boolean> {
  const configured = await configuredAgents(ctx.cwd);
  const agent = configured?.agents.find((candidate) => candidate.name === event.agent);
  if (!configured || !agent) return false;
  const selection = configured.select(agent, SESSION_MODEL);
  if (selection.role !== event.modelRole) return true;
  if (selection.patterns.some((pattern) => pattern.startsWith(SESSION_MODEL))) {
    const parent = ctx.models.current();
    const spawned = event.patterns.length === 1 ? ctx.models.resolve(event.patterns[0]!) : undefined;
    return !parent || !spawned || spawned.provider !== parent.provider || spawned.id !== parent.id;
  }
  return (
    selection.patterns.length !== event.patterns.length ||
    selection.patterns.some((pattern, index) => pattern !== event.patterns[index])
  );
}

/** Models the active session can authenticate and use for chat-based subagents. */
export function listModelChoices(ctx: ExtensionCommandContext): AvailableModel[] {
  const choices = new Map<string, AvailableModel>();
  for (const model of ctx.models.list()) {
    // Catalog rows without a kind are ordinary chat models.
    if (model.kind !== undefined && model.kind !== "chat") continue;
    const selector = formatModelStringWithRouting(model);
    choices.set(selector, { selector, name: model.name });
  }
  return [...choices.values()].sort((a, b) => a.selector.localeCompare(b.selector));
}
