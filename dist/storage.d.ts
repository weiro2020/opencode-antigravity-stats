/**
 * Storage manager for Antigravity Stats
 * Handles reading/writing to antigravity-stats.json
 */
import type { StatsData, ModelStats, DailyStats, RateLimitEntry, ErrorEntry, AntigravityAccountsData } from "./types.js";
/**
 * Creates an empty stats structure
 */
export declare function createEmptyStats(sessionId?: string): StatsData;
/**
 * Loads stats from disk
 * Includes migration of legacy calibration → calibrations[claude]
 */
export declare function loadStats(): Promise<StatsData>;
/**
 * Saves stats to disk, preserving calibration and windowStart from disk
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
//# sourceMappingURL=storage.d.ts.map