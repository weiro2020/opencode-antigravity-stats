/**
 * Storage manager for Antigravity Stats
 * Handles reading/writing to antigravity-stats.json
 */
import type { StatsData, ModelStats, DailyStats, RateLimitEntry, ErrorEntry, AntigravityAccountsData, ServerQuotaCache } from "./types.js";
/**
 * Creates an empty stats structure
 */
export declare function createEmptyStats(sessionId?: string): StatsData;
/**
 * Loads stats from disk
 */
export declare function loadStats(): Promise<StatsData>;
/**
 * Saves stats to disk
 * La memoria es la fuente de verdad - simplemente guardamos lo que hay en memoria
 */
export declare function saveStats(stats: StatsData): Promise<void>;
/**
 * Loads Antigravity accounts from disk
 */
export declare function loadAccounts(): Promise<AntigravityAccountsData | null>;
/**
 * Gets today's date key in YYYY-MM-DD format
 */
export declare function getTodayKey(): string;
/**
 * Ensures today's daily stats exist
 */
export declare function ensureDailyStats(stats: StatsData): DailyStats;
/**
 * Ensures model stats exist in session
 */
export declare function ensureModelStats(stats: StatsData, modelKey: string): ModelStats;
/**
 * Adds a rate limit entry
 */
export declare function addRateLimitEntry(stats: StatsData, entry: RateLimitEntry): void;
/**
 * Adds an error entry
 */
export declare function addErrorEntry(stats: StatsData, entry: ErrorEntry): void;
/**
 * Resets session stats (for new session)
 */
export declare function resetSession(stats: StatsData, sessionId: string): void;
/**
 * Gets the path to the accounts file
 */
export declare function getAccountsFilePath(): string;
/**
 * Gets the path to the stats file
 */
export declare function getStatsFilePath(): string;
/**
 * Gets the path to the quota cache file
 */
export declare function getQuotaCacheFilePath(): string;
/**
 * Loads server quota cache from disk
 * Handles both Python script format (models) and plugin format (groups)
 */
export declare function loadServerQuotaCache(): Promise<ServerQuotaCache | null>;
/**
 * Saves server quota cache to disk
 * Writes in format compatible with Python script (quota_cache.json)
 */
export declare function saveServerQuotaCache(cache: ServerQuotaCache): Promise<void>;
//# sourceMappingURL=storage.d.ts.map