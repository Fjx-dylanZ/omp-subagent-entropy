import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real RPC sessions and a loopback-only provider; no mocked extension handlers or model inference.
interface Frame {
  [key: string]: unknown;
}
interface Dialog extends Frame {
  id: string;
  method: string;
  options: string[];
}
interface State {
  sessionId: string;
  sessionFile: string;
}
interface Request {
  model: string;
  messages: { role: string; content?: unknown }[];
  tools?: { function: { name: string; parameters?: { properties?: Record<string, unknown> } } }[];
}

class Rpc {
  readonly frames: Frame[] = [];
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private failure?: Error;
  readonly reader: Promise<void>;
  readonly stderr: Promise<string>;

  constructor(readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.stderr = new Response(proc.stderr).text();
    this.reader = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line.trim()) this.frames.push(JSON.parse(line) as Frame);
          for (const listener of this.listeners) listener();
        }
      }
    })().catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of this.listeners) listener();
    });
  }

  send(value: Frame): void {
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
    this.proc.stdin.flush();
  }

  diagnostics(): string {
    const summaries = this.frames.slice(-8).map((frame) => ({
      type: frame.type,
      id: frame.id,
      command: frame.command,
      method: frame.method,
      success: frame.success,
      notifyType: frame.notifyType,
      message: typeof frame.message === "string" ? frame.message.slice(0, 600) : undefined,
      error: frame.error,
    }));
    return JSON.stringify(summaries, null, 2);
  }

  wait(predicate: (frame: Frame) => boolean, from = 0): Promise<Frame> {
    const { promise, resolve: resolveFrame, reject } = Promise.withResolvers<Frame>();
    const timer = setTimeout(() => {
      this.listeners.delete(check);
      reject(new Error(`RPC timeout; recent frames: ${this.diagnostics()}`));
    }, 15000);
    const check = () => {
      const frame = this.frames.slice(from).find(predicate);
      if (frame || this.failure) {
        clearTimeout(timer);
        this.listeners.delete(check);
        if (this.failure) reject(this.failure);
        else resolveFrame(frame!);
      }
    };
    this.listeners.add(check);
    check();
    return promise;
  }

  async request(command: Frame): Promise<Frame> {
    const id = `request-${++this.serial}`;
    const from = this.frames.length;
    this.send({ ...command, id });
    const response = await this.wait((frame) => frame.type === "response" && frame.id === id, from);
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }

  async state(): Promise<State> {
    return (await this.request({ type: "get_state" })).data as State;
  }

  async dialog(from: number): Promise<Dialog> {
    return (await this.wait(
      (frame) =>
        frame.type === "extension_ui_request" && (frame.method === "select" || frame.method === "input"),
      from,
    )) as Dialog;
  }

  async choose(dialog: Dialog, value: string): Promise<Dialog> {
    const from = this.frames.length;
    this.send({ type: "extension_ui_response", id: dialog.id, value });
    return this.dialog(from);
  }
}

const root = mkdtempSync(join(tmpdir(), "entropy-lifecycle-"));
const project = join(root, "project");
const moved = join(root, "moved");
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
const A = "lifecycle/candidate-a";
const B = "lifecycle/candidate-b";
const children = new Map<string, string[]>();
let sequence = 0;
let rpc: Rpc | undefined;

function response(body: Request, call?: { name: string; args: Frame }): Response {
  const id = `lifecycle-${++sequence}`;
  const frame = (delta: Frame, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: 1700000000,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const delta = call
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${id}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { role: "assistant", content: "Complete." };
  return new Response(frame(delta, null) + frame({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Request;
    const tools = body.tools ?? [];
    const call = (name: string, args: Frame) => {
      const properties = tools.find((tool) => tool.function.name === name)?.function.parameters?.properties;
      return {
        name,
        args: properties && "i" in properties ? { i: "Checking session routing", ...args } : args,
      };
    };
    if (tools.some((tool) => tool.function.name === "yield")) {
      const label = [...JSON.stringify(body.messages).matchAll(/LIFECYCLE-CHILD-([a-z0-9-]+)/g)].at(-1)?.[1];
      assert(label, "child requests must retain their assignment identity");
      children.set(label, [...(children.get(label) ?? []), body.model]);
      return response(body, call("yield", { data: { complete: true } }));
    }
    if (tools.some((tool) => tool.function.name === "task")) {
      let lastUser = body.messages.length - 1;
      while (lastUser >= 0 && body.messages[lastUser]?.role !== "user") lastUser--;
      const label = JSON.stringify(body.messages[lastUser]).match(/LIFECYCLE-SPAWN-([a-z0-9-]+)/)?.[1];
      assert(label, "unexpected parent inference request");
      if (body.messages.slice(lastUser + 1).some((message) => message.role === "tool")) return response(body);
      return response(
        body,
        call("task", {
          context: "Check one subagent's selected model.",
          tasks: [{ agent: "worker", task: `LIFECYCLE-CHILD-${label} Submit completion with yield.` }],
        }),
      );
    }
    return response(body);
  },
});

try {
  mkdirSync(agentDir, { recursive: true });
  for (const cwd of [project, moved]) {
    mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".omp", "agents", "worker.md"),
      `---\nname: worker\ndescription: Lifecycle regression worker\nmodel: ${JSON.stringify([A, B])}\ntools: []\n---\nSubmit completion with yield.\n`,
    );
    writeFileSync(
      join(cwd, ".omp", "subagent-entropy.json"),
      JSON.stringify({ agents: { worker: { mode: "round-robin" } } }),
    );
  }
  writeFileSync(
    join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        lifecycle: {
          baseUrl: `http://127.0.0.1:${fixture.port}/v1`,
          api: "openai-completions",
          auth: "none",
          disableStrictTools: true,
          models: ["parent", "candidate-a", "candidate-b"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "config.yml"),
    JSON.stringify({
      modelRoles: { default: "lifecycle/parent", smol: "lifecycle/parent" },
      async: { enabled: false },
      eval: { py: false },
    }),
  );
  const extension = process.env.ENTROPY_EXTENSION ?? resolve(import.meta.dir, "../src/index.ts");
  rpc = new Rpc(
    Bun.spawn(
      [
        "/usr/local/bin/omp",
        "--mode",
        "rpc",
        "--model",
        "lifecycle/parent",
        "--thinking",
        "off",
        "--no-extensions",
        "-e",
        extension,
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--no-title",
        "--no-pty",
        "--approval-mode",
        "yolo",
      ],
      {
        cwd: project,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PI_CONFIG_DIR: ".omp",
          PI_CODING_AGENT_DIR: agentDir,
          OMP_SKIP_SETUP: "1",
          PI_PY: "0",
          PI_AUTO_QA: "0",
          OTEL_SDK_DISABLED: "true",
        },
      },
    ),
  );
  const client = rpc;
  await client.wait((frame) => frame.type === "ready");
  const spawn = async (label: string) => {
    const from = client.frames.length;
    await client.request({ type: "prompt", message: `LIFECYCLE-SPAWN-${label}` });
    await client.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false, from);
    return children.get(label);
  };
  assert.deepEqual(await spawn("first"), ["candidate-a"]);
  const original = await client.state();
  await client.request({ type: "new_session" });
  await client.request({ type: "switch_session", sessionPath: original.sessionFile });
  assert.deepEqual(await spawn("returned"), ["candidate-a"], "A -> B -> A must reset without a B spawn");
  await client.request({ type: "switch_session", sessionPath: original.sessionFile });
  assert.equal((await client.state()).sessionId, original.sessionId);
  assert.deepEqual(await spawn("reloaded"), ["candidate-a"], "same-ID reload must reset routing");
  console.log("PASS real session transitions reset cached round-robin state");

  const from = client.frames.length;
  client.send({ id: "editor", type: "prompt", message: "/subagent-entropy worker" });
  let dialog = await client.dialog(from);
  const option = dialog.options.find((label) => label.includes(A));
  assert(option, "native candidate must be editable");
  dialog = await client.choose(dialog, option);
  dialog = await client.choose(dialog, "3");
  const oldFile = join(project, ".omp", "subagent-entropy.json");
  const newFile = join(moved, ".omp", "subagent-entropy.json");
  const oldText = readFileSync(oldFile, "utf8");
  const newText = readFileSync(newFile, "utf8");
  await client.request({ type: "prompt", message: `/move ${moved}` });
  assert.equal(
    (await client.state()).sessionId,
    original.sessionId,
    "move must exercise unchanged session identity",
  );
  const saveFrom = client.frames.length;
  client.send({ type: "extension_ui_response", id: dialog.id, value: "Save" });
  const notice = await client.wait(
    (frame) => frame.type === "extension_ui_request" && frame.method === "notify",
    saveFrom,
  );
  assert.equal(notice.notifyType, "error", "a stale draft must be refused, not report a successful save");
  assert.equal(readFileSync(oldFile, "utf8"), oldText);
  assert.equal(readFileSync(newFile, "utf8"), newText);
  dialog = await client.dialog(saveFrom);
  client.send({ type: "extension_ui_response", id: dialog.id, cancelled: true });
  await client.wait((frame) => frame.id === "editor" && frame.type === "prompt_result", from);
  console.log("PASS real same-ID project move refuses stale drafts in both projects");

  writeFileSync(newFile, JSON.stringify({ ["unknown\u001b[31m\nKEY"]: {} }));
  const badFrom = client.frames.length;
  client.send({ id: "invalid", type: "prompt", message: "/subagent-entropy worker" });
  const diagnostic = await client.wait(
    (frame) => frame.type === "extension_ui_request" && frame.method === "notify",
    badFrom,
  );
  assert.equal(diagnostic.notifyType, "error");
  assert.equal(typeof diagnostic.message, "string");
  assert.doesNotMatch(diagnostic.message as string, /[\u0000-\u001f\u007f-\u009f]/);
  console.log("PASS real command diagnostics cannot inject terminal controls");
} catch (error) {
  if (rpc) console.error(rpc.diagnostics());
  throw error;
} finally {
  if (rpc) {
    rpc.proc.kill("SIGTERM");
    await rpc.proc.exited;
    await rpc.reader;
    const stderr = await rpc.stderr;
    if (stderr.trim()) console.error(stderr);
  }
  fixture.stop(true);
  rmSync(root, { recursive: true, force: true });
}
