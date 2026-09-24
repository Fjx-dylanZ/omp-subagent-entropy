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
});
