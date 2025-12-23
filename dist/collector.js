/**
 * Stats Collector
 * Accumulates statistics from events and watcher
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadStats, saveStats, ensureModelStats, ensureDailyStats, addRateLimitEntry, addErrorEntry, resetSession, createEmptyStats, loadServerQuotaCache, saveServerQuotaCache, } from "./storage.js";
import { AccountsWatcher } from "./watcher.js";
import { FIVE_HOURS_MS } from "./types.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const execAsync = promisify(exec);
// Get the directory where this module is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Path to the quota command (in scripts/ directory relative to dist/)
// Structure: plugin/dist/collector.js -> plugin/scripts/quota
const QUOTA_COMMAND = join(__dirname, "..", "scripts", "quota");
/**
 * Determines the model group for quota tracking
 * Solo trackea modelos de Antigravity (provider google)
 * - claude: modelos Claude
 * - pro: modelos Gemini Pro
 * - flash: modelos Gemini Flash
 * - other: cualquier otro (no se trackea quota)
 */
export function getModelGroup(providerID, modelID) {
    // Solo trackear modelos de Antigravity (provider google)
    if (providerID !== "google")
        return "other";
    const lower = modelID.toLowerCase();
    if (lower.includes("claude"))
        return "claude";
    if (lower.includes("gemini") && lower.includes("flash"))
        return "flash";
    if (lower.includes("gemini") && lower.includes("pro"))
        return "pro";
    if (lower.includes("gemini"))
        return "pro"; // Default gemini → pro
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
    // Server quota cache (from quota command)
    serverQuotaCache = null;
    quotaFetchInterval = null;
    quotaFetchStarted = false;
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
        // Load server quota cache from disk (fallback if fetch fails)
        this.serverQuotaCache = await loadServerQuotaCache();
        // Fetch fresh quota data from server immediately
        // This ensures we have current data when the first message arrives
        // Wrapped in try/catch to prevent initialization failures
        try {
            await this.fetchServerQuota();
        }
        catch {
            // Silently ignore - fetchServerQuota already handles errors
            this.serverQuotaCache = null;
        }
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
        // Stop quota fetching interval
        if (this.quotaFetchInterval) {
            clearInterval(this.quotaFetchInterval);
            this.quotaFetchInterval = null;
        }
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        await this.watcher.stop();
        await saveStats(this.stats);
        // Save quota cache to disk
        if (this.serverQuotaCache) {
            await saveServerQuotaCache(this.serverQuotaCache);
        }
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
            // Priority: 1) Server quota cache email, 2) Local accounts file
            const serverEmail = this.serverQuotaCache?.email;
            const localAccount = await this.watcher.getActiveAccount();
            const activeAccount = serverEmail || localAccount;
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
        for (const account of accounts) {
            const prefix = account.email.split("@")[0].substring(0, 2).toUpperCase();
            const acctStats = this.accountStats.get(account.email);
            const rpm = acctStats?.requestTimestamps.length || 0;
            // Get quota tracking for this account
            const tracking = this.stats.quotaTracking?.[account.email];
            const window = tracking?.windows[activeGroup];
            let tokensUsed = 0;
            let requestsCount = 0;
            let timeUntilReset = "?";
            // El % viene del servidor, no se calcula localmente
            const percentRemaining = null;
            if (window) {
                const windowAge = now - window.windowStart;
                if (windowAge < FIVE_HOURS_MS) {
                    tokensUsed = window.tokensUsed;
                    requestsCount = window.requestsCount;
                    const remaining = FIVE_HOURS_MS - windowAge;
                    timeUntilReset = formatTimeRemaining(remaining);
                }
                else {
                    // Window expired
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
            // Update RPM data before saving so external scripts can read it
            this.updateRpmData();
            await saveStats(this.stats);
        }, 1000);
    }
    /**
     * Updates RPM data in stats for external scripts to read
     */
    updateRpmData() {
        this.cleanTimestamps();
        const now = Date.now();
        // Filter timestamps to only include last 60 seconds
        const recentTimestamps = this.requestTimestamps.filter(t => now - t < 60000);
        this.stats.rpmData = {
            rpm: recentTimestamps.length,
            timestamps: recentTimestamps,
            updatedAt: now,
        };
    }
    // ============================================
    // Server Quota Fetching (from quota command)
    // ============================================
    /**
     * Starts the quota fetching process
     * Called on first message, sets up interval for every 60 seconds
     * Note: First fetch is done in initialize() to ensure data is ready
     */
    startQuotaFetching() {
        if (this.quotaFetchStarted)
            return;
        this.quotaFetchStarted = true;
        // Set up interval for every 60 seconds
        // First fetch was already done in initialize()
        // Wrap in try/catch to prevent any unhandled errors
        this.quotaFetchInterval = setInterval(() => {
            this.fetchServerQuota().catch(() => {
                // Silently ignore all errors
            });
        }, 60000);
    }
    /**
     * Fetches quota from the server using the quota command
     * Updates serverQuotaCache and persists to disk on success
     * Script returns {"available": false} when tunnel is not available
     * ALL errors are silently ignored to prevent UI notifications
     */
    async fetchServerQuota() {
        try {
            const result = await execAsync(`${QUOTA_COMMAND} --json`, { timeout: 15000 });
            // If no output, treat as no data available
            if (!result.stdout || !result.stdout.trim()) {
                this.serverQuotaCache = null;
                return;
            }
            const data = JSON.parse(result.stdout);
            // Check if script returned "no data available" response
            if (data.available === false) {
                this.serverQuotaCache = null;
                return;
            }
            this.serverQuotaCache = {
                timestamp: Date.now(),
                email: data.email || "",
                groups: (data.groups || []).map((g) => ({
                    name: g.name,
                    remaining_percent: g.remaining_percent,
                    reset_time: g.reset_time,
                    time_until_reset: g.time_until_reset,
                })),
                isFromCache: data.is_cached || false,
            };
            // Verificar si hay que resetear contadores locales para cada grupo
            // Esto se ejecuta cada 60 segundos para todos los grupos de la cuenta activa
            const activeEmail = data.email;
            if (activeEmail && this.stats.quotaTracking?.[activeEmail]) {
                const accountTracking = this.stats.quotaTracking[activeEmail];
                // Mapeo de nombres de grupo del servidor a ModelGroup local
                const serverGroupMap = {
                    "Claude": "claude",
                    "Gemini 3 Pro": "pro",
                    "Gemini 3 Flash": "flash",
                };
                for (const serverGroup of (data.groups || [])) {
                    const modelGroup = serverGroupMap[serverGroup.name];
                    if (!modelGroup)
                        continue;
                    const window = accountTracking.windows?.[modelGroup];
                    if (!window)
                        continue;
                    const serverResetTime = serverGroup.reset_time
                        ? new Date(serverGroup.reset_time).getTime()
                        : null;
                    if (serverResetTime) {
                        const serverCycleStart = serverResetTime - FIVE_HOURS_MS;
                        if (window.windowStart < serverCycleStart) {
                            // El servidor empezó un nuevo ciclo - resetear contadores locales
                            window.windowStart = serverCycleStart;
                            window.requestsCount = 0;
                            window.tokensUsed = 0;
                        }
                    }
                }
                // Guardar cambios si hubo resets
                this.scheduleSave();
            }
            // Persist to disk on successful fetch
            await saveServerQuotaCache(this.serverQuotaCache);
        }
        catch {
            // Silently ignore ALL errors - don't let anything bubble up
            // This includes: exit code 2, JSON parse errors, timeouts, etc.
            // Just clear the cache so the plugin knows there's no live data
            this.serverQuotaCache = null;
        }
    }
    /**
     * Gets server quota data for a specific model group
     * Maps server group names to ModelGroup values
     * Calculates timeUntilReset dynamically from reset_time
     */
    getServerQuotaForGroup(group) {
        if (!this.serverQuotaCache || !this.serverQuotaCache.groups || group === "other")
            return null;
        // Map server group names to our ModelGroup values
        const groupNameMap = {
            "Claude": "claude",
            "Gemini 3 Pro": "pro",
            "Gemini 3 Flash": "flash",
        };
        const serverGroup = this.serverQuotaCache.groups.find((g) => groupNameMap[g.name] === group);
        if (!serverGroup)
            return null;
        // Calculate time until reset dynamically from reset_time
        const timeUntilReset = this.calculateTimeUntilReset(serverGroup.reset_time);
        return {
            percent: serverGroup.remaining_percent,
            timeUntilReset,
            resetTime: serverGroup.reset_time,
            isFromCache: this.serverQuotaCache.isFromCache ?? false,
        };
    }
    /**
     * Calculates time remaining until reset from ISO timestamp
     */
    calculateTimeUntilReset(resetTimeStr) {
        if (!resetTimeStr)
            return "?";
        try {
            const resetTime = new Date(resetTimeStr);
            const now = new Date();
            const diffMs = resetTime.getTime() - now.getTime();
            if (diffMs <= 0)
                return "0m";
            const hours = Math.floor(diffMs / (60 * 60 * 1000));
            const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
            if (hours > 0)
                return `${hours}h${minutes}m`;
            return `${minutes}m`;
        }
        catch {
            return "?";
        }
    }
    /**
     * Gets quota stats for all 3 groups, combining server data with local tracking
     * Returns groups ordered with active group first, then CL, PR, FL
     * @param activeGroup - The currently active model group
     */
    async getQuotaStatsAllGroups(activeGroup) {
        this.cleanTimestamps();
        const groups = ["claude", "pro", "flash"];
        const groupLabels = {
            claude: "CL",
            pro: "PR",
            flash: "FL",
            other: "?",
        };
        const result = [];
        // Get active account for local stats
        // Priority: 1) Server quota cache email, 2) Local accounts file
        const serverEmail = this.serverQuotaCache?.email;
        const localAccount = await this.watcher.getActiveAccount();
        const activeAccount = serverEmail || localAccount;
        const acctStats = activeAccount ? this.accountStats.get(activeAccount) : null;
        for (const group of groups) {
            const isActive = group === activeGroup;
            // Get server data (% and time)
            const serverData = this.getServerQuotaForGroup(group);
            // Get local data (rpm, requests, tokens) - only for active group
            let rpm = 0;
            let requestsCount = 0;
            let tokensUsed = 0;
            if (isActive && activeAccount) {
                rpm = acctStats?.requestTimestamps.length || 0;
                // Get from quota tracking for this account and group (READ ONLY)
                // La lógica de reset está en fetchServerQuota, no aquí
                const tracking = this.stats.quotaTracking?.[activeAccount];
                const window = tracking?.windows?.[group];
                if (window) {
                    requestsCount = window.requestsCount;
                    tokensUsed = window.tokensUsed;
                }
            }
            result.push({
                group,
                label: groupLabels[group],
                rpm,
                requestsCount,
                tokensUsed,
                percentRemaining: serverData?.percent ?? null,
                timeUntilReset: serverData?.timeUntilReset || "?",
                isFromCache: serverData?.isFromCache ?? true,
                isActive,
            });
        }
        // Sort: active group first, then maintain CL, PR, FL order
        result.sort((a, b) => {
            if (a.isActive && !b.isActive)
                return -1;
            if (!a.isActive && b.isActive)
                return 1;
            // For non-active, maintain original order (CL, PR, FL)
            const order = { claude: 0, pro: 1, flash: 2, other: 3 };
            return order[a.group] - order[b.group];
        });
        return result;
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