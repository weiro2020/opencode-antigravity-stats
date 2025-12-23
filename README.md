# OpenCode Antigravity Stats Plugin (v1.2.4)

Plugin for OpenCode that tracks real-time quota usage of AI models (Claude, Gemini) through Antigravity.

## What does this plugin do?

Tracks quota usage of AI models (Claude, Gemini) and provides stats via the `stats` script:

```bash
~/.antigravity-standalone/stats --oneline
```

Example output:
```
[CL] 5rpm/89req,84%,4h45m,1.5M | PR:100%,4h57m | FL:100%,4h57m
```

Where:
- `[CL]` = Active model (Claude)
- `5rpm` = Requests per minute (last 60 seconds)
- `89req` = Total requests in 5-hour window
- `84%` = Remaining quota (from server)
- `4h45m` = Time until reset
- `1.5M` = Tokens used

**Note:** The plugin does NOT modify the sidebar title. Stats are shown via the `stats` script.

## Project Structure

```
~/.config/opencode/plugin/opencode-antigravity-stats/
├── src/                    # TypeScript source code
│   ├── index.ts            # Entry point, event hooks
│   ├── collector.ts        # Main logic: tracking, quota fetch, accumulation
│   ├── storage.ts          # Disk persistence
│   ├── watcher.ts          # Monitors changes in antigravity-accounts.json
│   ├── types.ts            # TypeScript interfaces and constants
│   └── format.ts           # Output format for /stats command
├── dist/                   # Compiled code (active in OpenCode)
├── scripts/                # Auxiliary Python scripts
│   ├── stats               # Python script to show stats
│   ├── quota               # Query server quota
│   ├── get_antigravity_quota.py
│   ├── tunnel_config.json  # Tunnel config (DO NOT commit)
│   └── accounts/           # OAuth account management
│       ├── cuenta          # Select active account
│       ├── extraer-cuentas # Extract accounts to individual files
│       └── limpiar-cuentas # Clean logged-out accounts
├── docs/                   # Documentation
│   ├── ANTIGRAVITY.md      # Complete system documentation
│   └── TUNNEL.md           # SSH tunnel configuration
├── package.json
├── README.md               # This file
└── CHANGELOG.md
```

### Symlinks (compatibility)

```
~/.antigravity-standalone → scripts/
~/.config/opencode/cuenta → scripts/accounts/cuenta
```

## Model Groups

| Group | Label | Models |
|-------|-------|--------|
| **claude** | CL | claude-sonnet-4-5, claude-opus-4-5-thinking, gpt-oss-120b |
| **pro** | PR | gemini-3-pro-high, gemini-3-pro-low |
| **flash** | FL | gemini-3-flash |
| **other** | - | Any other (does not track quota) |

Models within the same group **share the same quota**.

## Tunnel Configuration

To get quota from a remote LS (Windows), configure `scripts/tunnel_config.json`:

```json
{
  "port": 50001,
  "csrf_token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Establish tunnel from Windows:
```powershell
ssh -R 50001:127.0.0.1:<LS_PORT> user@server -p <SSH_PORT>
```

## Behavior

The plugin tracks requests, tokens and RPM silently. Stats are obtained by running:

```bash
~/.antigravity-standalone/stats --oneline
```

| Scenario | Result |
|----------|--------|
| Tunnel active | Stats with server data |
| Tunnel off | Stats with local data + cache |

## Development

```bash
# Edit code
cd ~/.config/opencode/plugin/opencode-antigravity-stats/src/

# Compile
npm run build

# Restart OpenCode to apply changes
```

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getModelGroup()` | collector.ts | Maps model → group (claude/pro/flash/other) |
| `recordMessage()` | collector.ts | Updates tokens/requests per message |
| `fetchServerQuota()` | collector.ts | Executes `quota --json`, updates cache |
| `saveStats()` | storage.ts | Persists stats to disk |

## Data Files

| File | Description |
|------|-------------|
| `~/.config/opencode/antigravity-stats.json` | Local stats and tracking |
| `~/.config/opencode/antigravity-accounts.json` | OAuth accounts (from auth plugin) |
| `scripts/tunnel_config.json` | Tunnel configuration |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.
