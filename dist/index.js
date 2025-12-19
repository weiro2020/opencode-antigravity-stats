/**
 * OpenCode Antigravity Stats Plugin
 * Entry point
 */
import { z } from "zod";
import { StatsCollector, getModelGroup } from "./collector.js";
import { formatStats } from "./format.js";
let collector = null;
export const plugin = async ({ client }) => {
    // Initialize collector
    collector = new StatsCollector();
    // Toast callback
    const showToast = async (title, message, variant) => {
        // Toast deshabilitado - solo log en consola
        console.log(`[antigravity-stats] ${variant} - ${title}: ${message}`);
    };
    await collector.initialize(showToast);
    // Helper para formatear tokens
    const formatTokens = (n) => {
        if (n >= 1000000)
            return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000)
            return `${(n / 1000).toFixed(0)}K`;
        return n.toString();
    };
    // Actualiza el título de la sesión con las stats de quota
    // Formato: [C] !CR:4/20,92%,4h20,1.8M | CA:3/15,85%,3h45,1.2M | NA:0/5,?,5h0,0
    // Donde: [C] = grupo activo (Claude), 4/20 = 4 RPM actual, 20 requests acumuladas en ventana de 5h
    const updateSessionTitle = async (sessionID, providerID, modelID) => {
        if (!collector)
            return;
        try {
            // Determinar grupo del modelo activo
            const activeGroup = getModelGroup(providerID, modelID);
            // Si es "other", no mostrar stats de quota (no cuenta para límites)
            if (activeGroup === "other") {
                await client.session.update({
                    path: { id: sessionID },
                    body: { title: `[${modelID.substring(0, 10)}] No quota tracking` },
                });
                return;
            }
            const quotaStats = await collector.getQuotaStats(activeGroup);
            // Format: [C] !CR:4/20,92%,4h20,1.8M | CA:3/15,?,3h45,1.2M
            // [C/G] = grupo activo, ! = rate limited, prefix, rpm/accumulated, %, time until reset, tokens used
            const groupLabel = activeGroup === "claude" ? "C" : "G";
            const parts = quotaStats.map((acct) => {
                const prefix = acct.isRateLimited ? `!${acct.prefix}` : acct.prefix;
                const pct = acct.percentRemaining !== null
                    ? `${Math.round(acct.percentRemaining)}%`
                    : "?";
                const rpmReq = `${acct.rpm}/${acct.requestsCount}`;
                return `${prefix}:${rpmReq},${pct},${acct.timeUntilReset},${formatTokens(acct.tokensUsed)}`;
            });
            const title = parts.length > 0
                ? `[${groupLabel}] ${parts.join(" | ")}`
                : "No accounts";
            await client.session.update({
                path: { id: sessionID },
                body: { title },
            });
        }
        catch (error) {
            console.error("[antigravity-stats] Error updating session title:", error);
        }
    };
    return {
        /**
         * Event hook - captures messages and errors
         */
        event: async ({ event }) => {
            if (!collector)
                return;
            // Capture assistant messages with token usage
            if (event.type === "message.updated") {
                const msg = event.properties.info;
                // Only process completed assistant messages
                if (msg.role === "assistant" &&
                    msg.tokens &&
                    msg.time.completed) {
                    await collector.recordMessage({
                        sessionID: msg.sessionID,
                        messageID: msg.id,
                        model: `${msg.providerID}/${msg.modelID}`,
                        providerID: msg.providerID,
                        modelID: msg.modelID,
                        tokensIn: msg.tokens.input || 0,
                        tokensOut: msg.tokens.output || 0,
                        cacheRead: msg.tokens.cache?.read || 0,
                        cacheWrite: msg.tokens.cache?.write || 0,
                    });
                    // Actualizar título de sesión en sidebar
                    await updateSessionTitle(msg.sessionID, msg.providerID, msg.modelID);
                }
            }
            // Capture errors
            if (event.type === "session.error") {
                const error = event.properties.error;
                if (error?.name === "APIError" && error.data) {
                    const statusCode = error.data.statusCode || 0;
                    const message = error.data.message || "Unknown error";
                    // Try to extract model from the error message
                    let model = "unknown";
                    const modelMatch = message.match(/Model:\s*([^\s\n]+)/i);
                    if (modelMatch) {
                        model = modelMatch[1];
                    }
                    await collector.recordError({
                        code: statusCode,
                        message: message,
                        model: model,
                        isRateLimit: statusCode === 429,
                    });
                }
            }
        },
        /**
         * Tool definition for /stats command
         */
        tool: {
            "antigravity-stats": {
                description: "Show Antigravity usage statistics including tokens, rate-limits, and errors",
                parameters: z.object({
                    view: z
                        .enum(["session", "daily", "errors", "all"])
                        .optional()
                        .default("all")
                        .describe("View type: session (current), daily (last 7 days), errors (errors & rate-limits), all (everything)"),
                }),
                execute: async ({ view }) => {
                    if (!collector) {
                        return "Stats collector not initialized";
                    }
                    const stats = collector.getStats();
                    const accountsStats = await collector.getAllAccountsStats();
                    return formatStats(stats, view, accountsStats);
                },
            },
        },
    };
};
// Cleanup on process exit
process.on("beforeExit", async () => {
    if (collector) {
        await collector.stop();
    }
});
process.on("SIGINT", async () => {
    if (collector) {
        await collector.stop();
    }
    process.exit(0);
});
process.on("SIGTERM", async () => {
    if (collector) {
        await collector.stop();
    }
    process.exit(0);
});
export default plugin;
//# sourceMappingURL=index.js.map