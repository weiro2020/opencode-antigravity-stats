# OpenCode Antigravity Stats Plugin - Changelog

## v1.2.1 - 2025-12-21: Scripts Auxiliares

### Nuevo

**Agregado directorio scripts/ con utilidades:**
- `quota` - Wrapper bash para el script de quota
- `get_antigravity_quota.py` - Script Python que consulta quota del Language Server via Connect RPC
- `antigravity-server-wrapper.sh` - Previene auto-apagado del servidor despues de 3 horas

### Documentacion

- README actualizado con instrucciones de instalacion de scripts auxiliares

---

## v1.2.0 - 2025-12-21: Quota del Servidor y Arquitectura Simplificada

### Cambios Importantes

**Sistema de calibracion eliminado:**
- Los campos `calibration` y `calibrations` fueron eliminados de `AccountQuotaTracking`
- Los metodos `calibrateQuota()` y `calibrateQuotaManual()` fueron eliminados
- El porcentaje de quota ahora viene **exclusivamente del servidor** via `quota --json`

### Nuevas Funcionalidades

**Tracking de quota basado en servidor:**
- El % de quota se obtiene del servidor cada 60 segundos
- No mas estimacion local o calibracion necesaria
- Informacion de quota mas precisa y confiable

**Reset automatico de contadores:**
- Contadores locales (tokens, requests) se resetean automaticamente cuando se detecta nuevo ciclo del servidor
- Logica de deteccion: `windowStart_local < serverCycleStart` donde `serverCycleStart = reset_time - 5h`
- Cubre tanto resets por tiempo como por quota agotada (0%)

**Persistencia simplificada:**
- La memoria es ahora la fuente de verdad para stats
- No mas logica compleja de merge disco-vs-memoria
- Contadores se guardan directamente a disco sin comparacion

### Cambios Tecnicos

| Archivo | Cambios |
|---------|---------|
| `src/types.ts` | Eliminada interface `QuotaCalibration`. Simplificado `AccountQuotaTracking` para solo contener `windows` |
| `src/storage.ts` | Simplificado `saveStats()` - no mas comparacion con disco. `loadStats()` ahora limpia campos legacy de calibration |
| `src/collector.ts` | Eliminados `calibrateQuota()` y `calibrateQuotaManual()`. Agregada logica de reset en `fetchServerQuota()` para todos los grupos. Corregido `getQuotaStatsAllGroups()` para usar `serverCycleStart` en vez de `Date.now()` al resetear |

### Estructura de Datos

**Antes (v1.1):**
```json
{
  "quotaTracking": {
    "email@gmail.com": {
      "windows": { ... },
      "calibrations": {
        "claude": { "estimatedRequestLimit": 600, ... },
        "pro": { "estimatedRequestLimit": 600, ... },
        "flash": { "estimatedRequestLimit": 600, ... }
      },
      "calibration": { ... }
    }
  }
}
```

**Despues (v1.2):**
```json
{
  "quotaTracking": {
    "email@gmail.com": {
      "windows": {
        "claude": { "windowStart": 1766280143000, "tokensUsed": 500000, "requestsCount": 25 },
        "pro": { "windowStart": 1766277600000, "tokensUsed": 0, "requestsCount": 0 },
        "flash": { "windowStart": 1766277600000, "tokensUsed": 0, "requestsCount": 0 }
      }
    }
  }
}
```

### Migracion

No se necesita migracion manual. Los campos legacy `calibration` y `calibrations` se limpian automaticamente al cargar.

---

## v1.1.1 - 2025-12-19: Correccion de Calculo de Tiempo y Reset

### Correcciones

**Calculo dinamico de tiempo:**
- El tiempo hasta reset ahora se calcula dinamicamente desde `reset_time` (timestamp ISO)
- Antes: se guardaba como string pre-calculado que se volvia obsoleto

**Deteccion de reset de ciclo:**
- Agregada deteccion de reset de ciclo del servidor
- Resetea contadores locales cuando `windowStart < (reset_time - 5h)`

---

## v1.1.0 - 2025-12-19: Integracion con Servidor de Quota

### Nuevas Funcionalidades

**Integracion con servidor:**
- El plugin ahora ejecuta `quota --json` cada 60 segundos
- Primera ejecucion se dispara con el primer mensaje de la sesion
- Datos persistidos en archivo de cache

**3 Grupos de Modelos:**
- `CL` - Claude (todos los modelos Claude)
- `PR` - Gemini Pro (Gemini 3 Pro High/Low)
- `FL` - Gemini Flash (Gemini 3 Flash)

**Nuevo formato de titulo de sesion:**
```
[CL] CL:4/20,92%,4h20,1.8M | PR:100%,5h | FL:95%,4h35
```

### Fuentes de Datos

| Dato | Fuente |
|------|--------|
| `remaining_percent` | Servidor (quota --json) |
| `time_until_reset` | Servidor (quota --json) |
| `rpm` | Local (ultimos 60 segundos) |
| `requestsCount` | Local (ventana de 5 horas) |
| `tokensUsed` | Local (ventana de 5 horas) |

---

## v1.0.0 - 2025-12-18: Release Inicial

- Tracking basico de tokens y requests
- Soporte multi-cuenta
- Display en titulo de sesion
- Deteccion de rate limits
