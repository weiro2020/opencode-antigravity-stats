/**
 * Types for OpenCode Antigravity Stats Plugin
 */
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
    rpm?: number;
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
export interface AccountState {
    email: string;
    isRateLimited: boolean;
    rateLimitResetTime: number;
    lastUsed: number;
}
export type AccountStateMap = Record<string, AccountState>;
export type ModelGroup = "claude" | "pro" | "flash" | "other";
export interface ServerQuotaModel {
    label: string;
    model_id: string;
    remaining_percent: number;
    reset_time: string;
    is_exhausted: boolean;
}
export interface ServerQuotaGroup {
    name: string;
    remaining_percent: number;
    reset_time: string;
    time_until_reset: string;
}
export interface ServerQuotaCache {
    email: string;
    plan_name?: string;
    timestamp: string | number;
    models?: ServerQuotaModel[];
    prompt_credits_available?: number;
    prompt_credits_monthly?: number;
    flow_credits_available?: number;
    flow_credits_monthly?: number;
    groups?: ServerQuotaGroup[];
    isFromCache?: boolean;
}
export interface QuotaWindow {
    windowStart: number;
    tokensUsed: number;
    requestsCount: number;
}
export interface AccountQuotaTracking {
    windows: {
        [group in ModelGroup]?: QuotaWindow;
    };
}
export interface QuotaTrackingData {
    [email: string]: AccountQuotaTracking;
}
export declare const MAX_HISTORY_ENTRIES = 50;
export declare const RETENTION_DAYS = 7;
export declare const STATS_VERSION = 1;
export declare const FIVE_HOURS_MS: number;
//# sourceMappingURL=types.d.ts.map