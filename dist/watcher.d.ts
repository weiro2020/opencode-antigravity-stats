/**
 * Watcher for Antigravity accounts file
 * Monitors changes in isRateLimited status
 */
import type { AntigravityAccount, RateLimitEntry } from "./types.js";
export type RateLimitCallback = (entry: RateLimitEntry) => Promise<void>;
export declare class AccountsWatcher {
    private watcher;
    private previousState;
    private onRateLimit;
    private debounceTimer;
    /**
     * Starts watching the accounts file
     */
    start(onRateLimit: RateLimitCallback): Promise<void>;
    /**
     * Stops watching
     */
    stop(): Promise<void>;
    /**
     * Loads initial account state
     */
    private loadInitialState;
    /**
     * Handles file change with debouncing
     */
    private handleChange;
    /**
     * Checks for rate limit status changes
     */
    private checkForRateLimitChanges;
    /**
     * Gets current account that was most recently used
     */
    getActiveAccount(): Promise<string | null>;
    /**
     * Maps a project ID to account email
     */
    getAccountByProject(projectId: string): Promise<string | null>;
    /**
     * Gets all accounts with their current state
     */
    getAllAccounts(): Promise<AntigravityAccount[]>;
}
//# sourceMappingURL=watcher.d.ts.map