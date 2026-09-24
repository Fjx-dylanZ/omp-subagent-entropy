import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseConfig, type RoutingConfig, type RoutingRule } from "./config";

const MAX_CONFIG_BYTES = 1024 * 1024;

/*
 * Persistence for the interactive editor. A save re-reads the file and replaces only the edited
 * agent's entry, so role rules and other agents' rules changed elsewhere while a draft was open are
 * kept, and a change to the same agent is refused. The file is replaced by rename, so readers see
 * either the old or the new JSON, never a partial write.
 *
 * Limits: there is no cross-process lock. A write by another process that lands between a save's
 * re-read and its rename (milliseconds) is overwritten. Path checks and the write are separate
 * system calls, so a local process that swaps a checked directory for a link in that window can
 * cause empty directories to be created before the final check refuses the write.
 */

export interface RoutingDocument {
  readonly config: RoutingConfig;
}

/** The edited agent's rule on disk no longer matches the rule the editor started from. */
export class RoutingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConflictError";
  }
}

interface Loaded {
  raw: Record<string, unknown>;
  config: RoutingConfig;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function load(path: string): Loaded {
  // O_NONBLOCK avoids waiting for a writer when a project points this path at a FIFO.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("Routing configuration must be a regular file.");
    if (stats.size > MAX_CONFIG_BYTES) throw new Error("Routing configuration exceeds the 1 MiB limit.");
    // Bound the actual read, not only the stat: a concurrently growing file cannot
    // turn this in-process synchronous read into an unbounded allocation.
    const buffer = Buffer.allocUnsafe(stats.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stats.size) throw new Error("Routing configuration changed while reading. Try again.");
    raw = JSON.parse(buffer.toString("utf8", 0, length));
  } finally {
    closeSync(fd);
  }
  const config = parseConfig(raw);
  return { raw: raw as Record<string, unknown>, config };
}

/**
 * Reads and validates a routing file. A missing file is an empty configuration only when
 * `allowMissing` is set (the default path); an explicitly selected missing file is an error.
 */
export function readRoutingDocument(path: string, allowMissing: boolean): RoutingDocument {
  try {
    return { config: load(path).config };
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT")
      return { config: { agents: new Map(), roles: new Map() } };
    throw error;
  }
}

function sameRule(a: RoutingRule | undefined, b: RoutingRule | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.mode !== b.mode) return false;
  if (!a.weights || !b.weights) return a.weights === b.weights;
  if (a.weights.size !== b.weights.size) return false;
  for (const [selector, weight] of a.weights) {
    if (b.weights.get(selector) !== weight) return false;
  }
  return true;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

interface Target {
  /** Canonical directory, possibly not yet created. */
  dir: string;
  file: string;
  /** Permission bits of the existing regular file. */
  mode?: number;
}

/**
 * Resolves where a save may write without creating anything. The directory is canonicalized through
 * its nearest existing ancestor, so links (including dangling ones) above absent directories are
 * judged before any mkdir. The file itself must be absent or a regular file, never a link.
 */
function writeTarget(path: string, projectDir: string): Target {
  const root = realpathSync(projectDir);
  const requested = resolve(projectDir, path);
  const missing: string[] = [];
  let existing = dirname(requested);
  while (!lexists(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  let dir: string;
  try {
    dir = join(realpathSync(existing), ...missing);
  } catch (error) {
    throw new Error(
      `Refusing to write ${requested}: cannot resolve ${existing}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const file = join(dir, basename(requested));
  const inside = relative(root, file);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(
      `Refusing to write ${requested}: it resolves to ${file}, outside the project directory ${root}`,
    );
  }
  let stats: Stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { dir, file };
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`Refusing to write ${requested}: ${file} is a symbolic link`);
  if (!stats.isFile()) throw new Error(`Refusing to write ${requested}: ${file} is not a regular file`);
  return { dir, file, mode: stats.mode & 0o777 };
}

/**
 * Replaces `path` with `content` through an exclusively created temporary file in the same
 * directory. On failure the temporary file is removed and `path` is untouched.
 */
export function writeFileAtomic(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", mode);
  try {
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}

/**
 * Sets (or with `rule` undefined, removes) one agent's rule in the project-local routing file and
 * returns the document now on disk, which becomes the caller's next snapshot.
 *
 * The agent's rule on disk must still equal `snapshot`'s; otherwise nothing is written and a
 * RoutingConflictError is thrown. Malformed files are never overwritten. Paths resolving outside
 * `projectDir`, through escaping links, or to a link are refused before anything is created.
 */
export function saveAgentRule(
  path: string,
  snapshot: RoutingDocument,
  agent: string,
  rule: RoutingRule | undefined,
  projectDir: string,
): RoutingDocument {
  const target = writeTarget(path, projectDir);
  let latest: Loaded | undefined;
  try {
    latest = load(target.file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new Error(`Refusing to overwrite ${target.file}: ${(error as Error).message}`, { cause: error });
    }
  }

  const current = latest?.config.agents.get(agent);
  if (!sameRule(snapshot.config.agents.get(agent), current)) {
    throw new RoutingConflictError(
      `Routing for agent ${JSON.stringify(agent)} changed in ${target.file} after the editor opened; ` +
        "nothing was saved. Reopen the editor to edit the current rule.",
    );
  }
  if (sameRule(current, rule)) return { config: latest?.config ?? { agents: new Map(), roles: new Map() } };

  const raw = latest?.raw ?? {};
  const agents = Object.entries((raw.agents ?? {}) as Record<string, unknown>);
  const index = agents.findIndex(([name]) => name === agent);
  if (rule) {
    const entry: [string, unknown] = [
      agent,
      rule.weights ? { mode: rule.mode, weights: Object.fromEntries(rule.weights) } : { mode: rule.mode },
    ];
    if (index < 0) agents.push(entry);
    else agents[index] = entry;
  } else {
    agents.splice(index, 1);
  }
  const next: Record<string, unknown> = { ...raw, agents: Object.fromEntries(agents) };
  if (agents.length === 0) delete next.agents;
  const config = parseConfig(next);
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Routing configuration exceeds the 1 MiB limit.");
  }

  mkdirSync(target.dir, { recursive: true });
  if (realpathSync(target.dir) !== target.dir) {
    throw new Error(`Refusing to write ${target.file}: ${target.dir} was replaced by a link while saving`);
  }
  writeFileAtomic(target.file, content, target.mode ?? 0o600);
  return { config };
}
