/**
 * Stats Collector
 * Accumulates statistics from events and watcher
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  StatsData,
  MessageData,
  ErrorData,
  RateLimitEntry,
  ErrorEntry,
  ModelGroup,
  QuotaWindow,
  AccountQuotaTracking,
  ServerQuotaCache,
  ServerQuotaGroup,
} from "./types.js";
import {
  loadStats,
  saveStats,
  ensureModelStats,
  ensureDailyStats,
  addRateLimitEntry,
  addErrorEntry,
  resetSession,
  createEmptyStats,
  loadServerQuotaCache,
  saveServerQuotaCache,
} from "./storage.js";
import { AccountsWatcher } from "./watcher.js";
import { FIVE_HOURS_MS } from "./types.js";
import { homedir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(exec);

// Path to the quota command (absolute path since it may not be in PATH)
const QUOTA_COMMAND = join(homedir(), ".antigravity-standalone", "quota");

export type ToastCallback = (
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error"
) => Promise<void>;

/**
 * Determines the model group for quota tracking
 * Solo trackea modelos de Antigravity (provider google)
 * - claude: modelos Claude
 * - pro: modelos Gemini Pro
 * - flash: modelos Gemini Flash
 * - other: cualquier otro (no se trackea quota)
 */
export function getModelGroup(providerID: string, modelID: string): ModelGroup {
  // Solo trackear modelos de Antigravity (provider google)
  if (providerID !== "google") return "other";
  
  const lower = modelID.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gemini") && lower.includes("flash")) return "flash";
  if (lower.includes("gemini") && lower.includes("pro")) return "pro";
  if (lower.includes("gemini")) return "pro"; // Default gemini → pro
  return "other";
}

/**
 * Formats time remaining until reset
 */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export interface AccountSessionStats {
  requests: number;
  tokensTotal: number;
  rateLimits: number;
  requestTimestamps: number[];
  // RPM tracking at rate-limit moments
  lastRpmAtRateLimit: number | null;
  rpmAtRateLimitHistory: number[];
}

export class StatsCollector {
  private stats: StatsData;
  private watcher: AccountsWatcher;
  private currentSessionId: string | null = null;
  private onToast: ToastCallback | null = null;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private requestTimestamps: number[] = [];
  private accountStats: Map<string, AccountSessionStats> = new Map();
  
  // Server quota cache (from quota command)
  private serverQuotaCache: ServerQuotaCache | null = null;
  private quotaFetchInterval: NodeJS.Timeout | null = null;
  private quotaFetchStarted: boolean = false;

  constructor() {
    this.stats = createEmptyStats();
    this.watcher = new AccountsWatcher();
  }

  /**
   * Initializes the collector
   */
  async initialize(onToast?: ToastCallback): Promise<void> {
    this.onToast = onToast || null;

    // Load existing stats
    this.stats = await loadStats();
    
    // Load server quota cache from disk (fallback if fetch fails)
    this.serverQuotaCache = await loadServerQuotaCache();
    
    // Fetch fresh quota data from server immediately
    // This ensures we have current data when the first message arrives
    await this.fetchServerQuota();

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
  async stop(): Promise<void> {
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
  async recordMessage(data: MessageData): Promise<void> {
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
        const acctStats = this.accountStats.get(activeAccount)!;
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
        } else if (!existingWindow) {
          // No existe en memoria pero puede existir en disco
          if (diskWindow && (now - diskWindow.windowStart) < FIVE_HOURS_MS) {
            // Usar valores del disco y acumular
            accountTracking.windows[modelGroup] = {
              windowStart: diskWindow.windowStart,
              tokensUsed: diskWindow.tokensUsed + tokens,
              requestsCount: diskWindow.requestsCount + 1,
            };
          } else {
            // Crear nueva
            accountTracking.windows[modelGroup] = {
              windowStart: now,
              tokensUsed: tokens,
              requestsCount: 1,
            };
          }
        } else {
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
  private cleanTimestamps(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < 60000
    );
    // Also clean per-account timestamps
    for (const [, acctStats] of this.accountStats) {
      acctStats.requestTimestamps = acctStats.requestTimestamps.filter(
        (t) => now - t < 60000
      );
    }
  }

  /**
   * Gets quota stats for all accounts (for display in session title)
   * Returns data needed to show: !CR:5,92%,4h20,1.8M
   * @param activeGroup - The model group to show stats for (claude or gemini)
   */
  async getQuotaStats(activeGroup: ModelGroup = "claude"): Promise<
    Array<{
      email: string;
      prefix: string;
      rpm: number;
      isRateLimited: boolean;
      percentRemaining: number | null;
      timeUntilReset: string;
      tokensUsed: number;
      requestsCount: number;
      modelGroup: ModelGroup;
    }>
  > {
    // Si el grupo es "other", no mostramos stats de quota
    if (activeGroup === "other") {
      return [];
    }

    this.cleanTimestamps();
    const accounts = await this.watcher.getAllAccounts();
    const result: Array<{
      email: string;
      prefix: string;
      rpm: number;
      isRateLimited: boolean;
      percentRemaining: number | null;
      timeUntilReset: string;
      tokensUsed: number;
      requestsCount: number;
      modelGroup: ModelGroup;
    }> = [];

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
      const percentRemaining: number | null = null;

      if (window) {
        const windowAge = now - window.windowStart;
        if (windowAge < FIVE_HOURS_MS) {
          tokensUsed = window.tokensUsed;
          requestsCount = window.requestsCount;
          const remaining = FIVE_HOURS_MS - windowAge;
          timeUntilReset = formatTimeRemaining(remaining);
        } else {
          // Window expired
          timeUntilReset = "5h0m";
        }
      } else {
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
  getRPM(): number {
    this.cleanTimestamps();
    return this.requestTimestamps.length;
  }

  /**
   * Gets stats for all accounts (for display in session title)
   * Returns array of { prefix, rpm, tokensTotal, rateLimits, isRateLimited, rpmThreshold }
   */
  async getAllAccountsStats(): Promise<
    Array<{
      email: string;
      prefix: string;
      rpm: number;
      tokensTotal: number;
      rateLimits: number;
      isRateLimited: boolean;
      rpmThreshold: number | null;
      avgRpmAtRateLimit: number | null;
    }>
  > {
    this.cleanTimestamps();
    const accounts = await this.watcher.getAllAccounts();
    const result: Array<{
      email: string;
      prefix: string;
      rpm: number;
      tokensTotal: number;
      rateLimits: number;
      isRateLimited: boolean;
      rpmThreshold: number | null;
      avgRpmAtRateLimit: number | null;
    }> = [];

    for (const account of accounts) {
      const prefix = account.email.split("@")[0].substring(0, 2).toUpperCase();
      const acctStats = this.accountStats.get(account.email);
      const rpm = acctStats?.requestTimestamps.length || 0;
      const tokensTotal = acctStats?.tokensTotal || 0;
      const rateLimits = acctStats?.rateLimits || 0;
      const rpmThreshold = acctStats?.lastRpmAtRateLimit ?? null;

      // Calculate average RPM at rate-limit
      let avgRpmAtRateLimit: number | null = null;
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
  async recordError(data: ErrorData): Promise<void> {
    const entry: ErrorEntry = {
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
  private async handleRateLimit(entry: RateLimitEntry): Promise<void> {
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
    const acctStats = this.accountStats.get(entry.account)!;
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

      await this.onToast(
        "Rate Limit",
        `${entry.account} rate-limited. Reset in ${diffSecs}s`,
        "warning"
      );
    }

    this.scheduleSave();
  }

  /**
   * Schedules a debounced save
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(async () => {
      await saveStats(this.stats);
    }, 1000);
  }

  // ============================================
  // Server Quota Fetching (from quota command)
  // ============================================

  /**
   * Starts the quota fetching process
   * Called on first message, sets up interval for every 60 seconds
   * Note: First fetch is done in initialize() to ensure data is ready
   */
  startQuotaFetching(): void {
    if (this.quotaFetchStarted) return;
    this.quotaFetchStarted = true;

    // Set up interval for every 60 seconds
    // First fetch was already done in initialize()
    this.quotaFetchInterval = setInterval(() => {
      this.fetchServerQuota();
    }, 60000);
  }

  /**
   * Fetches quota from the server using the quota command
   * Updates serverQuotaCache and persists to disk on success
   */
  async fetchServerQuota(): Promise<void> {
    try {
      const result = await execAsync(`${QUOTA_COMMAND} --json`, { timeout: 15000 });
      const data = JSON.parse(result.stdout);

      this.serverQuotaCache = {
        timestamp: Date.now(),
        email: data.email || "",
        groups: (data.groups || []).map((g: any) => ({
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
        const serverGroupMap: Record<string, ModelGroup> = {
          "Claude": "claude",
          "Gemini 3 Pro": "pro",
          "Gemini 3 Flash": "flash",
        };
        
        for (const serverGroup of (data.groups || [])) {
          const modelGroup = serverGroupMap[serverGroup.name];
          if (!modelGroup) continue;
          
          const window = accountTracking.windows?.[modelGroup];
          if (!window) continue;
          
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

    } catch (error) {
      console.error("[antigravity-stats] Error fetching quota:", error);
      // Keep existing cache if available, mark as from cache
      if (this.serverQuotaCache) {
        this.serverQuotaCache.isFromCache = true;
      }
    }
  }

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
  } | null {
    if (!this.serverQuotaCache || !this.serverQuotaCache.groups || group === "other") return null;

    // Map server group names to our ModelGroup values
    const groupNameMap: Record<string, ModelGroup> = {
      "Claude": "claude",
      "Gemini 3 Pro": "pro",
      "Gemini 3 Flash": "flash",
    };

    const serverGroup = this.serverQuotaCache.groups.find(
      (g) => groupNameMap[g.name] === group
    );

    if (!serverGroup) return null;

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
  private calculateTimeUntilReset(resetTimeStr: string): string {
    if (!resetTimeStr) return "?";
    
    try {
      const resetTime = new Date(resetTimeStr);
      const now = new Date();
      const diffMs = resetTime.getTime() - now.getTime();
      
      if (diffMs <= 0) return "0m";
      
      const hours = Math.floor(diffMs / (60 * 60 * 1000));
      const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
      
      if (hours > 0) return `${hours}h${minutes}m`;
      return `${minutes}m`;
    } catch {
      return "?";
    }
  }

  /**
   * Gets quota stats for all 3 groups, combining server data with local tracking
   * Returns groups ordered with active group first, then CL, PR, FL
   * @param activeGroup - The currently active model group
   */
  async getQuotaStatsAllGroups(activeGroup: ModelGroup): Promise<
    Array<{
      group: ModelGroup;
      label: string;        // "CL", "PR", "FL"
      rpm: number;
      requestsCount: number;
      tokensUsed: number;
      percentRemaining: number | null;
      timeUntilReset: string;
      isFromCache: boolean;
      isActive: boolean;
    }>
  > {
    this.cleanTimestamps();
    
    const groups: ModelGroup[] = ["claude", "pro", "flash"];
    const groupLabels: Record<ModelGroup, string> = {
      claude: "CL",
      pro: "PR",
      flash: "FL",
      other: "?",
    };

    const result: Array<{
      group: ModelGroup;
      label: string;
      rpm: number;
      requestsCount: number;
      tokensUsed: number;
      percentRemaining: number | null;
      timeUntilReset: string;
      isFromCache: boolean;
      isActive: boolean;
    }> = [];

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
        
        // Get from quota tracking for this account and group
        const tracking = this.stats.quotaTracking?.[activeAccount];
        const window = tracking?.windows?.[group];
        
        if (window) {
          // Check if server quota was reset (100% remaining or reset_time is in the future 
          // and our windowStart is before the previous reset cycle)
          const serverResetTime = serverData?.resetTime ? new Date(serverData.resetTime).getTime() : null;
          const serverPercent = serverData?.percent;
          
          // If server shows 100% and we have requests, the server reset - clear our counters
          // Or if our window started before the server's current cycle began (reset_time - 5h)
          let shouldReset = false;
          
          // Comentado: Esta logica causa resets prematuros cuando el uso es bajo o hay mucho cache
          // y el servidor sigue reportando 100%. Confiamos mas en el timestamp.
          /*
          if (serverPercent !== null && serverPercent !== undefined && serverPercent >= 99.9 && window.requestsCount > 0) {
            // Server shows 100%, but we have requests - server must have reset
            shouldReset = true;
          } else 
          */
          if (serverResetTime) {
            // Calculate when the current server cycle started (reset_time - 5h)
            const serverCycleStart = serverResetTime - FIVE_HOURS_MS;
            if (window.windowStart < serverCycleStart) {
              // Our window started before the current server cycle - reset
              shouldReset = true;
            }
          }
          
          if (shouldReset && serverResetTime) {
            // Reset the local window to match server's new cycle
            const serverCycleStart = serverResetTime - FIVE_HOURS_MS;
            window.windowStart = serverCycleStart;
            window.requestsCount = 0;
            window.tokensUsed = 0;
            this.scheduleSave();
          }
          
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
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      // For non-active, maintain original order (CL, PR, FL)
      const order: Record<ModelGroup, number> = { claude: 0, pro: 1, flash: 2, other: 3 };
      return order[a.group] - order[b.group];
    });

    return result;
  }

  /**
   * Gets current stats
   */
  getStats(): StatsData {
    return this.stats;
  }

  /**
   * Gets the watcher instance (for account lookups)
   */
  getWatcher(): AccountsWatcher {
    return this.watcher;
  }

  /**
   * Forces a save
   */
  async forceSave(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await saveStats(this.stats);
  }
}
