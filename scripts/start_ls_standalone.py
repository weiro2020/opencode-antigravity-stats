#!/usr/bin/env python3
"""
Standalone Antigravity Language Server Launcher for Linux

This script starts the Language Server without the Antigravity IDE,
allowing it to run persistently for quota queries.
"""

import json
import os
import subprocess
import sys
import time
import signal
from pathlib import Path

# Configuration
LS_PATH = os.environ.get(
    "AG_LS_PATH",
    str(Path.home() / ".antigravity-standalone/bin/language_server_linux_x64")
)
GEMINI_DIR = os.environ.get("AG_GEMINI_DIR", str(Path.home() / ".gemini"))
APP_DATA_DIR = os.environ.get("AG_APP_DATA_DIR", "antigravity")
CLOUD_CODE_ENDPOINT = os.environ.get(
    "AG_CLOUD_CODE_ENDPOINT", 
    "https://daily-cloudcode-pa.sandbox.googleapis.com"
)
OAUTH_CREDS_JSON = os.environ.get(
    "AG_OAUTH_CREDS_JSON", 
    str(Path.home() / ".gemini" / "oauth_creds.json")
)
SERVER_PORT = int(os.environ.get("AG_SERVER_PORT", "56112"))
CSRF_TOKEN = os.environ.get("AG_CSRF_TOKEN", "standalone-csrf-token-12345")


# --- Minimal protobuf encoder ---

def _varint(n: int) -> bytes:
    out = bytearray()
    n = int(n)
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def _key(field_no: int, wire: int) -> bytes:
    return _varint((field_no << 3) | wire)


def _ld(field_no: int, payload: bytes) -> bytes:
    return _key(field_no, 2) + _varint(len(payload)) + payload


def _s(field_no: int, value: str) -> bytes:
    return _ld(field_no, value.encode("utf-8"))


def _build_metadata(access_token: str) -> bytes:
    """Build the protobuf Metadata message for stdin handshake."""
    # Field numbers from Antigravity extension:
    # ide_name=1, api_key=3, locale=4, os=5, ide_version=7,
    # extension_name=12, extension_path=17, device_fingerprint=24, trigger_id=25
    return b"".join([
        _s(1, "antigravity"),
        _s(3, access_token),
        _s(4, "en-US"),
        _s(5, "linux"),  # Changed from macOS
        _s(7, "0"),
        _s(12, "google.antigravity"),
        _s(17, str(Path.home() / ".antigravity-standalone")),
        _s(24, "opencode-standalone"),
        _s(25, "daemon"),
    ])


def load_access_token() -> str:
    """Load access token from oauth_creds.json."""
    try:
        with open(OAUTH_CREDS_JSON, 'r') as f:
            creds = json.load(f)
            return creds.get('access_token', '')
    except FileNotFoundError:
        print(f"Error: OAuth creds not found at {OAUTH_CREDS_JSON}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {OAUTH_CREDS_JSON}: {e}")
        sys.exit(1)


def start_language_server(access_token: str) -> subprocess.Popen:
    """Start the Language Server process."""
    metadata = _build_metadata(access_token)
    
    args = [
        LS_PATH,
        "-server_port", str(SERVER_PORT),
        "-random_port=false",
        "-enable_lsp=false",
        "-csrf_token", CSRF_TOKEN,
        "-cloud_code_endpoint", CLOUD_CODE_ENDPOINT,
        "-gemini_dir", GEMINI_DIR,
        "-app_data_dir", APP_DATA_DIR,
    ]
    
    print(f"Starting Language Server on port {SERVER_PORT}...")
    print(f"Command: {' '.join(args)}")
    
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    
    # Send metadata handshake
    assert proc.stdin is not None
    proc.stdin.write(metadata)
    proc.stdin.close()
    
    return proc


def wait_for_ready(proc: subprocess.Popen, timeout: int = 30) -> bool:
    """Wait until the server is ready to accept connections."""
    import socket
    
    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            # Process exited
            stdout, stderr = proc.communicate()
            print(f"Language Server exited with code {proc.returncode}")
            print(f"stdout: {stdout.decode('utf-8', errors='replace')[:500]}")
            print(f"stderr: {stderr.decode('utf-8', errors='replace')[:500]}")
            return False
        
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex(('127.0.0.1', SERVER_PORT))
            sock.close()
            if result == 0:
                print(f"Language Server is ready on port {SERVER_PORT}")
                return True
        except:
            pass
        
        time.sleep(0.5)
    
    return False


def main():
    print("=" * 60)
    print("Antigravity Language Server - Standalone Mode")
    print("=" * 60)
    
    # Load access token
    access_token = load_access_token()
    if not access_token:
        print("Error: No access token found")
        sys.exit(1)
    print(f"Access token loaded (length: {len(access_token)})")
    
    # Start the server
    proc = start_language_server(access_token)
    
    # Wait for it to be ready
    if not wait_for_ready(proc):
        print("Error: Language Server failed to start")
        sys.exit(1)
    
    print()
    print(f"Language Server is running!")
    print(f"  PID: {proc.pid}")
    print(f"  Port: {SERVER_PORT}")
    print(f"  CSRF Token: {CSRF_TOKEN}")
    print()
    print("To query quota, use:")
    print(f'  curl -X POST "http://127.0.0.1:{SERVER_PORT}/exa.language_server_pb.LanguageServerService/GetUserStatus" \\')
    print(f'    -H "Content-Type: application/json" \\')
    print(f'    -H "Accept: application/json" \\')
    print(f'    -H "Connect-Protocol-Version: 1" \\')
    print(f'    -H "x-codeium-csrf-token: {CSRF_TOKEN}" \\')
    print(f'    -d \'{{"metadata":{{"ideName":"antigravity","apiKey":"dummy","locale":"en-US","os":"linux"}}}}\'')
    print()
    print("Press Ctrl+C to stop the server...")
    
    # Handle signals
    def signal_handler(sig, frame):
        print("\nShutting down...")
        proc.terminate()
        proc.wait(timeout=5)
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Wait for process
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
