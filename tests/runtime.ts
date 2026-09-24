#!/usr/bin/env bun
/**
 * Runtime integration smoke for omp-subagent-entropy against the real omp release binary.
 *
 * Each scenario boots `omp -p --mode json` with an isolated temporary HOME / agent dir / workspace, loads
 * ../src/index.ts explicitly (`--no-extensions --extension`), and points a TEST-ONLY `auth: none` provider at a
 * loopback OpenAI chat-completions fixture. The fixture scripts the parent's tool calls (task, eval `agent()`,
 * eval `workpool()`) and each child's replies (read, then yield). No credentials, no external network, no model
 * inference.
 *
 * Assertions are split on purpose:
 *   - provider truth: the `model` field of every child request the fixture actually received (spawn count, initial
 *     model, per-child continuation stability, retry fallback);
 *   - omp metadata: task SingleResult `resolvedModel`, `resolvedModelRoute`, `resolvedModelIsFallback`, eval display
 *     output and workpool status, which must agree with provider truth.
 *
 * Usage: bun tests/runtime.ts [--list] [scenario ...]
 * Env: OMP_BIN (default /usr/local/bin/omp), ENTROPY_SMOKE_KEEP_TMP=1 keeps temp dirs for debugging.
 * ENTROPY_SMOKE_PLUGINS_DIR seeds an installed plugin root into each isolated HOME and uses normal discovery.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";

const OMP_BIN = process.env.OMP_BIN || "/usr/local/bin/omp";
const OMP_VERSION = "18.3.0";
const EXTENSION = resolve(import.meta.dir, "../src/index.ts");
const PLUGINS_DIR = process.env.ENTROPY_SMOKE_PLUGINS_DIR
  ? resolve(process.env.ENTROPY_SMOKE_PLUGINS_DIR)
  : undefined;
const KEEP_TMP = process.env.ENTROPY_SMOKE_KEEP_TMP === "1";
const DEFAULT_TIMEOUT_MS = 180_000;

const PROVIDER = "entropy-fixture";
const PARENT = "parent-model";
const AUX = "aux-model";
const A = "candidate-a";
const B = "candidate-b";
const C = "candidate-c";
const MODEL_IDS = [PARENT, AUX, A, B, C] as const;
const sel = (id: string): string => `${PROVIDER}/${id}`;
const PAIR = [sel(A), sel(B)];

/** Parent-owned block reason prefix; detailed wording is intentionally not pinned. */
const BLOCK_PREFIX = "subagent-entropy";
const MARKER = /ENTROPY-CHILD\[([a-z0-9-]+)\]/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type ChildMode = "read-then-yield" | "yield-first";

interface AgentSpec {
  model: string | string[];
  tools?: string[];
}

interface ParentCall {
  tool: "task" | "eval";
  args: Json;
}

interface Scenario {
  name: string;
  summary: string;
  agents: Record<string, AgentSpec>;
  modelRoles?: Record<string, string | string[]>;
  settings?: Json;
  /** Raw file text written to <cwd>/.omp/subagent-entropy.json. */
  defaultRouting?: string;
  /** Exported as OMP_SUBAGENT_ENTROPY_CONFIG; content is written there, or the path is left missing. */
  overrideRouting?: { content?: string };
  parent: ParentCall[];
  childMode: ChildMode;
  /** Child requests to these model ids get a non-transport-retried 429 so core retry fallback must take over. */
  failChildModels?: readonly string[];
  verify: (run: RunResult, check: Check) => void;
  timeoutMs?: number;
}

type RequestKind = "parent" | "child" | "aux" | "other";

interface ProviderRequest {
  seq: number;
  kind: RequestKind;
  path: string;
  model: string;
  status: number;
  action: string;
  /** First child marker in the child's conversation: identifies one spawned child session. */
  session?: string;
  /** Last child marker: identifies the current turn (differs from session for workpool follow-ups). */
  turn?: string;
  parentStep?: number;
}

interface ChildSession {
  label: string;
  requests: ProviderRequest[];
}

interface ToolResult {
  toolName: string;
  isError: boolean;
  text: string;
  details: unknown;
}

interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface RunResult {
  requests: ProviderRequest[];
  children: Map<string, ChildSession>;
  tools: ToolResult[];
  fixtureErrors: string[];
  /** Child labels of each scripted task call, in call order and item order (SingleResult.index fallback). */
  taskLabels: string[][];
  process: ProcessResult;
}

type Reply = { kind: "text"; text: string } | { kind: "tools"; calls: Array<{ name: string; args: Json }> };

interface WireMessage {
  role: string;
  text: string;
  calls: string[];
}

interface WireRequest {
  model: string;
  stream: boolean;
  messages: WireMessage[];
  /** Tool name → JSON-schema parameters exactly as omp sent them. */
  tools: Map<string, Json>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fmt(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function markers(text: string): string[] {
  return Array.from(text.matchAll(MARKER), (match) => match[1] ?? "").filter((label) => label.length > 0);
}

function merge(base: Json, overlay: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = out[key];
    out[key] = isRecord(previous) && isRecord(value) ? merge(previous, value) : value;
  }
  return out;
}

class Check {
  readonly failures: string[] = [];

  ok(condition: boolean, message: string): void {
    if (!condition) this.failures.push(message);
  }

  equal(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected))
      this.failures.push(`${message}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Loopback OpenAI chat-completions fixture (test-only protocol stub)
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function parseWire(body: unknown): WireRequest {
  const root: Json = isRecord(body) ? body : {};
  const messages: WireMessage[] = asArray(root.messages)
    .filter(isRecord)
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "",
      text: textOf(message.content),
      calls: asArray(message.tool_calls)
        .filter(isRecord)
        .map((call) => {
          const fn = call.function;
          return isRecord(fn) && typeof fn.name === "string" ? fn.name : "";
        }),
    }));
  const tools = new Map<string, Json>();
  for (const tool of asArray(root.tools)) {
    if (!isRecord(tool)) continue;
    const fn = tool.function;
    if (!isRecord(fn) || typeof fn.name !== "string") continue;
    tools.set(fn.name, isRecord(fn.parameters) ? fn.parameters : {});
  }
  return {
    model: typeof root.model === "string" ? root.model : "",
    stream: root.stream === true,
    messages,
    tools,
  };
}

/** Supply the injected intent field only when omp's wire schema declares it (agent-core intent tracing). */
function withIntent(schema: Json | undefined, args: Json): Json {
  const properties = schema?.properties;
  return isRecord(properties) && "i" in properties ? { i: "Entropy runtime smoke", ...args } : args;
}

/** Ordinary children submit `{data}`; workpool workers submit `{key, data}` per item (tools/yield.ts). */
function yieldCalls(schema: Json | undefined): Array<{ name: string; args: Json }> {
  const properties = schema?.properties;
  const key = isRecord(properties) ? properties.key : undefined;
  const keys = isRecord(key) ? asArray(key.enum) : [];
  if (keys.length > 0) {
    return keys.map((itemKey) => ({
      name: "yield",
      args: withIntent(schema, { key: itemKey, data: { ok: true } }),
    }));
  }
  return [{ name: "yield", args: withIntent(schema, { data: { ok: true } }) }];
}

function childPosition(messages: WireMessage[]): { session?: string; turn?: string; called: Set<string> } {
  const scan = (roles: readonly string[]) => {
    let session: string | undefined;
    let turn: string | undefined;
    let lastIndex = -1;
    for (const [index, message] of messages.entries()) {
      if (!roles.includes(message.role)) continue;
      const found = markers(message.text);
      if (found.length === 0) continue;
      session ??= found[0];
      turn = found[found.length - 1];
      lastIndex = index;
    }
    return { session, turn, lastIndex };
  };
  let position = scan(["user"]);
  if (position.session === undefined) position = scan(["system", "developer"]);
  const called = new Set<string>();
  for (const message of messages.slice(position.lastIndex + 1)) {
    if (message.role === "assistant") for (const name of message.calls) called.add(name);
  }
  return { session: position.session, turn: position.turn, called };
}

function chatResponse(wire: WireRequest, reply: Reply, seq: number): Response {
  const id = `chatcmpl-entropy-${seq}`;
  const created = 1_700_000_000;
  const usage = { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 };
  const finish = reply.kind === "tools" ? "tool_calls" : "stop";
  const toolCalls =
    reply.kind === "tools"
      ? reply.calls.map((call, index) => ({
          index,
          id: `call_entropy_${seq}_${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }))
      : [];
  if (!wire.stream) {
    const message =
      reply.kind === "text"
        ? { role: "assistant", content: reply.text }
        : {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map(({ index: _index, ...call }) => call),
          };
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model: wire.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    });
  }
  const frame = (payload: Json): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: wire.model, ...payload })}\n\n`;
  const delta =
    reply.kind === "text"
      ? { role: "assistant", content: reply.text }
      : { role: "assistant", tool_calls: toolCalls };
  const body =
    frame({ choices: [{ index: 0, delta, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
    frame({ choices: [], usage }) +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const liveFixtures = new Set<Fixture>();

class Fixture {
  readonly requests: ProviderRequest[] = [];
  readonly errors: string[] = [];
  #seq = 0;
  #server: Server<undefined> | undefined;

  constructor(private readonly scenario: Scenario) {}

  start(): string {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.#handle(request) });
    this.#server = server;
    liveFixtures.add(this);
    if (!server.port) throw new Error("fixture server did not bind a port");
    return `http://127.0.0.1:${server.port}/v1`;
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = undefined;
    liveFixtures.delete(this);
  }

  async #handle(request: Request): Promise<Response> {
    const seq = ++this.#seq;
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path.endsWith("/models")) {
        this.requests.push({ seq, kind: "other", path, model: "", status: 200, action: "list-models" });
        return Response.json({
          object: "list",
          data: MODEL_IDS.map((id) => ({ id, object: "model", owned_by: PROVIDER })),
        });
      }
      if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
        this.requests.push({ seq, kind: "other", path, model: "", status: 404, action: request.method });
        return new Response("not found", { status: 404 });
      }
      const wire = parseWire(await request.json());
      // Classify by the tool surface omp sent: children always carry the hidden `yield` tool; the scripted
      // parent carries task/eval; everything else (task labels, titles, judges) is auxiliary.
      if (wire.tools.has("yield")) return this.#child(seq, path, wire);
      if (wire.tools.has("task") || wire.tools.has("eval")) return this.#parent(seq, path, wire);
      this.requests.push({ seq, kind: "aux", path, model: wire.model, status: 200, action: "aux-text" });
      return chatResponse(wire, { kind: "text", text: "Entropy smoke" }, seq);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push(`request #${seq} ${path}: ${message}`);
      return Response.json({ error: { message: `entropy fixture failure: ${message}` } }, { status: 400 });
    }
  }

  #parent(seq: number, path: string, wire: WireRequest): Response {
    const step = wire.messages.filter(
      (message) => message.role === "assistant" && message.calls.length > 0,
    ).length;
    const call = this.scenario.parent[step];
    const reply: Reply = call
      ? {
          kind: "tools",
          calls: [{ name: call.tool, args: withIntent(wire.tools.get(call.tool), call.args) }],
        }
      : { kind: "text", text: "Entropy routing smoke complete." };
    this.requests.push({
      seq,
      kind: "parent",
      path,
      model: wire.model,
      status: 200,
      action: call ? `call:${call.tool}` : "final",
      parentStep: step,
    });
    return chatResponse(wire, reply, seq);
  }

  #child(seq: number, path: string, wire: WireRequest): Response {
    const { session, turn, called } = childPosition(wire.messages);
    const base = { seq, kind: "child" as const, path, model: wire.model, session, turn };
    if (this.scenario.failChildModels?.includes(wire.model)) {
      // `rate_limit_type: max_parallel_requests` bypasses pi-ai transport retries (utils/openai-http.ts) so the
      // failure reaches session TurnRecovery immediately; the message classifies as CONCURRENT_LIMIT, not a
      // usage limit, so no credential rotation happens and retry.modelFallback walks the child's chain.
      this.requests.push({ ...base, status: 429, action: "rejected-429" });
      return new Response(
        JSON.stringify({
          error: {
            message: "Too many concurrent requests (entropy fixture admission control)",
            type: "rate_limit_error",
          },
          rate_limit_type: "max_parallel_requests",
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", rate_limit_type: "max_parallel_requests" },
        },
      );
    }
    let reply: Reply;
    let action: string;
    if (called.has("yield")) {
      reply = { kind: "text", text: "Submitted." };
      action = "text";
    } else if (this.scenario.childMode === "read-then-yield" && !called.has("read")) {
      reply = {
        kind: "tools",
        calls: [{ name: "read", args: withIntent(wire.tools.get("read"), { path: "smoke.txt" }) }],
      };
      action = "read";
    } else {
      reply = { kind: "tools", calls: yieldCalls(wire.tools.get("yield")) };
      action = "yield";
    }
    this.requests.push({ ...base, status: 200, action });
    return chatResponse(wire, reply, seq);
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

const liveChildren = new Set<ChildProcess>();
let tempRoot: string | undefined;

/**
 * Signal omp and everything it spawned (eval JS workers, shells). omp runs as a detached process-group leader, so
 * `-pid` addresses the whole group; the kernel keeps a pgid unallocatable while any member lives, and ESRCH once
 * the group is empty is ignored. The leader itself is signalled through its ChildProcess, which is exit-aware.
 */
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ProcessResult> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<ProcessResult>();
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveChildren.add(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  let cancelKill = (): void => {};
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child, "SIGTERM");
    const kill = setTimeout(() => terminate(child, "SIGKILL"), 5_000);
    cancelKill = () => clearTimeout(kill);
  }, options.timeoutMs);
  const settle = () => {
    clearTimeout(timer);
    cancelKill();
    // Reap stragglers such as eval JS workers left behind in omp's process group.
    terminate(child, "SIGKILL");
    liveChildren.delete(child);
  };
  child.once("error", (error) => {
    settle();
    reject(error);
  });
  child.once("close", (code, signal) => {
    settle();
    resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      timedOut,
      durationMs: performance.now() - started,
    });
  });
  return promise;
}

function emergencyCleanup(): void {
  for (const child of liveChildren) terminate(child, "SIGKILL");
  liveChildren.clear();
  for (const fixture of liveFixtures) fixture.stop();
  if (tempRoot && !KEEP_TMP) rmSync(tempRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.error(`\nreceived ${signal}; cleaning up omp processes, fixtures and temp dirs`);
    emergencyCleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** Minimal, credential-free environment: nothing from the host except PATH. */
function ompEnv(dir: string, extra: Record<string, string>): Record<string, string> {
  const home = join(dir, "home");
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: home,
    TMPDIR: join(dir, "tmp"),
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OMP_SKIP_SETUP: "1",
    PI_NO_TITLE: "1",
    PI_PY: "0",
    PI_AUTO_QA: "0",
    OTEL_SDK_DISABLED: "true",
    ...extra,
  };
}

async function prepareDirs(dir: string): Promise<void> {
  const home = join(dir, "home");
  for (const path of [
    join(home, ".omp", "agent"),
    join(home, ".config"),
    join(home, ".cache"),
    join(home, ".local", "share"),
    join(home, ".local", "state"),
    join(dir, "tmp"),
    join(dir, "sessions"),
    join(dir, "routing"),
    join(dir, "workspace", ".omp", "agents"),
  ]) {
    await mkdir(path, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario files
// ---------------------------------------------------------------------------

function modelsYaml(baseUrl: string): string {
  // JSON is valid YAML; models.yml schema: config/models-config-schema-bundle.ts (18.3.0).
  const models = MODEL_IDS.map((id) => ({
    id,
    name: `Entropy fixture ${id}`,
    reasoning: false,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const config = {
    providers: {
      [PROVIDER]: { baseUrl, auth: "none", api: "openai-completions", disableStrictTools: true, models },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function configYaml(scenario: Scenario): string {
  const base: Json = {
    modelRoles: { default: sel(PARENT), smol: sel(AUX), ...scenario.modelRoles },
    // Sync task dispatch: a batch still fans out concurrently (task/index.ts #runSyncSpawns).
    async: { enabled: false },
    eval: { py: false },
    task: { maxConcurrency: 8 },
  };
  return `${JSON.stringify(merge(base, scenario.settings ?? {}), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Parent script builders
// ---------------------------------------------------------------------------

const assignment = (label: string): string =>
  `ENTROPY-CHILD[${label}] Read smoke.txt, then submit your result with the yield tool.`;

function task(items: ReadonlyArray<readonly [agent: string, label: string]>): ParentCall {
  return {
    tool: "task",
    args: {
      context: "Entropy routing runtime smoke. Follow the assignment exactly.",
      tasks: items.map(([agent, label]) => ({ agent, task: assignment(label) })),
    },
  };
}

/** One JS eval cell. The body is block-scoped so repeated cells never collide in the retained kernel's globals. */
function evalCell(title: string, lines: string[]): ParentCall {
  const code = ["{", ...lines.map((line) => `\t${line}`), "}"].join("\n");
  return { tool: "eval", args: { language: "js", title, timeout: 150, code } };
}

function evalAgent(agent: string, label: string): ParentCall {
  return evalCell(`agent() ${label}`, [
    `const text = await agent(${fmt(assignment(label))}, { agent: ${fmt(agent)} }).wait();`,
    `display({ label: ${fmt(label)}, completed: typeof text === "string" });`,
  ]);
}

function evalBlockedAgent(agent: string, label: string): ParentCall {
  return evalCell(`blocked agent() ${label}`, [
    `let blocked = "";`,
    `let spawned = false;`,
    `try {`,
    `  await agent(${fmt(assignment(label))}, { agent: ${fmt(agent)} }).wait();`,
    `  spawned = true;`,
    `} catch (error) {`,
    `  blocked = String(error instanceof Error ? error.message : error);`,
    `}`,
    `display({ label: ${fmt(label)}, spawned, blocked });`,
  ]);
}

// ---------------------------------------------------------------------------
// Result extraction and shared verification
// ---------------------------------------------------------------------------

function collectRun(scenario: Scenario, fixture: Fixture, proc: ProcessResult): RunResult {
  const children = new Map<string, ChildSession>();
  for (const request of fixture.requests) {
    if (request.kind !== "child" || request.session === undefined) continue;
    const child = children.get(request.session) ?? { label: request.session, requests: [] };
    child.requests.push(request);
    children.set(request.session, child);
  }
  const tools: ToolResult[] = [];
  for (const line of proc.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "tool_execution_end") continue;
    const result: Json = isRecord(event.result) ? event.result : {};
    tools.push({
      toolName: typeof event.toolName === "string" ? event.toolName : "",
      isError: event.isError === true,
      text: textOf(result.content),
      details: result.details,
    });
  }
  const taskLabels = scenario.parent
    .filter((call) => call.tool === "task")
    .map((call) =>
      asArray(call.args.tasks).map((item) => (isRecord(item) ? (markers(String(item.task))[0] ?? "") : "")),
    );
  return {
    requests: fixture.requests,
    children,
    tools,
    fixtureErrors: fixture.errors,
    taskLabels,
    process: proc,
  };
}

function commonChecks(scenario: Scenario, run: RunResult, check: Check): void {
  const proc = run.process;
  check.ok(!proc.timedOut, `omp did not finish within ${scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  check.equal(proc.code, 0, "omp exit code");
  check.ok(run.fixtureErrors.length === 0, `fixture errors: ${run.fixtureErrors.join("; ")}`);
  check.ok(
    !/Extension error|Failed to load extension/.test(proc.stderr),
    "stderr reports an extension load/runtime error (see stderr tail)",
  );
  const parents = run.requests.filter((request) => request.kind === "parent");
  check.ok(parents.length > 0, "parent session never reached the provider fixture");
  for (const request of parents) {
    check.equal(
      request.model,
      PARENT,
      `parent request #${request.seq} model (routing must not touch the main session)`,
    );
  }
  check.ok(
    parents.some((request) => request.action === "final" && request.parentStep === scenario.parent.length),
    `parent script not fully consumed (${scenario.parent.length} scripted tool calls, then a final reply)`,
  );
  const scriptedTools = run.tools.filter((tool) => tool.toolName === "task" || tool.toolName === "eval");
  check.equal(
    scriptedTools.map((tool) => tool.toolName).join(","),
    scenario.parent.map((call) => call.tool).join(","),
    "parent tool_execution_end sequence",
  );
  for (const request of run.requests) {
    if (request.kind === "child" && request.session === undefined) {
      check.ok(false, `child request #${request.seq} (${request.model}) carries no ENTROPY-CHILD marker`);
    }
  }
}

/** Exact spawn set and one model per child for its whole lifetime (provider truth). */
function expectSpawns(
  run: RunResult,
  check: Check,
  expected: Record<string, string>,
  options: { continuation?: boolean } = {},
): void {
  check.equal(
    [...run.children.keys()].sort().join(","),
    Object.keys(expected).sort().join(","),
    "spawned child sessions seen by the provider",
  );
  for (const [label, model] of Object.entries(expected)) {
    const child = run.children.get(label);
    if (!child) continue;
    const models = [...new Set(child.requests.map((request) => request.model))];
    check.equal(models.join(","), model, `${label}: provider model for every request of this child`);
    if (options.continuation) {
      const actions = child.requests.map((request) => request.action);
      check.ok(
        actions.includes("read") && actions.includes("yield"),
        `${label}: expected a multi-request continuation (read → yield); actions=${actions.join(",")}`,
      );
    }
  }
}

function taskResult(run: RunResult, label: string): Json | undefined {
  const taskTools = run.tools.filter((tool) => tool.toolName === "task");
  for (const [call, tool] of taskTools.entries()) {
    if (!isRecord(tool.details)) continue;
    for (const result of asArray(tool.details.results)) {
      if (!isRecord(result)) continue;
      const index = typeof result.index === "number" ? result.index : -1;
      const resultLabel = markers(JSON.stringify(result))[0] ?? run.taskLabels[call]?.[index];
      if (resultLabel === label) return result;
    }
  }
  return undefined;
}

function metadataIdentity(result: Json): unknown {
  if (typeof result.resolvedModelIdentity === "string") return result.resolvedModelIdentity;
  return typeof result.resolvedModel === "string"
    ? result.resolvedModel.replace(/:[a-z]+$/, "")
    : result.resolvedModel;
}

/** Contract order after routing: chosen native candidate first, every other native candidate kept in original order. */
function front(chosen: string, native: readonly string[]): string[] {
  return [chosen, ...native.filter((model) => model !== chosen)];
}

/**
 * omp's own metadata for a task spawn (SingleResult): route note presence, the pattern list the child was spawned
 * with (its runtime retry-fallback chain source), and the model omp attributes as serving. It must agree with the
 * provider-observed model.
 */
function expectTaskMetadata(
  run: RunResult,
  check: Check,
  label: string,
  expected: { routed: boolean; served: string; patterns: readonly string[]; fallback?: boolean },
): void {
  const result = taskResult(run, label);
  if (!result) {
    check.ok(false, `${label}: no task SingleResult metadata in the json event stream`);
    return;
  }
  check.equal(result.exitCode, 0, `${label}: task SingleResult exitCode`);
  const route = result.resolvedModelRoute;
  if (expected.routed) {
    check.ok(
      typeof route === "string" && route.trim().length > 0,
      `${label}: routed spawn must expose a resolvedModelRoute note, got ${fmt(route)}`,
    );
  } else {
    check.ok(
      route === undefined || route === null || route === "",
      `${label}: native spawn must not carry a route note, got ${fmt(route)}`,
    );
  }
  const override = result.modelOverride;
  const spawnedWith = typeof override === "string" ? [override] : asArray(override);
  check.equal(
    fmt(spawnedWith),
    fmt(expected.patterns.map(sel)),
    `${label}: SingleResult.modelOverride (spawn pattern order)`,
  );
  check.equal(metadataIdentity(result), sel(expected.served), `${label}: resolved (serving) model metadata`);
  if (expected.fallback !== undefined) {
    check.equal(
      result.resolvedModelIsFallback === true,
      expected.fallback,
      `${label}: resolvedModelIsFallback`,
    );
  }
}

function evalOutput(run: RunResult, label: string): Json | undefined {
  for (const tool of run.tools) {
    if (tool.toolName !== "eval" || !isRecord(tool.details)) continue;
    for (const output of asArray(tool.details.jsonOutputs)) {
      if (isRecord(output) && output.label === label) return output;
    }
  }
  return undefined;
}

function expectEvalCompleted(run: RunResult, check: Check, label: string): void {
  const output = evalOutput(run, label);
  check.equal(output?.completed, true, `${label}: eval agent() display output`);
}

function taskTexts(run: RunResult): string[] {
  return run.tools.filter((tool) => tool.toolName === "task").map((tool) => tool.text);
}

function expectBlockedTask(check: Check, text: string | undefined, what: string): void {
  check.ok(
    text?.includes(BLOCK_PREFIX) === true,
    `${what}: task result must report the routing refusal, got ${fmt(text?.slice(0, 240))}`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    name: "round-robin",
    summary:
      "equal RR shared by task and eval agent(): A,B,A,B; each child keeps its model across read → yield",
    agents: { "rr-pair": { model: PAIR } },
    defaultRouting: JSON.stringify({ agents: { "rr-pair": { mode: "round-robin" } } }),
    parent: [
      task([["rr-pair", "rr-1"]]),
      evalAgent("rr-pair", "rr-2"),
      task([["rr-pair", "rr-3"]]),
      evalAgent("rr-pair", "rr-4"),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, { "rr-1": A, "rr-2": B, "rr-3": A, "rr-4": B }, { continuation: true });
      expectTaskMetadata(run, check, "rr-1", { routed: true, served: A, patterns: [A, B] });
      expectTaskMetadata(run, check, "rr-3", { routed: true, served: A, patterns: [A, B] });
      expectEvalCompleted(run, check, "rr-2");
      expectEvalCompleted(run, check, "rr-4");
    },
  },
  {
    name: "weighted-batch",
    summary:
      "RR 3:1 via OMP_SUBAGENT_ENTROPY_CONFIG; one concurrent 4-item task batch yields exactly 3×A and 1×B",
    agents: { "weighted-pair": { model: PAIR } },
    overrideRouting: {
      content: JSON.stringify({
        agents: { "weighted-pair": { mode: "round-robin", weights: { [sel(A)]: 3, [sel(B)]: 1 } } },
      }),
    },
    parent: [
      task([
        ["weighted-pair", "w-1"],
        ["weighted-pair", "w-2"],
        ["weighted-pair", "w-3"],
        ["weighted-pair", "w-4"],
      ]),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      const labels = ["w-1", "w-2", "w-3", "w-4"];
      check.equal(
        [...run.children.keys()].sort().join(","),
        labels.join(","),
        "spawned child sessions seen by the provider",
      );
      const initial = labels.map((label) => run.children.get(label)?.requests[0]?.model);
      check.equal(
        initial.filter((model) => model === A).length,
        3,
        "children whose first provider request used candidate-a",
      );
      check.equal(
        initial.filter((model) => model === B).length,
        1,
        "children whose first provider request used candidate-b",
      );
      for (const label of labels) {
        const child = run.children.get(label);
        if (!child) continue;
        const models = [...new Set(child.requests.map((request) => request.model))];
        check.equal(
          models.length,
          1,
          `${label}: one provider model across its continuation (${models.join(",")})`,
        );
        const actions = child.requests.map((request) => request.action);
        check.ok(
          actions.includes("read") && actions.includes("yield"),
          `${label}: read → yield continuation; actions=${actions.join(",")}`,
        );
        const served = models[0];
        if (served)
          expectTaskMetadata(run, check, label, { routed: true, served, patterns: front(served, [A, B]) });
      }
    },
  },
  {
    name: "precedence",
    summary:
      "agent rule beats role rule; role rule applies alone; random 0/1 always B; unmatched and single-model stay native",
    modelRoles: { research: [sel(A), sel(B), sel(C)] },
    agents: {
      "role-agent-rule": { model: "@research" },
      "role-rule": { model: "@research" },
      "zero-one": { model: PAIR },
      "native-pair": { model: [sel(B), sel(A)] },
      "single-model": { model: [sel(C)] },
    },
    defaultRouting: JSON.stringify({
      agents: {
        "role-agent-rule": { mode: "random", weights: { [sel(A)]: 0, [sel(B)]: 0, [sel(C)]: 1 } },
        "zero-one": { mode: "random", weights: { [sel(A)]: 0, [sel(B)]: 1 } },
        // A single native candidate is a pin: the rule (even with weight 0) must not apply.
        "single-model": { mode: "random", weights: { [sel(C)]: 0 } },
      },
      roles: { research: { mode: "random", weights: { [sel(A)]: 0, [sel(B)]: 1, [sel(C)]: 0 } } },
    }),
    parent: [
      task([
        ["role-agent-rule", "p-agent-over-role"],
        ["role-rule", "p-role"],
        ["zero-one", "p-zero-1"],
        ["zero-one", "p-zero-2"],
        ["zero-one", "p-zero-3"],
        ["native-pair", "p-native-1"],
        ["native-pair", "p-native-2"],
        ["single-model", "p-single"],
      ]),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      // Native first choices would be A, A, A, A, A, B, B, C: every routed expectation differs from native.
      const cases: Record<string, { model: string; patterns: string[]; routed: boolean }> = {
        "p-agent-over-role": { model: C, patterns: front(C, [A, B, C]), routed: true },
        "p-role": { model: B, patterns: front(B, [A, B, C]), routed: true },
        "p-zero-1": { model: B, patterns: front(B, [A, B]), routed: true },
        "p-zero-2": { model: B, patterns: front(B, [A, B]), routed: true },
        "p-zero-3": { model: B, patterns: front(B, [A, B]), routed: true },
        "p-native-1": { model: B, patterns: [B, A], routed: false },
        "p-native-2": { model: B, patterns: [B, A], routed: false },
        "p-single": { model: C, patterns: [C], routed: false },
      };
      expectSpawns(
        run,
        check,
        Object.fromEntries(Object.entries(cases).map(([label, c]) => [label, c.model])),
        {
          continuation: true,
        },
      );
      for (const [label, c] of Object.entries(cases)) {
        expectTaskMetadata(run, check, label, { routed: c.routed, served: c.model, patterns: c.patterns });
      }
    },
  },
  {
    name: "workpool",
    summary:
      "workpool routes only its initial worker (A); the queued item is a follow-up turn on A; next agent() gets B",
    agents: { "pool-pair": { model: PAIR } },
    settings: { task: { maxConcurrency: 1 } },
    defaultRouting: JSON.stringify({ agents: { "pool-pair": { mode: "round-robin" } } }),
    parent: [
      evalCell("workpool follow-up", [
        `const pool = await workpool("pool-pair", { name: "entropy-pool" });`,
        `await pool.push(${fmt(assignment("pool-1"))}, ${fmt(assignment("pool-2"))});`,
        `const deadline = Date.now() + 120000;`,
        `let status = await pool.status();`,
        `while (status.items.completed + status.items.failed + status.items.cancelled < 2) {`,
        `  if (Date.now() > deadline) throw new Error("workpool did not drain: " + JSON.stringify(status));`,
        `  await Bun.sleep(100);`,
        `  status = await pool.status();`,
        `}`,
        `display({ label: "pool", status, peek: await pool.peek() });`,
        `const text = await agent(${fmt(assignment("pool-fresh"))}, { agent: "pool-pair" }).wait();`,
        `display({ label: "pool-fresh", completed: typeof text === "string" });`,
      ]),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, { "pool-1": A, "pool-fresh": B }, { continuation: true });
      const worker = run.children.get("pool-1");
      const turns = [...new Set(worker?.requests.map((request) => request.turn) ?? [])];
      check.equal(
        turns.join(","),
        "pool-1,pool-2",
        "worker session turns (pool-2 must reuse the pool-1 worker)",
      );
      const followUp = worker?.requests.filter((request) => request.turn === "pool-2") ?? [];
      check.ok(
        followUp.some((request) => request.action === "yield") &&
          followUp.every((request) => request.model === A),
        `pool-2 follow-up turn must complete on the initial worker model ${A}; got ${fmt(followUp.map((r) => `${r.model}:${r.action}`))}`,
      );
      const pool = evalOutput(run, "pool");
      const rawStatus = pool?.status;
      const status: Json = isRecord(rawStatus) ? rawStatus : {};
      const workers = asArray(status.agents);
      const firstWorker = workers[0];
      const rawItems = status.items;
      const items: Json = isRecord(rawItems) ? rawItems : {};
      check.equal(workers.length, 1, "workpool status worker count");
      check.equal(isRecord(firstWorker) ? firstWorker.turns : undefined, 2, "workpool worker turns");
      check.equal(items.completed, 2, "workpool completed items");
      const peek = pool?.peek;
      const batches = asArray(isRecord(peek) ? peek.batches : undefined).filter(isRecord);
      check.equal(batches.length, 2, "workpool batches");
      check.equal(new Set(batches.map((batch) => batch.agent)).size, 1, "workpool batches share one worker");
      expectEvalCompleted(run, check, "pool-fresh");
    },
  },
  {
    name: "fallback",
    summary:
      "random 0/1 routes B first; B is rejected; core retry falls back to preserved original A (weight 0)",
    agents: { "fallback-pair": { model: PAIR } },
    defaultRouting: JSON.stringify({
      agents: { "fallback-pair": { mode: "random", weights: { [sel(A)]: 0, [sel(B)]: 1 } } },
    }),
    parent: [task([["fallback-pair", "fb-1"]])],
    childMode: "yield-first",
    failChildModels: [B],
    verify(run, check) {
      check.equal([...run.children.keys()].join(","), "fb-1", "spawned child sessions seen by the provider");
      const requests = run.children.get("fb-1")?.requests ?? [];
      check.equal(requests[0]?.model, B, "fb-1: routed initial provider model");
      check.equal(requests[0]?.status, 429, "fb-1: routed initial request is rejected by the fixture");
      check.ok(
        requests.some((request) => request.model === A && request.action === "yield"),
        `fb-1: core retry must fall back to preserved ${A}; got ${fmt(requests.map((r) => `${r.model}:${r.status}:${r.action}`))}`,
      );
      check.ok(
        requests.every((request) => request.model === A || request.model === B),
        "fb-1: only the native candidates may serve the child",
      );
      // Metadata semantics differ on purpose: the route note explains the spawn choice (B), the resolved model is
      // what actually served (A) and is flagged as a fallback.
      expectTaskMetadata(run, check, "fb-1", {
        routed: true,
        served: A,
        patterns: front(B, [A, B]),
        fallback: true,
      });
    },
  },
  {
    name: "blocks",
    summary:
      "unknown weight selector and all-zero weights block with zero child requests; a valid rule still routes",
    agents: {
      "typo-pair": { model: PAIR },
      "zero-pair": { model: PAIR },
      "zero-one": { model: PAIR },
    },
    defaultRouting: JSON.stringify({
      agents: {
        "typo-pair": { mode: "random", weights: { [sel("candidate-z")]: 1 } },
        "zero-pair": { mode: "round-robin", weights: { [sel(A)]: 0, [sel(B)]: 0 } },
        "zero-one": { mode: "random", weights: { [sel(A)]: 0, [sel(B)]: 1 } },
      },
    }),
    parent: [
      task([["typo-pair", "block-typo"]]),
      task([["zero-pair", "block-zero"]]),
      task([["zero-one", "block-ok"]]),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, { "block-ok": B }, { continuation: true });
      const texts = taskTexts(run);
      expectBlockedTask(check, texts[0], "unknown weight selector");
      expectBlockedTask(check, texts[1], "no positive-weight candidate");
      expectTaskMetadata(run, check, "block-ok", { routed: true, served: B, patterns: front(B, [A, B]) });
    },
  },
  {
    name: "invalid-config",
    summary:
      "malformed routing file blocks task and eval agent() spawns (even unmatched agents); no child requests",
    agents: { "native-pair": { model: [sel(B), sel(A)] } },
    defaultRouting: '{"agents": {"native-pair": ',
    parent: [task([["native-pair", "invalid-task"]]), evalBlockedAgent("native-pair", "invalid-eval")],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, {});
      expectBlockedTask(check, taskTexts(run)[0], "malformed config (task)");
      const output = evalOutput(run, "invalid-eval");
      const blocked = output?.blocked;
      check.equal(output?.spawned, false, "malformed config (eval agent()) must not spawn");
      check.ok(
        typeof blocked === "string" && blocked.includes(BLOCK_PREFIX),
        `malformed config (eval agent()) block reason must mention ${BLOCK_PREFIX}, got ${fmt(blocked)}`,
      );
    },
  },
  {
    name: "missing-override",
    summary:
      "explicit OMP_SUBAGENT_ENTROPY_CONFIG path that does not exist blocks, ignoring a valid default file",
    agents: { "rr-pair": { model: PAIR } },
    defaultRouting: JSON.stringify({ agents: { "rr-pair": { mode: "round-robin" } } }),
    overrideRouting: {},
    parent: [task([["rr-pair", "missing-override"]])],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, {});
      expectBlockedTask(check, taskTexts(run)[0], "missing explicit config");
    },
  },
  {
    name: "no-config",
    summary:
      "absent default routing file keeps native first-candidate selection for task and eval, without route notes",
    agents: { "rr-pair": { model: PAIR } },
    parent: [
      task([["rr-pair", "native-1"]]),
      evalAgent("rr-pair", "native-2"),
      task([["rr-pair", "native-3"]]),
    ],
    childMode: "read-then-yield",
    verify(run, check) {
      expectSpawns(run, check, { "native-1": A, "native-2": A, "native-3": A }, { continuation: true });
      expectTaskMetadata(run, check, "native-1", { routed: false, served: A, patterns: [A, B] });
      expectTaskMetadata(run, check, "native-3", { routed: false, served: A, patterns: [A, B] });
      expectEvalCompleted(run, check, "native-2");
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function describeRun(run: RunResult): string[] {
  const lines: string[] = [];
  for (const child of [...run.children.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const steps = child.requests.map((request) => {
      const turn = request.turn && request.turn !== child.label ? `@${request.turn}` : "";
      return `${request.model}${request.status === 200 ? "" : `(${request.status})`}:${request.action}${turn}`;
    });
    const meta = taskResult(run, child.label);
    const route = meta ? `  route=${fmt(meta.resolvedModelRoute)} resolved=${fmt(meta.resolvedModel)}` : "";
    lines.push(`  child ${child.label}: ${steps.join(" → ")}${route}`);
  }
  const count = (kind: RequestKind) => run.requests.filter((request) => request.kind === kind).length;
  lines.push(
    `  provider requests: parent=${count("parent")} child=${count("child")} aux=${count("aux")} other=${count("other")}`,
  );
  return lines;
}

function describeFailure(run: RunResult): string[] {
  const lines = ["  provider ledger:"];
  for (const request of run.requests) {
    lines.push(
      `    #${request.seq} ${request.kind} ${request.model || request.path} ${request.status} ${request.action}` +
        (request.session ? ` session=${request.session} turn=${request.turn}` : "") +
        (request.parentStep !== undefined ? ` step=${request.parentStep}` : ""),
    );
  }
  for (const tool of run.tools) {
    lines.push(
      `  tool ${tool.toolName}${tool.isError ? " (error)" : ""}: ${tool.text.replace(/\s+/g, " ").slice(0, 400)}`,
    );
  }
  const proc = run.process;
  lines.push(`  omp exit code=${proc.code} signal=${proc.signal} timedOut=${proc.timedOut}`);
  const stderrTail = proc.stderr.trimEnd().split("\n").slice(-60);
  if (proc.stderr.trim()) lines.push("  stderr tail:", ...stderrTail.map((line) => `    ${line}`));
  if (!run.tools.length && proc.stdout.trim()) {
    const stdoutTail = proc.stdout.trimEnd().split("\n").slice(-20);
    lines.push("  stdout tail:", ...stdoutTail.map((line) => `    ${line.slice(0, 400)}`));
  }
  return lines;
}

async function runScenario(root: string, scenario: Scenario): Promise<boolean> {
  const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = await mkdtemp(join(root, `${scenario.name}-`));
  const workspace = join(dir, "workspace");
  const agentDir = join(dir, "home", ".omp", "agent");
  const fixture = new Fixture(scenario);
  console.log(`\n${scenario.name} — ${scenario.summary}`);
  try {
    await prepareDirs(dir);
    if (PLUGINS_DIR) {
      cpSync(PLUGINS_DIR, join(dir, "home", ".omp", "plugins"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const baseUrl = fixture.start();
    await writeFile(join(agentDir, "models.yml"), modelsYaml(baseUrl));
    await writeFile(join(agentDir, "config.yml"), configYaml(scenario));
    for (const [name, spec] of Object.entries(scenario.agents)) {
      const markdown = [
        "---",
        `name: ${name}`,
        `description: ${fmt(`Entropy runtime smoke agent ${name}`)}`,
        `model: ${fmt(spec.model)}`,
        `tools: ${fmt(spec.tools ?? ["read"])}`,
        "---",
        "You are a deterministic smoke-test worker. Follow the assignment exactly.",
        "",
      ].join("\n");
      await writeFile(join(workspace, ".omp", "agents", `${name}.md`), markdown);
    }
    await writeFile(join(workspace, "smoke.txt"), "entropy runtime smoke fixture file\n");
    if (scenario.defaultRouting !== undefined) {
      await writeFile(join(workspace, ".omp", "subagent-entropy.json"), scenario.defaultRouting);
    }
    const extraEnv: Record<string, string> = {};
    if (scenario.overrideRouting) {
      const { content } = scenario.overrideRouting;
      const path = join(dir, "routing", content === undefined ? "missing.json" : "entropy.json");
      if (content !== undefined) await writeFile(path, content);
      extraEnv.OMP_SUBAGENT_ENTROPY_CONFIG = path;
    }
    const args = [
      "-p",
      "--mode",
      "json",
      "--model",
      sel(PARENT),
      "--thinking",
      "off",
      ...(PLUGINS_DIR ? [] : ["--no-extensions", "--extension", EXTENSION]),
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-title",
      "--no-pty",
      "--approval-mode",
      "yolo",
      "--session-dir",
      join(dir, "sessions"),
      "--max-time",
      String(Math.max(30, Math.floor(timeoutMs / 1000) - 15)),
      `ENTROPY-SCENARIO ${scenario.name}: run the scripted subagent routing smoke.`,
    ];
    const proc = await runProcess(OMP_BIN, args, { cwd: workspace, env: ompEnv(dir, extraEnv), timeoutMs });
    const run = collectRun(scenario, fixture, proc);
    const check = new Check();
    commonChecks(scenario, run, check);
    scenario.verify(run, check);
    for (const line of describeRun(run)) console.log(line);
    if (check.failures.length === 0) {
      console.log(`  PASS in ${(proc.durationMs / 1000).toFixed(1)}s`);
      return true;
    }
    console.log(`  FAIL in ${(proc.durationMs / 1000).toFixed(1)}s:`);
    for (const failure of check.failures) console.log(`    - ${failure}`);
    for (const line of describeFailure(run)) console.log(line);
    if (KEEP_TMP) console.log(`  kept ${dir}`);
    return false;
  } catch (error) {
    console.log(
      `  HARNESS ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return false;
  } finally {
    fixture.stop();
    if (!KEEP_TMP) rmSync(dir, { recursive: true, force: true });
  }
}

async function checkOmpVersion(root: string): Promise<string | undefined> {
  const dir = join(root, "version");
  await prepareDirs(dir);
  const result = await runProcess(OMP_BIN, ["--version"], {
    cwd: dir,
    env: ompEnv(dir, {}),
    timeoutMs: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0 || !output.includes(OMP_VERSION)) {
    return `${OMP_BIN} --version must report ${OMP_VERSION}; exit=${result.code} output=${fmt(output.slice(0, 200))}`;
  }
  console.log(`omp: ${OMP_BIN} (${output.split("\n")[0]})`);
  return undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    for (const scenario of SCENARIOS) console.log(`${scenario.name}\t${scenario.summary}`);
    return 0;
  }
  const unknown = argv.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) {
    console.error(`unknown scenario(s): ${unknown.join(", ")}; use --list`);
    return 2;
  }
  const selected = argv.length > 0 ? SCENARIOS.filter((scenario) => argv.includes(scenario.name)) : SCENARIOS;
  if (!existsSync(OMP_BIN)) {
    console.error(`omp binary not found at ${OMP_BIN} (set OMP_BIN); run inside the project Docker image`);
    return 1;
  }
  if (!existsSync(PLUGINS_DIR ?? EXTENSION)) {
    console.error(`extension installation not found at ${PLUGINS_DIR ?? EXTENSION}`);
    return 1;
  }
  const root = await mkdtemp(join(tmpdir(), "omp-entropy-smoke-"));
  tempRoot = root;
  try {
    const versionError = await checkOmpVersion(root);
    if (versionError) {
      console.error(versionError);
      return 1;
    }
    console.log(PLUGINS_DIR ? `plugins: ${PLUGINS_DIR}` : `extension: ${EXTENSION}`);
    const failed: string[] = [];
    for (const scenario of selected) {
      if (!(await runScenario(root, scenario))) failed.push(scenario.name);
    }
    console.log(
      failed.length === 0
        ? `\nruntime smoke passed: ${selected.length} scenario(s)`
        : `\nruntime smoke FAILED: ${failed.join(", ")} (${failed.length}/${selected.length})`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (KEEP_TMP) console.log(`temp root kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
    tempRoot = undefined;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    emergencyCleanup();
    process.exit(1);
  },
);
