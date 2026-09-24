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
  /** Native candidates and saved explicit-pool selectors that currently resolve to a usable model. */
  available: ReadonlySet<string>;
}

/** One chat model that can be added to an explicit agent pool. */
export interface AvailableModel {
  /** Concrete `provider/model` selector, saved verbatim into the pool. */
  selector: string;
  /** Display name shown next to the selector. */
  name: string;
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
  | { kind: "pool" }
  | { kind: "native" }
  | { kind: "weight"; pattern: string }
  | { kind: "save" }
  | { kind: "remove" }
  | { kind: "cancel" };

interface Row extends ExtensionUISelectOption {
  action: Action;
}

/** Stable identity of an editor row across redraws whose rows come and go. */
function rowKey(action: Action): string {
  return action.kind === "weight" ? `weight:${action.pattern}` : action.kind;
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
  usable: (pattern: string) => boolean,
) {
  const result = new Map<string, number>();
  let maximum = 0;
  for (const pattern of patterns) {
    const weight = weightOf(pattern);
    if (weight > 0 && usable(pattern)) maximum = Math.max(maximum, weight);
  }
  if (maximum === 0) return result;
  let total = 0;
  for (const pattern of patterns) {
    const weight = weightOf(pattern);
    if (weight > 0 && usable(pattern)) {
      result.set(pattern, weight / maximum);
      total += weight / maximum;
    }
  }
  for (const [pattern, weight] of result) result.set(pattern, weight / total);
  return result;
}

function distinct(patterns: readonly string[]): string[] {
  return [...new Set(patterns)];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function roleRule(pool: AgentPool, config: RoutingConfig): RoutingRule | undefined {
  return pool.modelRole ? config.roles.get(pool.modelRole) : undefined;
}

/** What spawns of this agent use without an agent-specific rule. */
function fallbackPolicy(pool: AgentPool, config: RoutingConfig): string {
  const rule = roleRule(pool, config);
  return rule
    ? `role "${plain(pool.modelRole!, 60)}" rule (${rule.mode}) over the native model pool`
    : "native omp model order (no routing)";
}

function currentPolicy(pool: AgentPool, config: RoutingConfig): string {
  const agentRule = config.agents.get(pool.name);
  if (agentRule?.models) return `agent override (${agentRule.mode}) over its custom model pool`;
  const policy = agentRule ? `agent override (${agentRule.mode})` : fallbackPolicy(pool, config);
  const routed = agentRule || roleRule(pool, config);
  return routed && distinct(pool.patterns).length < 2
    ? `${policy}, inactive until the pool has 2+ models`
    : policy;
}

function countSummary(patterns: readonly string[], usable: (pattern: string) => boolean): string {
  const available = patterns.filter(usable).length;
  return available === patterns.length
    ? plural(patterns.length, "model")
    : `${available}/${patterns.length} models available`;
}

function nativeSummary(pool: AgentPool): string {
  const patterns = distinct(pool.patterns);
  if (patterns.length === 0) return "no native model list";
  if (patterns.length === 1) return `1 model (native pin: ${plain(patterns[0]!, 80)})`;
  return countSummary(patterns, (pattern) => pool.available.has(pattern));
}

/** The pool spawns route today: a saved custom agent pool, else the native one. */
function poolSummary(pool: AgentPool, config: RoutingConfig): string {
  const models = config.agents.get(pool.name)?.models;
  if (!models) return nativeSummary(pool);
  const custom = countSummary(distinct(models), (pattern) => pool.available.has(pattern));
  return `custom pool of ${custom} (native: ${nativeSummary(pool)})`;
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
        `${currentPolicy(agent, config)} · ${poolSummary(agent, config)}${description ? ` — ${description}` : ""}`,
        240,
      ),
    });
  }
  const choice = await ui.select(
    "Subagent routing: choose agent\n" +
      "Native model pools come from omp settings and are never modified here; an agent override can route its own model pool.",
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

function preview(selected: readonly string[]): string {
  if (selected.length === 0) return "none";
  const shown = selected.slice(0, 6).map((pattern, i) => `${i + 1}. ${plain(pattern, 60)}`);
  return `${shown.join(", ")}${selected.length > shown.length ? `, +${selected.length - shown.length} more` : ""}`;
}

/**
 * Toggle pool members with the built-in selector. Rows stay fixed for the whole dialog: Done and Cancel on
 * top, then the current members in pool order, then catalog models that could be added. Every model row
 * starts with a unique number so truncated or escaped labels cannot select another model.
 * Resolves the new ordered pool only when Done accepts a changed selection of 2+ models; Cancel, Esc,
 * or an unchanged Done resolve undefined and leave the caller's draft untouched.
 */
async function editPool(
  ui: ExtensionUIContext,
  agent: string,
  current: readonly string[],
  native: readonly string[],
  names: ReadonlyMap<string, string>,
  usable: (pattern: string) => boolean,
): Promise<string[] | undefined> {
  const universe = distinct([...current, ...names.keys()]);
  const selected = [...current];
  const start = JSON.stringify(current);
  const changed = () => JSON.stringify(selected) !== start;
  const fixed = 2;
  if (names.size === 0) {
    ui.notify(
      "subagent-entropy: no chat models are available to add. Log in to a provider or configure models in omp, " +
        "then reopen /subagent-entropy. You can still remove models here or use the native model pool.",
      "warning",
    );
  }
  // Start on the first model that can be added; with none, on Done.
  let cursor = universe.length > current.length ? fixed + current.length : 0;

  for (;;) {
    const title = [
      `Model pool: ${agent}`,
      `Selected ${selected.length} (pool and fallback order): ${preview(selected)}`,
      "Enter toggles a model. Done keeps the selection (2+ models); Cancel or Esc keeps the previous pool.",
    ];
    if (names.size === 0) title.push("Adding is unavailable: omp lists no available chat models.");
    const rows: ExtensionUISelectOption[] = [
      {
        label: "Done",
        description: `Keep these ${plural(selected.length, "model")} and return to the routing editor`,
      },
      { label: "Cancel", description: "Discard picker changes and return to the routing editor" },
    ];
    universe.forEach((pattern, i) => {
      const member = selected.includes(pattern);
      const name = names.get(pattern);
      const origin = native.includes(pattern)
        ? name === undefined
          ? "native omp pattern, not in the model catalog"
          : "native omp model"
        : name === undefined
          ? "saved selector, not in the model catalog"
          : "catalog model";
      rows.push({
        label:
          `${i + 1}. ${member ? "selected" : "add"} - ${literal(pattern, 100)}` +
          (name && name !== pattern ? ` · ${literal(name, 60)}` : ""),
        description: literal(
          `${origin}${usable(pattern) ? "" : ", UNAVAILABLE (skipped by routing)"} · enter to ${member ? "remove" : "add"}`,
        ),
      });
    });

    const choice = await ui.select(title.join("\n"), rows, {
      initialIndex: cursor,
      helpText: "enter toggle/choose  esc keep previous pool",
    });
    const index = rows.findIndex((row) => row.label === choice);
    if (index < 0 || index === 1) {
      if (changed()) {
        ui.notify(
          `subagent-entropy: discarded model pool changes for ${agent}; the previous pool is kept.`,
          "info",
        );
      }
      return undefined;
    }
    cursor = index;
    if (index === 0) {
      if (!changed()) return undefined;
      if (selected.length >= 2) return selected;
      ui.notify(
        `subagent-entropy: a custom model pool needs 2+ models (${selected.length} selected). ` +
          "Add models, Cancel to keep the previous pool, or choose Use native model pool in the routing editor.",
        "error",
      );
      continue;
    }
    const pattern = universe[index - fixed]!;
    const at = selected.indexOf(pattern);
    if (at >= 0) selected.splice(at, 1);
    else selected.push(pattern);
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
 * Pick one discovered agent and edit its routing rule (model pool, mode, weights) with the built-in
 * select/input/confirm dialogs. `catalog` lists the chat models that can be added to a custom pool.
 * The draft lives in memory until an explicit Save; every cancel path returns false without writing.
 * Returns true only after `save` succeeded for a Save or Remove.
 */
export async function editAgentRouting(
  ui: ExtensionUIContext,
  agents: readonly AgentPool[],
  config: RoutingConfig,
  catalog: readonly AvailableModel[],
  save: SaveAgentRule,
  requestedAgent?: string,
): Promise<boolean> {
  const pool = await chooseAgent(ui, agents, config, requestedAgent);
  if (!pool) return false;

  const name = plain(pool.name, 80);
  const description = plain(pool.description, 160);
  const native = distinct(pool.patterns);
  const agentRule = config.agents.get(pool.name);
  const savedPool = agentRule?.models ? distinct(agentRule.models) : undefined;
  const source = agentRule ?? roleRule(pool, config);
  const names = new Map<string, string>();
  for (const model of catalog) if (!names.has(model.selector)) names.set(model.selector, model.name);
  const usable = (pattern: string) => pool.available.has(pattern) || names.has(pattern);
  const pinned =
    native.length === 0
      ? `${name} has no native model list`
      : `${name} is pinned to one native model (${plain(native[0]!, 80)})`;

  // Draft state. An undefined custom pool routes the native list; only Save writes anything.
  let mode: RoutingMode = source?.mode ?? "random";
  let custom: string[] | undefined = savedPool && [...savedPool];
  const members = () => custom ?? native;
  // Seed from the rule spawns use today so unedited effective weights survive creating an override.
  const weights = new Map<string, number>();
  for (const [pattern, weight] of source?.weights ?? []) {
    if (members().includes(pattern)) weights.set(pattern, weight);
  }
  const weightOf = (pattern: string) => weights.get(pattern) ?? 1;
  // Retained members keep their weights, removed ones drop theirs, and new members start at 1.
  const rebase = () => {
    for (const pattern of weights.keys()) if (!members().includes(pattern)) weights.delete(pattern);
  };
  const snapshot = () => JSON.stringify([mode, custom ?? null, members().map(weightOf)]);
  const initial = snapshot();

  const seed = agentRule
    ? ""
    : source
      ? `, seeded from ${fallbackPolicy(pool, config)}; Save creates it`
      : ", all weights 1; Save creates it";
  let focus = !custom && native.length < 2 ? "pool" : "mode";

  for (;;) {
    const list = members();
    const share = shares(list, weightOf, usable);
    const dirty = snapshot() !== initial;
    // Without a custom pool, fewer than 2 native models is a native pin that routing never touches.
    const nativePin = !custom && native.length < 2;
    const unused = [...(source?.weights ?? [])]
      .filter(([pattern]) => !list.includes(pattern))
      .map(([pattern, weight]) => `${plain(pattern, 60)}=${weight}`);

    const title = [
      `Subagent routing: ${name}`,
      ...(description ? [description] : []),
      `Native model pool (omp settings, never modified here${pool.modelRole ? `; role "${plain(pool.modelRole, 60)}"` : ""}): ${nativeSummary(pool)}`,
      custom
        ? `Routing pool: custom agent pool of ${countSummary(custom, usable)}, replacing the native pool` +
          (JSON.stringify(custom) === JSON.stringify(savedPool) ? "" : " (unsaved)")
        : `Routing pool: native model pool${savedPool ? " (unsaved: Save drops the custom pool)" : ""}`,
      `Spawns use now: ${currentPolicy(pool, config)}`,
      `Draft agent override: ${mode}${dirty ? ", unsaved changes" : seed}`,
    ];
    if (nativePin && !savedPool) {
      title.push(`Routing needs 2+ models: ${pinned}. Choose Edit model pool to add models for this agent.`);
    } else if (nativePin) {
      title.push(
        `Save keeps this override without a custom pool, inactive: ${pinned}, so native omp selection applies. ` +
          "Remove agent override deletes the rule instead.",
      );
    } else {
      title.push(
        "Shares are initial-pick targets over available models with weight > 0; every model stays a retry fallback.",
      );
      if (share.size === 0) {
        title.push("No available model has a positive weight: Save is blocked until one does.");
      }
    }
    if (unused.length > 0) {
      title.push(
        agentRule
          ? `Saved weights not in the routing pool (dropped on Save): ${unused.join(", ")}`
          : `Role weights not in this pool (left out of the override): ${unused.join(", ")}`,
      );
    }

    const rows: Row[] = [
      { label: `Mode: ${mode}`, description: MODE_HELP[mode], action: { kind: "mode" } },
      {
        label: "Edit model pool",
        description: literal(
          `${custom ? "Custom" : "Native"} pool, ${plural(list.length, "model")}; add catalog models or remove models`,
        ),
        action: { kind: "pool" },
      },
    ];
    if (custom) {
      rows.push({
        label: "Use native model pool",
        description: literal(`Drop the custom pool and route the native one (${nativeSummary(pool)})`),
        action: { kind: "native" },
      });
    }
    list.forEach((pattern, i) => {
      const weight = weightOf(pattern);
      const pct = share.get(pattern);
      const status = nativePin
        ? "native pin, not routed"
        : !usable(pattern)
          ? "UNAVAILABLE, skipped"
          : pct === undefined
            ? "0%, fallback only"
            : `${(pct * 100).toFixed(1)}%`;
      const origin =
        names.get(pattern) ?? (native.includes(pattern) ? "native omp pattern" : "saved selector");
      rows.push({
        label: `${i + 1}. ${literal(pattern)} · weight ${weight} · ${status}`,
        description: literal(`${origin}; enter to change weight`, 120),
        action: { kind: "weight", pattern },
      });
    });
    rows.push({
      label: "Save",
      description: `Write this agent override${custom ? " with its model pool" : ""} to the project routing file`,
      action: { kind: "save" },
    });
    if (agentRule) {
      rows.push({
        label: "Remove agent override",
        description: literal(
          `Delete this agent's rule${savedPool ? " and its custom pool" : ""}; spawns fall back to ${fallbackPolicy(pool, config)}`,
        ),
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
      {
        initialIndex: Math.max(
          0,
          rows.findIndex((row) => rowKey(row.action) === focus),
        ),
        helpText: "enter edit/choose  esc discard draft",
      },
    );
    const picked = rows.find((row) => row.label === choice);
    const action: Action = picked?.action ?? { kind: "cancel" };
    focus = rowKey(action);

    switch (action.kind) {
      case "cancel":
        if (dirty) ui.notify(`subagent-entropy: discarded unsaved routing changes for ${name}.`, "info");
        return false;
      case "mode": {
        const next = await ui.select(`Routing mode: ${name}`, [...MODES], {
          initialIndex: MODES.findIndex((option) => option.label === mode),
        });
        if (next === "random" || next === "round-robin") mode = next;
        break;
      }
      case "pool": {
        const next = await editPool(ui, name, list, native, names, usable);
        if (next) {
          custom = next;
          rebase();
        }
        break;
      }
      case "native":
        custom = undefined;
        rebase();
        focus = "pool";
        break;
      case "weight": {
        const weight = await promptWeight(ui, action.pattern, weightOf(action.pattern));
        if (weight !== undefined) weights.set(action.pattern, weight);
        break;
      }
      case "save": {
        if (nativePin && !savedPool) {
          ui.notify(
            `subagent-entropy: not saved; ${pinned}. Choose Edit model pool and select 2+ models to route.`,
            "error",
          );
          focus = "pool";
          break;
        }
        // Restoring a native pin skips the weight check: native selection ignores routing weights.
        if (!nativePin && share.size === 0) {
          ui.notify(
            `subagent-entropy: not saved; give at least one available model of ${name} a weight above 0.`,
            "error",
          );
          break;
        }
        // Missing weight means 1, so only non-default weights of current members are written.
        const saved = new Map<string, number>();
        for (const pattern of list) if (weightOf(pattern) !== 1) saved.set(pattern, weightOf(pattern));
        const rule: RoutingRule = {
          mode,
          ...(custom ? { models: [...custom] } : {}),
          ...(saved.size > 0 ? { weights: saved } : {}),
        };
        const success = custom
          ? `saved ${mode} routing for ${name} over a custom pool of ${plural(custom.length, "model")}.`
          : nativePin
            ? `saved ${mode} routing for ${name} without a custom pool; ${pinned}, so native omp selection applies.`
            : `saved ${mode} routing for ${name} over the native model pool.`;
        if (await persist(ui, save, pool.name, rule, success)) return true;
        break;
      }
      case "remove": {
        const confirmed = await ui.confirm(
          `Remove agent override for ${name}?`,
          `Spawns of ${name} will fall back to ${fallbackPolicy(pool, config)}.\n` +
            `${savedPool ? "Its custom model pool, mode, and weights are deleted. " : ""}` +
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
