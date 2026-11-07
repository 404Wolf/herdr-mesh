import { type Terminal } from "../core.js";
import { type ToolDef } from "./types.js";
/** Live core terminals with status, labels, parent and the app pane showing them. */
export declare function coreTerminals(): Promise<Array<Terminal & Record<string, unknown>>>;
export declare const agentTools: ToolDef[];
