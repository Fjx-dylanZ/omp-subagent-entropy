import type { ExtensionUIContext, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import type { RoutingConfig, RoutingMode, RoutingRule } from "./config";
import { plain } from "./display";

/** One discovered subagent and its resolved native model pool (read-only here). */
export interface AgentPool {
  name: string;
  description: string;
  /** Expanded native candidates in native order, including thinking suffixes. */
  patterns: readonly string[];
  modelRole?: string;
  /** Candidates that currently resolve to a usable model. */
  available: ReadonlySet<string>;
}

/** Persist (rule) or delete (undefined) one agent-specific rule. Throws with an actionable message on failure. */
export type SaveAgentRule = (agent: string, rule: RoutingRule | undefined) => void | Promise<void>;

const MODES: readonly ExtensionUISelectOption[] = [
  { label: "random", description: "Weighted random draw for every spawn" },
  { label: "round-robin", description: "Smooth weighted rotation within this session" },
];

const MODE_HELP: Record<RoutingMode, string> = {
  random: "Weighted random first model per spawn; enter to change",
  "round-robin": "Smooth weighted rotation per session; enter to change",
};

type Action =
  | { kind: "mode" }
  | { kind: "weight"; pattern: string }
  | { kind: "save" }
  | { kind: "remove" }
  | { kind: "cancel" };

interface Row extends ExtensionUISelectOption {
  action: Action;
}

/** Selector labels and descriptions render as inline markdown; keep names and globs literal. */
function literal(text: string, max?: number): string {
  return plain(text, max).replace(/[\\`*_~[\]<>$&#]/g, "\\$&");
}

/** Accept plain decimal or exponent notation only: no signs, hex, Infinity, or NaN. */
function parseWeight(text: string): number | undefined {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Target share of initial picks, mirroring the router: only available positive-weight candidates count. */
function shares(
  patterns: readonly string[],
  weightOf: (pattern: string) => number,
  available: ReadonlySet<string>,
) {
  const result = new Map<string, number>();
  let maximum = 0;
  for (const pattern of patterns) {
    const weight = weightOf(pattern);
    if (weight > 0 && available.has(pattern)) maximum = Math.max(maximum, weight);
  }
  if (maximum === 0) return result;
  let total = 0;
  for (const pattern of patterns) {
    const weight = weightOf(pattern);
    if (weight > 0 && available.has(pattern)) {
      result.set(pattern, weight / maximum);
      total += weight / maximum;
    }
  }
  for (const [pattern, weight] of result) result.set(pattern, weight / total);
  return result;
}

function distinctPatterns(pool: AgentPool): string[] {
  return [...new Set(pool.patterns)];
}

function roleRule(pool: AgentPool, config: RoutingConfig): RoutingRule | undefined {
  return pool.modelRole ? config.roles.get(pool.modelRole) : undefined;
}

/** What spawns of this agent use without an agent-specific rule. */
function fallbackPolicy(pool: AgentPool, config: RoutingConfig): string {
  const rule = roleRule(pool, config);
  return rule
    ? `role "${plain(pool.modelRole!, 60)}" rule (${rule.mode})`
    : "native omp model order (no routing)";
}

function currentPolicy(pool: AgentPool, config: RoutingConfig): string {
  const agentRule = config.agents.get(pool.name);
  const policy = agentRule ? `agent override (${agentRule.mode})` : fallbackPolicy(pool, config);
  const routed = agentRule || roleRule(pool, config);
  return routed && distinctPatterns(pool).length < 2
    ? `${policy}, inactive until the pool has 2+ models`
    : policy;
}

function poolSummary(pool: AgentPool): string {
  const patterns = distinctPatterns(pool);
  if (patterns.length === 0) return "no native model list";
  if (patterns.length === 1) return "1 model (native pin)";
  const available = patterns.filter((pattern) => pool.available.has(pattern)).length;
  return available === patterns.length
    ? `${patterns.length} models`
    : `${available}/${patterns.length} models available`;
}

async function chooseAgent(
  ui: ExtensionUIContext,
  agents: readonly AgentPool[],
  config: RoutingConfig,
  requestedAgent: string | undefined,
): Promise<AgentPool | undefined> {
  const byName = new Map<string, AgentPool>();
  for (const agent of agents) if (!byName.has(agent.name)) byName.set(agent.name, agent);
  if (byName.size === 0) {
    ui.notify("subagent-entropy: no subagents were discovered for this project.", "warning");
    return undefined;
  }

  const requested = requestedAgent?.trim();
  if (requested) {
    const exact = byName.get(requested);
    if (exact) return exact;
    ui.notify(
      `subagent-entropy: no discovered subagent is named "${plain(requested, 60)}"; choose one below.`,
      "warning",
    );
  }

  const byLabel = new Map<string, AgentPool>();
  const options: ExtensionUISelectOption[] = [];
  for (const agent of byName.values()) {
    const label = `${options.length + 1}. ${literal(agent.name)}`;
    byLabel.set(label, agent);
    const description = plain(agent.description, 90);
    options.push({
      label,
      description: literal(
        `${currentPolicy(agent, config)} · ${poolSummary(agent)}${description ? ` — ${description}` : ""}`,
        200,
      ),
    });
  }
  const choice = await ui.select(
    "Subagent routing: choose agent\n" +
      "Model pools come from native omp settings and are read-only here; this edits routing mode and weights only.",
    options,
  );
  return choice === undefined ? undefined : byLabel.get(choice);
}

async function promptWeight(
  ui: ExtensionUIContext,
  pattern: string,
  current: number,
): Promise<number | undefined> {
  const name = plain(pattern, 80);
  let title = `Weight for ${name} (now ${current}; number ≥ 0, 0 = fallback only)`;
  for (;;) {
    const text = (await ui.input(title))?.trim();
    // Escape or an empty submit keeps the current weight and returns to the editor.
    if (!text) return undefined;
    const weight = parseWeight(text);
    if (weight !== undefined) return weight;
    title = `Invalid weight "${plain(text, 24)}": enter a finite number ≥ 0 (${name} now ${current})`;
  }
}

async function persist(
  ui: ExtensionUIContext,
  save: SaveAgentRule,
  agent: string,
  rule: RoutingRule | undefined,
  success: string,
): Promise<boolean> {
  try {
    await save(agent, rule);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ui.notify(
      `subagent-entropy: could not ${rule ? "save" : "remove"} routing for ${plain(agent, 60)}: ${plain(reason, 300)}. ` +
        "Fix the problem and retry, or Cancel.",
      "error",
    );
    return false;
  }
  ui.notify(
    `subagent-entropy: ${success} Applies from the next subagent spawn; running subagents keep their models.`,
    "info",
  );
  return true;
}

/**
 * Pick one discovered agent and edit its routing rule with the built-in select/input/confirm dialogs.
 * The draft lives in memory until an explicit Save; every cancel path returns false without writing.
 * Returns true only after `save` succeeded for a Save or Remove.
 */
export async function editAgentRouting(
  ui: ExtensionUIContext,
  agents: readonly AgentPool[],
  config: RoutingConfig,
  save: SaveAgentRule,
  requestedAgent?: string,
): Promise<boolean> {
  const pool = await chooseAgent(ui, agents, config, requestedAgent);
  if (!pool) return false;

  const name = plain(pool.name, 80);
  const description = plain(pool.description, 160);
  const patterns = distinctPatterns(pool);
  const editable = patterns.length >= 2;
  const agentRule = config.agents.get(pool.name);
  const source = agentRule ?? roleRule(pool, config);
  const prerequisite =
    `${name} ${patterns.length === 0 ? "has no native model list" : `is pinned to one native model (${plain(patterns[0]!, 80)})`}; ` +
    `routing needs 2+ models. Configure a model list for this agent${pool.modelRole ? ` or its role "${plain(pool.modelRole, 60)}"` : ""} in native omp settings first.`;
  if (!editable && !agentRule) {
    ui.notify(`subagent-entropy: ${prerequisite}`, "warning");
    return false;
  }

  // Seed from the rule spawns use today so unedited effective weights survive creating an override.
  let mode: RoutingMode = source?.mode ?? "random";
  const weights = new Map<string, number>();
  const unused: string[] = [];
  for (const [pattern, weight] of source?.weights ?? []) {
    if (patterns.includes(pattern)) weights.set(pattern, weight);
    else unused.push(`${plain(pattern, 60)}=${weight}`);
  }
  const weightOf = (pattern: string) => weights.get(pattern) ?? 1;
  let dirty = false;
  // Rows keep the same order and count for the whole dialog, so the index restores the cursor.
  let cursor = 0;

  const seed = agentRule
    ? ""
    : source
      ? `, seeded from ${fallbackPolicy(pool, config)}; Save creates it`
      : ", all weights 1; Save creates it";
  for (;;) {
    const share = shares(patterns, weightOf, pool.available);
    const title = [
      `Subagent routing: ${name}`,
      ...(description ? [description] : []),
      `Native model pool (read-only, from omp settings${pool.modelRole ? `, role "${plain(pool.modelRole, 60)}"` : ""}): ${poolSummary(pool)}`,
      `Spawns use now: ${currentPolicy(pool, config)}`,
    ];
    if (editable) {
      title.push(
        `Draft agent override: ${mode}${dirty ? ", unsaved changes" : seed}`,
        "Shares are initial-pick targets over available models with weight > 0; every model stays a retry fallback.",
      );
      if (unused.length > 0) {
        title.push(
          agentRule
            ? `Stale weights not in the native pool (removed on Save): ${unused.join(", ")}`
            : `Role weights not in this pool (left out of the override): ${unused.join(", ")}`,
        );
      }
      if (share.size === 0)
        title.push("No available model has a positive weight: Save is blocked until one does.");
    } else {
      title.push(prerequisite);
    }

    const rows: Row[] = [];
    if (editable) {
      rows.push({ label: `Mode: ${mode}`, description: MODE_HELP[mode], action: { kind: "mode" } });
      for (const pattern of patterns) {
        const weight = weightOf(pattern);
        const pct = share.get(pattern);
        const status = !pool.available.has(pattern)
          ? "UNAVAILABLE, skipped"
          : pct === undefined
            ? "0%, fallback only"
            : `${(pct * 100).toFixed(1)}%`;
        rows.push({
          label: `${rows.length}. ${literal(pattern)} · weight ${weight} · ${status}`,
          action: { kind: "weight", pattern },
        });
      }
      rows.push({
        label: "Save",
        description: "Write this agent override to the project routing file",
        action: { kind: "save" },
      });
    }
    if (agentRule) {
      rows.push({
        label: "Remove agent override",
        description: literal(`Delete this agent's rule; spawns fall back to ${fallbackPolicy(pool, config)}`),
        action: { kind: "remove" },
      });
    }
    rows.push({
      label: "Cancel",
      description: "Discard the draft without writing anything",
      action: { kind: "cancel" },
    });

    const choice = await ui.select(
      title.join("\n"),
      rows.map(({ label, description }) => ({ label, description })),
      { initialIndex: cursor, helpText: "enter edit/choose  esc discard draft" },
    );
    const index = rows.findIndex((row) => row.label === choice);
    if (index >= 0) cursor = index;
    const action: Action = index >= 0 ? rows[index]!.action : { kind: "cancel" };

    switch (action.kind) {
      case "cancel":
        if (dirty) ui.notify(`subagent-entropy: discarded unsaved routing changes for ${name}.`, "info");
        return false;
      case "mode": {
        const picked = await ui.select(`Routing mode: ${name}`, [...MODES], {
          initialIndex: MODES.findIndex((option) => option.label === mode),
        });
        if ((picked === "random" || picked === "round-robin") && picked !== mode) {
          mode = picked;
          dirty = true;
        }
        break;
      }
      case "weight": {
        const weight = await promptWeight(ui, action.pattern, weightOf(action.pattern));
        if (weight !== undefined && weight !== weightOf(action.pattern)) {
          weights.set(action.pattern, weight);
          dirty = true;
        }
        break;
      }
      case "save": {
        if (share.size === 0) {
          ui.notify(
            `subagent-entropy: not saved; give at least one available model of ${name} a weight above 0.`,
            "error",
          );
          break;
        }
        // Missing weight means 1, so only non-default weights are written.
        const saved = new Map<string, number>();
        for (const pattern of patterns) if (weightOf(pattern) !== 1) saved.set(pattern, weightOf(pattern));
        const rule: RoutingRule = saved.size > 0 ? { mode, weights: saved } : { mode };
        if (await persist(ui, save, pool.name, rule, `saved ${mode} routing for ${name}.`)) return true;
        break;
      }
      case "remove": {
        const confirmed = await ui.confirm(
          `Remove agent override for ${name}?`,
          `Spawns of ${name} will fall back to ${fallbackPolicy(pool, config)}.\n` +
            "Role rules and the native model pool are not changed.",
        );
        if (
          confirmed &&
          (await persist(
            ui,
            save,
            pool.name,
            undefined,
            `removed the agent override for ${name}; spawns now use ${fallbackPolicy(pool, config)}.`,
          ))
        ) {
          return true;
        }
        break;
      }
    }
  }
}
