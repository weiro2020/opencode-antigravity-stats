#!/usr/bin/env python3
import json
import sys
import os

CONFIG_PATH = os.path.expanduser("~/.antigravity-standalone/tunnel_config.json")

def update(token=None, port=None):
    try:
        with open(CONFIG_PATH, 'r') as f:
            config = json.load(f)
    except:
        config = {"port": 50001, "csrf_token": "", "windows_ls_port": 0}

    if token: config["csrf_token"] = token
    if port: config["windows_ls_port"] = int(port)

    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)
    
    print(f"Configuración actualizada:")
    print(f"  Token: {config['csrf_token']}")
    print(f"  Port:  {config['windows_ls_port']}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: update-tunnel-config <token> [port]")
    else:
        token = sys.argv[1]
        port = sys.argv[2] if len(sys.argv) > 2 else None
        update(token, port)
