# OpenCode Antigravity Stats Plugin - Changelog

## v1.2.1 - 2025-12-21: Auxiliary Scripts

### New

**Added scripts/ directory with standalone utilities:**
- `quota` - Bash wrapper for quota fetcher
- `get_antigravity_quota.py` - Python script to fetch quota from Language Server via Connect RPC
- `antigravity-server-wrapper.sh` - Prevents server auto-shutdown after 3 hours

### Docs

- Updated README with installation instructions for auxiliary scripts

---

## v1.2.0 - 2025-12-21: Server-Driven Quota & Simplified Architecture

### Breaking Changes

**Removed calibration system:**
- The `calibration` and `calibrations` fields have been removed from `AccountQuotaTracking`
- The `calibrateQuota()` and `calibrateQuotaManual()` methods have been removed
- Quota percentage now comes **exclusively from the server** via `quota --json`

### New Features

**Server-driven quota tracking:**
- Quota % is fetched from the server every 60 seconds
- No more local estimation or calibration needed
- More accurate and reliable quota information

**Automatic counter reset:**
- Local counters (tokens, requests) now reset automatically when a new server cycle is detected
- Detection logic: `windowStart_local < serverCycleStart` where `serverCycleStart = reset_time - 5h`
- Covers both time-based resets and 0%-reached resets

**Simplified persistence:**
- Memory is now the source of truth for stats
- No more complex disk-vs-memory merging logic
- Counters are saved directly to disk without comparison

### Technical Changes

| File | Changes |
|------|---------|
| `src/types.ts` | Removed `QuotaCalibration` interface. Simplified `AccountQuotaTracking` to only contain `windows` |
| `src/storage.ts` | Simplified `saveStats()` - no more disk comparison. `loadStats()` now cleans legacy calibration fields |
| `src/collector.ts` | Removed `calibrateQuota()` and `calibrateQuotaManual()`. Added reset logic in `fetchServerQuota()` for all groups. Fixed `getQuotaStatsAllGroups()` to use `serverCycleStart` instead of `Date.now()` when resetting |

### Data Structure

**Before (v1.1):**
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

**After (v1.2):**
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

### Migration

No manual migration needed. Legacy `calibration` and `calibrations` fields are automatically cleaned on load.

---

## v1.1.1 - 2025-12-19: Time Calculation & Reset Fixes

### Fixes

**Dynamic time calculation:**
- Time until reset is now calculated dynamically from `reset_time` (ISO timestamp)
- Previously: stored as pre-calculated string that became stale

**Counter reset detection:**
- Added detection for server cycle reset
- Resets local counters when `windowStart < (reset_time - 5h)`

---

## v1.1.0 - 2025-12-19: Server Quota Integration

### New Features

**Server integration:**
- Plugin now executes `quota --json` every 60 seconds
- First execution triggered with first message of session
- Data persisted to cache file

**3 Model Groups:**
- `CL` - Claude (all Claude models)
- `PR` - Gemini Pro (Gemini 3 Pro High/Low)
- `FL` - Gemini Flash (Gemini 3 Flash)

**New session title format:**
```
[CL] CL:4/20,92%,4h20,1.8M | PR:100%,5h | FL:95%,4h35
```

### Data Sources

| Data | Source |
|------|--------|
| `remaining_percent` | Server (quota --json) |
| `time_until_reset` | Server (quota --json) |
| `rpm` | Local (last 60 seconds) |
| `requestsCount` | Local (5-hour window) |
| `tokensUsed` | Local (5-hour window) |

---

## v1.0.0 - 2025-12-18: Initial Release

- Basic token and request tracking
- Multi-account support
- Session title display
- Rate limit detection
