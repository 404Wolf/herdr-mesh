import { z } from "zod";
import { runHerdr, HerdrError } from "../herdr.js";
import { redirectMoved } from "../migrate.js";
import { backendForContainer, backendForTarget, explicitBackend, preferredBackend, } from "../core.js";
/** Route by a terminal/pane/agent argument (falls back to the default when absent). */
export const byTarget = (...keys) => async (a) => {
    for (const k of keys) {
        if (typeof a[k] === "string" && a[k])
            return backendForTarget(String(a[k]), a);
    }
    return explicitBackend(a) ?? preferredBackend();
};
/** Route by a tab or workspace id argument. */
export const byContainer = (...keys) => async (a) => {
    const id = keys.map((k) => a[k]).find((v) => typeof v === "string" && v);
    return backendForContainer(id, a);
};
/** The `backend` argument when it forces one. */
export const explicit = (a) => explicitBackend(a);
/** Throw from a core handler when herdr-core has no equivalent. */
export function unsupported(what) {
    throw new HerdrError(`not supported on herdr-core: ${what}`);
}
/** Pretty JSON result. */
export function okJson(value) {
    return ok(JSON.stringify(value, null, 2));
}
/** Wrap arbitrary text as a successful tool result. */
export function ok(text) {
    return { content: [{ type: "text", text: text || "(no output)" }] };
}
/** Format a herdr result (parsed JSON if available, else raw stdout). */
export function formatResult(result) {
    return result.json !== undefined
        ? JSON.stringify(result.json, null, 2)
        : result.stdout.trim() || "(no output)";
}
/** Execute a ToolDef: run custom handler, or build argv + run herdr. */
export async function execTool(tool, args) {
    // Old TUI ids that the migration moved to herdr-core: use the new terminal/space.
    const { args: a, notes } = await redirectMoved(args);
    const withNotes = (r) => notes.length ? { ...r, content: [{ type: "text", text: notes.join("\n") }, ...r.content] } : r;
    try {
        return withNotes(await dispatch(tool, a));
    }
    catch (err) {
        const message = err instanceof HerdrError || err instanceof Error ? err.message : String(err);
        return withNotes({ content: [{ type: "text", text: message }], isError: true });
    }
}
async function dispatch(tool, args) {
    if (tool.handle)
        return tool.handle(args);
    const backend = await (tool.pick ?? byTarget())(args);
    if (backend === "core") {
        if (!tool.core)
            unsupported(`${tool.name} is a Herdr TUI tool`);
        return tool.core(args);
    }
    if (tool.run)
        return tool.run(args);
    const argv = tool.buildArgs(args);
    const result = await runHerdr(argv, { timeoutMs: tool.timeoutMs });
    return ok(formatResult(result));
}
/** Common reusable schema fragments. */
export const targetSchema = z
    .string()
    .describe("Agent target: herdr-core terminal address (t7, vps/t7) or name, Herdr app pane id, or Herdr TUI terminal id / agent name / label / pane id.");
export const backendSchema = z
    .enum(["auto", "core", "tui"])
    .optional()
    .describe("Force a backend: core = herdr-core (hc + Herdr app), tui = Herdr TUI (herdr). Default auto: by the target's id, else herdr-core when this agent runs in a herdr-core terminal (HC_TERMINAL_ID).");
export const sourceSchema = z
    .enum(["visible", "recent", "recent-unwrapped"])
    .optional()
    .describe("Which portion of the pane buffer to read (default: visible).");
/** Append `--flag value` when value is defined. */
export function flag(argv, name, value) {
    if (value !== undefined && value !== null && value !== "") {
        argv.push(name, String(value));
    }
}
/** Append a boolean `--flag` / `--no-flag` pair when defined. */
export function boolFlag(argv, onFlag, offFlag, value) {
    if (value === true)
        argv.push(onFlag);
    else if (value === false && offFlag)
        argv.push(offFlag);
}
//# sourceMappingURL=types.js.map