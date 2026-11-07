import { z } from "zod";
import { runHc, runHerdr } from "../herdr.js";
import { appDo, appPanes, findSpace, findTab, hcGet, hcList, hcRead, hcWaitStatus, statusWord, newAppId, requirePane, selfTerminal, terminalOf, } from "../core.js";
import { ok, okJson, formatResult, explicit, targetSchema, sourceSchema, flag, boolFlag, byTarget, byContainer, unsupported, } from "./types.js";
/** Live core terminals with status, labels, parent and the app pane showing them. */
export async function coreTerminals() {
    const list = await hcList();
    const panes = await appPanes().catch(() => []);
    return Promise.all(list.map(async (t) => {
        const full = await hcGet(t.address).catch(() => t);
        const pane = panes.find((p) => p.terminal === t.address);
        return {
            address: full.address,
            name: full.name ?? null,
            agent: t.agent ?? null,
            state: full.state,
            status: statusWord(full),
            reported: full.reported ?? false,
            turn: full.turn,
            cwd: full.foreground?.cwd ?? full.cwd,
            parent: full.parent ?? null,
            labels: full.labels ?? {},
            pane_id: pane?.pane ?? null,
            tab_id: pane?.tab_id ?? null,
            tab_name: pane?.tab_name ?? null,
            workspace_id: pane?.space_id ?? null,
            workspace_name: pane?.space_name ?? null,
            self: full.address === selfTerminal(),
        };
    }));
}
/** Text output of a core read. */
async function coreRead(a, key, defSource) {
    const t = await terminalOf(String(a[key]));
    return ok(await hcRead(t, a.source ?? defSource, a.lines ?? 200));
}
const SEND_NO_ENTER = "herdr-core can only paste text and press Enter (hc send); use herdr_relay or herdr_pane_run to deliver it, or herdr_pane_send_keys for single keys";
export const agentTools = [
    {
        name: "herdr_agent_list",
        description: "List all agents herdr currently recognizes — any supported agent type (pi, omp, claude, codex, opencode, hermes, qodercli, …) — with semantic state (idle/working/blocked/done), cwd, pane/tab/workspace ids. Use this first to discover targets for other agent tools.",
        inputSchema: {},
        // Lists both backends (whichever answer), so agents can find each other mid-migration.
        handle: async (a) => {
            const want = explicit(a);
            const out = {};
            if (want !== "tui") {
                out.herdr_core = await coreTerminals()
                    .then((terminals) => ({ self: selfTerminal() ?? null, terminals }))
                    .catch((e) => ({ error: String(e instanceof Error ? e.message : e) }));
            }
            if (want !== "core") {
                out.herdr_tui = await runHerdr(["agent", "list"])
                    .then((r) => r.json ?? r.stdout.trim())
                    .catch((e) => ({ error: String(e instanceof Error ? e.message : e) }));
            }
            return okJson(out);
        },
    },
    {
        name: "herdr_agent_get",
        description: "Get details for a single agent (state, pane id, workspace, agent session).",
        inputSchema: { target: targetSchema },
        buildArgs: (a) => ["agent", "get", String(a.target)],
        pick: byTarget("target"),
        core: async (a) => {
            const t = await hcGet(await terminalOf(String(a.target)));
            const pane = await requirePane(t.address).catch(() => undefined);
            return okJson({ ...t, pane: pane ?? null });
        },
    },
    {
        name: "herdr_agent_read",
        description: "Read another agent's terminal output to gather context (contextual handoff). Defaults to the visible screen, which is the most reliable source. Keep `lines` small to avoid flooding context. To find valid targets first, call `herdr_agent_list`.",
        inputSchema: {
            target: targetSchema,
            source: sourceSchema,
            lines: z
                .number()
                .int()
                .positive()
                .max(2000)
                .optional()
                .describe("Number of trailing lines to read (default 200)."),
        },
        buildArgs: (a) => {
            const argv = ["agent", "read", String(a.target)];
            flag(argv, "--source", a.source ?? "visible");
            flag(argv, "--lines", a.lines ?? 200);
            argv.push("--format", "text");
            return argv;
        },
        pick: byTarget("target"),
        core: (a) => coreRead(a, "target", "visible"),
    },
    {
        name: "herdr_agent_send",
        description: "Low-level: write literal text to an agent WITHOUT pressing Enter (the text is typed but not submitted; Herdr TUI only, herdr-core can't type without submitting). For normal agent-to-agent messaging prefer `herdr_relay` (types + Enter) or `herdr_handoff` (send + wait + read). First call `herdr_agent_list` if you're unsure of the target.",
        inputSchema: {
            target: targetSchema,
            text: z.string().describe("Literal text to deliver to the agent."),
        },
        buildArgs: (a) => ["agent", "send", String(a.target), String(a.text)],
        pick: byTarget("target"),
        core: async () => unsupported(SEND_NO_ENTER),
    },
    {
        name: "herdr_agent_wait",
        description: "Block until an agent reaches a given status. Useful to synchronize a handoff (wait for the other agent to become idle/done before sending the next step).",
        inputSchema: {
            target: targetSchema,
            status: z
                .enum(["idle", "working", "blocked", "done", "unknown"])
                .describe("Status to wait for."),
            timeout_ms: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Max time to wait in milliseconds."),
        },
        // Allow the subprocess to outlive the requested CLI timeout.
        timeoutMs: 120_000,
        buildArgs: (a) => {
            const argv = ["agent", "wait", String(a.target), "--status", String(a.status)];
            flag(argv, "--timeout", a.timeout_ms);
            return argv;
        },
        pick: byTarget("target"),
        core: async (a) => {
            const t = await terminalOf(String(a.target));
            const r = await hcWaitStatus(t, String(a.status), a.timeout_ms ?? 100_000);
            return okJson({
                reached: r.reached,
                wanted: a.status,
                address: r.terminal.address,
                state: r.terminal.state,
                status: statusWord(r.terminal),
                turn: r.terminal.turn,
                exit_code: r.terminal.exit_code ?? null,
            });
        },
    },
    {
        name: "herdr_wait_output",
        description: "Block until a pane's output matches given text (or regex). Useful to wait for a build/command to finish in another agent's pane. On herdr-core only output printed after the wait starts counts.",
        inputSchema: {
            pane_id: z.string().describe("Pane id to watch."),
            match: z.string().describe("Text (or regex if `regex` is true) to wait for."),
            regex: z.boolean().optional().describe("Treat `match` as a regex."),
            source: sourceSchema,
            timeout_ms: z.number().int().positive().optional(),
        },
        timeoutMs: 120_000,
        buildArgs: (a) => {
            const argv = ["wait", "output", String(a.pane_id), "--match", String(a.match)];
            boolFlag(argv, "--regex", undefined, a.regex);
            flag(argv, "--source", a.source);
            flag(argv, "--timeout", a.timeout_ms);
            return argv;
        },
        pick: byTarget("pane_id"),
        core: async (a) => {
            const t = await terminalOf(String(a.pane_id));
            const match = String(a.match);
            const timeout = a.timeout_ms ?? 100_000;
            if (!a.regex) {
                // hc matches output printed after the wait starts (not text already on screen).
                const secs = Math.max(1, Math.ceil(timeout / 1000));
                const r = await runHc(["wait", t, "--output", match, "--timeout", String(secs)], {
                    timeoutMs: timeout + 15_000,
                });
                return ok(formatResult(r));
            }
            // Regex: hc has none, so poll and wait for a new match (more matches than at the start).
            const re = new RegExp(match, "gm");
            const count = async () => ((await hcRead(t, "recent", 400)).match(re) ?? []).length;
            const initial = await count();
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 1000));
                if ((await count()) > initial)
                    return ok(`matched /${match}/`);
            }
            return { content: [{ type: "text", text: `timed out waiting for /${match}/` }], isError: true };
        },
    },
    {
        name: "herdr_agent_start",
        description: "Start a new agent in a fresh terminal. Works with any agent (pi, omp, claude, codex, opencode, …). Provide the agent's launch command/argv. Optionally place it in a workspace/tab or split from the current pane. On herdr-core it runs via `hc run --bg` as your child: with workspace/tab/split it gets a pane in the Herdr app (workspace = app space id, tab = app tab id); without, it is a background sub-agent. Names on herdr-core: 1-32 of a-z 0-9 - _, unique among live terminals.",
        inputSchema: {
            name: z.string().describe("Name/label for the new agent terminal."),
            argv: z
                .array(z.string())
                .min(1)
                .describe("Command and arguments to launch the agent, e.g. ['claude'], ['codex'], ['opencode']."),
            cwd: z.string().optional().describe("Working directory for the new agent."),
            workspace: z.string().optional().describe("Workspace id to place the agent in."),
            tab: z.string().optional().describe("Tab id to place the agent in."),
            split: z
                .enum(["right", "down"])
                .optional()
                .describe("Split direction from the current pane."),
            focus: z.boolean().optional().describe("Focus the new agent (default: focus)."),
            outlive_parent: z
                .boolean()
                .optional()
                .describe("herdr-core only, background sub-agents: keep running when the calling agent ends (default false). Agents given a pane (workspace/tab/split) are never children and always outlive the caller."),
        },
        buildArgs: (a) => {
            const argv = ["agent", "start", String(a.name)];
            flag(argv, "--cwd", a.cwd);
            flag(argv, "--workspace", a.workspace);
            flag(argv, "--tab", a.tab);
            flag(argv, "--split", a.split);
            boolFlag(argv, "--focus", "--no-focus", a.focus);
            argv.push("--", ...a.argv);
            return argv;
        },
        pick: byContainer("tab", "workspace"),
        core: async (a) => {
            // Placement maps to app labels: a terminal labelled herdr.space/herdr.tab shows up there.
            const labels = {};
            let placed = "background sub-agent (no pane; the app lists it under its parent)";
            if (a.tab) {
                const { space, tab } = await findTab(String(a.tab));
                Object.assign(labels, { "herdr.space": space.id, "herdr.tab": tab.id });
                placed = `in tab ${tab.id}`;
            }
            else if (a.workspace) {
                const space = await findSpace(String(a.workspace));
                Object.assign(labels, { "herdr.space": space.id, "herdr.tab": newAppId("tb") });
                placed = `in a new tab of space ${space.id}`;
            }
            else if (a.split) {
                const me = selfTerminal();
                if (!me)
                    unsupported("split needs the caller's own terminal (HC_TERMINAL_ID)");
                const pane = await requirePane(me);
                Object.assign(labels, { "herdr.space": pane.space_id, "herdr.tab": pane.tab_id });
                placed = `beside ${me} in tab ${pane.tab_id} (the app picks the split side)`;
            }
            const hasPane = Object.keys(labels).length > 0;
            const argv = ["run", "--bg", "--name", String(a.name)];
            flag(argv, "--cwd", a.cwd);
            for (const [k, v] of Object.entries(labels))
                argv.push("--label", `${k}=${v}`);
            // The app shows a terminal with a parent as a sub-agent (no pane), so a placed
            // agent is started without one: a peer, like Herdr TUI agents.
            if (hasPane)
                argv.push("--keep", "--no-parent", "--label", "herdr.seen=0");
            else if (a.outlive_parent)
                argv.push("--outlive-parent");
            argv.push("--", ...a.argv);
            const started = (await runHc(argv)).json;
            let pane = null;
            if (hasPane) {
                for (let i = 0; i < 20 && !pane; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                    pane = (await appPanes().catch(() => [])).find((p) => p.terminal === started.address) ?? null;
                }
                if (!pane)
                    placed += "; the app has not shown it yet (is the Herdr window open?)";
                else if (a.focus !== false)
                    await appDo("agent.focus", { terminal: started.address }).catch(() => { });
            }
            return okJson({ started, placed, pane });
        },
    },
    {
        name: "herdr_agent_rename",
        description: "Rename an agent (or clear its name with clear=true). Herdr TUI only: herdr-core names are set at creation.",
        inputSchema: {
            target: targetSchema,
            name: z.string().optional().describe("New name. Omit and set clear=true to clear."),
            clear: z.boolean().optional(),
        },
        buildArgs: (a) => {
            const argv = ["agent", "rename", String(a.target)];
            if (a.clear)
                argv.push("--clear");
            else
                argv.push(String(a.name));
            return argv;
        },
        pick: byTarget("target"),
        core: async () => unsupported("terminals can't be renamed; names are given at creation (herdr_agent_start name)"),
    },
    {
        name: "herdr_agent_focus",
        description: "Focus an agent's pane in the herdr UI.",
        inputSchema: { target: targetSchema },
        buildArgs: (a) => ["agent", "focus", String(a.target)],
        pick: byTarget("target"),
        core: async (a) => {
            const t = await hcGet(await terminalOf(String(a.target)));
            return okJson(await appDo("agent.focus", { terminal: t.address }));
        },
    },
];
//# sourceMappingURL=agent.js.map