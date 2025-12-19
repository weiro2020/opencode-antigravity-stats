/**
 * Stats Collector
 * Accumulates statistics from events and watcher
 */
import { loadStats, saveStats, ensureModelStats, ensureDailyStats, addRateLimitEntry, addErrorEntry, resetSession, createEmptyStats, } from "./storage.js";
import { AccountsWatcher } from "./watcher.js";
import { FIVE_HOURS_MS } from "./types.js";
/**
 * Determines the model group for quota tracking
 * Solo trackea modelos de Antigravity (provider google)
 * - claude: modelos Claude
 * - gemini: modelos Gemini
 * - other: cualquier otro (no se trackea quota)
 */
export function getModelGroup(providerID, modelID) {
    // Solo trackear modelos de Antigravity (provider google)
    if (providerID !== "google")
        return "other";
    const lower = modelID.toLowerCase();
    if (lower.includes("claude"))
        return "claude";
    if (lower.includes("gemini"))
        return "gemini";
    return "other";
}
/**
 * Formats time remaining until reset
 */
function formatTimeRemaining(ms) {
    if (ms <= 0)
        return "0m";
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    if (hours > 0)
        return `${hours}h${minutes}m`;
    return `${minutes}m`;
}
export class StatsCollector {
    stats;
    watcher;
    currentSessionId = null;
    onToast = null;
    saveDebounceTimer = null;
    requestTimestamps = [];
    accountStats = new Map();
    constructor() {
        this.stats = createEmptyStats();
        this.watcher = new AccountsWatcher();
    }
    /**
     * Initializes the collector
     */
    async initialize(onToast) {
        this.onToast = onToast || null;
        // Load existing stats
        this.stats = await loadStats();
        // Inicializar accountStats desde quotaTracking guardado en disco
        // Esto preserva los contadores entre reinicios de OpenCode
        // NO validamos expiración aquí - eso lo hace recordMessage
        if (this.stats.quotaTracking) {
            for (const [email, tracking] of Object.entries(this.stats.quotaTracking)) {
                const claudeWindow = tracking.windows?.claude;
                if (claudeWindow) {
                    this.accountStats.set(email, {
                        requests: 0, // RPM se calcula en tiempo real
                        tokensTotal: claudeWindow.tokensUsed,
                        rateLimits: 0,
                        requestTimestamps: [],
                        lastRpmAtRateLimit: null,
                        rpmAtRateLimitHistory: [],
                    });
                }
            }
        }
        // Start watching accounts file for rate limits
        await this.watcher.start(async (entry) => {
            await this.handleRateLimit(entry);
        });
    }
    /**
     * Stops the collector
     */
    async stop() {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        await this.watcher.stop();
        await saveStats(this.stats);
    }
    /**
     * Records a message with token usage
     */
    async recordMessage(data) {
        // Check if session changed
        if (this.currentSessionId !== data.sessionID) {
            this.currentSessionId = data.sessionID;
            resetSession(this.stats, data.sessionID);
        }
        const modelKey = `${data.providerID}/${data.modelID}`;
        // Update session model stats
        const modelStats = ensureModelStats(this.stats, modelKey);
        modelStats.requests++;
        modelStats.tokensIn += data.tokensIn;
        modelStats.tokensOut += data.tokensOut;
        modelStats.cacheRead += data.cacheRead;
        modelStats.cacheWrite += data.cacheWrite;
        // Update session totals
        this.stats.session.totals.requests++;
        this.stats.session.totals.tokensIn += data.tokensIn;
        this.stats.session.totals.tokensOut += data.tokensOut;
        this.stats.session.totals.cacheRead += data.cacheRead;
        this.stats.session.totals.cacheWrite += data.cacheWrite;
        // Update daily stats
        const daily = ensureDailyStats(this.stats);
        daily.requests++;
        daily.tokensIn += data.tokensIn;
        daily.tokensOut += data.tokensOut;
        // Update daily model stats
        if (!daily.byModel[modelKey]) {
            daily.byModel[modelKey] = {
                requests: 0,
                tokensIn: 0,
                tokensOut: 0,
            };
        }
        daily.byModel[modelKey].requests++;
        daily.byModel[modelKey].tokensIn += data.tokensIn;
        daily.byModel[modelKey].tokensOut += data.tokensOut;
        // Determinar grupo del modelo
        const modelGroup = getModelGroup(data.providerID, data.modelID);
        // Solo trackear quota/cuenta/RPM para modelos de Antigravity (claude o gemini)
        // El grupo "other" no cuenta tokens ni afecta la quota
        if (modelGroup !== "other") {
            // Update daily account stats (use active account)
            const activeAccount = await this.watcher.getActiveAccount();
            if (activeAccount) {
                if (!daily.byAccount[activeAccount]) {
                    daily.byAccount[activeAccount] = { requests: 0, rateLimits: 0 };
                }
                daily.byAccount[activeAccount].requests++;
                // Track per-account session stats
                if (!this.accountStats.has(activeAccount)) {
                    this.accountStats.set(activeAccount, {
                        requests: 0,
                        tokensTotal: 0,
                        rateLimits: 0,
                        requestTimestamps: [],
                        lastRpmAtRateLimit: null,
                        rpmAtRateLimitHistory: [],
                    });
                }
                const acctStats = this.accountStats.get(activeAccount);
                acctStats.requests++;
                acctStats.tokensTotal += data.tokensIn + data.tokensOut;
                acctStats.requestTimestamps.push(Date.now());
                // Track quota window (5-hour window per account + model group)
                const tokens = data.tokensIn + data.tokensOut;
                const now = Date.now();
                if (!this.stats.quotaTracking) {
                    this.stats.quotaTracking = {};
                }
                if (!this.stats.quotaTracking[activeAccount]) {
                    this.stats.quotaTracking[activeAccount] = { windows: {} };
                }
                const accountTracking = this.stats.quotaTracking[activeAccount];
                let existingWindow = accountTracking.windows[modelGroup];
                // Leer del disco por si fue modificado externamente
                const diskStats = await loadStats();
                const diskWindow = diskStats.quotaTracking?.[activeAccount]?.windows?.[modelGroup];
                // Determinar el windowStart efectivo (el más viejo entre memoria y disco, si es válido)
                let effectiveWindowStart = existingWindow?.windowStart || now;
                if (diskWindow && diskWindow.windowStart < effectiveWindowStart) {
                    effectiveWindowStart = diskWindow.windowStart;
                }
                const windowAge = now - effectiveWindowStart;
                if (windowAge > FIVE_HOURS_MS) {
                    // Ventana expirada - crear nueva
                    accountTracking.windows[modelGroup] = {
                        windowStart: now,
                        tokensUsed: tokens,
                        requestsCount: 1,
                    };
                }
                else if (!existingWindow) {
                    // No existe en memoria pero puede existir en disco
                    if (diskWindow && (now - diskWindow.windowStart) < FIVE_HOURS_MS) {
                        // Usar valores del disco y acumular
                        accountTracking.windows[modelGroup] = {
                            windowStart: diskWindow.windowStart,
                            tokensUsed: diskWindow.tokensUsed + tokens,
                            requestsCount: diskWindow.requestsCount + 1,
                        };
                    }
                    else {
                        // Crear nueva
                        accountTracking.windows[modelGroup] = {
                            windowStart: now,
                            tokensUsed: tokens,
                            requestsCount: 1,
                        };
                    }
                }
                else {
                    // Ventana existe en memoria - sincronizar con disco si tiene más datos
                    if (diskWindow) {
                        // Usar el windowStart más viejo
                        existingWindow.windowStart = effectiveWindowStart;
                        // Si disco tiene más, sincronizar (evita perder datos si se modificó externamente)
                        if (diskWindow.tokensUsed > existingWindow.tokensUsed) {
                            existingWindow.tokensUsed = diskWindow.tokensUsed;
                        }
                        if (diskWindow.requestsCount > existingWindow.requestsCount) {
                            existingWindow.requestsCount = diskWindow.requestsCount;
                        }
                    }
                    // Acumular el nuevo request
                    existingWindow.tokensUsed += tokens;
                    existingWindow.requestsCount++;
                }
            }
        }
        // Record timestamp for RPM calculation
        this.requestTimestamps.push(Date.now());
        this.cleanTimestamps();
        // Debounced save
        this.scheduleSave();
    }
    /**
     * Cleans timestamps older than 60 seconds
     */
    cleanTimestamps() {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60000);
        // Also clean per-account timestamps
        for (const [, acctStats] of this.accountStats) {
            acctStats.requestTimestamps = acctStats.requestTimestamps.filter((t) => now - t < 60000);
        }
    }
    /**
     * Gets quota stats for all accounts (for display in session title)
     * Returns data needed to show: !CR:5,92%,4h20,1.8M
     * @param activeGroup - The model group to show stats for (claude or gemini)
     */
    async getQuotaStats(activeGroup = "claude") {
        // Si el grupo es "other", no mostramos stats de quota
        if (activeGroup === "other") {
            return [];
        }
        this.cleanTimestamps();
        const accounts = await this.watcher.getAllAccounts();
        const result = [];
        const now = Date.now();
        // Read disk stats to get externally set calibration and windowStart
        const diskStats = await loadStats();
        for (const account of accounts) {
            const prefix = account.email.split("@")[0].substring(0, 2).toUpperCase();
            const acctStats = this.accountStats.get(account.email);
            const rpm = acctStats?.requestTimestamps.length || 0;
            // Get quota tracking for this account
            const tracking = this.stats.quotaTracking?.[account.email];
            const diskTracking = diskStats.quotaTracking?.[account.email];
            const window = tracking?.windows[activeGroup];
            const diskWindow = diskTracking?.windows?.[activeGroup];
            let tokensUsed = 0;
            let requestsCount = 0;
            let timeUntilReset = "?";
            let percentRemaining = null;
            if (window) {
                // Use disk windowStart if it's older (externally set)
                let windowStart = window.windowStart;
                if (diskWindow && diskWindow.windowStart < windowStart) {
                    windowStart = diskWindow.windowStart;
                }
                // Check if window is still valid (less than 5 hours old)
                const windowAge = now - windowStart;
                if (windowAge < FIVE_HOURS_MS) {
                    tokensUsed = window.tokensUsed;
                    requestsCount = window.requestsCount;
                    const remaining = FIVE_HOURS_MS - windowAge;
                    timeUntilReset = formatTimeRemaining(remaining);
                    // Use disk calibration if available (externally set)
                    // Priority: calibrations[group] > calibration (legacy)
                    const calibration = diskTracking?.calibrations?.[activeGroup] ||
                        tracking?.calibrations?.[activeGroup] ||
                        diskTracking?.calibration ||
                        tracking?.calibration;
                    // Calculate estimated % if calibrated
                    if (calibration) {
                        const requestRatio = requestsCount / calibration.estimatedRequestLimit;
                        const usedPercent = requestRatio * 100;
                        percentRemaining = Math.max(0, Math.min(100, 100 - usedPercent));
                    }
                }
                else {
                    // Window expired, reset
                    timeUntilReset = "5h0m";
                }
            }
            else {
                timeUntilReset = "5h0m"; // No window yet
            }
            result.push({
                email: account.email,
                prefix,
                rpm,
                isRateLimited: account.isRateLimited,
                percentRemaining,
                timeUntilReset,
                tokensUsed,
                requestsCount,
                modelGroup: activeGroup,
            });
        }
        return result;
    }
    /**
     * Calibrates quota estimation for an account
     * Call this when user provides current % from AntigravityQuota extension
     * @param email Account email
     * @param percentRemaining Current % remaining
     * @param modelGroup Model group to calibrate (claude or gemini)
     */
    calibrateQuota(email, percentRemaining, modelGroup = "claude") {
        if (modelGroup === "other") {
            console.error("[antigravity-stats] Cannot calibrate 'other' group");
            return;
        }
        if (!this.stats.quotaTracking?.[email]) {
            console.error("[antigravity-stats] No tracking data for account:", email);
            return;
        }
        const tracking = this.stats.quotaTracking[email];
        const window = tracking.windows[modelGroup];
        if (!window) {
            console.error("[antigravity-stats] No window data for calibration");
            return;
        }
        const percentUsed = 100 - percentRemaining;
        if (percentUsed <= 0) {
            console.error("[antigravity-stats] Cannot calibrate with 100% remaining");
            return;
        }
        // Calcular límites estimados
        // Si usamos X tokens y Y requests, y eso representa Z% del total:
        // límite_tokens = X / (Z/100)
        // límite_requests = Y / (Z/100)
        const estimatedTokenLimit = Math.round(window.tokensUsed / (percentUsed / 100));
        const estimatedRequestLimit = Math.round(window.requestsCount / (percentUsed / 100));
        // Guardar en calibrations[group]
        if (!tracking.calibrations) {
            tracking.calibrations = {};
        }
        tracking.calibrations[modelGroup] = {
            tokensAtCalibration: window.tokensUsed,
            requestsAtCalibration: window.requestsCount,
            percentRemaining,
            timestamp: Date.now(),
            estimatedTokenLimit,
            estimatedRequestLimit,
        };
        console.log(`[antigravity-stats] Calibrated quota for ${email} (${modelGroup})`);
        console.log("  Tokens at calibration:", window.tokensUsed);
        console.log("  Requests at calibration:", window.requestsCount);
        console.log("  Percent remaining:", percentRemaining);
        console.log("  Estimated token limit:", estimatedTokenLimit);
        console.log("  Estimated request limit:", estimatedRequestLimit);
        this.scheduleSave();
    }
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
    calibrateQuotaManual(email, percentRemaining, estimatedTokenLimit, estimatedRequestLimit, windowAgeMinutes, modelGroup = "claude") {
        if (modelGroup === "other") {
            console.error("[antigravity-stats] Cannot calibrate 'other' group");
            return;
        }
        // Ensure quota tracking exists for this account
        if (!this.stats.quotaTracking) {
            this.stats.quotaTracking = {};
        }
        if (!this.stats.quotaTracking[email]) {
            this.stats.quotaTracking[email] = { windows: {} };
        }
        const tracking = this.stats.quotaTracking[email];
        // If windowAgeMinutes provided, adjust the window start time
        if (windowAgeMinutes !== undefined && windowAgeMinutes > 0) {
            const windowStart = Date.now() - (windowAgeMinutes * 60 * 1000);
            if (!tracking.windows[modelGroup]) {
                tracking.windows[modelGroup] = {
                    windowStart,
                    tokensUsed: 0,
                    requestsCount: 0,
                };
            }
            else {
                tracking.windows[modelGroup].windowStart = windowStart;
            }
        }
        const window = tracking.windows[modelGroup];
        const tokensUsed = window?.tokensUsed || 0;
        const requestsCount = window?.requestsCount || 0;
        // Guardar en calibrations[group]
        if (!tracking.calibrations) {
            tracking.calibrations = {};
        }
        tracking.calibrations[modelGroup] = {
            tokensAtCalibration: tokensUsed,
            requestsAtCalibration: requestsCount,
            percentRemaining,
            timestamp: Date.now(),
            estimatedTokenLimit,
            estimatedRequestLimit,
        };
        console.log(`[antigravity-stats] Manual calibration for ${email} (${modelGroup})`);
        console.log("  Percent remaining:", percentRemaining);
        console.log("  Estimated token limit:", estimatedTokenLimit);
        console.log("  Estimated request limit:", estimatedRequestLimit);
        if (windowAgeMinutes) {
            console.log("  Window age:", windowAgeMinutes, "minutes");
        }
        this.scheduleSave();
    }
    /**
     * Gets current RPM (Requests Per Minute) based on last 60 seconds
     */
    getRPM() {
        this.cleanTimestamps();
        return this.requestTimestamps.length;
    }
    /**
     * Gets stats for all accounts (for display in session title)
     * Returns array of { prefix, rpm, tokensTotal, rateLimits, isRateLimited, rpmThreshold }
     */
    async getAllAccountsStats() {
        this.cleanTimestamps();
        const accounts = await this.watcher.getAllAccounts();
        const result = [];
        for (const account of accounts) {
            const prefix = account.email.split("@")[0].substring(0, 2).toUpperCase();
            const acctStats = this.accountStats.get(account.email);
            const rpm = acctStats?.requestTimestamps.length || 0;
            const tokensTotal = acctStats?.tokensTotal || 0;
            const rateLimits = acctStats?.rateLimits || 0;
            const rpmThreshold = acctStats?.lastRpmAtRateLimit ?? null;
            // Calculate average RPM at rate-limit
            let avgRpmAtRateLimit = null;
            if (acctStats?.rpmAtRateLimitHistory.length) {
                const sum = acctStats.rpmAtRateLimitHistory.reduce((a, b) => a + b, 0);
                avgRpmAtRateLimit = Math.round(sum / acctStats.rpmAtRateLimitHistory.length);
            }
            result.push({
                email: account.email,
                prefix,
                rpm,
                tokensTotal,
                rateLimits,
                isRateLimited: account.isRateLimited,
                rpmThreshold,
                avgRpmAtRateLimit,
            });
        }
        return result;
    }
    /**
     * Records an error
     */
    async recordError(data) {
        const entry = {
            timestamp: new Date().toISOString(),
            code: data.code,
            model: data.model,
            message: data.message.slice(0, 200), // Truncate message
        };
        addErrorEntry(this.stats, entry);
        // Update model error count in session
        const modelStats = ensureModelStats(this.stats, data.model);
        modelStats.errors++;
        // If it's a rate limit error, the watcher will handle it
        // But we still record it as an error
        this.scheduleSave();
    }
    /**
     * Handles a rate limit detected by the watcher
     */
    async handleRateLimit(entry) {
        // Track per-account rate limits
        if (!this.accountStats.has(entry.account)) {
            this.accountStats.set(entry.account, {
                requests: 0,
                tokensTotal: 0,
                rateLimits: 0,
                requestTimestamps: [],
                lastRpmAtRateLimit: null,
                rpmAtRateLimitHistory: [],
            });
        }
        const acctStats = this.accountStats.get(entry.account);
        acctStats.rateLimits++;
        // Record RPM at rate-limit moment
        this.cleanTimestamps();
        const currentRpm = acctStats.requestTimestamps.length;
        acctStats.lastRpmAtRateLimit = currentRpm;
        acctStats.rpmAtRateLimitHistory.push(currentRpm);
        // Keep only last 10 entries
        if (acctStats.rpmAtRateLimitHistory.length > 10) {
            acctStats.rpmAtRateLimitHistory.shift();
        }
        // Add RPM to entry before saving
        entry.rpm = currentRpm;
        addRateLimitEntry(this.stats, entry);
        // Show toast notification
        if (this.onToast) {
            const resetDate = new Date(entry.resetTime);
            const now = new Date();
            const diffMs = resetDate.getTime() - now.getTime();
            const diffSecs = Math.max(0, Math.ceil(diffMs / 1000));
            await this.onToast("Rate Limit", `${entry.account} rate-limited. Reset in ${diffSecs}s`, "warning");
        }
        this.scheduleSave();
    }
    /**
     * Schedules a debounced save
     */
    scheduleSave() {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(async () => {
            await saveStats(this.stats);
        }, 1000);
    }
    /**
     * Gets current stats
     */
    getStats() {
        return this.stats;
    }
    /**
     * Gets the watcher instance (for account lookups)
     */
    getWatcher() {
        return this.watcher;
    }
    /**
     * Forces a save
     */
    async forceSave() {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        await saveStats(this.stats);
    }
}
//# sourceMappingURL=collector.js.map