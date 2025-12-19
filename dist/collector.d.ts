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
 * - gemini: modelos Gemini
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
     * Calibrates quota estimation for an account
     * Call this when user provides current % from AntigravityQuota extension
     * @param email Account email
     * @param percentRemaining Current % remaining
     * @param modelGroup Model group to calibrate (claude or gemini)
     */
    calibrateQuota(email: string, percentRemaining: number, modelGroup?: ModelGroup): void;
    /**
     * Calibrates quota with manual limits (when auto-calculation isn't possible)
     * Use this when the user has low usage but knows the actual limits
     * @param email Account email
     * @param percentRemaining Current % remaining from AntigravityQuota
     * @param estimatedTokenLimit Manual estimate of total token limit
     * @param estimatedRequestLimit Manual estimate of total request limit
     * @param windowAgeMinutes How old is the current window (in minutes)
     * @param modelGroup Model group to calibrate (claude or gemini)
     */
    calibrateQuotaManual(email: string, percentRemaining: number, estimatedTokenLimit: number, estimatedRequestLimit: number, windowAgeMinutes?: number, modelGroup?: ModelGroup): void;
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