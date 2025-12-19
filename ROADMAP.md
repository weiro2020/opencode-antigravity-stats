# OpenCode Antigravity Stats Plugin - Hoja de Ruta

## Objetivo

Crear un plugin de OpenCode que monitoree y registre estadísticas de uso de las cuentas Antigravity, incluyendo:
- Tokens de entrada/salida por modelo y proveedor
- Rate-limits detectados por cuenta
- Errores por código HTTP
- Resumen de sesión actual y últimos 7 días

## Arquitectura

```
~/.config/opencode/
├── opencode.json                    # Config principal (agregar plugin)
├── antigravity-accounts.json        # Cuentas Antigravity (existente)
├── antigravity-stats.json           # Stats acumuladas (nuevo)
└── plugins/
    └── opencode-antigravity-stats/
        ├── package.json
        ├── tsconfig.json
        ├── ROADMAP.md               # Este archivo
        ├── src/
        │   ├── index.ts             # Entry point del plugin
        │   ├── types.ts             # Interfaces TypeScript
        │   ├── storage.ts           # CRUD de stats.json
        │   ├── watcher.ts           # Monitor de accounts.json
        │   ├── collector.ts         # Acumulación de stats
        │   └── format.ts            # Formateo de output /stats
        └── dist/                    # Código compilado
```

## Fuentes de Datos

| Dato | Fuente | Método |
|------|--------|--------|
| Tokens (in/out/cache) | Evento `message.updated` | Hook `event` |
| Rate-limits por cuenta | `antigravity-accounts.json` | Watcher (chokidar) |
| Errores HTTP | Evento `session.error` | Hook `event` |
| Modelo/Proveedor usado | `AssistantMessage.providerID/modelID` | Hook `event` |

## Funcionalidades

### 1. Comando `/stats`

```
/stats           → Resumen de sesión + 7 días
/stats session   → Solo stats de sesión actual
/stats daily     → Solo stats últimos 7 días
/stats errors    → Solo errores y rate-limits
```

### 2. Toast Notifications

- Warning cuando se detecta rate-limit
- Info con cuenta que fue rotada

### 3. Retención de Datos

- Stats diarias: últimos 7 días
- Historial de errores: últimos 50
- Historial de rate-limits: últimos 50

## Fases de Implementación

### Fase 1: Setup (Backup + Estructura)
- [x] Documentar hoja de ruta
- [ ] Backup de configuración existente
- [ ] Crear package.json y tsconfig.json

### Fase 2: Core (Types + Storage)
- [ ] Implementar types.ts
- [ ] Implementar storage.ts

### Fase 3: Monitoreo (Watcher + Collector)
- [ ] Implementar watcher.ts
- [ ] Implementar collector.ts

### Fase 4: UI (Format + Entry Point)
- [ ] Implementar format.ts
- [ ] Implementar index.ts

### Fase 5: Deploy (Compilar + Registrar)
- [ ] Compilar TypeScript
- [ ] Registrar plugin en opencode.json
- [ ] Verificar funcionamiento

## Rollback

Si algo falla, restaurar desde:
```bash
~/.config/opencode/backup-YYYY-MM-DD/
├── opencode.json
├── antigravity-accounts.json
└── antigravity-stats.json (si existe)
```

Comando de rollback:
```bash
cp ~/.config/opencode/backup-*/* ~/.config/opencode/
```

## Dependencias

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.0.167",
    "chokidar": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0"
  }
}
```

## Estructura de antigravity-stats.json

```json
{
  "version": 1,
  "lastUpdated": "ISO8601",
  "session": {
    "id": "ses_xxx",
    "startedAt": "ISO8601",
    "byModel": {
      "google/gemini-3-flash": {
        "requests": 5,
        "tokensIn": 1200,
        "tokensOut": 3500,
        "cacheRead": 0,
        "cacheWrite": 0,
        "errors": 0
      }
    },
    "totals": {
      "requests": 8,
      "tokensIn": 2000,
      "tokensOut": 5600,
      "errors": 1
    }
  },
  "rateLimits": {
    "total": 4,
    "history": []
  },
  "errors": {
    "total": 7,
    "byCode": {},
    "history": []
  },
  "daily": {}
}
```

## Verificación

1. Reiniciar OpenCode
2. Ejecutar `/stats` - debe mostrar stats vacías
3. Enviar algunos mensajes
4. Ejecutar `/stats` - debe mostrar tokens acumulados
5. Verificar `antigravity-stats.json` se actualiza

## Autor

Generado automáticamente para el proyecto OpenCode Antigravity Stats.
Fecha: 2025-12-18
