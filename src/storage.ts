/**
 * Storage manager for Antigravity Stats
 * Handles reading/writing to antigravity-stats.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  StatsData,
  SessionStats,
  ModelStats,
  DailyStats,
  RateLimitEntry,
  ErrorEntry,
  AntigravityAccountsData,
  STATS_VERSION,
  MAX_HISTORY_ENTRIES,
  RETENTION_DAYS,
} from "./types.js";
import { FIVE_HOURS_MS } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const STATS_FILE = join(CONFIG_DIR, "antigravity-stats.json");
const ACCOUNTS_FILE = join(CONFIG_DIR, "antigravity-accounts.json");

/**
 * Creates an empty stats structure
 */
export function createEmptyStats(sessionId?: string): StatsData {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    session: {
      id: sessionId || "",
      startedAt: new Date().toISOString(),
      byModel: {},
      totals: {
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        errors: 0,
      },
    },
    rateLimits: {
      total: 0,
      history: [],
    },
    errors: {
      total: 0,
      byCode: {},
      history: [],
    },
    daily: {},
  };
}

/**
 * Loads stats from disk
 * Includes migration of legacy calibration → calibrations[claude]
 */
export async function loadStats(): Promise<StatsData> {
  try {
    if (!existsSync(STATS_FILE)) {
      return createEmptyStats();
    }
    const content = await readFile(STATS_FILE, "utf-8");
    const data = JSON.parse(content) as StatsData;
    
    // Migrate legacy calibration → calibrations.claude
    if (data.quotaTracking) {
      for (const [email, tracking] of Object.entries(data.quotaTracking)) {
        // If has old calibration but no calibrations object
        if (tracking.calibration && !tracking.calibrations) {
          tracking.calibrations = {
            claude: tracking.calibration,
          };
        }
        // If calibrations doesn't have both claude and gemini defaults, create them
        if (!tracking.calibrations) {
          tracking.calibrations = {};
        }
        // Ensure default calibration for claude if missing (600 requests limit)
        if (!tracking.calibrations.claude) {
          tracking.calibrations.claude = {
            tokensAtCalibration: 0,
            requestsAtCalibration: 0,
            percentRemaining: 100,
            timestamp: Date.now(),
            estimatedTokenLimit: 10000000, // 10M tokens estimate
            estimatedRequestLimit: 600,     // 600 requests per 5h window
          };
        }
        // Ensure default calibration for gemini if missing (600 requests limit)
        if (!tracking.calibrations.gemini) {
          tracking.calibrations.gemini = {
            tokensAtCalibration: 0,
            requestsAtCalibration: 0,
            percentRemaining: 100,
            timestamp: Date.now(),
            estimatedTokenLimit: 10000000, // 10M tokens estimate
            estimatedRequestLimit: 600,     // 600 requests per 5h window
          };
        }
      }
    }
    
    return data;
  } catch (error) {
    console.error("[antigravity-stats] Error loading stats:", error);
    return createEmptyStats();
  }
}

/**
 * Saves stats to disk, preserving calibration and windowStart from disk
 */
export async function saveStats(stats: StatsData): Promise<void> {
  try {
    // Ensure directory exists
    const dir = dirname(STATS_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    stats.lastUpdated = new Date().toISOString();

    // Cleanup old data before saving
    cleanupOldData(stats);

    // Preserve calibrations and windowStart from disk that may have been set externally
    // This allows external tools to calibrate quota and set window times
    if (existsSync(STATS_FILE)) {
      try {
        const diskContent = await readFile(STATS_FILE, "utf-8");
        const diskStats = JSON.parse(diskContent) as StatsData;
        
        if (diskStats.quotaTracking) {
          for (const [email, diskTracking] of Object.entries(diskStats.quotaTracking)) {
            // If we have this account in memory
            if (stats.quotaTracking?.[email]) {
              // Always preserve disk calibrations (allows external manual changes)
              // Priority: calibrations (new) > calibration (legacy)
              if (diskTracking.calibrations) {
                if (!stats.quotaTracking[email].calibrations) {
                  stats.quotaTracking[email].calibrations = {};
                }
                // Merge calibrations from disk
                for (const [group, cal] of Object.entries(diskTracking.calibrations)) {
                  if (cal) {
                    stats.quotaTracking[email].calibrations![group as keyof typeof diskTracking.calibrations] = cal;
                  }
                }
              }
              // Legacy: preserve old calibration field if exists
              if (diskTracking.calibration && !stats.quotaTracking[email].calibration) {
                stats.quotaTracking[email].calibration = diskTracking.calibration;
              }
              
              // Preserve disk windowStart if it's been manually adjusted (older than memory)
              // BUT only if the disk window is still valid (less than 5 hours old)
              // Also preserve tokensUsed and requestsCount if disk has higher values
              if (diskTracking.windows) {
                const now = Date.now();
                for (const [group, diskWindow] of Object.entries(diskTracking.windows)) {
                  const memWindow = stats.quotaTracking[email].windows?.[group as keyof typeof diskTracking.windows];
                  if (diskWindow && memWindow) {
                    const diskWindowAge = now - diskWindow.windowStart;
                    // Only use disk values if the disk window is still valid (< 5 hours)
                    if (diskWindowAge < FIVE_HOURS_MS) {
                      // Use disk windowStart if older than memory
                      if (diskWindow.windowStart < memWindow.windowStart) {
                        memWindow.windowStart = diskWindow.windowStart;
                      }
                      // Use disk values if higher (externally set)
                      if (diskWindow.tokensUsed > memWindow.tokensUsed) {
                        memWindow.tokensUsed = diskWindow.tokensUsed;
                      }
                      if (diskWindow.requestsCount > memWindow.requestsCount) {
                        memWindow.requestsCount = diskWindow.requestsCount;
                      }
                    }
                  } else if (diskWindow && !memWindow) {
                    // Disk has window but memory doesn't - preserve it if valid
                    const diskWindowAge = now - diskWindow.windowStart;
                    if (diskWindowAge < FIVE_HOURS_MS) {
                      if (!stats.quotaTracking[email].windows) {
                        stats.quotaTracking[email].windows = {};
                      }
                      stats.quotaTracking[email].windows[group as keyof typeof diskTracking.windows] = diskWindow;
                    }
                  }
                }
              }
            } else {
              // Account exists on disk but not in memory, preserve it
              if (!stats.quotaTracking) stats.quotaTracking = {};
              stats.quotaTracking[email] = diskTracking;
            }
          }
        }
      } catch (err) {
        // Ignore read errors, just save what we have
      }
    }

    await writeFile(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
  } catch (error) {
    console.error("[antigravity-stats] Error saving stats:", error);
  }
}

/**
 * Loads Antigravity accounts from disk
 */
export async function loadAccounts(): Promise<AntigravityAccountsData | null> {
  try {
    if (!existsSync(ACCOUNTS_FILE)) {
      return null;
    }
    const content = await readFile(ACCOUNTS_FILE, "utf-8");
    return JSON.parse(content) as AntigravityAccountsData;
  } catch (error) {
    console.error("[antigravity-stats] Error loading accounts:", error);
    return null;
  }
}

/**
 * Gets today's date key in YYYY-MM-DD format
 */
export function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Ensures today's daily stats exist
 */
export function ensureDailyStats(stats: StatsData): DailyStats {
  const today = getTodayKey();
  if (!stats.daily[today]) {
    stats.daily[today] = {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      rateLimits: 0,
      errors: 0,
      byModel: {},
      byAccount: {},
    };
  }
  return stats.daily[today];
}

/**
 * Ensures model stats exist in session
 */
export function ensureModelStats(stats: StatsData, modelKey: string): ModelStats {
  if (!stats.session.byModel[modelKey]) {
    stats.session.byModel[modelKey] = {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      errors: 0,
    };
  }
  return stats.session.byModel[modelKey];
}

/**
 * Adds a rate limit entry
 */
export function addRateLimitEntry(stats: StatsData, entry: RateLimitEntry): void {
  stats.rateLimits.total++;
  stats.rateLimits.history.unshift(entry);

  // Keep only last N entries
  if (stats.rateLimits.history.length > 50) {
    stats.rateLimits.history = stats.rateLimits.history.slice(0, 50);
  }

  // Update daily stats
  const daily = ensureDailyStats(stats);
  daily.rateLimits++;

  // Update account stats
  if (!daily.byAccount[entry.account]) {
    daily.byAccount[entry.account] = { requests: 0, rateLimits: 0 };
  }
  daily.byAccount[entry.account].rateLimits++;
}

/**
 * Adds an error entry
 */
export function addErrorEntry(stats: StatsData, entry: ErrorEntry): void {
  stats.errors.total++;
  stats.errors.byCode[entry.code] = (stats.errors.byCode[entry.code] || 0) + 1;
  stats.errors.history.unshift(entry);

  // Keep only last N entries
  if (stats.errors.history.length > 50) {
    stats.errors.history = stats.errors.history.slice(0, 50);
  }

  // Update daily stats
  const daily = ensureDailyStats(stats);
  daily.errors++;

  // Update session totals
  stats.session.totals.errors++;
}

/**
 * Cleans up data older than retention period
 */
function cleanupOldData(stats: StatsData): void {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffKey = cutoffDate.toISOString().split("T")[0];

  // Remove old daily stats
  for (const dateKey of Object.keys(stats.daily)) {
    if (dateKey < cutoffKey) {
      delete stats.daily[dateKey];
    }
  }

  // Trim history arrays
  const cutoffTimestamp = cutoffDate.toISOString();

  stats.rateLimits.history = stats.rateLimits.history.filter(
    (entry) => entry.timestamp >= cutoffTimestamp
  );

  stats.errors.history = stats.errors.history.filter(
    (entry) => entry.timestamp >= cutoffTimestamp
  );
}

/**
 * Resets session stats (for new session)
 */
export function resetSession(stats: StatsData, sessionId: string): void {
  stats.session = {
    id: sessionId,
    startedAt: new Date().toISOString(),
    byModel: {},
    totals: {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      errors: 0,
    },
  };
}

/**
 * Gets the path to the accounts file
 */
export function getAccountsFilePath(): string {
  return ACCOUNTS_FILE;
}

/**
 * Gets the path to the stats file
 */
export function getStatsFilePath(): string {
  return STATS_FILE;
}
