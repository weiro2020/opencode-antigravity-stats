/**
 * Stats Collector
 * Accumulates statistics from events and watcher
 */
import type { StatsData, MessageData, ErrorData, ModelGroup } from "./types.js";
import { AccountsWatcher } from "./watcher.js";
export type ToastCallback = (title: string, message: string, variant: "info" | "success" | "warning" | "error") => Promise<void>;
/**
 * Determines the model group for quota tracking
 * Solo trackea modelos de Antigravity (provider google)
 * - claude: modelos Claude
 * - pro: modelos Gemini Pro
 * - flash: modelos Gemini Flash
 * - other: cualquier otro (no se trackea quota)
 */
export declare function getModelGroup(providerID: string, modelID: string): ModelGroup;
export interface AccountSessionStats {
    requests: number;
    tokensTotal: number;
    rateLimits: number;
    requestTimestamps: number[];
    lastRpmAtRateLimit: number | null;
    rpmAtRateLimitHistory: number[];
}
export declare class StatsCollector {
    private stats;
    private watcher;
    private currentSessionId;
    private onToast;
    private saveDebounceTimer;
    private requestTimestamps;
    private accountStats;
    private serverQuotaCache;
    private quotaFetchInterval;
    private quotaFetchStarted;
    constructor();
    /**
     * Initializes the collector
     */
    initialize(onToast?: ToastCallback): Promise<void>;
    /**
     * Stops the collector
     */
    stop(): Promise<void>;
    /**
     * Records a message with token usage
     */
    recordMessage(data: MessageData): Promise<void>;
    /**
     * Cleans timestamps older than 60 seconds
     */
    private cleanTimestamps;
    /**
     * Gets quota stats for all accounts (for display in session title)
     * Returns data needed to show: !CR:5,92%,4h20,1.8M
     * @param activeGroup - The model group to show stats for (claude or gemini)
     */
    getQuotaStats(activeGroup?: ModelGroup): Promise<Array<{
        email: string;
        prefix: string;
        rpm: number;
        isRateLimited: boolean;
        percentRemaining: number | null;
        timeUntilReset: string;
        tokensUsed: number;
        requestsCount: number;
        modelGroup: ModelGroup;
    }>>;
    /**
     * Gets current RPM (Requests Per Minute) based on last 60 seconds
     */
    getRPM(): number;
    /**
     * Gets stats for all accounts (for display in session title)
     * Returns array of { prefix, rpm, tokensTotal, rateLimits, isRateLimited, rpmThreshold }
     */
    getAllAccountsStats(): Promise<Array<{
        email: string;
        prefix: string;
        rpm: number;
        tokensTotal: number;
        rateLimits: number;
        isRateLimited: boolean;
        rpmThreshold: number | null;
        avgRpmAtRateLimit: number | null;
    }>>;
    /**
     * Records an error
     */
    recordError(data: ErrorData): Promise<void>;
    /**
     * Handles a rate limit detected by the watcher
     */
    private handleRateLimit;
    /**
     * Schedules a debounced save
     */
    private scheduleSave;
    /**
     * Starts the quota fetching process
     * Called on first message, sets up interval for every 60 seconds
     * Note: First fetch is done in initialize() to ensure data is ready
     */
    startQuotaFetching(): void;
    /**
     * Fetches quota from the server using the quota command
     * Updates serverQuotaCache and persists to disk on success
     */
    fetchServerQuota(): Promise<void>;
    /**
     * Gets server quota data for a specific model group
     * Maps server group names to ModelGroup values
     * Calculates timeUntilReset dynamically from reset_time
     */
    getServerQuotaForGroup(group: ModelGroup): {
        percent: number | null;
        timeUntilReset: string;
        resetTime: string | null;
        isFromCache: boolean;
    } | null;
    /**
     * Calculates time remaining until reset from ISO timestamp
     */
    private calculateTimeUntilReset;
    /**
     * Gets quota stats for all 3 groups, combining server data with local tracking
     * Returns groups ordered with active group first, then CL, PR, FL
     * @param activeGroup - The currently active model group
     */
    getQuotaStatsAllGroups(activeGroup: ModelGroup): Promise<Array<{
        group: ModelGroup;
        label: string;
        rpm: number;
        requestsCount: number;
        tokensUsed: number;
        percentRemaining: number | null;
        timeUntilReset: string;
        isFromCache: boolean;
        isActive: boolean;
    }>>;
    /**
     * Gets current stats
     */
    getStats(): StatsData;
    /**
     * Gets the watcher instance (for account lookups)
     */
    getWatcher(): AccountsWatcher;
    /**
     * Forces a save
     */
    forceSave(): Promise<void>;
}
//# sourceMappingURL=collector.d.ts.map