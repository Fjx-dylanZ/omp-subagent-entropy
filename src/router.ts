import type { RoutingConfig } from "./config";
import { plain } from "./display";

interface Spawn {
  agent: string;
  modelRole?: string;
  patterns: readonly string[];
}

interface Rotation {
  signature: string;
  current: number[];
}

export interface Route {
  model: string[];
  note: string;
}

/** One router per parent session. No asynchronous work occurs while reserving a selection. */
export class ModelRouter {
  private readonly rotations = new Map<string, Rotation>();

  constructor(private readonly random: () => number = Math.random) {}

  route(config: RoutingConfig, spawn: Spawn, available: (selector: string) => boolean): Route | undefined {
    const agentRule = config.agents.get(spawn.agent);
    const rule = agentRule ?? (spawn.modelRole ? config.roles.get(spawn.modelRole) : undefined);
    if (!rule) return undefined;

    // An agent's explicit pool replaces the native list, including a native single-model pin, for both
    // selection and fallback order. Only agent rules may carry one.
    const explicit = agentRule?.models;
    const patterns = [...new Set(explicit ?? spawn.patterns)];
    // Without one, a native single-model override is a pin, not a pool to route.
    if (!explicit && patterns.length < 2) return undefined;

    const ruleKey = agentRule ? `agent:${spawn.agent}` : `role:${spawn.modelRole}`;
    if (rule.weights) {
      for (const selector of rule.weights.keys()) {
        if (!patterns.includes(selector)) {
          throw new Error(
            `${ruleKey}: weighted selector ${JSON.stringify(selector)} is not in the ` +
              `${explicit ? "configured" : "expanded"} model list`,
          );
        }
      }
    }

    const candidates: { selector: string; weight: number }[] = [];
    let maximum = 0;
    for (const selector of patterns) {
      const weight = rule.weights?.get(selector) ?? 1;
      if (weight > 0 && available(selector)) {
        candidates.push({ selector, weight });
        maximum = Math.max(maximum, weight);
      }
    }
    if (candidates.length === 0) {
      throw new Error(`${ruleKey}: no available model has a positive routing weight`);
    }

    // Normalize before summing so even large finite relative weights cannot overflow.
    const weights = candidates.map((candidate) => candidate.weight / maximum);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / total;

    let selected = 0;
    if (rule.mode === "random") {
      const draw = this.random();
      if (!(draw >= 0 && draw < 1)) throw new Error("Random source must return a number in [0, 1)");
      let cumulative = 0;
      selected = candidates.length - 1;
      for (let i = 0; i < weights.length; i++) {
        cumulative += weights[i]!;
        if (draw < cumulative) {
          selected = i;
          break;
        }
      }
    } else {
      const signature = JSON.stringify(candidates.map((candidate, i) => [candidate.selector, weights[i]]));
      let rotation = this.rotations.get(ruleKey);
      if (!rotation || rotation.signature !== signature) {
        rotation = { signature, current: weights.map(() => 0) };
        this.rotations.set(ruleKey, rotation);
      }
      for (let i = 0; i < weights.length; i++) {
        rotation.current[i] = rotation.current[i]! + weights[i]!;
        if (rotation.current[i]! > rotation.current[selected]!) selected = i;
      }
      rotation.current[selected] = rotation.current[selected]! - 1;
    }

    const chosen = candidates[selected]!.selector;
    const share = Math.round(weights[selected]! * 10000) / 100;
    return {
      // Weights govern the starting model, not core retry/fallback policy.
      model: [chosen, ...patterns.filter((pattern) => pattern !== chosen)],
      note: plain(`${rule.mode} ${ruleKey}: ${chosen} (${share}% target share)`, 500),
    };
  }
}
