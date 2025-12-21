/**
 * Storage manager for Antigravity Stats
 * Handles reading/writing to antigravity-stats.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
const CONFIG_DIR = join(homedir(), ".config", "opencode");
const STATS_FILE = join(CONFIG_DIR, "antigravity-stats.json");
const ACCOUNTS_FILE = join(CONFIG_DIR, "antigravity-accounts.json");
// Use the same cache file as the Python quota script for compatibility
const QUOTA_CACHE_FILE = join(homedir(), ".antigravity-standalone", "quota_cache.json");
/**
 * Creates an empty stats structure
 */
export function createEmptyStats(sessionId) {
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
 */
export async function loadStats() {
    try {
        if (!existsSync(STATS_FILE)) {
            return createEmptyStats();
        }
        const content = await readFile(STATS_FILE, "utf-8");
        const data = JSON.parse(content);
        // Limpiar campos legacy de calibration si existen
        if (data.quotaTracking) {
            for (const [email, tracking] of Object.entries(data.quotaTracking)) {
                // Eliminar campos de calibration obsoletos
                delete tracking.calibration;
                delete tracking.calibrations;
            }
        }
        return data;
    }
    catch (error) {
        console.error("[antigravity-stats] Error loading stats:", error);
        return createEmptyStats();
    }
}
/**
 * Saves stats to disk
 * La memoria es la fuente de verdad - simplemente guardamos lo que hay en memoria
 */
export async function saveStats(stats) {
    try {
        // Ensure directory exists
        const dir = dirname(STATS_FILE);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        stats.lastUpdated = new Date().toISOString();
        // Cleanup old data before saving
        cleanupOldData(stats);
        await writeFile(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
    }
    catch (error) {
        console.error("[antigravity-stats] Error saving stats:", error);
    }
}
/**
 * Loads Antigravity accounts from disk
 */
export async function loadAccounts() {
    try {
        if (!existsSync(ACCOUNTS_FILE)) {
            return null;
        }
        const content = await readFile(ACCOUNTS_FILE, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        console.error("[antigravity-stats] Error loading accounts:", error);
        return null;
    }
}
/**
 * Gets today's date key in YYYY-MM-DD format
 */
export function getTodayKey() {
    return new Date().toISOString().split("T")[0];
}
/**
 * Ensures today's daily stats exist
 */
export function ensureDailyStats(stats) {
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
export function ensureModelStats(stats, modelKey) {
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
export function addRateLimitEntry(stats, entry) {
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
export function addErrorEntry(stats, entry) {
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
function cleanupOldData(stats) {
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
    stats.rateLimits.history = stats.rateLimits.history.filter((entry) => entry.timestamp >= cutoffTimestamp);
    stats.errors.history = stats.errors.history.filter((entry) => entry.timestamp >= cutoffTimestamp);
}
/**
 * Resets session stats (for new session)
 */
export function resetSession(stats, sessionId) {
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
export function getAccountsFilePath() {
    return ACCOUNTS_FILE;
}
/**
 * Gets the path to the stats file
 */
export function getStatsFilePath() {
    return STATS_FILE;
}
/**
 * Gets the path to the quota cache file
 */
export function getQuotaCacheFilePath() {
    return QUOTA_CACHE_FILE;
}
/**
 * Converts models array to groups array
 * Groups models by: Claude, Gemini 3 Pro, Gemini 3 Flash
 */
function modelsToGroups(models) {
    const groupsMap = {
        'Claude': { models: [], pct: null, reset: null },
        'Gemini 3 Pro': { models: [], pct: null, reset: null },
        'Gemini 3 Flash': { models: [], pct: null, reset: null },
    };
    for (const m of models) {
        const labelLower = m.label.toLowerCase();
        let groupName = null;
        if (labelLower.includes('claude') || labelLower.includes('gpt-oss') || labelLower.includes('gpt oss')) {
            groupName = 'Claude';
        }
        else if (labelLower.includes('gemini') && labelLower.includes('flash')) {
            groupName = 'Gemini 3 Flash';
        }
        else if (labelLower.includes('gemini') && labelLower.includes('pro')) {
            groupName = 'Gemini 3 Pro';
        }
        else if (labelLower.includes('gemini')) {
            groupName = 'Gemini 3 Pro'; // Default gemini to Pro
        }
        if (groupName && groupsMap[groupName]) {
            groupsMap[groupName].models.push(m.label);
            if (groupsMap[groupName].pct === null) {
                groupsMap[groupName].pct = m.remaining_percent;
                groupsMap[groupName].reset = m.reset_time;
            }
        }
    }
    const result = [];
    for (const name of ['Claude', 'Gemini 3 Pro', 'Gemini 3 Flash']) {
        const g = groupsMap[name];
        if (g.models.length > 0 && g.pct !== null) {
            result.push({
                name,
                remaining_percent: g.pct,
                reset_time: g.reset || '',
                time_until_reset: '', // Will be calculated dynamically
            });
        }
    }
    return result;
}
/**
 * Loads server quota cache from disk
 * Handles both Python script format (models) and plugin format (groups)
 */
export async function loadServerQuotaCache() {
    try {
        if (!existsSync(QUOTA_CACHE_FILE)) {
            return null;
        }
        const content = await readFile(QUOTA_CACHE_FILE, "utf-8");
        const data = JSON.parse(content);
        // If we have models but no groups, convert them
        if (data.models && data.models.length > 0 && (!data.groups || data.groups.length === 0)) {
            data.groups = modelsToGroups(data.models);
        }
        return data;
    }
    catch (error) {
        console.error("[antigravity-stats] Error loading quota cache:", error);
        return null;
    }
}
/**
 * Saves server quota cache to disk
 * Writes in format compatible with Python script (quota_cache.json)
 */
export async function saveServerQuotaCache(cache) {
    try {
        // Ensure directory exists
        const dir = dirname(QUOTA_CACHE_FILE);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        // Convert timestamp to ISO string if it's a number (for Python compatibility)
        const cacheToSave = { ...cache };
        if (typeof cacheToSave.timestamp === 'number') {
            cacheToSave.timestamp = new Date(cacheToSave.timestamp).toISOString();
        }
        // Ensure we have models array for Python script compatibility
        // If we only have groups, convert them back to models format
        if ((!cacheToSave.models || cacheToSave.models.length === 0) && cacheToSave.groups && cacheToSave.groups.length > 0) {
            cacheToSave.models = cacheToSave.groups.map(g => ({
                label: g.name,
                model_id: `GROUP_${g.name.toUpperCase().replace(/\s+/g, '_')}`,
                remaining_percent: g.remaining_percent,
                reset_time: g.reset_time,
                is_exhausted: g.remaining_percent === 0,
            }));
        }
        await writeFile(QUOTA_CACHE_FILE, JSON.stringify(cacheToSave, null, 2), "utf-8");
    }
    catch (error) {
        console.error("[antigravity-stats] Error saving quota cache:", error);
    }
}
//# sourceMappingURL=storage.js.map