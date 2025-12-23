# OpenCode Antigravity Stats Plugin (v1.2.3)

Plugin para OpenCode que muestra en tiempo real el uso de quota de los modelos de IA (Claude, Gemini) a través de Antigravity.

## Este es el Repo Privado

| Repo | URL | Uso |
|------|-----|-----|
| **Este (Privado)** | `weiro2020/opencode-antigravity-stats-Esp` | Desarrollo personal, docs en español |
| **Público** | `weiro2020/opencode-antigravity-stats` | Para compartir, docs en inglés |

**Flujo de trabajo:**
1. Desarrollar y probar en este repo (privado)
2. Sincronizar código al repo público cuando esté listo
3. NO commitear información sensible al repo público

## Qué hace este plugin?

Muestra en el título de la sesión de OpenCode información como:
```
[CL] CL:4/20,92%,4h20,1.8M | PR:5,100%,5h | FL:12,95%,4h35
```

Donde:
- `[CL]` = Modelo activo (Claude)
- `CL:4/20,92%,4h20,1.8M` = Claude: 4 RPM / 20 requests, 92% restante, 4h20m para reset, 1.8M tokens usados
- `PR:5,100%,5h` = Gemini Pro: 5 requests, 100% restante, 5h para reset
- `FL:12,95%,4h35` = Gemini Flash: 12 requests, 95% restante, 4h35m para reset

**Cuando no hay datos de quota** (túnel apagado), el título permanece sin modificar.

## Estructura del Proyecto

```
~/.config/opencode/plugin/opencode-antigravity-stats/
├── src/                    # Código fuente TypeScript
│   ├── index.ts            # Entry point, hooks de eventos, formato del título
│   ├── collector.ts        # Lógica principal: tracking, fetch quota, acumulación
│   ├── storage.ts          # Persistencia en disco
│   ├── watcher.ts          # Monitorea cambios en antigravity-accounts.json
│   ├── types.ts            # Interfaces TypeScript y constantes
│   └── format.ts           # Formato de salida del comando /stats
├── dist/                   # Código compilado (activo en OpenCode)
├── scripts/                # Scripts Python auxiliares
│   ├── quota               # Consulta quota del servidor
│   ├── get_antigravity_quota.py
│   ├── tunnel_config.json  # Config túnel (NO commitear)
│   └── accounts/           # Gestión de cuentas OAuth
│       ├── cuenta          # Seleccionar cuenta activa
│       ├── extraer-cuentas # Extraer cuentas a archivos individuales
│       └── limpiar-cuentas # Limpiar cuentas deslogueadas
├── docs/                   # Documentación
│   ├── ANTIGRAVITY.md      # Doc completa del sistema
│   └── TUNNEL.md           # Config del túnel SSH
├── package.json
├── README.md               # Este archivo
└── CHANGELOG.md
```

### Symlinks (compatibilidad)

```
~/.antigravity-standalone → scripts/
~/.config/opencode/cuenta → scripts/accounts/cuenta
```

## Grupos de Modelos

| Grupo | Label | Modelos |
|-------|-------|---------|
| **claude** | CL | claude-sonnet-4-5, claude-opus-4-5-thinking, gpt-oss-120b |
| **pro** | PR | gemini-3-pro-high, gemini-3-pro-low |
| **flash** | FL | gemini-3-flash |
| **other** | - | Cualquier otro (no trackea quota) |

Los modelos dentro del mismo grupo **comparten la misma cuota**.

## Configuración del Túnel

Para obtener quota de un LS remoto (Windows), configurar `scripts/tunnel_config.json`:

```json
{
  "port": 50001,
  "csrf_token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Establecer el túnel desde Windows:
```powershell
ssh -R 50001:127.0.0.1:<PUERTO_LS> capw@142.171.248.233 -p 39776
```

## Comportamiento

| Escenario | Título de sesión |
|-----------|------------------|
| Túnel activo | Muestra stats: `[CL] CL:4/20,92%...` |
| Túnel apagado | No modifica el título (sin errores) |
| Modelo "other" | No modifica el título |

## Desarrollo

```bash
# Editar código
cd ~/.config/opencode/plugin/opencode-antigravity-stats/src/

# Compilar
npm run build

# Reiniciar OpenCode para aplicar cambios
```

## Sincronizar al Repo Público

```bash
# Copiar código al repo público
cp src/*.ts ~/public-antigravity-stats/src/
cp scripts/* ~/public-antigravity-stats/scripts/

# Compilar y commitear
cd ~/public-antigravity-stats
npm run build
git add -A && git commit -m "Sync from private repo"
git push
```

**IMPORTANTE:** No copiar archivos con información sensible:
- `tunnel_config.json` (contiene CSRF token real)
- Cualquier `.json` con datos de cuentas

## Funciones Clave

| Función | Archivo | Propósito |
|---------|---------|-----------|
| `getModelGroup()` | collector.ts | Mapea modelo → grupo (claude/pro/flash/other) |
| `recordMessage()` | collector.ts | Actualiza tokens/requests por mensaje |
| `fetchServerQuota()` | collector.ts | Ejecuta `quota --json`, actualiza cache |
| `getQuotaStatsAllGroups()` | collector.ts | Stats de los 3 grupos (para título) |
| `updateSessionTitle()` | index.ts | Actualiza el título de la sesión |

## Archivos de Datos

| Archivo | Descripción |
|---------|-------------|
| `~/.config/opencode/antigravity-stats.json` | Stats y tracking local |
| `~/.config/opencode/antigravity-accounts.json` | Cuentas OAuth (del plugin auth) |
| `scripts/tunnel_config.json` | Configuración del túnel |

## Changelog

Ver [CHANGELOG.md](CHANGELOG.md) para historial de versiones.
