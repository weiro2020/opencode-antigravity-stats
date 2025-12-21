#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
#
# MODIFIED: Wrapper that removes --enable-remote-auto-shutdown flag
# This prevents the Antigravity server from auto-shutting down after 3 hours of inactivity.
#
# Installation:
#   1. Find your antigravity-server binary:
#      ls ~/.antigravity-server/bin/*/bin/antigravity-server
#
#   2. Backup the original:
#      cp ~/.antigravity-server/bin/<version>/bin/antigravity-server \
#         ~/.antigravity-server/bin/<version>/bin/antigravity-server.original
#
#   3. Replace with this wrapper:
#      cp antigravity-server-wrapper.sh ~/.antigravity-server/bin/<version>/bin/antigravity-server
#      chmod +x ~/.antigravity-server/bin/<version>/bin/antigravity-server
#
# Note: The Antigravity app may update and overwrite this wrapper. Re-apply after updates.

case "$1" in
	--inspect*) INSPECT="$1"; shift;;
esac

ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"

# Set rpath before changing the interpreter path
if [ -n "$VSCODE_SERVER_CUSTOM_GLIBC_LINKER" ] && [ -n "$VSCODE_SERVER_CUSTOM_GLIBC_PATH" ] && [ -n "$VSCODE_SERVER_PATCHELF_PATH" ]; then
	echo "Patching glibc from $VSCODE_SERVER_CUSTOM_GLIBC_PATH with $VSCODE_SERVER_PATCHELF_PATH..."
	"$VSCODE_SERVER_PATCHELF_PATH" --set-rpath "$VSCODE_SERVER_CUSTOM_GLIBC_PATH" "$ROOT/node"
	echo "Patching linker from $VSCODE_SERVER_CUSTOM_GLIBC_LINKER with $VSCODE_SERVER_PATCHELF_PATH..."
	"$VSCODE_SERVER_PATCHELF_PATH" --set-interpreter "$VSCODE_SERVER_CUSTOM_GLIBC_LINKER" "$ROOT/node"
	echo "Patching complete."
fi

# Filter out --enable-remote-auto-shutdown from arguments
FILTERED_ARGS=""
for arg in "$@"; do
	if [ "$arg" != "--enable-remote-auto-shutdown" ]; then
		FILTERED_ARGS="$FILTERED_ARGS $arg"
	fi
done

"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" $FILTERED_ARGS
