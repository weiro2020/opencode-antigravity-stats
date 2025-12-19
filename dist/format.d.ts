/**
 * Formatter for stats output
 * Generates human-readable output for /stats command
 */
import type { StatsData } from "./types.js";
/**
 * Account stats data passed from collector
 */
export interface AccountStatsInfo {
    email: string;
    prefix: string;
    rpm: number;
    tokensTotal: number;
    rateLimits: number;
    isRateLimited: boolean;
    rpmThreshold: number | null;
    avgRpmAtRateLimit: number | null;
}
/**
 * Formats all stats
 */
export declare function formatStats(stats: StatsData, view?: "session" | "daily" | "errors" | "all", accountsStats?: AccountStatsInfo[]): string;
//# sourceMappingURL=format.d.ts.map