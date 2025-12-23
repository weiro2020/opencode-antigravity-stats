/**
 * OpenCode Antigravity Stats Plugin
 * Punto de entrada del plugin
 */

import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import { StatsCollector } from "./collector.js";
import { formatStats } from "./format.js";

let collector: StatsCollector | null = null;

export const plugin: Plugin = async () => {
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

          // Iniciar fetch de quota en primer mensaje (corre cada 60s)
          collector.startQuotaFetching();
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
