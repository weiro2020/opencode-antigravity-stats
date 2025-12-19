/**
 * Types for OpenCode Antigravity Stats Plugin
 */

// ============================================
// Stats Data Structures
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
// - gemini: modelos Gemini de Antigravity (provider google)
// - other: cualquier otro modelo (no se trackea quota)
export type ModelGroup = "claude" | "gemini" | "other";

// Ventana de 5 horas de quota
export interface QuotaWindow {
  windowStart: number;      // timestamp del primer request de esta ventana
  tokensUsed: number;       // tokens acumulados (in + out)
  requestsCount: number;    // requests en esta ventana
}

// Calibración de límite para estimar %
export interface QuotaCalibration {
  tokensAtCalibration: number;    // tokens cuando se calibró
  requestsAtCalibration: number;  // requests cuando se calibró
  percentRemaining: number;       // % reportado por usuario
  timestamp: number;              // cuándo se calibró
  // Límites estimados (calculados)
  estimatedTokenLimit: number;
  estimatedRequestLimit: number;
}

// Tracking completo de quota por cuenta
export interface AccountQuotaTracking {
  // Ventana actual por grupo de modelo
  windows: {
    [group in ModelGroup]?: QuotaWindow;
  };
  // Calibración por grupo (cada grupo tiene su propio límite)
  calibrations?: {
    [group in ModelGroup]?: QuotaCalibration;
  };
  // DEPRECATED: calibración compartida (mantener para migración)
  calibration?: QuotaCalibration;
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
