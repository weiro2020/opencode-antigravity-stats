/**
 * Formatter for stats output
 * Generates human-readable output for /stats command
 */
/**
 * Formats a number with K/M notation
 */
function formatNumber(num) {
    if (num >= 1_000_000) {
        return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
        return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
}
/**
 * Formats duration from session start
 */
function formatDuration(startedAt) {
    const start = new Date(startedAt);
    const now = new Date();
    const diffMs = now.getTime() - start.getTime();
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}
/**
 * Formats a date key to readable format
 */
function formatDateKey(dateKey) {
    const date = new Date(dateKey);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateKey === today.toISOString().split("T")[0]) {
        return "Hoy";
    }
    if (dateKey === yesterday.toISOString().split("T")[0]) {
        return "Ayer";
    }
    const day = date.getDate();
    const months = [
        "Ene", "Feb", "Mar", "Abr", "May", "Jun",
        "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
    ];
    return `${day} ${months[date.getMonth()]}`;
}
/**
 * Formats session stats
 */
function formatSession(stats) {
    const session = stats.session;
    const lines = [];
    const sessionId = session.id ? session.id.slice(0, 12) + "..." : "N/A";
    const duration = session.startedAt ? formatDuration(session.startedAt) : "N/A";
    lines.push(`Session Actual (${sessionId} - ${duration})`);
    lines.push("─".repeat(60));
    // Models
    const models = Object.entries(session.byModel);
    if (models.length === 0) {
        lines.push("  Sin datos de modelos aun");
    }
    else {
        for (const [model, modelStats] of models) {
            const tokensIn = formatNumber(modelStats.tokensIn);
            const tokensOut = formatNumber(modelStats.tokensOut);
            lines.push(`  ${model}`);
            lines.push(`    ${modelStats.requests} req | ${tokensIn} in | ${tokensOut} out` +
                (modelStats.errors > 0 ? ` | ${modelStats.errors} err` : ""));
        }
    }
    // Totals
    lines.push("");
    lines.push(`  Totales: ${session.totals.requests} req | ` +
        `${formatNumber(session.totals.tokensIn)} in | ` +
        `${formatNumber(session.totals.tokensOut)} out` +
        (session.totals.errors > 0 ? ` | ${session.totals.errors} err` : ""));
    return lines.join("\n");
}
/**
 * Formats daily stats for last 7 days
 */
function formatDaily(stats) {
    const lines = [];
    lines.push("Ultimos 7 Dias");
    lines.push("─".repeat(60));
    // Get last 7 days sorted
    const today = new Date();
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split("T")[0]);
    }
    let totalRequests = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalRateLimits = 0;
    let totalErrors = 0;
    for (const day of days) {
        const daily = stats.daily[day];
        if (daily) {
            const dateLabel = formatDateKey(day).padEnd(8);
            const req = daily.requests.toString().padStart(4);
            const tokensIn = formatNumber(daily.tokensIn).padStart(6);
            const tokensOut = formatNumber(daily.tokensOut).padStart(6);
            const rl = daily.rateLimits > 0 ? ` | ${daily.rateLimits} rl` : "";
            const err = daily.errors > 0 ? ` | ${daily.errors} err` : "";
            lines.push(`  ${dateLabel} ${req} req | ${tokensIn} in | ${tokensOut} out${rl}${err}`);
            totalRequests += daily.requests;
            totalTokensIn += daily.tokensIn;
            totalTokensOut += daily.tokensOut;
            totalRateLimits += daily.rateLimits;
            totalErrors += daily.errors;
        }
    }
    if (totalRequests === 0) {
        lines.push("  Sin datos aun");
    }
    else {
        lines.push("");
        lines.push(`  Total:   ${totalRequests} req | ${formatNumber(totalTokensIn)} in | ` +
            `${formatNumber(totalTokensOut)} out` +
            (totalRateLimits > 0 ? ` | ${totalRateLimits} rl` : "") +
            (totalErrors > 0 ? ` | ${totalErrors} err` : ""));
    }
    return lines.join("\n");
}
/**
 * Formats errors and rate limits
 */
function formatErrors(stats, accountsStats) {
    const lines = [];
    lines.push("Errores y Rate-Limits");
    lines.push("─".repeat(60));
    // RPM Thresholds section (from accounts stats)
    if (accountsStats && accountsStats.length > 0) {
        lines.push("  RPM Thresholds (detectados):");
        for (const acct of accountsStats) {
            const status = acct.isRateLimited ? " [RL!]" : "";
            const threshold = acct.rpmThreshold !== null ? acct.rpmThreshold.toString() : "?";
            const avg = acct.avgRpmAtRateLimit !== null ? ` (avg: ${acct.avgRpmAtRateLimit})` : "";
            lines.push(`    ${acct.prefix} (${acct.email.split("@")[0]}): ${acct.rpm} RPM actual, ${threshold} threshold${avg}${status}`);
        }
        lines.push("");
    }
    // Errors by code
    const errorCodes = Object.entries(stats.errors.byCode);
    if (errorCodes.length === 0) {
        lines.push("  Sin errores registrados");
    }
    else {
        lines.push("  Por codigo:");
        for (const [code, count] of errorCodes.sort((a, b) => b[1] - a[1])) {
            const codeLabel = code === "429" ? "429 Rate Limited" :
                code === "404" ? "404 Not Found" :
                    code === "500" ? "500 Server Error" :
                        code === "503" ? "503 Unavailable" :
                            `${code} Error`;
            lines.push(`    ${codeLabel}: ${count}`);
        }
    }
    // Rate limit history (last 5)
    lines.push("");
    lines.push("  Ultimos rate-limits:");
    if (stats.rateLimits.history.length === 0) {
        lines.push("    Ninguno registrado");
    }
    else {
        const recent = stats.rateLimits.history.slice(0, 5);
        for (const entry of recent) {
            const time = new Date(entry.timestamp).toLocaleString("es-AR", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            });
            const account = entry.account.split("@")[0];
            lines.push(`    ${time} - ${account}@...`);
        }
    }
    // Accounts summary
    lines.push("");
    lines.push("  Por cuenta (ultimos 7 dias):");
    const accountStats = {};
    for (const daily of Object.values(stats.daily)) {
        for (const [account, accStats] of Object.entries(daily.byAccount)) {
            if (!accountStats[account]) {
                accountStats[account] = { requests: 0, rateLimits: 0 };
            }
            accountStats[account].requests += accStats.requests;
            accountStats[account].rateLimits += accStats.rateLimits;
        }
    }
    if (Object.keys(accountStats).length === 0) {
        lines.push("    Sin datos de cuentas");
    }
    else {
        for (const [account, accStats] of Object.entries(accountStats)) {
            lines.push(`    ${account}`);
            lines.push(`      ${accStats.requests} req | ${accStats.rateLimits} rate-limits`);
        }
    }
    return lines.join("\n");
}
/**
 * Formats all stats
 */
export function formatStats(stats, view = "all", accountsStats) {
    const header = [
        "═".repeat(60),
        "                 ANTIGRAVITY STATS",
        "═".repeat(60),
        "",
    ].join("\n");
    const sections = [header];
    if (view === "session" || view === "all") {
        sections.push(formatSession(stats));
        sections.push("");
    }
    if (view === "daily" || view === "all") {
        sections.push(formatDaily(stats));
        sections.push("");
    }
    if (view === "errors" || view === "all") {
        sections.push(formatErrors(stats, accountsStats));
    }
    return sections.join("\n");
}
//# sourceMappingURL=format.js.map