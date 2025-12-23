# Antigravity - Sistema de Quota y Stats

Documentación completa del sistema de monitoreo de quota de Antigravity.

## Estructura de Repositorios

| Repo | Visibilidad | Ruta Local | Uso |
|------|-------------|-----------|-----|
| **Privado** | 🔒 | `~/.config/opencode/plugin/opencode-antigravity-stats/` | Desarrollo, activo en OpenCode |
| **Público** | 🌐 | `~/public-antigravity-stats/` | Para compartir, sin info sensible |

## Componentes

| Componente | Ubicación | Descripción |
|------------|-----------|-------------|
| Plugin Stats | `~/.config/opencode/plugin/opencode-antigravity-stats/` | Plugin activo en OpenCode |
| Script Quota | `~/.config/opencode/plugin/opencode-antigravity-stats/scripts/quota` | Consulta quota del servidor |
| Gestión Cuentas | `~/.config/opencode/cuenta` | Selección manual de cuenta |

---

## Antigravity Stats Plugin (v1.2.3)

Plugin de OpenCode que trackea uso de cuentas Antigravity. Consulta quota del servidor cada 60 segundos via túnel SSH.

### Comportamiento

| Escenario | Título de sesión |
|-----------|------------------|
| Túnel activo | Muestra stats: `[CL] CL:4/20,92%,4h20,1.8M | PR:5,100%,5h | FL:12,95%,4h35` |
| Túnel apagado | No modifica el título (OpenCode muestra título normal) |
| Modelo "other" | No modifica el título |

**Nota:** El plugin nunca muestra errores en consola ni toasts. Si el túnel no está disponible, simplemente no actualiza el título.

### Formato del título

```
[CL] CL:4/20,92%,4h20,1.8M | PR:5,100%,5h | FL:12,95%,4h35
```

Donde:
- **[CL/PR/FL]**: grupo activo - CL=Claude, PR=Gemini Pro, FL=Gemini Flash
- **Grupo activo** (formato completo): `label:rpm/req,pct%,tiempo,tokens`
- **Grupos inactivos** (formato con requests): `label:req,pct%,tiempo`
- **!** antes del % indica que usa datos de cache (servidor no disponible)

### Arquitectura del Código

| Archivo | Propósito |
|---------|-----------|
| `src/index.ts` | Entry point, hooks de eventos, formato del título |
| `src/collector.ts` | Lógica principal: tracking, fetch de quota, acumulación |
| `src/storage.ts` | Persistencia en disco |
| `src/watcher.ts` | Monitorea cambios en `antigravity-accounts.json` |
| `src/types.ts` | Interfaces TypeScript y constantes |
| `src/format.ts` | Formato de salida del comando `/stats` |

### Funciones Clave en `collector.ts`

| Función | Línea ~ | Propósito |
|---------|---------|-----------|
| `getModelGroup()` | 56 | Mapea modelo → grupo (claude/pro/flash/other) |
| `recordMessage()` | 168 | Actualiza tokens/requests por mensaje |
| `fetchServerQuota()` | 610 | Ejecuta `quota --json`, actualiza cache |
| `getQuotaStatsAllGroups()` | 737 | Stats de los 3 grupos (para título) |

### Modificaciones Comunes

| Quiero... | Modificar... |
|-----------|--------------|
| Cambiar formato del título | `updateSessionTitle()` en `index.ts` |
| Agregar nuevo grupo de modelos | `getModelGroup()` en `collector.ts` |
| Cambiar qué muestra para grupos inactivos | `getQuotaStatsAllGroups()` en `collector.ts` |
| Modificar lógica de reset | Buscar `shouldReset` en `getQuotaStatsAllGroups()` |
| Cambiar intervalo de fetch | `startQuotaFetching()` en `collector.ts` |

### Grupos de modelos

| Grupo | Label | Modelos |
|-------|-------|---------|
| **claude** | CL | claude-sonnet-4-5, claude-opus-4-5-thinking, gpt-oss-120b |
| **pro** | PR | gemini-3-pro-high, gemini-3-pro-low |
| **flash** | FL | gemini-3-flash |
| **other** | - | Cualquier otro (no trackea quota) |

### Fuentes de datos

| Dato | Fuente |
|------|--------|
| % restante | Servidor (via `quota --json`) |
| Tiempo hasta reset | Servidor (calculado desde `reset_time`) |
| RPM | Local (requests en últimos 60 seg) |
| Requests/Tokens | Local (acumulados en ventana, persistidos en disco) |
| Email activo | Servidor (prioridad) o archivo local |

### Archivos

| Archivo | Descripción |
|---------|-------------|
| `~/public-antigravity-stats/src/` | Código fuente TypeScript |
| `~/public-antigravity-stats/dist/` | Código compilado |
| `~/.config/opencode/antigravity-stats.json` | Stats y tracking local |

### Comportamiento

#### Reset automático de contadores

El plugin detecta cuando el servidor inicia un nuevo ciclo de quota:

1. Cada 60 segundos, consulta `quota --json`
2. Obtiene `reset_time` del servidor
3. Calcula `serverCycleStart = reset_time - 5 horas`
4. Compara con `windowStart` local
5. Si `windowStart < serverCycleStart` → **resetea tokens y requests a 0**

Esto cubre dos escenarios:
- El ciclo terminó por **tiempo** (pasaron 5 horas)
- El ciclo terminó porque el **% llegó a 0**

#### Persistencia

Los contadores (tokens, requests, windowStart) se guardan en disco automáticamente.

| Escenario | Resultado |
|-----------|-----------|
| Cerrar y abrir OpenCode **dentro del mismo ciclo** | Contadores se mantienen |
| Cerrar y abrir OpenCode **después de nuevo ciclo** | Contadores se resetean |

#### Ventana de 5 horas

- La ventana **NO es cada 5 horas de reloj**
- Empieza a correr con el **primer request después del reset**
- Termina 5 horas después, o cuando el % llega a 0 (lo que ocurra primero)
- Si no hay requests, el servidor muestra 100% y 5h (listo para nuevo ciclo)

### Estructura del JSON

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

### Desarrollo

```bash
# Editar código
cd ~/public-antigravity-stats/src/

# Compilar
npm run build

# Reiniciar OpenCode para aplicar cambios
```

---

## Script Quota

Script Python que consulta la quota del servidor Antigravity via túnel SSH.

### Ubicación

```
~/.config/opencode/plugin/opencode-antigravity-stats/scripts/quota
```

> **Nota:** `~/.antigravity-standalone/` es un symlink a `scripts/` para compatibilidad.

### Fuente de datos

| Fuente | Descripción |
|--------|-------------|
| Túnel SSH | LS de Windows via túnel reverso (puerto 50001) |

**Nota:** El script solo consulta via túnel. Si el túnel no está disponible, retorna `{"available": false}` sin errores.

### Uso

```bash
# Consultar quota (requiere túnel activo)
quota

# Ver quota en JSON (usado por el plugin)
quota --json

# Usar datos en cache
quota --cached
```

### Salida JSON

**Cuando hay túnel activo:**
```json
{
  "email": "usuario@gmail.com",
  "plan_name": "Pro",
  "timestamp": "2025-12-21T01:25:01.536878+00:00",
  "is_cached": false,
  "groups": [
    {
      "name": "Claude",
      "remaining_percent": 85.6,
      "reset_time": "2025-12-21T06:22:23Z",
      "time_until_reset": "4h43m"
    }
  ]
}
```

**Cuando NO hay túnel:**
```json
{"available": false}
```

### Cache y Túnel

| Archivo | Propósito |
|---------|-----------|
| `scripts/quota_cache.json` | Cache de última quota |
| `scripts/tunnel_config.json` | Config del túnel SSH |

> Los archivos están en `~/.config/opencode/plugin/opencode-antigravity-stats/scripts/`

### Configuración del Túnel

Para usar el túnel:

```json
{
  "port": 50001,
  "csrf_token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Ver documentación completa en [`TUNNEL.md`](./TUNNEL.md).

---

## Gestión de Cuentas - Comando `cuenta`

Sistema para seleccionar manualmente qué cuenta de Google OAuth usar, evitando la rotación automática del plugin de autenticación.

### Ubicación

```
~/.config/opencode/cuenta
```

### Alias

```bash
alias cuenta='python3 ~/.config/opencode/cuenta'
```

### Comandos

| Comando | Descripción |
|---------|-------------|
| `cuenta` | Ver cuenta activa y su estado |
| `cuenta list` | Listar todas las cuentas disponibles |
| `cuenta <prefijo>` | Cambiar a una cuenta específica |
| `cuenta add` | Agregar nueva cuenta (interactivo) |

### Prefijos

El prefijo son las **primeras 3 letras del email** (antes del @):

| Email | Prefijo |
|-------|---------|
| cristiancatanza@gmail.com | `cri` |
| starlinkchacrapoli@gmail.com | `sta` |

### Archivos

```
~/.config/opencode/
├── antigravity-accounts.json      ← Archivo activo (1 sola cuenta)
├── antigravity-accounts/          ← Cuentas individuales
│   ├── cri.json                   ← cristiancatanza@gmail.com
│   └── sta.json                   ← starlinkchacrapoli@gmail.com
└── cuenta                         ← Script Python
```

### Flujo de uso

1. **Cerrar OpenCode**
2. Ejecutar `cuenta sta` (o `cuenta cri`)
3. **Abrir OpenCode**

**Importante:** El cambio solo aplica al reiniciar OpenCode, ya que el plugin mantiene las cuentas en memoria.

### Agregar nueva cuenta

#### Método 1: Via plugin OAuth de Antigravity (recomendado)

1. **Cerrar OpenCode**
2. En Antigravity (Windows), agregar la cuenta usando el plugin OAuth
3. La cuenta se agrega a `antigravity-accounts.json` (puede haber múltiples)
4. Extraer la cuenta a su archivo individual:
   ```bash
   extraer-cuentas
   ```
5. Activar solo esa cuenta:
   ```bash
   cuenta <prefijo>
   ```
6. **Abrir OpenCode**

#### Método 2: Manual con `cuenta add`

```bash
cuenta add
# Te pedirá:
# - Email
# - Refresh Token (de ~/.gemini/oauth_creds.json después de autenticar)
# - Project ID (opcional)
```

El prefijo se genera automáticamente de las primeras 3 letras del email.

### Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `cuenta` | Ver cuenta activa |
| `cuenta list` | Listar cuentas disponibles |
| `cuenta <prefijo>` | Cambiar a una cuenta |
| `cuenta add` | Agregar cuenta manualmente |
| `extraer-cuentas` | Extraer cuentas del archivo activo a archivos individuales |
| `limpiar-cuentas` | Eliminar cuentas deslogueadas del tracking |

### Por qué existe este sistema

El plugin `opencode-antigravity-auth` rota automáticamente entre cuentas cuando una alcanza rate limit. Para evitar esto y poder elegir qué cuenta usar (ej: en una casa con 2 usuarios), este sistema permite:

1. Guardar cada cuenta en un archivo individual
2. Al ejecutar `cuenta <prefijo>`, copia ESA cuenta al archivo activo
3. Como hay una sola cuenta en el archivo, el plugin no puede rotar

---

## Persistencia del Servidor

El servidor Antigravity tiene un timeout de 3 horas de inactividad. Se implementó un wrapper script para mantenerlo activo.

**Documentación completa:** [`antigravity-server-persistence.md`](./antigravity-server-persistence.md)

### Modificación realizada

Se modificó el script de inicio del servidor para filtrar el flag `--enable-remote-auto-shutdown`:

```
~/.antigravity-server/bin/<version>/bin/
├── antigravity-server          # Wrapper modificado (ACTIVO)
└── antigravity-server.original # Backup del original
```

El wrapper intercepta los argumentos y elimina `--enable-remote-auto-shutdown` antes de ejecutar el servidor.

### Estado

| Componente | Estado |
|------------|--------|
| Servidor principal | **Inmortal** - no se cierra por timeout |
| Language Server (Extension Host) | Se cierra si Windows envía señal de apagado |

### IMPORTANTE: Cómo cerrar Antigravity en Windows

Para que el LS local **NO se cierre**:

| Método | Resultado |
|--------|-----------|
| ✅ **Administrador de Tareas** → Finalizar tarea | LS sigue vivo |
| ❌ Botón X / File→Exit / Alt+F4 | LS se cierra (envía señal de apagado) |

---

## Troubleshooting

### Troubleshooting

#### El título no muestra datos (túnel activo)

1. Verificar que el túnel esté escuchando: `ss -tln | grep 50001`
2. Verificar que el servidor responde: `quota --json`
3. Reiniciar OpenCode

#### El título no muestra datos (túnel apagado)

Esto es **comportamiento esperado**. El plugin no modifica el título cuando no hay datos de quota disponibles.

#### Los contadores no se resetean

1. Verificar `reset_time` del servidor: `quota --json`
2. El reset ocurre cuando `windowStart < (reset_time - 5h)`
3. Esperar al próximo fetch (cada 60 seg) o reiniciar OpenCode

#### Cuenta incorrecta

1. Cerrar OpenCode
2. Ejecutar `cuenta <prefijo>`
3. Verificar: `cuenta` (debe mostrar la cuenta correcta)
4. Abrir OpenCode
