/**
 * Tipos para OpenCode Antigravity Stats Plugin
 */

// ============================================
// Estructuras de Datos de Stats
// ============================================

export interface ModelStats {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  errors: number;
}

export interface SessionTotals {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  errors: number;
}

export interface SessionStats {
  id: string;
  startedAt: string;
  byModel: Record<string, ModelStats>;
  totals: SessionTotals;
}

export interface RateLimitEntry {
  timestamp: string;
  account: string;
  resetTime: string;
  rpm?: number; // RPM al momento del rate limit
}

export interface RateLimitStats {
  total: number;
  history: RateLimitEntry[];
}

export interface ErrorEntry {
  timestamp: string;
  code: number;
  model: string;
  message: string;
}

export interface ErrorStats {
  total: number;
  byCode: Record<number, number>;
  history: ErrorEntry[];
}

export interface DailyAccountStats {
  requests: number;
  rateLimits: number;
}

export interface DailyModelStats {
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export interface DailyStats {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  rateLimits: number;
  errors: number;
  byModel: Record<string, DailyModelStats>;
  byAccount: Record<string, DailyAccountStats>;
}

export interface StatsData {
  version: number;
  lastUpdated: string;
  session: SessionStats;
  rateLimits: RateLimitStats;
  errors: ErrorStats;
  daily: Record<string, DailyStats>;
  quotaTracking?: QuotaTrackingData;
  rpmData?: RpmData;  // RPM data for external scripts
}

// RPM data persisted for external scripts to read
export interface RpmData {
  rpm: number;                    // Current RPM (requests in last 60s)
  timestamps: number[];           // Recent request timestamps (last 60s)
  updatedAt: number;              // When this was last updated (Unix ms)
}

// ============================================
// Antigravity Accounts Structure
// ============================================

export interface AntigravityAccount {
  email: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId: string;
  addedAt: number;
  lastUsed: number;
  isRateLimited: boolean;
  rateLimitResetTime: number;
}

export interface AntigravityAccountsData {
  version: number;
  accounts: AntigravityAccount[];
  activeIndex: number;
}

// ============================================
// Collector Input Types
// ============================================

export interface MessageData {
  sessionID: string;
  messageID: string;
  model: string;
  providerID: string;
  modelID: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ErrorData {
  code: number;
  message: string;
  model: string;
  isRateLimit: boolean;
}

export interface RateLimitData {
  account: string;
  resetTime: number;
}

// ============================================
// Watcher State Types
// ============================================

export interface AccountState {
  email: string;
  isRateLimited: boolean;
  rateLimitResetTime: number;
  lastUsed: number;
}

export type AccountStateMap = Record<string, AccountState>;

// ============================================
// Quota Tracking Types
// ============================================

// Grupos de modelos para quota (comparten límite)
// - claude: modelos Claude de Antigravity (provider google)
// - pro: modelos Gemini Pro de Antigravity (provider google)
// - flash: modelos Gemini Flash de Antigravity (provider google)
// - other: cualquier otro modelo (no se trackea quota)
export type ModelGroup = "claude" | "pro" | "flash" | "other";

// ============================================
// Server Quota Cache Types (from quota command)
// ============================================

// Individual model quota (format used by Python script)
export interface ServerQuotaModel {
  label: string;                    // "Claude Sonnet 4.5", "Gemini 3 Pro (High)", etc.
  model_id: string;                 // "MODEL_CLAUDE_4_5_SONNET", etc.
  remaining_percent: number;        // 92.5
  reset_time: string;               // ISO timestamp
  is_exhausted: boolean;            // true if remaining is 0
}

// Quota data for a single group from the server
export interface ServerQuotaGroup {
  name: string;                    // "Claude", "Gemini 3 Pro", "Gemini 3 Flash"
  remaining_percent: number;       // 92.5
  reset_time: string;              // ISO timestamp
  time_until_reset: string;        // "4h20m"
}

// Cache of server quota data (persisted to disk)
// Compatible with Python script format (quota_cache.json)
export interface ServerQuotaCache {
  // Common fields
  email: string;                   // Active account email
  plan_name?: string;              // "Pro", etc.
  timestamp: string | number;      // ISO string (Python) or Unix ms (plugin)
  
  // Python script format
  models?: ServerQuotaModel[];     // Individual models (Python format)
  prompt_credits_available?: number;
  prompt_credits_monthly?: number;
  flow_credits_available?: number;
  flow_credits_monthly?: number;
  
  // Plugin format (computed from models)
  groups?: ServerQuotaGroup[];     // Grouped quotas
  isFromCache?: boolean;           // True if using cached data (LS not available)
}

// Ventana de 5 horas de quota
export interface QuotaWindow {
  windowStart: number;      // timestamp del primer request de esta ventana
  tokensUsed: number;       // tokens acumulados (in + out)
  requestsCount: number;    // requests en esta ventana
}

// Tracking de quota por cuenta
export interface AccountQuotaTracking {
  // Ventana actual por grupo de modelo
  windows: {
    [group in ModelGroup]?: QuotaWindow;
  };
}

// Agregar al StatsData
export interface QuotaTrackingData {
  [email: string]: AccountQuotaTracking;
}

// ============================================
// Constants
// ============================================

export const MAX_HISTORY_ENTRIES = 50;
export const RETENTION_DAYS = 7;
export const STATS_VERSION = 1;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
