# =====================================================
# Script: setup_tunnel.ps1
# Descripcion: Automatiza la configuracion del tunel SSH
#              para Antigravity Language Server
# =====================================================

param(
    [string]$RemoteHost = "142.171.248.233",
    [int]$RemotePort = 39776,
    [string]$RemoteUser = "capw",
    [int]$TunnelLocalPort = 50001
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Configuracion de Tunel SSH Antigravity" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Buscar el proceso del Language Server de Antigravity
Write-Host "[Paso 1] Buscando proceso del Language Server..." -ForegroundColor Yellow

$process = Get-WmiObject Win32_Process -Filter "name='language_server_windows_x64.exe'" | Select-Object -First 1

if (-not $process) {
    Write-Error "Antigravity no esta abierto"
    Read-Host "Presiona Enter para cerrar"
    exit 1
}

Write-Host "Proceso encontrado: PID $($process.ProcessId)" -ForegroundColor Green

# 2. Extraer el token de la linea de comandos
$cmdLine = $process.CommandLine
$tokenMatch = [regex]::Match($cmdLine, '--csrf_token\s+([\w-]+)')

if ($tokenMatch.Success) {
    $token = $tokenMatch.Groups[1].Value
    Write-Host "CSRF Token: $token" -ForegroundColor Green
}
else {
    Write-Error "No se pudo extraer el token de la linea de comandos"
    Read-Host "Presiona Enter para cerrar"
    exit 1
}

# 3. Detectar el puerto HTTP probando conexiones
Write-Host ""
Write-Host "[Paso 2] Detectando puerto HTTP..." -ForegroundColor Yellow

$ports = Get-NetTCPConnection -OwningProcess $process.ProcessId -ErrorAction SilentlyContinue | 
Where-Object { $_.State -eq 'Listen' } | 
Select-Object -ExpandProperty LocalPort

if (-not $ports) {
    Write-Error "No se encontraron puertos en escucha"
    Read-Host "Presiona Enter para cerrar"
    exit 1
}

Write-Host "Puertos encontrados: $($ports -join ', ')" -ForegroundColor Gray

$port = $null
foreach ($p in $ports) {
    Write-Host "  Probando puerto $p..." -ForegroundColor Gray -NoNewline
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$p" -TimeoutSec 2 -ErrorAction Stop
        $port = $p
        Write-Host " OK" -ForegroundColor Green
        break
    }
    catch {
        if ($_.Exception.Response) {
            $port = $p
            Write-Host " OK" -ForegroundColor Green
            break
        }
        Write-Host " X" -ForegroundColor DarkGray
    }
}

if (-not $port) {
    Write-Host "No se detecto puerto HTTP, usando el mas alto" -ForegroundColor Yellow
    $port = ($ports | Sort-Object -Descending)[0]
}

Write-Host "Puerto HTTP: $port" -ForegroundColor Green

# Copiar token al portapapeles
$token | Set-Clipboard
Write-Host ""
Write-Host "[OK] CSRF Token copiado al portapapeles" -ForegroundColor Green

# 4. Actualizar el archivo en el VPS (usando ssh)
Write-Host ""
Write-Host "[Paso 3] Actualizando tunnel_config.json en el VPS..." -ForegroundColor Yellow

# Usar echo con comillas escapadas para bash
$remoteCmd = "echo '{`"port`": $TunnelLocalPort, `"csrf_token`": `"$token`", `"windows_ls_port`": $port}' > ~/.antigravity-standalone/tunnel_config.json"

ssh "${RemoteUser}@${RemoteHost}" -p $RemotePort $remoteCmd

if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Archivo actualizado en el VPS" -ForegroundColor Green
}
else {
    Write-Host "[ADVERTENCIA] No se pudo actualizar el archivo remoto" -ForegroundColor Yellow
}

# 5. Iniciar el Tunel con ServerAliveInterval
Write-Host ""
Write-Host "[Paso 4] Iniciando tunel SSH..." -ForegroundColor Yellow
Write-Host "Comando: ssh -o ServerAliveInterval=60 -R ${TunnelLocalPort}:127.0.0.1:${port} ${RemoteUser}@${RemoteHost} -p ${RemotePort}" -ForegroundColor Magenta
Write-Host ""
Write-Host "Presiona Ctrl+C para cerrar el tunel cuando termines." -ForegroundColor DarkGray
Write-Host ""

ssh -o ServerAliveInterval=60 -R "${TunnelLocalPort}:127.0.0.1:${port}" "${RemoteUser}@${RemoteHost}" -p $RemotePort
