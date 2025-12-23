# Antigravity Server Persistence - Investigación y Solución

## Problema

El servidor de Antigravity (Language Server) en el VPS se cierra automáticamente **3 horas** después de que Antigravity en Windows se desconecta. Además, el proceso hijo (Extension Host) que contiene el LS se cierra inmediatamente al perder la conexión con Windows.

### Comportamiento observado

1. Antigravity Windows se conecta via SSH al VPS.
2. Inicia el servidor con el flag `--enable-remote-auto-shutdown`.
3. Cuando Windows se desconecta, aparece en el log:
   ```
   [ManagementConnection] The client has disconnected, will wait for reconnection 3h before disposing...
   ```
4. Si nadie se reconecta en 3 horas, el servidor se cierra.

---

## Solución Implementada: Wrapper Script

Se implementó un **Wrapper Script** que intercepta el inicio del servidor y elimina el flag de auto-apagado.

### Archivos modificados

```
~/.antigravity-server/bin/94f91bc110994badc7c086033db813077a5226af/bin/
├── antigravity-server          # Wrapper modificado (ACTIVO)
└── antigravity-server.original # Backup del original
```

### Modificación exacta

El script original ejecuta:
```sh
"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" "$@"
```

El wrapper modificado filtra el flag `--enable-remote-auto-shutdown`:
```sh
# Filter out --enable-remote-auto-shutdown from arguments
FILTERED_ARGS=""
for arg in "$@"; do
    if [ "$arg" != "--enable-remote-auto-shutdown" ]; then
        FILTERED_ARGS="$FILTERED_ARGS $arg"
    fi
done

"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" $FILTERED_ARGS
```

### Código completo del wrapper

```sh
#!/usr/bin/env sh
# MODIFIED: Wrapper that removes --enable-remote-auto-shutdown flag

case "$1" in
    --inspect*) INSPECT="$1"; shift;;
esac

ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"

"$ROOT/bin/helpers/check-requirements.sh"

if [ ! -f "$ROOT/node" ]; then
    if [ -x /usr/bin/patchelf ]; then
        patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 "$ROOT/node_modules/@anthropic-ai/claude-code/vendor/node/node"
    else
        echo "Warning: patchelf not found. May have issues with glibc."
    fi
    ln -s "$ROOT/node_modules/@anthropic-ai/claude-code/vendor/node/node" "$ROOT/node"
fi

# Filter out --enable-remote-auto-shutdown from arguments
FILTERED_ARGS=""
for arg in "$@"; do
    if [ "$arg" != "--enable-remote-auto-shutdown" ]; then
        FILTERED_ARGS="$FILTERED_ARGS $arg"
    fi
done

"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" $FILTERED_ARGS
```

---

## Resultado

| Componente | Estado | Descripción |
|------------|--------|-------------|
| Servidor principal | ✅ Inmortal | No se cierra por timeout de 3 horas |
| Language Server (Extension Host) | ⚠️ Depende de Windows | Se cierra si Windows envía señal de apagado |

---

## IMPORTANTE: Cómo cerrar Antigravity en Windows

Para que el Language Server local **NO se cierre**, Antigravity en Windows se debe cerrar de la siguiente manera:

### ✅ Correcto: Cerrar por Administrador de Tareas

1. Abrir **Administrador de Tareas** (Ctrl+Shift+Esc)
2. Buscar el proceso de Antigravity
3. Click derecho → **Finalizar tarea**

Esto mata el proceso sin enviar señales de apagado al servidor.

### ❌ Incorrecto: Cerrar por la ventana

Si se cierra Antigravity usando:
- El botón X de la ventana
- File → Exit
- Alt+F4

**El cliente envía una señal de apagado que cierra todo en el servidor**, incluyendo el Language Server.

---

## Intentos Fallidos (Referencia Técnica)

Se intentaron aplicar parches al archivo `server-main.js` para mantener vivo el Extension Host:

1. **Prevent Main Shutdown:** Ignorar `this.l()` al desconectar. (Funcionó parcialmente).
2. **Prevent Kill:** Eliminar `this.h.kill()` al desconectar. (Falló: el proceso se cerraba solo).
3. **Prevent Socket Close:** Eliminar `this.j.socket.end()`. (Falló: causó crash del servidor).

**Estado de `server-main.js`:** Restaurado al original (limpio).

---

## Fecha de implementación

2025-12-20
