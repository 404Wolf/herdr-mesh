import { z, type ZodRawShape } from "zod";
import { type Backend } from "../core.js";
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: ZodRawShape;
    /** Build the herdr CLI argv from validated args (single-command tools). */
    buildArgs?: (args: Record<string, unknown>) => string[];
    /** Custom multi-step handler (composite tools). Takes precedence over buildArgs. */
    run?: (args: Record<string, unknown>) => Promise<ToolResult>;
    /** Optional per-tool timeout (ms); falls back to runHerdr default. */
    timeoutMs?: number;
    /** herdr-core (hc + Herdr app) handler. Absent: the tool only works on the TUI. */
    core?: (args: Record<string, unknown>) => Promise<ToolResult>;
    /** Pick the backend for a call (default: `backend` arg, else HC_TERMINAL_ID decides). */
    pick?: (args: Record<string, unknown>) => Promise<Backend>;
    /** Handles both backends itself (no routing). */
    handle?: (args: Record<string, unknown>) => Promise<ToolResult>;
}
/** Route by a terminal/pane/agent argument (falls back to the default when absent). */
export declare const byTarget: (...keys: string[]) => (a: Record<string, unknown>) => Promise<Backend>;
/** Route by a tab or workspace id argument. */
export declare const byContainer: (...keys: string[]) => (a: Record<string, unknown>) => Promise<Backend>;
/** The `backend` argument when it forces one. */
export declare const explicit: (a: Record<string, unknown>) => Backend | undefined;
/** Throw from a core handler when herdr-core has no equivalent. */
export declare function unsupported(what: string): never;
/** Pretty JSON result. */
export declare function okJson(value: unknown): ToolResult;
export interface ToolResult {
    [key: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
/** Wrap arbitrary text as a successful tool result. */
export declare function ok(text: string): ToolResult;
/** Format a herdr result (parsed JSON if available, else raw stdout). */
export declare function formatResult(result: {
    json?: unknown;
    stdout: string;
}): string;
/** Execute a ToolDef: run custom handler, or build argv + run herdr. */
export declare function execTool(tool: ToolDef, args: Record<string, unknown>): Promise<ToolResult>;
/** Common reusable schema fragments. */
export declare const targetSchema: z.ZodString;
export declare const backendSchema: z.ZodOptional<z.ZodEnum<["auto", "core", "tui"]>>;
export declare const sourceSchema: z.ZodOptional<z.ZodEnum<["visible", "recent", "recent-unwrapped"]>>;
/** Append `--flag value` when value is defined. */
export declare function flag(argv: string[], name: string, value: unknown): void;
/** Append a boolean `--flag` / `--no-flag` pair when defined. */
export declare function boolFlag(argv: string[], onFlag: string, offFlag: string | undefined, value: unknown): void;
