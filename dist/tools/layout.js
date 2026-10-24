import { z } from "zod";
import { runHerdr } from "../herdr.js";
import { ok, flag, boolFlag } from "./types.js";
const directionSchema = z.enum(["left", "right", "up", "down"]);
const paneRefSchema = z
    .string()
    .optional()
    .describe("Pane id. Omit to use the calling agent's own pane (HERDR_PANE_ID).");
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
    },
    {
        name: "herdr_pane_layout",
        description: "Show the split layout of a pane's tab: every pane's rect (x, y, width, height), the " +
            "splits, and which pane is focused. Use for 'the top-right pane' style references.",
        inputSchema: { pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "layout"], a.pane_id),
    },
    {
        name: "herdr_pane_neighbor",
        description: "Find the pane next to a pane in a direction (e.g. 'the pane to my right'). " +
            "result.neighbor.neighbor_pane_id is absent when there is no pane that way; say so " +
            "instead of picking another pane.",
        inputSchema: { direction: directionSchema, pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "neighbor", "--direction", String(a.direction)], a.pane_id),
    },
    {
        name: "herdr_pane_edges",
        description: "Which outer edges of its tab a pane touches (true = on that edge).",
        inputSchema: { pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "edges"], a.pane_id),
    },
    {
        name: "herdr_pane_focus",
        description: "Move the user's focus to the neighboring pane in a direction.",
        inputSchema: { direction: directionSchema, pane_id: paneRefSchema },
        buildArgs: (a) => paneRef(["pane", "focus", "--direction", String(a.direction)], a.pane_id),
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
    },
    {
        name: "herdr_pane_zoom",
        description: "Zoom a pane to fill its tab: toggle (default), on, or off.",
        inputSchema: {
            pane_id: paneRefSchema,
            mode: z.enum(["toggle", "on", "off"]).optional(),
        },
        buildArgs: (a) => [...paneRef(["pane", "zoom"], a.pane_id), `--${a.mode ?? "toggle"}`],
    },
];
//# sourceMappingURL=layout.js.map