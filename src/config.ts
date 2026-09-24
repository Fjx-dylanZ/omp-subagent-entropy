export type RoutingMode = "random" | "round-robin";

export interface RoutingRule {
  mode: RoutingMode;
  weights?: ReadonlyMap<string, number>;
  /**
   * Agent rules only: an explicit, ordered pool of at least two distinct model selectors that
   * replaces the agent's native model list (including a native single-model pin) for selection
   * and fallback order. Absent means the native list is routed.
   */
  models?: readonly string[];
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

// Each entry is exactly one selector: a comma would read as a list, and controls or line breaks
// could corrupt diagnostics.
const UNSAFE_SELECTOR = /[,\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Returns the pool in configured order; a Set keeps insertion order and gives O(1) membership. */
function modelPool(value: unknown, location: string): ReadonlySet<string> {
  const path = `${location}.models`;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of model selectors`);
  if (value.length < 2) {
    throw new Error(`${path} must list at least two models; remove it to use the native model setting`);
  }
  const pool = new Set<string>();
  for (const [index, selector] of value.entries()) {
    if (typeof selector !== "string" || !selector.trim() || selector !== selector.trim()) {
      throw new Error(`${path}[${index}] must be a nonempty selector with no surrounding whitespace`);
    }
    if (UNSAFE_SELECTOR.test(selector)) {
      throw new Error(`${path}[${index}] must be a single selector without commas or control characters`);
    }
    if (pool.has(selector)) throw new Error(`${path} lists ${JSON.stringify(selector)} more than once`);
    pool.add(selector);
  }
  return pool;
}

function rules(value: unknown, path: "agents" | "roles"): ReadonlyMap<string, RoutingRule> {
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
    if (path === "roles" && Object.hasOwn(rule, "models")) {
      throw new Error(`${location}.models is not allowed: model pools can be set only on agent rules`);
    }
    keys(rule, path === "agents" ? ["mode", "models", "weights"] : ["mode", "weights"], location);
    if (rule.mode !== "random" && rule.mode !== "round-robin") {
      throw new Error(`${location}.mode must be random or round-robin`);
    }
    const models = rule.models === undefined ? undefined : modelPool(rule.models, location);
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
        // An explicit pool is fully known here, so a weight outside it is a contradiction in the file.
        if (models && !models.has(selector)) {
          throw new Error(`${location}.weights[${JSON.stringify(selector)}] is not in ${location}.models`);
        }
        weights.set(selector, weight);
      }
    }
    result.set(
      name,
      models ? { mode: rule.mode, weights, models: [...models] } : { mode: rule.mode, weights },
    );
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
