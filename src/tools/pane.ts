import { z } from "zod";
import { runHc } from "../herdr.js";
import {
  appDo,
  appStatus,
  hcGet,
  hcKey,
  hcRead,
  paneOf,
  requirePane,
  restoreView,
  terminalOf,
} from "../core.js";
import { coreTerminals } from "./agent.js";
import {
  type ToolDef,
  ok,
  okJson,
  formatResult,
  sourceSchema,
  flag,
  boolFlag,
  byTarget,
  byContainer,
  unsupported,
} from "./types.js";

const paneIdSchema = z
  .string()
  .describe("Pane: Herdr TUI pane id (w1:p2), or on herdr-core a terminal address/name (t7) or Herdr app pane id.");

export const paneTools: ToolDef[] = [
  {
    name: "herdr_pane_list",
    description:
      "List panes, optionally filtered to a workspace. On herdr-core: live terminals with the app pane/tab/space showing each (workspace = app space id).",
    inputSchema: {
      workspace: z.string().optional().describe("Workspace id filter (TUI w1, or app space id)."),
    },
    buildArgs: (a) => {
      const argv = ["pane", "list"];
      flag(argv, "--workspace", a.workspace);
      return argv;
    },
    pick: byContainer("workspace"),
    core: async (a) => {
      const all = await coreTerminals();
      return okJson({ terminals: a.workspace ? all.filter((t) => t.workspace_id === a.workspace) : all });
    },
  },
  {
    name: "herdr_pane_get",
    description: "Get details for a pane.",
    inputSchema: { pane_id: paneIdSchema },
    buildArgs: (a) => ["pane", "get", String(a.pane_id)],
    pick: byTarget("pane_id"),
    core: async (a) => {
      const t = await hcGet(await terminalOf(String(a.pane_id)));
      return okJson({ ...t, pane: (await paneOf(t.address).catch(() => undefined)) ?? null });
    },
  },
  {
    name: "herdr_pane_read",
    description: "Read a pane's terminal output. Keep `lines` small to avoid flooding context.",
    inputSchema: {
      pane_id: paneIdSchema,
      source: sourceSchema,
      lines: z.number().int().positive().max(2000).optional(),
    },
    buildArgs: (a) => {
      const argv = ["pane", "read", String(a.pane_id)];
      flag(argv, "--source", a.source);
      flag(argv, "--lines", a.lines ?? 200);
      argv.push("--format", "text");
      return argv;
    },
    pick: byTarget("pane_id"),
    core: async (a) =>
      ok(await hcRead(await terminalOf(String(a.pane_id)), a.source as string | undefined, (a.lines as number) ?? 200)),
  },
  {
    name: "herdr_pane_split",
    description:
      "Split a pane to create a new one (direction right or down). On herdr-core the new pane runs a shell in the Herdr app.",
    inputSchema: {
      pane_id: paneIdSchema,
      direction: z.enum(["right", "down"]),
      cwd: z.string().optional(),
      focus: z.boolean().optional(),
    },
    buildArgs: (a) => {
      const argv = ["pane", "split", String(a.pane_id), "--direction", String(a.direction)];
      flag(argv, "--cwd", a.cwd);
      boolFlag(argv, "--focus", "--no-focus", a.focus);
      return argv;
    },
    pick: byTarget("pane_id"),
    core: async (a) => {
      const pane = await requirePane(String(a.pane_id));
      const before = await appStatus();
      let res: unknown;
      if (a.cwd) {
        // pane.split takes no folder; terminal.open does, beside the focused pane.
        await appDo("pane.focus", { pane: pane.pane });
        res = await appDo("terminal.open", { place: a.direction, folder: a.cwd });
      } else {
        res = await appDo("pane.split", { direction: a.direction, pane: pane.pane });
      }
      if (a.focus === false) await restoreView(before);
      return okJson(res);
    },
  },
  {
    name: "herdr_pane_run",
    description:
      "Run a command in a pane: writes the command text AND presses Enter. Use this (not herdr_agent_send) when you want to execute a shell command.",
    inputSchema: {
      pane_id: paneIdSchema,
      command: z.string().describe("Command to type and submit."),
    },
    buildArgs: (a) => ["pane", "run", String(a.pane_id), String(a.command)],
    pick: byTarget("pane_id"),
    core: async (a) =>
      ok(formatResult(await runHc(["send", await terminalOf(String(a.pane_id)), String(a.command)], { timeoutMs: 60_000 }))),
  },
  {
    name: "herdr_pane_send_text",
    description:
      "Send literal text to a pane without pressing Enter. Herdr TUI only (herdr-core always submits; use herdr_pane_run).",
    inputSchema: { pane_id: paneIdSchema, text: z.string() },
    buildArgs: (a) => ["pane", "send-text", String(a.pane_id), String(a.text)],
    pick: byTarget("pane_id"),
    core: async () =>
      unsupported("typing text without Enter; use herdr_pane_run (paste + Enter) or herdr_pane_send_keys"),
  },
  {
    name: "herdr_pane_send_keys",
    description:
      "Send one or more key names to a pane (e.g. 'enter', 'ctrl-c', 'escape'). On herdr-core single letters/digits and 'space' work too.",
    inputSchema: {
      pane_id: paneIdSchema,
      keys: z.array(z.string()).min(1).describe("Key names to send in order."),
    },
    buildArgs: (a) => ["pane", "send-keys", String(a.pane_id), ...(a.keys as string[])],
    pick: byTarget("pane_id"),
    core: async (a) =>
      ok(
        formatResult(
          await runHc(["keys", await terminalOf(String(a.pane_id)), ...(a.keys as string[]).map(hcKey)]),
        ),
      ),
  },
  {
    name: "herdr_pane_close",
    description:
      "Close a pane (terminates its processes). Re-check the target with herdr_pane_get first; never close your own pane unless asked. On herdr-core: ends the terminal (its pane closes) and removes it.",
    inputSchema: { pane_id: paneIdSchema },
    buildArgs: (a) => ["pane", "close", String(a.pane_id)],
    pick: byTarget("pane_id"),
    core: async (a) => {
      const t = await hcGet(await terminalOf(String(a.pane_id)));
      const killed = t.state === "live" ? (await runHc(["kill", t.address])).json : { already: t.state };
      const removed = await runHc(["rm", t.address])
        .then((r) => r.json)
        .catch((e) => ({ rm_error: String(e instanceof Error ? e.message : e) }));
      return okJson({ address: t.address, killed, removed });
    },
  },
  {
    name: "herdr_pane_rename",
    description:
      "Rename a pane label (or clear with clear=true). Herdr TUI only: herdr-core names terminals at creation.",
    inputSchema: {
      pane_id: paneIdSchema,
      label: z.string().optional(),
      clear: z.boolean().optional(),
    },
    buildArgs: (a) => {
      const argv = ["pane", "rename", String(a.pane_id)];
      if (a.clear) argv.push("--clear");
      else argv.push(String(a.label));
      return argv;
    },
    pick: byTarget("pane_id"),
    core: async () =>
      unsupported("panes can't be renamed; name terminals at creation (herdr_agent_start name) or rename the tab"),
  },
];
