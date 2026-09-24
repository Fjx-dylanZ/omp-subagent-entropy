#!/usr/bin/env bun
/**
 * Clean package-install smoke for omp-subagent-entropy (Docker `install-smoke` target).
 *
 * The `bun pm pack` release tarball is installed through the real `omp plugin install`. omp classifies a local
 * `.tgz` path as a directory to link (cli/classify-install-target.ts), so a TEST-ONLY loopback npm registry serves
 * the tarball and it is installed by name through omp's npm branch (`bun install --no-cache <name>@<version>` in
 * ~/.omp/plugins). Then, from fresh processes in a separate workspace and without any `--extension` flag:
 *   - registration persisted: omp-plugins.lock.json + plugins/package.json + a real (non-symlink) package dir;
 *   - no node_modules copy of the omp host packages is reachable from the installed plugin;
 *   - installed discovery registers `/subagent-entropy` (RPC get_available_commands, source "extension");
 *   - subagent routing works: tests/runtime.ts scenarios seeded with the installed plugins root.
 * Offline: loopback only, no credentials, no model inference.
 *
 * Usage: bun --no-install tests/install.ts [runtime scenario ...]   (default: round-robin weighted-batch)
 * Env: OMP_BIN (default /usr/local/bin/omp), ENTROPY_PACKAGE_DIR (default /opt/package: one *.tgz + SHA256SUMS),
 *      ENTROPY_SMOKE_KEEP_TMP=1 keeps temp dirs for debugging.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const OMP_BIN = process.env.OMP_BIN || "/usr/local/bin/omp";
const PACKAGE_DIR = process.env.ENTROPY_PACKAGE_DIR || "/opt/package";
const KEEP_TMP = process.env.ENTROPY_SMOKE_KEEP_TMP === "1";
const SCENARIOS = process.argv.length > 2 ? process.argv.slice(2) : ["round-robin", "weighted-batch"];
const RUNTIME = join(import.meta.dir, "runtime.ts");
const COMMAND = "subagent-entropy";
const PROVIDER = "install-fixture";
const MODEL = "parent-model";

/** Untrusted JSON shapes read from omp output/state; every used field is compared, never assumed. */
interface InstallResult {
  name?: unknown;
  version?: unknown;
  enabled?: unknown;
  path?: unknown;
}
interface PluginsLock {
  plugins?: Record<string, { version?: unknown; enabled?: unknown } | undefined>;
}
interface PluginsManifest {
  dependencies?: Record<string, unknown>;
}
interface RpcFrame {
  type?: unknown;
  id?: unknown;
  success?: unknown;
  data?: { commands?: unknown };
}
interface SlashCommand {
  name?: unknown;
  source?: unknown;
}

class Failure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-20).join("\n");
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const liveKills = new Set<() => void>();
let tempRoot: string | undefined;

function cleanup(): void {
  for (const kill of liveKills) kill();
  liveKills.clear();
  if (tempRoot && !KEEP_TMP) rmSync(tempRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function run(
  cmd: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => proc.kill("SIGKILL");
  liveKills.add(kill);
  const timer = setTimeout(kill, options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    liveKills.delete(kill);
  }
}

/** Minimal, credential-free omp environment rooted in `root` (mirrors tests/runtime.ts). */
function ompEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(root, "home");
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: home,
    TMPDIR: join(root, "tmp"),
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

// ---------------------------------------------------------------------------
// Artifact + loopback npm registry (test-only)
// ---------------------------------------------------------------------------

interface Artifact {
  path: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  /** npm registry `dist` digests of the tarball bytes. */
  dist: { integrity: string; shasum: string };
}

async function loadArtifact(root: string): Promise<Artifact> {
  const tarballs = readdirSync(PACKAGE_DIR).filter((file) => file.endsWith(".tgz"));
  const [file] = tarballs;
  assert(
    file && tarballs.length === 1,
    `${PACKAGE_DIR} must hold exactly one .tgz (found: ${tarballs.join(", ")})`,
  );
  const path = join(PACKAGE_DIR, file);
  const bytes = await Bun.file(path).bytes();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const sums = await readFile(join(PACKAGE_DIR, "SHA256SUMS"), "utf8");
  assert(
    sums.split("\n").some((line) => line.trim() === `${digest}  ${file}`),
    `SHA256SUMS does not list ${file} with sha256 ${digest}`,
  );
  const tools = { cwd: root, env: { PATH: process.env.PATH || "/usr/bin:/bin" }, timeoutMs: 30_000 };
  const listing = await run(["tar", "-tzf", path], tools);
  const packed = await run(["tar", "-xzOf", path, "package/package.json"], tools);
  assert(listing.code === 0 && packed.code === 0, `cannot read ${path}: ${listing.stderr}${packed.stderr}`);
  const manifest: Record<string, unknown> | null = JSON.parse(packed.stdout);
  const name = manifest?.name;
  const version = manifest?.version;
  assert(
    manifest && typeof name === "string" && typeof version === "string",
    "packed package.json lacks name/version",
  );
  console.log(`package: ${file} sha256=${digest}`);
  for (const entry of listing.stdout.trim().split("\n")) console.log(`  ${entry}`);
  const dist = {
    integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`,
    shasum: new Bun.CryptoHasher("sha1").update(bytes).digest("hex"),
  };
  return { path, name, version, manifest, dist };
}

/**
 * One loopback server: a single-package npm registry for the packed tarball, plus the model list of an
 * inference-free provider (`<url>v1`). Any other request (a dependency fetch, a completion) is recorded and 404s.
 */
function startLoopback(artifact: Artifact) {
  const { name, version, dist } = artifact;
  const tarballPath = `/${name}/-/${basename(artifact.path)}`;
  const stats = { tarballs: 0, unexpected: [] as string[] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      if (request.method === "GET" && path === `/${name}`) {
        const tarball = `${url.origin}${tarballPath}`;
        const versionDoc = { ...artifact.manifest, _id: `${name}@${version}`, dist: { ...dist, tarball } };
        return Response.json({ name, "dist-tags": { latest: version }, versions: { [version]: versionDoc } });
      }
      if (request.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: PROVIDER }] });
      }
      if (request.method === "GET" && path === tarballPath) {
        stats.tarballs++;
        return new Response(Bun.file(artifact.path), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      stats.unexpected.push(`${request.method} ${path}`);
      return new Response("not found", { status: 404 });
    },
  });
  return { url: server.url.href, stats, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Real `omp plugin install` from the loopback registry, then its persisted state. Returns the plugins root. */
async function installAndVerify(root: string, artifact: Artifact, registryUrl: string): Promise<string> {
  const spec = `${artifact.name}@${artifact.version}`;
  const pluginsDir = join(root, "home", ".omp", "plugins");
  const packageDir = join(pluginsDir, "node_modules", artifact.name);

  const install = await run([OMP_BIN, "plugin", "install", spec, "--json"], {
    cwd: join(root, "install-cwd"),
    env: ompEnv(root, { NPM_CONFIG_REGISTRY: registryUrl }),
    timeoutMs: 180_000,
  });
  assert(install.code === 0, `omp plugin install ${spec} exited ${install.code}\n${tail(install.stderr)}`);
  let result: InstallResult | null;
  try {
    result = JSON.parse(install.stdout);
  } catch {
    throw new Failure(`omp plugin install --json printed non-JSON:\n${tail(install.stdout)}`);
  }
  assert(
    result?.name === artifact.name &&
      result.version === artifact.version &&
      result.enabled === true &&
      result.path === packageDir,
    `unexpected install result (want ${spec} enabled at ${packageDir}): ${install.stdout.trim()}`,
  );
  console.log(`installed: ${spec} -> ${packageDir}`);

  const lock: PluginsLock | null = JSON.parse(
    await readFile(join(pluginsDir, "omp-plugins.lock.json"), "utf8"),
  );
  const entry = lock?.plugins?.[artifact.name];
  assert(
    entry?.version === artifact.version && entry.enabled === true,
    `omp-plugins.lock.json does not register ${spec} as enabled: ${JSON.stringify(lock)}`,
  );
  const manifest: PluginsManifest | null = JSON.parse(
    await readFile(join(pluginsDir, "package.json"), "utf8"),
  );
  assert(
    typeof manifest?.dependencies?.[artifact.name] === "string",
    `plugins/package.json lacks a ${artifact.name} dependency`,
  );
  assert(lstatSync(packageDir).isDirectory(), `${packageDir} must be a real installed directory, not a link`);

  for (let dir = packageDir; ; dir = dirname(dir)) {
    const hostCopy = join(dir, "node_modules", "@oh-my-pi");
    assert(!existsSync(hostCopy), `${hostCopy} would let the plugin bypass omp's bundled host modules`);
    if (dirname(dir) === dir) break;
  }
  return pluginsDir;
}

/** Fresh RPC session in a separate workspace; returns omp's slash-command catalog. */
async function availableCommands(root: string): Promise<SlashCommand[]> {
  const proc = Bun.spawn(
    [
      OMP_BIN,
      "--mode",
      "rpc",
      "--model",
      `${PROVIDER}/${MODEL}`,
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-title",
      "--session-dir",
      join(root, "sessions"),
    ],
    { cwd: join(root, "workspace"), env: ompEnv(root), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const kill = () => proc.kill("SIGKILL");
  liveKills.add(kill);
  const timer = setTimeout(kill, 120_000);
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let frame: RpcFrame | null;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame?.type === "ready") {
          proc.stdin.write(`${JSON.stringify({ id: "commands", type: "get_available_commands" })}\n`);
          proc.stdin.flush();
        } else if (frame?.type === "response" && frame.id === "commands") {
          const commands = frame.data?.commands;
          assert(
            frame.success === true && Array.isArray(commands),
            `get_available_commands failed: ${line.slice(0, 500)}`,
          );
          return commands;
        }
      }
    }
    throw new Failure(
      `omp --mode rpc exited ${await proc.exited} without a command list\n${tail(await stderr)}`,
    );
  } finally {
    clearTimeout(timer);
    proc.kill("SIGTERM");
    const force = setTimeout(kill, 5_000);
    await proc.exited;
    clearTimeout(force);
    liveKills.delete(kill);
  }
}

async function main(): Promise<number> {
  assert(
    existsSync(OMP_BIN),
    `omp binary not found at ${OMP_BIN}; run inside the install-smoke Docker image`,
  );
  const root = await mkdtemp(join(tmpdir(), "omp-entropy-install-"));
  tempRoot = root;
  const agentDir = join(root, "home", ".omp", "agent");
  for (const dir of [
    agentDir,
    join(root, "home", ".config"),
    join(root, "home", ".cache"),
    join(root, "home", ".local", "share"),
    join(root, "home", ".local", "state"),
    join(root, "tmp"),
    join(root, "sessions"),
    join(root, "install-cwd"),
    join(root, "workspace"),
  ]) {
    await mkdir(dir, { recursive: true });
  }

  const artifact = await loadArtifact(root);
  const loopback = startLoopback(artifact);
  try {
    const pluginsDir = await installAndVerify(root, artifact, loopback.url);
    assert(loopback.stats.tarballs > 0, "omp plugin install never fetched the packed tarball");

    // The RPC session needs a configured model, never inference; no external keys.
    const model = {
      id: MODEL,
      name: MODEL,
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 4096,
    };
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const provider = {
      baseUrl: `${loopback.url}v1`,
      auth: "none",
      api: "openai-completions",
      models: [{ ...model, cost }],
    };
    await writeFile(
      join(agentDir, "models.yml"),
      `${JSON.stringify({ providers: { [PROVIDER]: provider } })}\n`,
    );
    await writeFile(
      join(agentDir, "config.yml"),
      `${JSON.stringify({ modelRoles: { default: `${PROVIDER}/${MODEL}` } })}\n`,
    );
    const command = (await availableCommands(root)).find((item) => item?.name === COMMAND);
    assert(
      command?.source === "extension",
      `/${COMMAND} is not registered by installed discovery: ${JSON.stringify(command)}`,
    );
    console.log(`command: /${COMMAND} registered (source=extension) via installed discovery`);
    assert(
      loopback.stats.unexpected.length === 0,
      `unexpected loopback requests: ${loopback.stats.unexpected.join(", ")}`,
    );

    console.log(
      `routing: tests/runtime.ts ${SCENARIOS.join(" ")} with ENTROPY_SMOKE_PLUGINS_DIR=${pluginsDir}`,
    );
    const smoke = Bun.spawn([process.execPath, "--no-install", RUNTIME, ...SCENARIOS], {
      env: { ...process.env, ENTROPY_SMOKE_PLUGINS_DIR: pluginsDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const kill = () => smoke.kill("SIGTERM");
    liveKills.add(kill);
    const code = await smoke.exited;
    liveKills.delete(kill);
    assert(code === 0, `installed-plugin routing smoke exited ${code}`);
    console.log("\npackage install smoke passed");
    return 0;
  } finally {
    loopback.stop();
    if (KEEP_TMP) console.log(`temp root kept: ${root}`);
  }
}

main().then(
  (code) => {
    cleanup();
    process.exit(code);
  },
  (error) => {
    console.error(error instanceof Failure ? `\npackage install smoke FAILED: ${error.message}` : error);
    cleanup();
    process.exit(1);
  },
);
