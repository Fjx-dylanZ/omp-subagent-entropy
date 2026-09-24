import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RoutingMode, RoutingRule } from "../src/config";
import { readRoutingDocument, RoutingConflictError, saveAgentRule, writeFileAtomic } from "../src/store";

const A = "provider/a:high";
const B = "provider/b:low";
const C = "provider/c";

let base: string;
let project: string;
let file: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "entropy-store-"));
  project = join(base, "project");
  mkdirSync(project);
  file = join(project, ".omp", "subagent-entropy.json");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function rule(mode: RoutingMode, weights?: Record<string, number>, models?: string[]): RoutingRule {
  return { mode, weights: weights && new Map(Object.entries(weights)), models };
}

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const onDisk = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const roles = { review: { mode: "random", weights: { [A]: 3, [B]: 1 } } };
const planner = { mode: "round-robin", weights: { [A]: 2 } };

describe("saving an agent rule", () => {
  test("replaces only that agent, keeping role rules and other agents", () => {
    put(file, { agents: { reviewer: { mode: "random" }, planner }, roles });
    const saved = saveAgentRule(
      file,
      readRoutingDocument(file, false),
      "reviewer",
      rule("round-robin", { [A]: 0, [B]: 5 }),
      project,
    );

    expect(onDisk(file)).toEqual({
      agents: { reviewer: { mode: "round-robin", weights: { [A]: 0, [B]: 5 } }, planner },
      roles,
    });
    expect(readRoutingDocument(file, false).config).toEqual(saved.config);
    expect(readdirSync(dirname(file))).toEqual(["subagent-entropy.json"]);
  });

  test("creates a missing default file privately, and keeps an existing file's permissions", () => {
    const empty = readRoutingDocument(file, true);
    expect(empty.config.agents.size + empty.config.roles.size).toBe(0);

    const first = saveAgentRule(file, empty, "reviewer", rule("random", { [A]: 3 }), project);
    expect(onDisk(file)).toEqual({ agents: { reviewer: { mode: "random", weights: { [A]: 3 } } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    chmodSync(file, 0o640);
    saveAgentRule(file, first, "planner", rule("round-robin"), project);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("merges edits made elsewhere to other agents and roles while the draft was open", () => {
    put(file, { agents: { reviewer: { mode: "random" } }, roles });
    const snapshot = readRoutingDocument(file, false);
    const external = {
      agents: { reviewer: { mode: "random" }, planner },
      roles: { review: { mode: "round-robin" }, plan: { mode: "random", weights: { [B]: 4 } } },
    };
    put(file, external);

    const saved = saveAgentRule(file, snapshot, "reviewer", rule("random", { [B]: 7 }), project);
    expect(onDisk(file)).toEqual({
      agents: { reviewer: { mode: "random", weights: { [B]: 7 } }, planner },
      roles: external.roles,
    });
    expect(saved.config).toEqual(readRoutingDocument(file, false).config);
  });

  test("refuses a same-agent change made elsewhere, but accepts saves chained from the returned document", () => {
    put(file, { agents: { reviewer: { mode: "random", weights: { [A]: 1 } } }, roles });
    const original = readRoutingDocument(file, false);

    const saved = saveAgentRule(file, original, "reviewer", rule("random", { [A]: 2 }), project);
    saveAgentRule(file, saved, "reviewer", rule("round-robin", { [A]: 3 }), project);
    const current = readFileSync(file, "utf8");
    expect(() => saveAgentRule(file, original, "reviewer", rule("random", { [A]: 9 }), project)).toThrow(
      RoutingConflictError,
    );
    expect(readFileSync(file, "utf8")).toBe(current);
  });

  test("treats removal or creation of the same agent elsewhere as a conflict", () => {
    put(file, { agents: { reviewer: { mode: "random" } }, roles });
    const had = readRoutingDocument(file, false);
    put(file, { roles });
    const removed = readFileSync(file, "utf8");
    expect(() => saveAgentRule(file, had, "reviewer", rule("random", { [B]: 1 }), project)).toThrow(
      RoutingConflictError,
    );
    expect(readFileSync(file, "utf8")).toBe(removed);

    rmSync(file);
    const lacked = readRoutingDocument(file, true);
    put(file, { agents: { reviewer: { mode: "random" } } });
    const created = readFileSync(file, "utf8");
    expect(() => saveAgentRule(file, lacked, "reviewer", undefined, project)).toThrow(RoutingConflictError);
    expect(() => saveAgentRule(file, lacked, "reviewer", rule("round-robin"), project)).toThrow(
      RoutingConflictError,
    );
    expect(readFileSync(file, "utf8")).toBe(created);
  });

  test("never overwrites malformed or invalid configuration", () => {
    put(file, { agents: { planner } });
    const snapshot = readRoutingDocument(file, false);
    for (const text of ['{"agents": {', "", '{"agents":{"planner":{"mode":"weighted"}}}', '{"agent":{}}']) {
      put(file, text);
      expect(() => readRoutingDocument(file, true)).toThrow();
      expect(() => saveAgentRule(file, snapshot, "reviewer", rule("random"), project)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  test("an explicitly selected missing file is an error", () => {
    expect(() => readRoutingDocument(file, false)).toThrow();
  });

  test("rejects invalid rules before touching disk", () => {
    put(file, { agents: { planner } });
    const text = readFileSync(file, "utf8");
    const snapshot = readRoutingDocument(file, false);
    expect(() => saveAgentRule(file, snapshot, "reviewer", rule("random", { [A]: -1 }), project)).toThrow();
    expect(() => saveAgentRule(file, snapshot, " reviewer", rule("random"), project)).toThrow();
    for (const invalid of [
      rule("random", undefined, [A]),
      rule("random", undefined, [A, `${B},${C}`]),
      rule("random", { [C]: 1 }, [A, B]),
    ]) {
      expect(() => saveAgentRule(file, snapshot, "reviewer", invalid, project)).toThrow();
    }
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe("agent model pools", () => {
  test("round-trip in order, and a rule without models drops the pool while other rules are kept", () => {
    put(file, { agents: { reviewer: { mode: "random", weights: { [A]: 3 } }, planner }, roles });
    const pooled = saveAgentRule(
      file,
      readRoutingDocument(file, false),
      "reviewer",
      rule("round-robin", { [C]: 2 }, [C, A]),
      project,
    );
    expect(onDisk(file)).toEqual({
      agents: { reviewer: { mode: "round-robin", models: [C, A], weights: { [C]: 2 } }, planner },
      roles,
    });
    expect(pooled.config).toEqual(readRoutingDocument(file, false).config);
    expect(pooled.config.agents.get("reviewer")?.models).toEqual([C, A]);

    const native = saveAgentRule(file, pooled, "reviewer", rule("round-robin", { [A]: 3 }), project);
    expect(onDisk(file)).toEqual({
      agents: { reviewer: { mode: "round-robin", weights: { [A]: 3 } }, planner },
      roles,
    });
    expect(native.config.agents.get("reviewer")?.models).toBeUndefined();
  });

  test("removing a pooled agent's override removes its pool and keeps other rules", () => {
    put(file, {
      agents: { reviewer: { mode: "random", models: [A, B], weights: { [B]: 2 } }, planner },
      roles,
    });
    const removed = saveAgentRule(file, readRoutingDocument(file, false), "reviewer", undefined, project);
    expect(onDisk(file)).toEqual({ agents: { planner }, roles });
    expect(removed.config.agents.has("reviewer")).toBe(false);
  });

  test("pool order is part of the rule: a reorder is saved, and one made elsewhere is a conflict", () => {
    put(file, { agents: { reviewer: { mode: "random", models: [A, B] } }, roles });
    const snapshot = readRoutingDocument(file, false);
    saveAgentRule(file, snapshot, "reviewer", rule("random", undefined, [B, A]), project);
    expect(onDisk(file)).toEqual({ agents: { reviewer: { mode: "random", models: [B, A] } }, roles });

    const reordered = readFileSync(file, "utf8");
    const stale = rule("round-robin", undefined, [A, B]);
    expect(() => saveAgentRule(file, snapshot, "reviewer", stale, project)).toThrow(RoutingConflictError);
    expect(readFileSync(file, "utf8")).toBe(reordered);

    put(file, { agents: { reviewer: { mode: "random" } } });
    const unpooled = readRoutingDocument(file, false);
    put(file, { agents: { reviewer: { mode: "random", models: [A, B] } } });
    const pooledElsewhere = readFileSync(file, "utf8");
    expect(() => saveAgentRule(file, unpooled, "reviewer", rule("round-robin"), project)).toThrow(
      RoutingConflictError,
    );
    expect(readFileSync(file, "utf8")).toBe(pooledElsewhere);
  });
});

describe("bounded configuration reads", () => {
  test("accepts a regular configuration at the limit and refuses oversized reads and saves", () => {
    const content = JSON.stringify({ agents: { reviewer: { mode: "random" } } });
    put(file, content + " ".repeat(1024 * 1024 - content.length));
    const snapshot = readRoutingDocument(file, false);
    expect(snapshot.config.agents.get("reviewer")?.mode).toBe("random");
    const oversized = `${readFileSync(file, "utf8")} `;
    writeFileSync(file, oversized);
    expect(() => readRoutingDocument(file, false)).toThrow();
    expect(() => saveAgentRule(file, snapshot, "reviewer", rule("round-robin"), project)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(oversized);
  });

  test("rejects FIFOs and device links without blocking the host process", () => {
    const fifo = join(project, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const device = join(project, "device");
    symlinkSync("/dev/zero", device);
    const module = new URL("../src/store.ts", import.meta.url).href;
    for (const path of [fifo, device]) {
      const code = `import { readRoutingDocument } from ${JSON.stringify(module)};
        try { readRoutingDocument(${JSON.stringify(path)}, false); process.exit(2); }
        catch { process.exit(0); }`;
      const result = Bun.spawnSync(["bun", "-e", code], { timeout: 3000 });
      expect(result.exitCode).toBe(0);
    }
  }, 10000);
});

describe("removing an agent rule", () => {
  test("drops only that agent, revealing role rules", () => {
    put(file, { agents: { reviewer: { mode: "random" }, planner }, roles });
    const afterReviewer = saveAgentRule(
      file,
      readRoutingDocument(file, false),
      "reviewer",
      undefined,
      project,
    );
    expect(onDisk(file)).toEqual({ agents: { planner }, roles });
    expect(afterReviewer.config.agents.has("reviewer")).toBe(false);
    expect(afterReviewer.config.roles.get("review")?.mode).toBe("random");

    saveAgentRule(file, afterReviewer, "planner", undefined, project);
    expect(readRoutingDocument(file, false).config.agents.size).toBe(0);
    expect(readRoutingDocument(file, false).config.roles.size).toBe(1);
  });

  test("with no rule and no file, writes nothing", () => {
    const result = saveAgentRule(file, readRoutingDocument(file, true), "reviewer", undefined, project);
    expect(result.config.agents.size).toBe(0);
    expect(existsSync(dirname(file))).toBe(false);
  });
});

describe("save location", () => {
  test("refuses paths outside the project, through escaping links, or to links", () => {
    const outside = join(base, "outside");
    const victim = join(outside, "victim.json");
    put(victim, { agents: {} });
    const victimText = readFileSync(victim, "utf8");
    mkdirSync(join(project, "inner"));
    put(join(project, "inner", "real.json"), { agents: {} });
    symlinkSync(outside, join(project, "escape"));
    symlinkSync(join(base, "absent", "dir"), join(project, "dangling"));
    symlinkSync(victim, join(project, "victim-link.json"));
    symlinkSync(join(project, "inner", "real.json"), join(project, "inner-link.json"));

    for (const path of [
      join(outside, "routing.json"),
      join("..", "outside", "routing.json"),
      join(project, "escape", "victim.json"),
      join(project, "escape", "new", "routing.json"),
      join(project, "dangling", "routing.json"),
      join(project, "victim-link.json"),
      join(project, "inner-link.json"),
      project,
    ]) {
      const snapshot = { config: { agents: new Map(), roles: new Map() } };
      expect(() => saveAgentRule(path, snapshot, "reviewer", rule("random"), project)).toThrow();
    }

    expect(readdirSync(outside)).toEqual(["victim.json"]);
    expect(readFileSync(victim, "utf8")).toBe(victimText);
    expect(existsSync(join(base, "absent"))).toBe(false);
    expect(lstatSync(join(project, "victim-link.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(project, "inner-link.json")).isSymbolicLink()).toBe(true);
    expect(readdirSync(project).sort()).toEqual([
      "dangling",
      "escape",
      "inner",
      "inner-link.json",
      "victim-link.json",
    ]);
  });

  test("allows links that stay inside the project, including a linked project directory", () => {
    const alias = join(base, "alias");
    symlinkSync(project, alias);
    mkdirSync(join(project, "real"));
    symlinkSync(join(project, "real"), join(project, ".omp"));
    const path = join(alias, ".omp", "subagent-entropy.json");

    saveAgentRule(path, readRoutingDocument(path, true), "reviewer", rule("random"), alias);
    expect(onDisk(join(project, "real", "subagent-entropy.json"))).toEqual({
      agents: { reviewer: { mode: "random" } },
    });
  });
});

test("a failed replacement removes its temporary file and leaves the target intact", () => {
  const target = join(project, "routing.json");
  put(join(target, "keep"), "x");
  expect(() => writeFileAtomic(target, "{}\n", 0o600)).toThrow();
  expect(readdirSync(project)).toEqual(["routing.json"]);
  expect(readFileSync(join(target, "keep"), "utf8")).toBe("x");
});
