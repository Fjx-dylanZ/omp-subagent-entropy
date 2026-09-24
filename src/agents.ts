import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  formatModelStringWithRouting,
  resolveAgentModelSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentPool } from "./editor";

/** Read the spawning session's settings; never use or mutate the global settings singleton. */
export async function loadAgentPools(ctx: ExtensionCommandContext): Promise<AgentPool[]> {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("The active session's agent settings are unavailable.");
  await settings.reloadFromDisk();
  const { agents } = await discoverAgents(ctx.cwd);
  const overrides = settings.get("task.agentModelOverrides");
  const disabled = settings.get("task.disabledAgents");
  const current = ctx.models.current();
  const activeModelPattern = current ? formatModelStringWithRouting(current) : undefined;
  return agents
    .map((agent) => {
      const selection = resolveAgentModelSelection({
        settingsOverride: Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined,
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: settings.getModelRole("default"),
      });
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
