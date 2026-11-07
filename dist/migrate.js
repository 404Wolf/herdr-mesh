/**
 * TUI -> herdr-core migration redirects. The migration script records each
 * moved TUI pane in moved.json (on the machine it ran on); once the old pane
 * is gone, tools given its id use the herdr-core terminal instead.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runHc, runHerdr } from "./herdr.js";
/** Arguments that hold a terminal/pane/agent id. */
const PANE_KEYS = ["target", "pane_id", "source_pane", "target_pane"];
/** Arguments that hold a workspace id. */
const WORKSPACE_KEYS = ["workspace", "workspace_id"];
export function movedMapPath() {
    if (process.env.HERDR_MIGRATE_MAP)
        return process.env.HERDR_MIGRATE_MAP;
    const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(state, "herdr-migrate", "moved.json");
}
/** Re-read on every call: the file grows while the migration runs. */
function readMoved() {
    try {
        const json = JSON.parse(readFileSync(movedMapPath(), "utf8"));
        return json && typeof json === "object" ? json : {};
    }
    catch {
        return {};
    }
}
async function get(t) {
    try {
        return (await runHc(["get", t])).json;
    }
    catch {
        return undefined;
    }
}
async function ok(p) {
    try {
        await p;
        return true;
    }
    catch {
        return false;
    }
}
/** The hc address for a moved entry, as this machine's hc sees it. */
async function addressOf(e) {
    const t = e.terminal;
    if (!t)
        return undefined;
    if (e.machine === "local" || !t.includes("/"))
        return t;
    // "<laptop>/t1" read on the laptop itself: hc there knows it as bare t1.
    const bare = t.slice(t.indexOf("/") + 1);
    const [prefixed, local] = await Promise.all([get(t), get(bare)]);
    if (local && (!prefixed || prefixed.address === bare || prefixed.created_ms === local.created_ms))
        return bare;
    if (prefixed)
        return prefixed.address ?? t;
    return t;
}
/**
 * Replace old TUI pane/workspace ids that were migrated (and are no longer live
 * in the TUI) with their herdr-core terminal / app space.
 */
export async function redirectMoved(args) {
    const notes = [];
    if (args.backend === "tui")
        return { args, notes };
    const moved = readMoved();
    const keys = Object.keys(moved);
    if (!keys.length)
        return { args, notes };
    const out = { ...args };
    for (const k of PANE_KEYS) {
        const id = out[k];
        if (typeof id !== "string" || !(id in moved))
            continue;
        if (await ok(runHerdr(["pane", "get", id])))
            continue; // still a live TUI pane
        const address = await addressOf(moved[id]);
        if (!address)
            continue;
        out[k] = address;
        notes.push(`[herdr-mesh] TUI pane ${id} was migrated to herdr-core terminal ${address}` +
            `${moved[id].machine && moved[id].machine !== "local" ? ` (machine ${moved[id].machine})` : ""}; use ${address} from now on.`);
    }
    for (const k of WORKSPACE_KEYS) {
        const id = out[k];
        if (typeof id !== "string" || !/^w[^:]+$/.test(id))
            continue;
        const entry = keys.find((p) => p.startsWith(`${id}:`) && moved[p].space);
        if (!entry)
            continue;
        if (await ok(runHerdr(["workspace", "get", id])))
            continue; // still a live TUI workspace
        out[k] = moved[entry].space;
        notes.push(`[herdr-mesh] TUI workspace ${id} was migrated to Herdr app space ${moved[entry].space}; use that id from now on.`);
    }
    return { args: out, notes };
}
//# sourceMappingURL=migrate.js.map