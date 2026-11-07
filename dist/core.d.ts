export type Backend = "core" | "tui";
/** Default backend when nothing in the call decides it. */
export declare function preferredBackend(): Backend;
export declare function explicitBackend(a: Record<string, unknown>): Backend | undefined;
/** Which backend owns a tab or workspace id. */
export declare function backendForContainer(id: string | undefined, a: Record<string, unknown>): Backend;
/**
 * Decide which backend owns a terminal/pane/agent target. Unambiguous ids
 * decide by shape; names are probed, herdr-core first when running in a core
 * terminal (HC_TERMINAL_ID), else the TUI first.
 */
export declare function backendForTarget(target: string, a: Record<string, unknown>): Promise<Backend>;
export interface Terminal {
    address: string;
    name?: string | null;
    state?: string;
    /** OSC 7501 record: `{state: "idle"|"working"|...}`, or null when none reported. */
    status?: {
        state?: string;
        [key: string]: unknown;
    } | string | null;
    reported?: boolean;
    labels?: Record<string, string>;
    parent?: string | null;
    turn?: number;
    cwd?: string;
    [key: string]: unknown;
}
/** A terminal's status word (idle, working, done, blocked, error), or null. */
export declare function statusWord(t: Terminal): string | null;
/** The caller's own terminal, when the agent runs in herdr-core. */
export declare function selfTerminal(): string | undefined;
/** Turn an app pane id into the terminal it shows; other targets pass through. */
export declare function terminalOf(target: string): Promise<string>;
export declare function hcGet(target: string): Promise<Terminal>;
export declare function hcList(all?: boolean): Promise<Terminal[]>;
/** Read a terminal: `visible` = the screen, else `lines` of history too; trimmed to `lines`. */
export declare function hcRead(target: string, source: string | undefined, lines: number): Promise<string>;
/** hc key names use `ctrl+c`; the TUI used `ctrl-c`. Accept both. */
export declare function hcKey(key: string): string;
/**
 * Wait until a terminal reports `want` (idle/working/blocked/done/unknown),
 * exits, or the timeout passes. Uses `hc wait` while it is working, polls otherwise.
 */
export declare function hcWaitStatus(target: string, want: string, timeoutMs: number): Promise<{
    reached: boolean;
    terminal: Terminal;
}>;
export interface AppTerminal {
    terminal: string | null;
    pane: string;
    status?: string | null;
    name?: string | null;
    sub_agents?: unknown[];
    [key: string]: unknown;
}
export interface AppTab {
    id: string;
    name: string | null;
    active?: boolean;
    settled?: boolean;
    terminals: AppTerminal[];
}
export interface AppSpace {
    id: string;
    name: string | null;
    folder?: string | null;
    machine?: string | null;
    active?: boolean;
    tabs: AppTab[];
}
export interface AppStatus {
    space: string | null;
    tab: string | null;
    focused_pane: string | null;
    [key: string]: unknown;
}
export declare function appLs(): Promise<AppSpace[]>;
export declare function appStatus(): Promise<AppStatus>;
/** Run an app command with one JSON object of arguments; returns its JSON reply. */
export declare function appDo(command: string, args?: Record<string, unknown>): Promise<unknown>;
export interface PaneInfo {
    pane: string;
    terminal: string | null;
    space_id: string;
    space_name: string | null;
    tab_id: string;
    tab_name: string | null;
}
/** Every pane in the window, flattened with its tab and space. */
export declare function appPanes(spaces?: AppSpace[]): Promise<PaneInfo[]>;
/** The pane showing a terminal (or pane id), or undefined when it has none. */
export declare function paneOf(target: string, spaces?: AppSpace[]): Promise<PaneInfo | undefined>;
export declare function requirePane(target: string, spaces?: AppSpace[]): Promise<PaneInfo>;
export declare function findTab(id: string): Promise<{
    space: AppSpace;
    tab: AppTab;
}>;
export declare function findSpace(id: string): Promise<AppSpace>;
/** A fresh id in the app's style, for labels that make a new space or tab. */
export declare function newAppId(prefix: "sp" | "tb"): string;
/** Put the user's view back on a tab after a command that switched it. */
export declare function restoreView(before: AppStatus): Promise<void>;
interface LayoutNode {
    id: string;
    type: "row" | "column" | "block" | string;
    children?: LayoutNode[];
    content?: {
        terminal?: string;
        mod?: string;
        [key: string]: unknown;
    };
    size?: {
        weight?: number;
        px?: number;
    };
}
export interface PaneRect {
    pane_id: string;
    terminal: string | null;
    mod?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    focused: boolean;
}
export interface TabLayout {
    space_id: string;
    tab_id: string;
    panes: PaneRect[];
    root: LayoutNode;
}
/** The split layout of the tab holding `pane` (fractions of the tab, 0..1). */
export declare function tabLayout(pane: PaneInfo): Promise<TabLayout>;
/** The pane next to `paneId` in a direction: the one sharing the most edge. */
export declare function neighbor(layout: TabLayout, paneId: string, direction: string): PaneRect | undefined;
export declare function edges(layout: TabLayout, paneId: string): {
    left: boolean;
    top: boolean;
    right: boolean;
    bottom: boolean;
};
export {};
