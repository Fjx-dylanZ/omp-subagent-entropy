export type RoutingMode = "random" | "round-robin";

export interface RoutingRule {
  mode: RoutingMode;
  weights?: ReadonlyMap<string, number>;
}

export interface RoutingConfig {
  agents: ReadonlyMap<string, RoutingRule>;
  roles: ReadonlyMap<string, RoutingRule>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown setting ${path}.${key}`);
  }
}

function rules(value: unknown, path: string): ReadonlyMap<string, RoutingRule> {
  const result = new Map<string, RoutingRule>();
  if (value === undefined) return result;
  for (const [name, raw] of Object.entries(object(value, path))) {
    if (!name.trim() || name !== name.trim()) {
      throw new Error(`${path} names must be nonempty and have no surrounding whitespace`);
    }
    if (path === "roles" && name.startsWith("@")) {
      throw new Error(`Use role name ${name.slice(1)}, not ${name}, in roles`);
    }
    const location = `${path}.${name}`;
    const rule = object(raw, location);
    keys(rule, ["mode", "weights"], location);
    if (rule.mode !== "random" && rule.mode !== "round-robin") {
      throw new Error(`${location}.mode must be random or round-robin`);
    }
    let weights: Map<string, number> | undefined;
    if (rule.weights !== undefined) {
      weights = new Map();
      for (const [selector, weight] of Object.entries(object(rule.weights, `${location}.weights`))) {
        if (!selector.trim() || selector !== selector.trim()) {
          throw new Error(`${location}.weights selectors must be nonempty with no surrounding whitespace`);
        }
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
          throw new Error(
            `${location}.weights[${JSON.stringify(selector)}] must be a finite nonnegative number`,
          );
        }
        weights.set(selector, weight);
      }
    }
    result.set(name, { mode: rule.mode, weights });
  }
  return result;
}

export function parseConfig(value: unknown): RoutingConfig {
  const root = object(value, "config");
  keys(root, ["agents", "roles"], "config");
  return {
    agents: rules(root.agents, "agents"),
    roles: rules(root.roles, "roles"),
  };
}
