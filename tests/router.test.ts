import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import { ModelRouter } from "../src/router";

const A = "provider/a:high";
const B = "provider/b:low";
const C = "provider/c";
const spawn = { agent: "reviewer", modelRole: "review", patterns: [A, B, C] };
const available = () => true;

describe("weighted random selection", () => {
  test("honors probability boundaries and preserves selectors and fallback candidates", () => {
    const config = parseConfig({
      agents: { reviewer: { mode: "random", weights: { [A]: 3, [B]: 1, [C]: 0 } } },
    });
    let draw = 0;
    const router = new ModelRouter(() => draw);
    for (const [sample, expected] of [
      [0, A],
      [0.749999, A],
      [0.75, B],
      [0.999999, B],
    ] as const) {
      draw = sample;
      const route = router.route(config, spawn, available)!;
      expect(route.model).toEqual(expected === A ? [A, B, C] : [B, A, C]);
    }
  });

  test("renormalizes over available models without dropping core fallback entries", () => {
    const config = parseConfig({
      roles: { review: { mode: "random", weights: { [A]: 70, [B]: 20, [C]: 10 } } },
    });
    let draw = 0.66;
    const router = new ModelRouter(() => draw);
    expect(router.route(config, spawn, (selector) => selector !== A)!.model).toEqual([B, A, C]);
    draw = 0.67;
    expect(router.route(config, spawn, (selector) => selector !== A)!.model).toEqual([C, A, B]);
  });

  test("large finite weights do not overflow their probability sum", () => {
    const config = parseConfig({
      agents: { reviewer: { mode: "random", weights: { [A]: 1e308, [B]: 1e308, [C]: 0 } } },
    });
    const router = new ModelRouter(() => 0.75);
    expect(router.route(config, spawn, available)!.model[0]).toBe(B);
  });

  test("refuses to silently use core routing when no eligible model exists", () => {
    const empty = parseConfig({
      agents: { reviewer: { mode: "random", weights: { [A]: 0, [B]: 0, [C]: 0 } } },
    });
    const unavailable = parseConfig({ roles: { review: { mode: "random" } } });
    const router = new ModelRouter();
    expect(() => router.route(empty, spawn, available)).toThrow(/positive routing weight/);
    expect(() => router.route(unavailable, spawn, () => false)).toThrow(/positive routing weight/);
  });
});

describe("weighted round-robin", () => {
  test("alternates equal-weight candidates once per invocation", () => {
    const config = parseConfig({ roles: { review: { mode: "round-robin" } } });
    const router = new ModelRouter();
    const pool = { ...spawn, patterns: [A, B] };
    const selected = Array.from({ length: 6 }, () => router.route(config, pool, available)!.model[0]);
    expect(selected).toEqual([A, B, A, B, A, B]);
  });

  test("shares a role's 3:1 allocation across different agent names", () => {
    const config = parseConfig({
      roles: { review: { mode: "round-robin", weights: { [A]: 3, [B]: 1, [C]: 0 } } },
    });
    const router = new ModelRouter();
    for (let cycle = 0; cycle < 10; cycle++) {
      const selected = Array.from(
        { length: 4 },
        (_, i) => router.route(config, { ...spawn, agent: `worker-${i}` }, available)!.model[0],
      );
      expect(selected.filter((model) => model === A)).toHaveLength(3);
      expect(selected.filter((model) => model === B)).toHaveLength(1);
    }
  });

  test("agent-specific allocation takes precedence and does not advance the role's rotation", () => {
    const config = parseConfig({
      roles: { review: { mode: "round-robin" } },
      agents: { reviewer: { mode: "random", weights: { [A]: 0, [B]: 1 } } },
    });
    const router = new ModelRouter(() => 0);
    const pool = { ...spawn, patterns: [A, B] };
    expect(router.route(config, pool, available)!.model[0]).toBe(B);
    expect(router.route(config, { ...pool, agent: "second" }, available)!.model[0]).toBe(A);
    expect(router.route(config, pool, available)!.model[0]).toBe(B);
    expect(router.route(config, { ...pool, agent: "second" }, available)!.model[0]).toBe(B);
  });

  test("resets balances when the available pool changes", () => {
    const config = parseConfig({ roles: { review: { mode: "round-robin" } } });
    const router = new ModelRouter();
    const pool = { ...spawn, patterns: [A, B] };
    expect(router.route(config, pool, available)!.model[0]).toBe(A);
    expect(router.route(config, pool, (selector) => selector === B)!.model[0]).toBe(B);
    expect(router.route(config, pool, available)!.model[0]).toBe(A);
  });

  test("resets balances when configured proportions change", () => {
    const equal = parseConfig({ roles: { review: { mode: "round-robin" } } });
    const weighted = parseConfig({ roles: { review: { mode: "round-robin", weights: { [A]: 3, [B]: 1 } } } });
    const router = new ModelRouter();
    const pool = { ...spawn, patterns: [A, B] };
    expect(router.route(equal, pool, available)!.model[0]).toBe(A);
    expect(router.route(weighted, pool, available)!.model[0]).toBe(A);
  });
});

test("unmatched agents and explicit single-model pins retain native behavior", () => {
  const config = parseConfig({ agents: { reviewer: { mode: "random", weights: { [A]: 3, [B]: 1 } } } });
  const router = new ModelRouter(() => {
    throw new Error("Must not draw for native routing");
  });
  expect(router.route(config, { ...spawn, agent: "unmatched" }, available)).toBeUndefined();
  expect(router.route(config, { ...spawn, patterns: [C] }, available)).toBeUndefined();
});

test("a misspelled weight selector fails rather than silently changing probabilities", () => {
  const config = parseConfig({ roles: { review: { mode: "random", weights: { "provider/typo": 9 } } } });
  expect(() => new ModelRouter().route(config, spawn, available)).toThrow(/not in the expanded model list/);
});

test("routing annotations cannot inject terminal controls or alter model selectors", () => {
  const name = "reviewer\u001b[31m\nunsafe";
  const config = parseConfig({ agents: { [name]: { mode: "random" } } });
  const route = new ModelRouter(() => 0).route(config, { ...spawn, agent: name }, available)!;
  expect(route.note).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(route.model).toEqual([A, B, C]);
});

describe("explicit agent model pools", () => {
  const X = "openai/x:high";
  const Y = "anthropic/y";
  const Z = "google/z:low";

  test("replace the native list, including a single-model pin, for selection and fallback", () => {
    const config = parseConfig({ agents: { reviewer: { mode: "round-robin", models: [X, Y] } } });
    for (const patterns of [[C], [A, B, C], []]) {
      const router = new ModelRouter();
      const native = { ...spawn, patterns };
      const routes = Array.from({ length: 4 }, () => router.route(config, native, available)!.model);
      expect(routes).toEqual([
        [X, Y],
        [Y, X],
        [X, Y],
        [Y, X],
      ]);
    }
  });

  test("weights select within the pool and fallback keeps every entry in configured order", () => {
    const config = parseConfig({
      agents: { reviewer: { mode: "random", models: [X, Y, Z], weights: { [X]: 3, [Y]: 1, [Z]: 0 } } },
    });
    let draw = 0;
    const router = new ModelRouter(() => draw);
    const pinned = { ...spawn, patterns: [C] };
    for (const [sample, expected] of [
      [0, [X, Y, Z]],
      [0.749999, [X, Y, Z]],
      [0.75, [Y, X, Z]],
      [0.999999, [Y, X, Z]],
    ] as const) {
      draw = sample;
      expect(router.route(config, pinned, available)!.model).toEqual([...expected]);
    }
    draw = 0;
    expect(router.route(config, pinned, (selector) => selector !== X)!.model).toEqual([Y, X, Z]);
  });

  test("a pool with no available positive-weight model blocks instead of using the native model", () => {
    const zero = parseConfig({
      agents: { reviewer: { mode: "random", models: [X, Y], weights: { [X]: 0, [Y]: 0 } } },
    });
    const pool = parseConfig({ agents: { reviewer: { mode: "round-robin", models: [X, Y] } } });
    const pinned = { ...spawn, patterns: [C] };
    const router = new ModelRouter(() => 0);
    expect(() => router.route(zero, pinned, available)).toThrow(/positive routing weight/);
    expect(() => router.route(pool, pinned, (selector) => selector === C)).toThrow(/positive routing weight/);
  });

  test("an agent's pool does not apply to other agents sharing its role", () => {
    const config = parseConfig({
      roles: { review: { mode: "round-robin" } },
      agents: { reviewer: { mode: "round-robin", models: [X, Y] } },
    });
    const router = new ModelRouter();
    const sibling = { ...spawn, agent: "auditor" };
    expect(router.route(config, sibling, available)!.model).toEqual([A, B, C]);
    expect(router.route(config, spawn, available)!.model).toEqual([X, Y]);
    expect(router.route(config, sibling, available)!.model).toEqual([B, A, C]);
    expect(router.route(config, { ...sibling, patterns: [C] }, available)).toBeUndefined();
  });
});

describe("routing configuration", () => {
  test("rejects invalid probabilities, modes, and ambiguous configuration", () => {
    for (const weight of [-1, Infinity, NaN, "3", null]) {
      expect(() =>
        parseConfig({ roles: { review: { mode: "random", weights: { [A]: weight } } } }),
      ).toThrow();
    }
    for (const value of [
      [],
      null,
      { role: {} },
      { roles: { "@review": { mode: "random" } } },
      { agents: { reviewer: { mode: "roundrobin" } } },
      { agents: { reviewer: { mode: "random", probability: 0.5 } } },
    ])
      expect(() => parseConfig(value)).toThrow();
  });

  test("keeps an agent model pool verbatim and in configured order", () => {
    const models = [B, A, "sonnet"];
    const config = parseConfig({
      agents: { reviewer: { mode: "random", models, weights: { [A]: 2 } }, planner: { mode: "random" } },
    });
    expect(config.agents.get("reviewer")?.models).toEqual(models);
    expect(config.agents.get("planner")?.models).toBeUndefined();
  });

  test("rejects malformed model pools, weights outside a pool, and pools on role rules", () => {
    const agent = (models: unknown, weights?: Record<string, number>) => ({
      agents: { reviewer: { mode: "random", models, ...(weights && { weights }) } },
    });
    for (const models of [
      `${A},${B}`,
      { 0: A, 1: B },
      null,
      [],
      [A],
      [A, A],
      [A, 3],
      [A, null],
      [A, ""],
      [A, " "],
      [A, ` ${B}`],
      [A, `${B}\n`],
      [A, `${B},${C}`],
      [A, `provider/\u001b[31mb`],
      [A, "provider/b\u0085"],
    ]) {
      expect(() => parseConfig(agent(models))).toThrow();
    }
    expect(() => parseConfig(agent([A, B], { [C]: 1 }))).toThrow();
    expect(() => parseConfig({ roles: { review: { mode: "random", models: [A, B] } } })).toThrow();
  });
});
