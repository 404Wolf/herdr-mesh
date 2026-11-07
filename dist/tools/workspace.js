import { z } from "zod";
import { appDo, appLs, appStatus, findSpace, findTab, restoreView } from "../core.js";
import { okJson, flag, boolFlag, byContainer } from "./types.js";
/** A tab as listed by the app, with its space. */
const tabView = (space, t) => ({
    tab_id: t.id,
    label: t.name,
    workspace_id: space.id,
    workspace_label: space.name,
    active: t.active ?? false,
    settled: t.settled ?? false,
    panes: t.terminals.map((p) => ({ pane_id: p.pane, terminal: p.terminal, status: p.status ?? null })),
});
export const tabTools = [
    {
        name: "herdr_tab_list",
        description: "List tabs, optionally filtered to a workspace. On herdr-core these are Herdr app tabs (workspace = app space id).",
        inputSchema: { workspace: z.string().optional() },
        buildArgs: (a) => {
            const argv = ["tab", "list"];
            flag(argv, "--workspace", a.workspace);
            return argv;
        },
        pick: byContainer("workspace"),
        core: async (a) => {
            const spaces = await appLs();
            const tabs = spaces
                .filter((sp) => !a.workspace || sp.id === a.workspace)
                .flatMap((sp) => sp.tabs.map((t) => tabView(sp, t)));
            return okJson({ tabs });
        },
    },
    {
        name: "herdr_tab_create",
        description: "Create a new tab (on herdr-core: a Herdr app tab with a shell; it is shown unless focus=false).",
        inputSchema: {
            workspace: z.string().optional(),
            cwd: z.string().optional(),
            label: z.string().optional(),
            focus: z.boolean().optional(),
        },
        buildArgs: (a) => {
            const argv = ["tab", "create"];
            flag(argv, "--workspace", a.workspace);
            flag(argv, "--cwd", a.cwd);
            flag(argv, "--label", a.label);
            boolFlag(argv, "--focus", "--no-focus", a.focus);
            return argv;
        },
        pick: byContainer("workspace"),
        core: async (a) => {
            const before = await appStatus();
            const res = await appDo("tab.new", { name: a.label, space: a.workspace, folder: a.cwd });
            if (a.focus === false)
                await restoreView(before);
            return okJson(res);
        },
    },
    {
        name: "herdr_tab_get",
        description: "Get details for a tab.",
        inputSchema: { tab_id: z.string() },
        buildArgs: (a) => ["tab", "get", String(a.tab_id)],
        pick: byContainer("tab_id"),
        core: async (a) => {
            const { space, tab } = await findTab(String(a.tab_id));
            return okJson(tabView(space, tab));
        },
    },
    {
        name: "herdr_tab_focus",
        description: "Focus a tab.",
        inputSchema: { tab_id: z.string() },
        buildArgs: (a) => ["tab", "focus", String(a.tab_id)],
        pick: byContainer("tab_id"),
        core: async (a) => {
            const { space } = await findTab(String(a.tab_id));
            await appDo("space.select", { id: space.id });
            return okJson(await appDo("tab.select", { id: a.tab_id }));
        },
    },
    {
        name: "herdr_tab_rename",
        description: "Rename a tab.",
        inputSchema: { tab_id: z.string(), label: z.string() },
        buildArgs: (a) => ["tab", "rename", String(a.tab_id), String(a.label)],
        pick: byContainer("tab_id"),
        core: async (a) => okJson(await appDo("tab.rename", { id: a.tab_id, name: a.label })),
    },
    {
        name: "herdr_tab_close",
        description: "Close a tab and end its terminals.",
        inputSchema: { tab_id: z.string() },
        buildArgs: (a) => ["tab", "close", String(a.tab_id)],
        pick: byContainer("tab_id"),
        core: async (a) => {
            await findTab(String(a.tab_id));
            return okJson(await appDo("tab.close", { id: a.tab_id, confirmed: true }));
        },
    },
];
export const workspaceTools = [
    {
        name: "herdr_workspace_list",
        description: "List workspaces. On herdr-core these are Herdr app spaces.",
        inputSchema: {},
        buildArgs: () => ["workspace", "list"],
        pick: byContainer(),
        core: async () => {
            const status = await appStatus().catch(() => undefined);
            const spaces = await appLs();
            return okJson({
                workspaces: spaces.map((sp) => ({
                    workspace_id: sp.id,
                    label: sp.name,
                    folder: sp.folder ?? null,
                    machine: sp.machine ?? null,
                    focused: sp.id === status?.space,
                    tabs: sp.tabs.map((t) => ({ tab_id: t.id, label: t.name, panes: t.terminals.length })),
                })),
            });
        },
    },
    {
        name: "herdr_workspace_create",
        description: "Create a new workspace (on herdr-core: a Herdr app space; it is shown unless focus=false).",
        inputSchema: {
            cwd: z.string().optional(),
            label: z.string().optional(),
            focus: z.boolean().optional(),
        },
        buildArgs: (a) => {
            const argv = ["workspace", "create"];
            flag(argv, "--cwd", a.cwd);
            flag(argv, "--label", a.label);
            boolFlag(argv, "--focus", "--no-focus", a.focus);
            return argv;
        },
        pick: byContainer(),
        core: async (a) => {
            const before = await appStatus();
            const res = await appDo("space.new", { name: a.label, folder: a.cwd });
            if (a.focus === false)
                await restoreView(before);
            return okJson(res);
        },
    },
    {
        name: "herdr_workspace_get",
        description: "Get details for a workspace.",
        inputSchema: { workspace_id: z.string() },
        buildArgs: (a) => ["workspace", "get", String(a.workspace_id)],
        pick: byContainer("workspace_id"),
        core: async (a) => {
            const sp = await findSpace(String(a.workspace_id));
            return okJson({ workspace_id: sp.id, label: sp.name, folder: sp.folder ?? null, machine: sp.machine ?? null, tabs: sp.tabs.map((t) => tabView(sp, t)) });
        },
    },
    {
        name: "herdr_workspace_focus",
        description: "Focus a workspace.",
        inputSchema: { workspace_id: z.string() },
        buildArgs: (a) => ["workspace", "focus", String(a.workspace_id)],
        pick: byContainer("workspace_id"),
        core: async (a) => okJson(await appDo("space.select", { id: a.workspace_id })),
    },
    {
        name: "herdr_workspace_rename",
        description: "Rename a workspace.",
        inputSchema: { workspace_id: z.string(), label: z.string() },
        buildArgs: (a) => ["workspace", "rename", String(a.workspace_id), String(a.label)],
        pick: byContainer("workspace_id"),
        core: async (a) => okJson(await appDo("space.rename", { id: a.workspace_id, name: a.label })),
    },
    {
        name: "herdr_workspace_close",
        description: "Close a workspace and end its terminals.",
        inputSchema: { workspace_id: z.string() },
        buildArgs: (a) => ["workspace", "close", String(a.workspace_id)],
        pick: byContainer("workspace_id"),
        core: async (a) => {
            await findSpace(String(a.workspace_id));
            return okJson(await appDo("space.close", { id: a.workspace_id, confirmed: true }));
        },
    },
];
//# sourceMappingURL=workspace.js.map