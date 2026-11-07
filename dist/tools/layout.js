import { z } from "zod";
import { runHerdr, runHc } from "../herdr.js";
import { appDo, appLs, appStatus, edges, findSpace, findTab, hcGet, neighbor, newAppId, paneOf, requirePane, restoreView, selfTerminal, tabLayout, terminalOf, } from "../core.js";
import { ok, okJson, flag, boolFlag, byTarget, unsupported } from "./types.js";
/** The app pane a layout tool acts on: the given one, else the caller's own. */
async function corePane(pane) {
    const target = pane || selfTerminal();
    if (!target)
        throw new Error("give pane_id (this agent is not in a herdr-core terminal)");
    return requirePane(target);
}
async function waitFor(probe, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe().catch(() => undefined);
        if (v)
            return v;
        if (Date.now() > deadline)
            return undefined;
        await new Promise((r) => setTimeout(r, 250));
    }
}
const DIRECTIONS = ["left", "right", "up", "down"];
const directionSchema = z.enum(["left", "right", "up", "down"]);
const paneRefSchema = z
    .string()
    .optional()
    .describe("Pane id (TUI w1:p2; herdr-core terminal t7/name or app pane id). Omit to use the calling agent's own pane (HERDR_PANE_ID / HC_TERMINAL_ID).");
/** `--pane ID`, or `--current` (the pane this MCP server's agent runs in). */
function paneRef(argv, pane) {
    if (pane)
        argv.push("--pane", String(pane));
    else
        argv.push("--current");
    return argv;
}
function focusedOf(json, key) {
    const list = json?.result?.[key];
    return Array.isArray(list) ? list.find((item) => item.focused) : undefined;
}
export const layoutTools = [
    {
        name: "herdr_where",
        description: "Where am I, and where is the user? Returns the calling agent's own pane/tab/workspace " +
            "ids and the workspace, tab, and pane the user currently has focused. They differ once " +
            "the user moves elsewhere; act on the user's focus only when they refer to 'this' or " +
            "'the one I'm in'.",
        inputSchema: {},
        run: async () => {
            const self = {
                pane_id: process.env.HERDR_PANE_ID ?? null,
                tab_id: process.env.HERDR_TAB_ID ?? null,
                workspace_id: process.env.HERDR_WORKSPACE_ID ?? null,
            };
            const workspace = focusedOf((await runHerdr(["workspace", "list"])).json, "workspaces");
            const workspaceId = workspace?.workspace_id;
            let tab;
            let pane;
            if (workspaceId) {
                tab = focusedOf((await runHerdr(["tab", "list", "--workspace", workspaceId])).json, "tabs");
                const panes = (await runHerdr(["pane", "list", "--workspace", workspaceId])).json;
                const list = panes?.result?.panes ?? [];
                pane = list.find((p) => p.focused && (!tab || p.tab_id === tab.tab_id));
            }
            return ok(JSON.stringify({
                self,
                user_focus: {
                    workspace: workspace ?? null,
                    tab: tab ?? null,
                    pane: pane ?? null,
                },
            }, null, 2));
        },
        core: async () => {
            const me = selfTerminal();
            const spaces = await appLs().catch(() => undefined);
            const status = await appStatus().catch(() => undefined);
            const pane = me && spaces ? await paneOf(me, spaces).catch(() => undefined) : undefined;
            const space = spaces?.find((s) => s.id === status?.space);
            const tab = space?.tabs.find((t) => t.id === status?.tab);
            const focused = tab?.terminals.find((p) => p.pane === status?.focused_pane);
            return okJson({
                self: {
                    terminal: me ?? null,
                    pane_id: pane?.pane ?? null,
                    tab_id: pane?.tab_id ?? null,
                    tab_name: pane?.tab_name ?? null,
                    workspace_id: pane?.space_id ?? null,
                    workspace_name: pane?.space_name ?? null,
                },
                user_focus: status
                    ? {
                        workspace: space ? { id: space.id, name: space.name, folder: space.folder } : null,
                        tab: tab ? { id: tab.id, name: tab.name } : null,
                        pane: status.focused_pane ? { pane_id: status.focused_pane, terminal: focused?.terminal ?? null } : null,
                    }
                    : "Herdr app not running",
            });
        },
    },
    {
        name: "herdr_pane_layout",
        description: "Show the split layout of a pane's tab: every pane's rect (x, y, width, height), the " +
            "splits, and which pane is focused. Use for 'the top-right pane' style references.",
        inputSchema: { pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "layout"], a.pane_id),
        pick: byTarget("pane_id"),
        core: async (a) => {
            const l = await tabLayout(await corePane(a.pane_id));
            return okJson({ space_id: l.space_id, tab_id: l.tab_id, panes: l.panes });
        },
    },
    {
        name: "herdr_pane_neighbor",
        description: "Find the pane next to a pane in a direction (e.g. 'the pane to my right'). " +
            "result.neighbor.neighbor_pane_id is absent when there is no pane that way; say so " +
            "instead of picking another pane.",
        inputSchema: { direction: directionSchema, pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "neighbor", "--direction", String(a.direction)], a.pane_id),
        pick: byTarget("pane_id"),
        core: async (a) => {
            const pane = await corePane(a.pane_id);
            const n = neighbor(await tabLayout(pane), pane.pane, String(a.direction));
            return okJson({
                result: {
                    neighbor: {
                        pane_id: pane.pane,
                        terminal: pane.terminal,
                        direction: a.direction,
                        ...(n ? { neighbor_pane_id: n.pane_id, neighbor_terminal: n.terminal } : {}),
                    },
                },
            });
        },
    },
    {
        name: "herdr_pane_edges",
        description: "Which outer edges of its tab a pane touches (true = on that edge).",
        inputSchema: { pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "edges"], a.pane_id),
        pick: byTarget("pane_id"),
        core: async (a) => {
            const pane = await corePane(a.pane_id);
            return okJson({ pane_id: pane.pane, terminal: pane.terminal, edges: edges(await tabLayout(pane), pane.pane) });
        },
    },
    {
        name: "herdr_pane_focus",
        description: "Move the user's focus to the neighboring pane in a direction.",
        inputSchema: { direction: directionSchema, pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "focus", "--direction", String(a.direction)], a.pane_id),
        pick: byTarget("pane_id"),
        core: async (a) => {
            const pane = await corePane(a.pane_id);
            const n = neighbor(await tabLayout(pane), pane.pane, String(a.direction));
            if (!n)
                throw new Error(`no pane ${a.direction} of ${pane.pane}`);
            await appDo("pane.focus", { pane: n.pane_id });
            return okJson({ focused: n.pane_id, terminal: n.terminal });
        },
    },
    {
        name: "herdr_pane_swap",
        description: "Swap two panes: either a pane with its neighbor in `direction`, or `source_pane` with " +
            "`target_pane`. Swapping always moves the user's focus; note it first (herdr_where) and " +
            "restore it with herdr_tab_focus / herdr_workspace_focus if needed.",
        inputSchema: {
            direction: directionSchema.optional(),
            pane_id: paneRefSchema,
            source_pane: z.string().optional(),
            target_pane: z.string().optional(),
        },
        buildArgs: (a) => {
            if (a.source_pane || a.target_pane) {
                if (!a.source_pane || !a.target_pane) {
                    throw new Error("source_pane and target_pane must be given together");
                }
                return [
                    "pane",
                    "swap",
                    "--source-pane",
                    String(a.source_pane),
                    "--target-pane",
                    String(a.target_pane),
                ];
            }
            if (!a.direction)
                throw new Error("give direction, or source_pane and target_pane");
            return paneRef(["pane", "swap", "--direction", String(a.direction)], a.pane_id);
        },
        pick: byTarget("source_pane", "pane_id"),
        core: async (a) => {
            // The app swaps the focused pane with its neighbor, so focus the source first.
            let pane;
            let direction;
            if (a.source_pane || a.target_pane) {
                if (!a.source_pane || !a.target_pane)
                    throw new Error("source_pane and target_pane must be given together");
                pane = await requirePane(String(a.source_pane));
                const target = await requirePane(String(a.target_pane));
                if (target.tab_id !== pane.tab_id)
                    unsupported("swapping panes in different tabs (use herdr_pane_move)");
                const layout = await tabLayout(pane);
                direction = DIRECTIONS.find((d) => neighbor(layout, pane.pane, d)?.pane_id === target.pane);
                if (!direction)
                    unsupported("swapping panes that aren't next to each other");
            }
            else {
                if (!a.direction)
                    throw new Error("give direction, or source_pane and target_pane");
                pane = await corePane(a.pane_id);
                direction = String(a.direction);
                if (!neighbor(await tabLayout(pane), pane.pane, direction))
                    throw new Error(`no pane ${direction} of ${pane.pane}`);
            }
            const at = (l) => l.panes.find((p) => p.terminal === pane.terminal);
            const before = at(await tabLayout(pane));
            await appDo("pane.focus", { pane: pane.pane });
            const res = await appDo("pane.swap", { direction });
            const after = at(await tabLayout(pane));
            const moved = !!before && !!after && (before.x !== after.x || before.y !== after.y);
            return {
                ...okJson({
                    swapped: moved,
                    pane_id: pane.pane,
                    terminal: pane.terminal,
                    direction,
                    result: res,
                    ...(moved
                        ? {}
                        : {
                            note: "the app reported ok but the layout did not change: it swaps using the panes it last drew, so the Herdr window must be on screen",
                        }),
                }),
                isError: !moved,
            };
        },
    },
    {
        name: "herdr_pane_move",
        description: "Move a pane, keeping its processes running: into an existing tab (tab + split), into " +
            "a new tab (new_tab, optionally in `workspace`), or into a new workspace " +
            "(new_workspace). The pane may get a new id; read it from the result. A tab left " +
            "empty closes. Defaults to focus=false so the user's view is not hijacked.",
        inputSchema: {
            pane_id: z.string(),
            tab: z.string().optional().describe("Destination tab id."),
            split: z.enum(["right", "down"]).optional().describe("Split direction inside `tab`."),
            target_pane: z.string().optional().describe("Pane in `tab` to split next to."),
            ratio: z.number().positive().lt(1).optional(),
            new_tab: z.boolean().optional(),
            new_workspace: z.boolean().optional(),
            workspace: z.string().optional().describe("Workspace for new_tab."),
            label: z.string().optional(),
            tab_label: z.string().optional().describe("Tab label for new_workspace."),
            focus: z.boolean().optional(),
        },
        buildArgs: (a) => {
            const argv = ["pane", "move", String(a.pane_id)];
            const modes = [a.tab !== undefined, a.new_tab === true, a.new_workspace === true];
            if (modes.filter(Boolean).length !== 1) {
                throw new Error("give exactly one of tab, new_tab, or new_workspace");
            }
            if (a.tab !== undefined) {
                argv.push("--tab", String(a.tab), "--split", String(a.split ?? "right"));
                flag(argv, "--target-pane", a.target_pane);
                flag(argv, "--ratio", a.ratio);
            }
            else if (a.new_tab) {
                argv.push("--new-tab");
                flag(argv, "--workspace", a.workspace);
                flag(argv, "--label", a.label);
            }
            else {
                argv.push("--new-workspace");
                flag(argv, "--label", a.label);
                flag(argv, "--tab-label", a.tab_label);
            }
            boolFlag(argv, "--focus", "--no-focus", a.focus ?? false);
            return argv;
        },
        pick: byTarget("pane_id"),
        core: async (a) => {
            // The app adopts terminals by their herdr.space/herdr.tab labels: park the
            // terminal (pane removed, program keeps running), relabel it, let the app adopt it.
            const modes = [a.tab !== undefined, a.new_tab === true, a.new_workspace === true];
            if (modes.filter(Boolean).length !== 1)
                throw new Error("give exactly one of tab, new_tab, or new_workspace");
            const address = (await hcGet(await terminalOf(String(a.pane_id)))).address;
            const before = await appStatus();
            const current = await paneOf(address).catch(() => undefined);
            const notes = [];
            let space;
            let tab;
            if (a.tab !== undefined) {
                const found = await findTab(String(a.tab));
                if (found.tab.id === current?.tab_id)
                    throw new Error(`${address} is already in tab ${found.tab.id}`);
                space = found.space.id;
                tab = found.tab.id;
                if (a.split || a.target_pane || a.ratio)
                    notes.push("split/target_pane/ratio ignored: the app places it");
            }
            else if (a.new_tab) {
                const sp = a.workspace ? (await findSpace(String(a.workspace))).id : (current?.space_id ?? before.space);
                if (!sp)
                    throw new Error("give workspace (no current space)");
                space = sp;
                tab = newAppId("tb");
            }
            else {
                space = newAppId("sp");
                tab = newAppId("tb");
            }
            if (space.includes("/"))
                unsupported("moving terminals between machines' spaces");
            if (current) {
                await appDo("terminal.park", { terminal: address });
                await waitFor(async () => !(await hcGet(address)).labels?.["herdr.tab"] || undefined, 5000);
            }
            await runHc(["label", address, `herdr.space=${space}`, `herdr.tab=${tab}`]);
            const landed = await waitFor(async () => {
                const p = await paneOf(address);
                return p && p.tab_id === tab ? p : undefined;
            }, 8000);
            if (!landed)
                notes.push("the app has not shown it yet (is the Herdr window open?)");
            if (a.new_workspace && a.label)
                await appDo("space.rename", { id: space, name: a.label });
            if (a.new_workspace && a.tab_label)
                await appDo("tab.rename", { id: tab, name: a.tab_label });
            if (a.new_tab && a.label)
                await appDo("tab.rename", { id: tab, name: a.label });
            if (a.focus)
                await appDo("pane.focus", { terminal: address }).catch(() => { });
            else
                await restoreView(before);
            return okJson({ terminal: address, from: current ?? null, to: landed ?? { space_id: space, tab_id: tab }, notes });
        },
    },
    {
        name: "herdr_pane_resize",
        description: "Move a pane's split edge in a direction by `amount` (a fraction of the tab, e.g. 0.1).",
        inputSchema: {
            direction: directionSchema,
            amount: z.number().positive().max(1).optional(),
            pane_id: paneRefSchema,
        },
        buildArgs: (a) => {
            const argv = ["pane", "resize", "--direction", String(a.direction)];
            flag(argv, "--amount", a.amount);
            return paneRef(argv, a.pane_id);
        },
        pick: byTarget("pane_id"),
        core: async () => unsupported("resizing panes (the Herdr app has no pane resize command; drag the split)"),
    },
    {
        name: "herdr_pane_zoom",
        description: "Zoom a pane to fill its tab: toggle (default), on, or off.",
        inputSchema: {
            pane_id: paneRefSchema,
            mode: z.enum(["toggle", "on", "off"]).optional(),
        },
        buildArgs: (a) => [...paneRef(["pane", "zoom"], a.pane_id), `--${a.mode ?? "toggle"}`],
        pick: byTarget("pane_id"),
        core: async (a) => {
            if (a.mode && a.mode !== "toggle")
                unsupported("zoom on/off (the app only toggles; use mode toggle)");
            const pane = await corePane(a.pane_id);
            return okJson({ pane_id: pane.pane, result: await appDo("pane.zoom", { pane: pane.pane }) });
        },
    },
];
//# sourceMappingURL=layout.js.map