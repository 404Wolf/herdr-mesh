import { execFile, spawn } from "node:child_process";

/** Herdr TUI CLI (panes, tabs, workspaces). */
const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";
/** herdr-core CLI (terminals). */
const HC_BIN = process.env.HC_BIN ?? "hc";
/** Herdr desktop app CLI (spaces, tabs, panes shown in the window). */
const HERDR_APP_BIN = process.env.HERDR_APP_BIN ?? "herdr-app";

const DEFAULT_TIMEOUT_MS = 30_000;
// herdr read/wait commands can block; give them generous headroom over the CLI's own --timeout.
const MAX_BUFFER = 8 * 1024 * 1024;

export interface HerdrResult {
  /** Parsed JSON object when the CLI emitted JSON, otherwise undefined. */
  json?: unknown;
  /** Raw stdout text (always present). */
  stdout: string;
  /** Raw stderr text. */
  stderr: string;
}

export class HerdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

/** Environment for hc: inside a herdr-core terminal, talk to the core that runs it. */
function hcEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.HC_SOCKET && env.HC_TERMINAL_SOCKET) env.HC_SOCKET = env.HC_TERMINAL_SOCKET;
  return env;
}

function runCli(
  bin: string,
  display: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; hint: string },
): Promise<HerdrResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HerdrResult>((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: MAX_BUFFER, encoding: "utf8", env: opts.env },
      (error, stdout, stderr) => {
        const out = stdout ?? "";
        const err = stderr ?? "";

        if (error) {
          // Distinguish "not installed" from a command-level failure.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(new HerdrError(`${display} CLI not found (tried "${bin}"). ${opts.hint}`));
            return;
          }
          if ((error as { killed?: boolean }).killed) {
            reject(
              new HerdrError(`${display} command timed out after ${timeout}ms: ${display} ${args.join(" ")}`),
            );
            return;
          }
          // Non-zero exit: surface stderr/stdout so the agent sees the real reason
          // (e.g. server not running, unknown target).
          const detail = (err || out || error.message).trim();
          reject(new HerdrError(`${display} ${args.join(" ")} failed: ${detail}`));
          return;
        }

        resolve({ json: tryParseJson(out), stdout: out, stderr: err });
      },
    );
  });
}

/**
 * Run a Herdr TUI CLI command and return its output.
 *
 * herdr prints newline-delimited JSON for most socket-API commands
 * (e.g. `{"id":...,"result":{...},"type":...}`). We parse the last JSON line
 * when possible and also return the raw stdout for non-JSON commands.
 */
export function runHerdr(args: string[], opts: { timeoutMs?: number } = {}): Promise<HerdrResult> {
  return runCli(HERDR_BIN, "herdr", args, {
    ...opts,
    hint: "Install it from https://herdr.dev or set HERDR_BIN to its path.",
  });
}

/** Run an `hc` (herdr-core) command with JSON output. */
export function runHc(args: string[], opts: { timeoutMs?: number } = {}): Promise<HerdrResult> {
  return runCli(HC_BIN, "hc", [...args, "--json"], {
    ...opts,
    env: hcEnv(),
    hint: "Install herdr-core or set HC_BIN to its path.",
  });
}

/** Run a `herdr-app` command (talks to the open Herdr window). */
export function runApp(args: string[], opts: { timeoutMs?: number } = {}): Promise<HerdrResult> {
  return runCli(HERDR_APP_BIN, "herdr-app", args, {
    ...opts,
    hint: "Install the Herdr desktop app or set HERDR_APP_BIN to its path.",
  });
}

/**
 * Call one herdr-core API method over `hc connect` (JSON-RPC over stdio).
 * Used for reads the CLI doesn't expose, such as the app's layout document.
 */
export function coreRpc(
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(HC_BIN, ["connect"], { env: hcEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new HerdrError(`hc connect: ${method} timed out after ${timeout}ms`))),
      timeout,
    );
    child.on("error", (e) => finish(() => reject(new HerdrError(`hc connect failed: ${e.message}`))));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string; data?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1) continue;
        if (msg.error) {
          const e = msg.error;
          finish(() => reject(new HerdrError(`hc ${method} failed: ${e.message} ${JSON.stringify(e.data ?? "")}`)));
        } else {
          finish(() => resolve(msg.result));
        }
      }
    });
    child.on("close", (code) =>
      finish(() => reject(new HerdrError(`hc connect exited (${code}) before answering ${method}: ${stderr.trim()}`))),
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

/** Parse the last non-empty line as JSON; herdr emits one JSON object per command. */
function tryParseJson(stdout: string): unknown {
  const whole = stdout.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try {
      return JSON.parse(whole); // herdr-app prints pretty (multi-line) JSON
    } catch {
      /* fall through to line-by-line */
    }
  }
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line);
      } catch {
        // not JSON after all; fall through
      }
    }
  }
  return undefined;
}
