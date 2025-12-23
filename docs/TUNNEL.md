# Antigravity Tunnel - Conexión al LS de Windows

Sistema para conectar OpenCode (Linux/VPS) al Language Server de Antigravity corriendo en Windows, via túnel SSH.

## Por qué usar el túnel

| Método | Ventaja | Desventaja |
|--------|---------|------------|
| LS Local (VPS) | No requiere Windows | Delay importante en quota, datos no son tiempo real |
| LS Windows via Tunnel | Quota en tiempo real | Requiere túnel SSH activo |

**Objetivo:** Usar el LS de Windows para obtener datos de quota en tiempo real, sin el delay del LS local.

---

## Estado Actual: ✅ FUNCIONANDO

**Última prueba exitosa:** 2025-12-21

```
Email: cristiancatanza@gmail.com
Plan: Pro
Claude: 89.6% (4h49m)
Gemini 3 Pro: 100% (4h37m)
Gemini 3 Flash: 100% (4h58m)
```

---

## Arquitectura

```
┌─────────────────────────┐         SSH Tunnel          ┌─────────────────────────┐
│  Linux VPS              │ ◄────────────────────────── │  Windows PC             │
│                         │     localhost:50001         │                         │
│  OpenCode               │          ↕                  │  Antigravity IDE        │
│  Plugin Stats           │     (túnel reverso)         │  Language Server        │
│  get_quota_tunnel.py    │                             │  (puerto HTTP local)    │
└─────────────────────────┘                             └─────────────────────────┘
```

**Importante:** El LS usa HTTP (no HTTPS) cuando se accede via túnel.

---

## Configuración Actual

**Archivo:** `~/.antigravity-standalone/tunnel_config.json`

```json
{
  "port": 50001,
  "csrf_token": "7ec30f4e-9965-4c52-b1a4-fde66a4bd193",
  "windows_ls_port": 53964
}
```

| Campo | Descripción |
|-------|-------------|
| `port` | Puerto local en VPS donde escucha el túnel |
| `csrf_token` | Token del LS de Windows (cambia cada reinicio) |
| `windows_ls_port` | Puerto del LS en Windows (referencia) |

---

## Componentes

| Archivo | Propósito |
|---------|-----------|
| `~/.antigravity-standalone/tunnel_config.json` | Config del túnel |
| `~/.antigravity-standalone/setup_tunnel.ps1` | Script PowerShell para Windows (automatiza todo) |
| `~/.antigravity-standalone/get_quota_tunnel.py` | Script para consultar quota via túnel |

---

## Cómo Usar

### Método Automático (Recomendado)

Ejecutar el script `setup_tunnel.ps1` en Windows:

```powershell
# Desde PowerShell en Windows
.\setup_tunnel.ps1
```

El script hace todo automáticamente:
1. Detecta el proceso del Language Server
2. Extrae el CSRF token de la línea de comandos
3. Detecta el puerto HTTP probando conexiones
4. Actualiza `tunnel_config.json` en el VPS via SSH
5. Inicia el túnel con keep-alive

### Método Manual

#### 1. Obtener datos del LS de Windows

En Windows, obtener el puerto HTTP y CSRF token del Language Server.

**Método rápido:** Revisar la configuración de Antigravity o usar Process Explorer.

#### 2. Establecer el túnel SSH

Desde Windows (PowerShell):

```powershell
ssh -o ServerAliveInterval=60 -R 50001:127.0.0.1:<PUERTO_LS> capw@142.171.248.233 -p 39776
```

#### 3. Probar conexión

```bash
# Con el script Python
python3 ~/.antigravity-standalone/get_quota_tunnel.py

# Con curl directo (HTTP, no HTTPS)
curl -s -X POST "http://127.0.0.1:50001/exa.language_server_pb.LanguageServerService/GetUserStatus" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -H "x-codeium-csrf-token: 7ec30f4e-9965-4c52-b1a4-fde66a4bd193" \
  -d '{"metadata":{"ideName":"antigravity","apiKey":"","locale":"en-US","os":"linux"}}' | jq .
```

---

## Troubleshooting

### "Connection refused"
- Verificar que el túnel SSH está activo: `ss -tunlp | grep 50001`
- Verificar que Antigravity está abierto en Windows

### "CSRF token invalid" o respuesta vacía
- El token cambia cada vez que se reinicia el LS
- Obtener el nuevo token desde Windows y actualizar config

### "SSL: wrong version number"
- El túnel usa HTTP, no HTTPS
- Asegurarse de usar `http://` en vez de `https://`

### Túnel se desconecta
- Usar `autossh` o `ssh -o ServerAliveInterval=60` para mantener vivo
- O reconectar manualmente cuando sea necesario

---

## Integración Completada ✅

El script `quota` ahora usa el túnel como fallback automático.

### Orden de prioridad de fuentes:

| Prioridad | Fuente | Cuándo se usa |
|-----------|--------|---------------|
| 1 | LS Local | Si hay un LS corriendo en el VPS |
| 2 | Túnel SSH | Si el LS local no está, y el túnel está activo |
| 3 | Cache | Si ninguna fuente live está disponible |

### Uso:

```bash
# Auto-detecta (LS local → túnel → cache)
quota

# Forzar usar túnel
quota --tunnel

# JSON para plugins
quota --json --quiet
```

### Archivos modificados:

| Archivo | Cambio |
|---------|--------|
| `get_antigravity_quota.py` | Agregado soporte para túnel como fallback |
| `tunnel_config.json` | Configuración del túnel (puerto, CSRF token) |

---

## Notas Técnicas

- El LS usa **Connect RPC** sobre HTTP/2
- Endpoint: `/exa.language_server_pb.LanguageServerService/GetUserStatus`
- La respuesta contiene `cascadeModelConfigData.clientModelConfigs[]` con quota por modelo
- Cada modelo tiene `quotaInfo.remainingFraction` (0-1) y `quotaInfo.resetTime`
- El CSRF token se pasa en el header `x-codeium-csrf-token`

### Estructura de respuesta relevante

```json
{
  "userStatus": {
    "email": "...",
    "cascadeModelConfigData": {
      "clientModelConfigs": [
        {
          "label": "Claude Sonnet 4.5",
          "quotaInfo": {
            "remainingFraction": 0.896,
            "resetTime": "2025-12-21T08:51:17Z"
          }
        }
      ]
    }
  }
}
```

---

## Script de Automatización (Windows)

**Archivo:** `~/.antigravity-standalone/setup_tunnel.ps1`

Script PowerShell que automatiza toda la configuración del túnel desde Windows.

### Qué hace

1. **Detecta el proceso** del Language Server (`language_server_windows_x64.exe`)
2. **Extrae el CSRF token** de la línea de comandos del proceso
3. **Detecta el puerto HTTP** probando conexiones a los puertos del proceso
4. **Actualiza `tunnel_config.json`** en el VPS via SSH
5. **Inicia el túnel** con `ServerAliveInterval=60` para mantenerlo vivo

### Uso

```powershell
# Ejecutar desde PowerShell en Windows
.\setup_tunnel.ps1

# Con parámetros personalizados
.\setup_tunnel.ps1 -RemoteHost "ip.del.vps" -RemotePort 22 -RemoteUser "usuario"
```

### Parámetros

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `-RemoteHost` | `142.171.248.233` | IP del VPS |
| `-RemotePort` | `39776` | Puerto SSH del VPS |
| `-RemoteUser` | `capw` | Usuario SSH |
| `-TunnelLocalPort` | `50001` | Puerto del túnel en el VPS |

### Requisitos

- Antigravity debe estar abierto en Windows
- SSH configurado para conectar al VPS (con clave SSH recomendado)

### Nota técnica

El script usa comillas simples en bash para preservar las comillas dobles del JSON:

```powershell
$remoteCmd = "echo '{`"port`": $TunnelLocalPort, `"csrf_token`": `"$token`", `"windows_ls_port`": $port}' > ~/.antigravity-standalone/tunnel_config.json"
```

Esto genera en el VPS:
```bash
echo '{"port": 50001, "csrf_token": "xxx", "windows_ls_port": 53964}' > ~/.antigravity-standalone/tunnel_config.json
```

### Ejemplo de salida

```
========================================
 Configuracion de Tunel SSH Antigravity
========================================

[Paso 1] Buscando proceso del Language Server...
Proceso encontrado: PID 12345
CSRF Token: 7ec30f4e-9965-4c52-b1a4-fde66a4bd193

[Paso 2] Detectando puerto HTTP...
Puertos encontrados: 53964, 53965
  Probando puerto 53964... OK
Puerto HTTP: 53964

[OK] CSRF Token copiado al portapapeles

[Paso 3] Actualizando tunnel_config.json en el VPS...
[OK] Archivo actualizado en el VPS

[Paso 4] Iniciando tunel SSH...
Comando: ssh -o ServerAliveInterval=60 -R 50001:127.0.0.1:53964 capw@142.171.248.233 -p 39776

Presiona Ctrl+C para cerrar el tunel cuando termines.
```
