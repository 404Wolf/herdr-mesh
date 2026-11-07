export interface HerdrResult {
    /** Parsed JSON object when the CLI emitted JSON, otherwise undefined. */
    json?: unknown;
    /** Raw stdout text (always present). */
    stdout: string;
    /** Raw stderr text. */
    stderr: string;
}
export declare class HerdrError extends Error {
    constructor(message: string);
}
/**
 * Run a Herdr TUI CLI command and return its output.
 *
 * herdr prints newline-delimited JSON for most socket-API commands
 * (e.g. `{"id":...,"result":{...},"type":...}`). We parse the last JSON line
 * when possible and also return the raw stdout for non-JSON commands.
 */
export declare function runHerdr(args: string[], opts?: {
    timeoutMs?: number;
}): Promise<HerdrResult>;
/** Run an `hc` (herdr-core) command with JSON output. */
export declare function runHc(args: string[], opts?: {
    timeoutMs?: number;
}): Promise<HerdrResult>;
/** Run a `herdr-app` command (talks to the open Herdr window). */
export declare function runApp(args: string[], opts?: {
    timeoutMs?: number;
}): Promise<HerdrResult>;
/**
 * Call one herdr-core API method over `hc connect` (JSON-RPC over stdio).
 * Used for reads the CLI doesn't expose, such as the app's layout document.
 */
export declare function coreRpc(method: string, params: Record<string, unknown>, opts?: {
    timeoutMs?: number;
}): Promise<unknown>;
