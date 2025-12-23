/**
 * OpenCode Antigravity Stats Plugin
 * Punto de entrada del plugin
 */

import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import { StatsCollector, getModelGroup } from "./collector.js";
import { formatStats } from "./format.js";
import type { ModelGroup } from "./types.js";

let collector: StatsCollector | null = null;

export const plugin: Plugin = async ({ client }) => {
  // Inicializar collector
  collector = new StatsCollector();

  // Callback para notificaciones toast
  const showToast = async (
    _title: string,
    _message: string,
    _variant: "info" | "success" | "warning" | "error"
  ) => {
    // Toast deshabilitado - silently ignore
  };

  await collector.initialize(showToast);

  // Helper para formatear tokens
  const formatTokens = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return n.toString();
  };

  // Actualiza el título de la sesión con las stats de quota
  // Formato: [CL] CL:4/20,92%,4h20,1.8M | PR:100%,5h | FL:95%,4h35
  // Grupo activo: completo (rpm/req, %, time, tokens)
  // Grupos inactivos: compacto (solo % y time)
  // ! antes del % indica que usa cache/fallback
  // Si no hay datos de quota (tunnel no disponible), no modifica el título
  const updateSessionTitle = async (sessionID: string, providerID: string, modelID: string) => {
    if (!collector) return;

    try {
      // Determinar grupo del modelo activo
      const activeGroup = getModelGroup(providerID, modelID);
      
      // Si es "other", no mostrar stats de quota (no cuenta para límites)
      if (activeGroup === "other") {
        return; // Don't modify title for "other" models
      }

      // Obtener los 3 grupos con datos combinados del servidor + local
      const allGroups = await collector.getQuotaStatsAllGroups(activeGroup);
      
      // Si no hay datos de ningún grupo (tunnel no disponible), no modificar el título
      // Esto permite que OpenCode muestre su título normal
      const hasQuotaData = allGroups.some(g => g.percentRemaining !== null);
      if (!hasQuotaData) {
        return; // Don't modify title when no quota data available
      }

      // Construir partes del titulo
      // Activo: CL:4/20,92%,4h20,1.8M
      // Inactivo: PR:100%,5h
      const parts = allGroups.map((g) => {
        const pctPrefix = g.isFromCache ? "!" : "";
        const pct = g.percentRemaining !== null 
          ? `${pctPrefix}${Math.round(g.percentRemaining)}%` 
          : "?";
        
        if (g.isActive) {
          // Grupo activo: formato completo
          return `${g.label}:${g.rpm}/${g.requestsCount},${pct},${g.timeUntilReset},${formatTokens(g.tokensUsed)}`;
        } else {
          // Grupos inactivos: agregamos requests acumulados
          return `${g.label}:${g.requestsCount},${pct},${g.timeUntilReset}`;
        }
      });

      // Etiqueta del grupo activo
      const groupLabels: Record<ModelGroup, string> = {
        claude: "CL",
        pro: "PR",
        flash: "FL",
        other: "?",
      };

      const title = `[${groupLabels[activeGroup]}] ${parts.join(" | ")}`;

      await client.session.update({
        path: { id: sessionID },
        body: { title },
      });
    } catch (error) {
      // Silently ignore errors - don't spam console
    }
  };

  return {
    /**
     * Hook de eventos - captura mensajes y errores
     */
    event: async ({ event }) => {
      if (!collector) return;

      // Capturar mensajes del asistente con uso de tokens
      if (event.type === "message.updated") {
        const msg = event.properties.info;

        // Solo procesar mensajes completados del asistente
        if (
          msg.role === "assistant" &&
          msg.tokens &&
          msg.time.completed
        ) {
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

          // Iniciar fetch de quota en primer mensaje (corre inmediatamente + cada 60s)
          collector.startQuotaFetching();

          // Actualizar título de sesión en sidebar
          await updateSessionTitle(msg.sessionID, msg.providerID, msg.modelID);
        }
      }

      // Capturar errores
      if (event.type === "session.error") {
        const error = event.properties.error;

        if (error?.name === "APIError" && error.data) {
          const statusCode = error.data.statusCode || 0;
          const message = error.data.message || "Unknown error";

          // Intentar extraer modelo del mensaje de error
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
     * Definicion de herramienta para comando /stats
     */
    tool: {
      "antigravity-stats": {
        description:
          "Mostrar estadisticas de uso de Antigravity incluyendo tokens, rate-limits y errores",
        parameters: z.object({
          view: z
            .enum(["session", "daily", "errors", "all"])
            .optional()
            .default("all")
            .describe(
              "Tipo de vista: session (actual), daily (ultimos 7 dias), errors (errores y rate-limits), all (todo)"
            ),
        }),
        execute: async ({ view }: { view: "session" | "daily" | "errors" | "all" }) => {
          if (!collector) {
            return "Collector de stats no inicializado";
          }

          const stats = collector.getStats();
          const accountsStats = await collector.getAllAccountsStats();
          return formatStats(stats, view, accountsStats);
        },
      },
    },
  };
};

// Limpieza al salir del proceso
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
