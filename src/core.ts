/**
 * herdr-core backend: terminals run by `hc`, arranged by the Herdr desktop app
 * (`herdr-app`). Also decides, per call, whether a tool talks to herdr-core or
 * to the older Herdr TUI (`herdr`).
 */
import { randomBytes } from "node:crypto";
import { HerdrError, coreRpc, runApp, runHc, runHerdr } from "./herdr.js";

export type Backend = "core" | "tui";

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** `t7`, `t1b`, `vps/t7`: a herdr-core terminal address. */
const CORE_ADDRESS = /^([A-Za-z0-9][\w.-]*\/)?t\d+[a-z0-9]*$/;
/** App ids: panes `p<hex>`, tabs `tb<hex>`, spaces `sp<hex>` (optionally `machine/`-prefixed). */
const APP_PANE = /^([\w.-]+\/)?p[0-9a-f]{16,}$/;
const APP_TAB = /^([\w.-]+\/)?tb[0-9a-z]{4,}$/;
const APP_SPACE = /^([\w.-]+\/)?sp[0-9a-z]{4,}$/;
/** TUI ids: workspaces `w6`, panes/tabs `w6:pQ`, terminals `term_…`. */
const TUI_ID = /^(w\d+(:.*)?|term_.+)$/;

/** Default backend when nothing in the call decides it. */
export function preferredBackend(): Backend {
  const forced = process.env.HERDR_MESH_BACKEND;
  if (forced === "core" || forced === "tui") return forced;
  return process.env.HC_TERMINAL_ID ? "core" : "tui";
}

export function explicitBackend(a: Record<string, unknown>): Backend | undefined {
  return a.backend === "core" || a.backend === "tui" ? a.backend : undefined;
}

/** Which backend owns a tab or workspace id. */
export function backendForContainer(id: string | undefined, a: Record<string, unknown>): Backend {
  const explicit = explicitBackend(a);
  if (explicit) return explicit;
  if (id) {
    if (TUI_ID.test(id)) return "tui";
    if (APP_TAB.test(id) || APP_SPACE.test(id)) return "core";
  }
  return preferredBackend();
}

async function succeeds(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide which backend owns a terminal/pane/agent target. Unambiguous ids
 * decide by shape; names are probed, herdr-core first when running in a core
 * terminal (HC_TERMINAL_ID), else the TUI first.
 */
export async function backendForTarget(target: string, a: Record<string, unknown>): Promise<Backend> {
  const explicit = explicitBackend(a);
  if (explicit) return explicit;
  if (CORE_ADDRESS.test(target) || APP_PANE.test(target)) return "core";
  if (TUI_ID.test(target)) return "tui";
  const order: Backend[] = preferredBackend() === "core" ? ["core", "tui"] : ["tui", "core"];
  for (const b of order) {
    if (b === "core" && (await succeeds(runHc(["get", target])))) return "core";
    if (
      b === "tui" &&
      ((await succeeds(runHerdr(["agent", "get", target]))) || (await succeeds(runHerdr(["pane", "get", target]))))
    ) {
      return "tui";
    }
  }
  throw new HerdrError(`no herdr-core terminal or Herdr TUI pane/agent matches "${target}"`);
}

// ---------------------------------------------------------------------------
// herdr-core terminals
// ---------------------------------------------------------------------------

export interface Terminal {
  address: string;
  name?: string | null;
  state?: string;
  /** OSC 7501 record: `{state: "idle"|"working"|...}`, or null when none reported. */
  status?: { state?: string; [key: string]: unknown } | string | null;
  reported?: boolean;
  labels?: Record<string, string>;
  parent?: string | null;
  turn?: number;
  cwd?: string;
  [key: string]: unknown;
}

/** A terminal's status word (idle, working, done, blocked, error), or null. */
export function statusWord(t: Terminal): string | null {
  const s = t.status;
  if (!s) return null;
  return typeof s === "string" ? s : (s.state ?? null);
}

/** The caller's own terminal, when the agent runs in herdr-core. */
export function selfTerminal(): string | undefined {
  return process.env.HC_TERMINAL_ID || undefined;
}

/** Turn an app pane id into the terminal it shows; other targets pass through. */
export async function terminalOf(target: string): Promise<string> {
  if (!APP_PANE.test(target)) return target;
  const found = (await appPanes()).find((p) => p.pane === target);
  if (!found) throw new HerdrError(`no Herdr app pane "${target}"`);
  if (!found.terminal) throw new HerdrError(`pane "${target}" shows a mod, not a terminal`);
  return found.terminal;
}

export async function hcGet(target: string): Promise<Terminal> {
  return (await runHc(["get", target])).json as Terminal;
}

export async function hcList(all = false): Promise<Terminal[]> {
  const res = (await runHc(all ? ["ls", "--all"] : ["ls"])).json as { terminals?: Terminal[] };
  return res?.terminals ?? [];
}

/** Read a terminal: `visible` = the screen, else `lines` of history too; trimmed to `lines`. */
export async function hcRead(target: string, source: string | undefined, lines: number): Promise<string> {
  const history = source && source !== "visible" ? lines : 0;
  const res = (await runHc(["read", target, "--lines", String(history)], { timeoutMs: 60_000 })).json as {
    text?: string;
    complete?: boolean;
    why?: string;
  };
  const text = (res?.text ?? "").replace(/\s+$/, "");
  const tail = text.split("\n").slice(-lines).join("\n");
  return res?.complete === false ? `${tail}\n\n[incomplete read: ${res.why ?? "unknown"}]` : tail;
}

/** hc key names use `ctrl+c`; the TUI used `ctrl-c`. Accept both. */
export function hcKey(key: string): string {
  return key.replace(/^((?:(?:ctrl|alt|shift|meta|super|cmd|option)[-+])+)(.+)$/i, (_m, mods: string, k: string) =>
    mods.replace(/-/g, "+") + k,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does a terminal's reported status satisfy a TUI-style status? */
function statusMatches(want: string, status: string | null): boolean {
  switch (want) {
    case "idle":
    case "done":
      return status === "idle" || status === "done";
    case "unknown":
      return status === null || status === undefined;
    default:
      return status === want;
  }
}

/**
 * Wait until a terminal reports `want` (idle/working/blocked/done/unknown),
 * exits, or the timeout passes. Uses `hc wait` while it is working, polls otherwise.
 */
export async function hcWaitStatus(
  target: string,
  want: string,
  timeoutMs: number,
): Promise<{ reached: boolean; terminal: Terminal }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await hcGet(target);
    if (statusMatches(want, statusWord(t))) return { reached: true, terminal: t };
    if (t.state !== "live") return { reached: false, terminal: t };
    const left = deadline - Date.now();
    if (left <= 0) return { reached: false, terminal: t };
    if (statusWord(t) === "working" && want !== "working") {
      const secs = Math.max(1, Math.ceil(left / 1000));
      await runHc(["wait", target, "--timeout", String(secs)], { timeoutMs: left + 15_000 }).catch(() => {});
    } else {
      await sleep(Math.min(500, left));
    }
  }
}

// ---------------------------------------------------------------------------
// Herdr desktop app: spaces > tabs > panes
// ---------------------------------------------------------------------------

export interface AppTerminal {
  terminal: string | null;
  pane: string;
  status?: string | null;
  name?: string | null;
  sub_agents?: unknown[];
  [key: string]: unknown;
}
export interface AppTab {
  id: string;
  name: string | null;
  active?: boolean;
  settled?: boolean;
  terminals: AppTerminal[];
}
export interface AppSpace {
  id: string;
  name: string | null;
  folder?: string | null;
  machine?: string | null;
  active?: boolean;
  tabs: AppTab[];
}
export interface AppStatus {
  space: string | null;
  tab: string | null;
  focused_pane: string | null;
  [key: string]: unknown;
}

export async function appLs(): Promise<AppSpace[]> {
  const json = (await runApp(["ls"])).json as { spaces?: AppSpace[] };
  return json?.spaces ?? [];
}

export async function appStatus(): Promise<AppStatus> {
  return (await runApp(["status"])).json as AppStatus;
}

/** Run an app command with one JSON object of arguments; returns its JSON reply. */
export async function appDo(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const res = await runApp(["do", command, JSON.stringify(clean)]);
  const json = res.json as { error?: string } | undefined;
  if (json && typeof json === "object" && "error" in json && json.error) {
    throw new HerdrError(`herdr-app do ${command} failed: ${json.error}`);
  }
  return json ?? res.stdout.trim();
}

export interface PaneInfo {
  pane: string;
  terminal: string | null;
  space_id: string;
  space_name: string | null;
  tab_id: string;
  tab_name: string | null;
}

/** Every pane in the window, flattened with its tab and space. */
export async function appPanes(spaces?: AppSpace[]): Promise<PaneInfo[]> {
  const out: PaneInfo[] = [];
  for (const s of spaces ?? (await appLs())) {
    for (const t of s.tabs) {
      for (const p of t.terminals) {
        out.push({
          pane: p.pane,
          terminal: p.terminal,
          space_id: s.id,
          space_name: s.name,
          tab_id: t.id,
          tab_name: t.name,
        });
      }
    }
  }
  return out;
}

/** The pane showing a terminal (or pane id), or undefined when it has none. */
export async function paneOf(target: string, spaces?: AppSpace[]): Promise<PaneInfo | undefined> {
  const panes = await appPanes(spaces);
  if (APP_PANE.test(target)) return panes.find((p) => p.pane === target);
  let address = target;
  if (!CORE_ADDRESS.test(target)) address = (await hcGet(target)).address;
  return panes.find((p) => p.terminal === address);
}

export async function requirePane(target: string, spaces?: AppSpace[]): Promise<PaneInfo> {
  const p = await paneOf(target, spaces);
  if (!p) {
    throw new HerdrError(
      `terminal "${target}" has no pane in the Herdr app (a background or sub-agent terminal); ` +
        `give it one with herdr_pane_move (new_tab) first`,
    );
  }
  return p;
}

export async function findTab(id: string): Promise<{ space: AppSpace; tab: AppTab }> {
  for (const space of await appLs()) {
    const tab = space.tabs.find((t) => t.id === id);
    if (tab) return { space, tab };
  }
  throw new HerdrError(`no Herdr app tab "${id}"`);
}

export async function findSpace(id: string): Promise<AppSpace> {
  const space = (await appLs()).find((s) => s.id === id);
  if (!space) throw new HerdrError(`no Herdr app space "${id}"`);
  return space;
}

/** A fresh id in the app's style, for labels that make a new space or tab. */
export function newAppId(prefix: "sp" | "tb"): string {
  return prefix + randomBytes(16).toString("hex");
}

/** Put the user's view back on a tab after a command that switched it. */
export async function restoreView(before: AppStatus): Promise<void> {
  const now = await appStatus().catch(() => undefined);
  if (!now) return;
  if (before.space && now.space !== before.space) await appDo("space.select", { id: before.space }).catch(() => {});
  if (before.tab && now.tab !== before.tab) await appDo("tab.select", { id: before.tab }).catch(() => {});
  if (before.focused_pane && now.focused_pane !== before.focused_pane) {
    await appDo("pane.focus", { pane: before.focused_pane }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Layout geometry, from the app's layout document in the core
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string;
  type: "row" | "column" | "block" | string;
  children?: LayoutNode[];
  content?: { terminal?: string; mod?: string; [key: string]: unknown };
  size?: { weight?: number; px?: number };
}

export interface PaneRect {
  pane_id: string;
  terminal: string | null;
  mod?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
}

export interface TabLayout {
  space_id: string;
  tab_id: string;
  panes: PaneRect[];
  root: LayoutNode;
}

async function layoutDoc(): Promise<{ spaces?: Array<{ id: string; tabs: Array<{ id: string; root: LayoutNode }> }> }> {
  const res = (await coreRpc("doc.get", { name: "herdr-app" })) as { value?: unknown };
  return (res?.value ?? {}) as Awaited<ReturnType<typeof layoutDoc>>;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function rects(node: LayoutNode, x: number, y: number, w: number, h: number, out: PaneRect[], focused: string | null) {
  if (node.type === "block" || !node.children?.length) {
    out.push({
      pane_id: node.id,
      terminal: node.content?.terminal ?? null,
      ...(node.content?.mod ? { mod: String(node.content.mod) } : {}),
      x: round(x),
      y: round(y),
      width: round(w),
      height: round(h),
      focused: node.id === focused,
    });
    return;
  }
  const kids = node.children;
  const weights = kids.map((k) => k.size?.weight ?? 1 / kids.length);
  const total = weights.reduce((s, v) => s + v, 0) || 1;
  let offset = 0;
  kids.forEach((k, i) => {
    const share = weights[i] / total;
    if (node.type === "column") rects(k, x, y + offset * h, w, share * h, out, focused);
    else rects(k, x + offset * w, y, share * w, h, out, focused);
    offset += share;
  });
}

/** The split layout of the tab holding `pane` (fractions of the tab, 0..1). */
export async function tabLayout(pane: PaneInfo): Promise<TabLayout> {
  const doc = await layoutDoc();
  const space = doc.spaces?.find((s) => s.id === pane.space_id || pane.space_id.endsWith(`/${s.id}`));
  const tab = space?.tabs.find((t) => t.id === pane.tab_id || pane.tab_id.endsWith(`/${t.id}`));
  if (!tab) throw new HerdrError(`no layout for tab "${pane.tab_id}" (remote spaces aren't supported yet)`);
  const status = await appStatus().catch(() => undefined);
  const panes: PaneRect[] = [];
  rects(tab.root, 0, 0, 1, 1, panes, status?.tab === pane.tab_id ? status.focused_pane : null);
  return { space_id: pane.space_id, tab_id: pane.tab_id, panes, root: tab.root };
}

const EPS = 0.002;

/** The pane next to `paneId` in a direction: the one sharing the most edge. */
export function neighbor(layout: TabLayout, paneId: string, direction: string): PaneRect | undefined {
  const me = layout.panes.find((p) => p.pane_id === paneId);
  if (!me) return undefined;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
  let best: PaneRect | undefined;
  let bestOverlap = EPS;
  for (const p of layout.panes) {
    if (p.pane_id === paneId) continue;
    let touches = false;
    let ov = 0;
    if (direction === "right") {
      touches = Math.abs(p.x - (me.x + me.width)) < EPS;
      ov = overlap(me.y, me.y + me.height, p.y, p.y + p.height);
    } else if (direction === "left") {
      touches = Math.abs(p.x + p.width - me.x) < EPS;
      ov = overlap(me.y, me.y + me.height, p.y, p.y + p.height);
    } else if (direction === "down") {
      touches = Math.abs(p.y - (me.y + me.height)) < EPS;
      ov = overlap(me.x, me.x + me.width, p.x, p.x + p.width);
    } else if (direction === "up") {
      touches = Math.abs(p.y + p.height - me.y) < EPS;
      ov = overlap(me.x, me.x + me.width, p.x, p.x + p.width);
    }
    if (touches && ov > bestOverlap) {
      best = p;
      bestOverlap = ov;
    }
  }
  return best;
}

export function edges(layout: TabLayout, paneId: string) {
  const me = layout.panes.find((p) => p.pane_id === paneId);
  if (!me) throw new HerdrError(`pane "${paneId}" is not in tab "${layout.tab_id}"`);
  return {
    left: me.x < EPS,
    top: me.y < EPS,
    right: me.x + me.width > 1 - EPS,
    bottom: me.y + me.height > 1 - EPS,
  };
}
