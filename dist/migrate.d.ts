export declare function movedMapPath(): string;
export interface Redirects {
    args: Record<string, unknown>;
    notes: string[];
}
/**
 * Replace old TUI pane/workspace ids that were migrated (and are no longer live
 * in the TUI) with their herdr-core terminal / app space.
 */
export declare function redirectMoved(args: Record<string, unknown>): Promise<Redirects>;
