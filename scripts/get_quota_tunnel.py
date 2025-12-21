#!/usr/bin/env python3
"""
Antigravity Quota Fetcher via SSH Tunnel

Connects to a remote Language Server through an SSH tunnel.
Configure TUNNEL_PORT and CSRF_TOKEN before use.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict

# ============================================
# CONFIGURATION - Update these values
# ============================================
TUNNEL_PORT = 50001  # Local port that tunnels to Windows LS
CSRF_TOKEN = "7ec30f4e-9965-4c52-b1a4-fde66a4bd193"  # Token from Windows LS
USE_HTTPS = False  # Windows LS uses HTTP when tunneled
# ============================================

CACHE_FILE = Path.home() / ".antigravity-standalone" / "quota_cache.json"


@dataclass
class ModelQuota:
    label: str
    model_id: str
    remaining_percent: float
    reset_time: str
    is_exhausted: bool


@dataclass
class QuotaSnapshot:
    email: str
    plan_name: str
    models: List[ModelQuota]
    timestamp: str
    prompt_credits_available: int = 0
    prompt_credits_monthly: int = 0
    flow_credits_available: int = 0
    flow_credits_monthly: int = 0
    is_cached: bool = False
    cache_age_seconds: int = 0


def fetch_quota_via_tunnel() -> Optional[QuotaSnapshot]:
    """Fetch quota from the Language Server via SSH tunnel."""
    protocol = "https" if USE_HTTPS else "http"
    url = f"{protocol}://127.0.0.1:{TUNNEL_PORT}/exa.language_server_pb.LanguageServerService/GetUserStatus"
    
    cmd = [
        "curl", "-s", "-k", "-X", "POST", url,
        "-H", "Content-Type: application/json",
        "-H", "Accept: application/json",
        "-H", "Connect-Protocol-Version: 1",
        "-H", f"x-codeium-csrf-token: {CSRF_TOKEN}",
        "-d", '{"metadata":{"ideName":"antigravity","apiKey":"","locale":"en-US","os":"linux"}}',
        "--connect-timeout", "10"
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0 or not result.stdout.strip():
            print(f"Error: curl failed or empty response", file=sys.stderr)
            return None
        
        data = json.loads(result.stdout)
        return parse_quota_response(data)
        
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"Error fetching quota: {e}", file=sys.stderr)
        return None


def parse_quota_response(data: Dict[str, Any]) -> QuotaSnapshot:
    """Parse the GetUserStatus response into a QuotaSnapshot."""
    user_status = data.get('userStatus', {})
    plan_status = user_status.get('planStatus', {})
    plan_info = plan_status.get('planInfo', {})
    cascade_data = user_status.get('cascadeModelConfigData', {})
    
    models = []
    for config in cascade_data.get('clientModelConfigs', []):
        quota_info = config.get('quotaInfo', {})
        remaining = quota_info.get('remainingFraction', 1.0)
        
        model_or_alias = config.get('modelOrAlias', {})
        model_id = model_or_alias.get('model', model_or_alias.get('alias', 'unknown'))
        
        models.append(ModelQuota(
            label=config.get('label', 'Unknown'),
            model_id=model_id,
            remaining_percent=remaining * 100,
            reset_time=quota_info.get('resetTime', ''),
            is_exhausted=remaining == 0
        ))
    
    return QuotaSnapshot(
        email=user_status.get('email', ''),
        plan_name=plan_info.get('planName', 'Unknown'),
        models=models,
        timestamp=datetime.now(timezone.utc).isoformat(),
        prompt_credits_available=plan_status.get('availablePromptCredits', 0),
        prompt_credits_monthly=plan_info.get('monthlyPromptCredits', 0),
        flow_credits_available=plan_status.get('availableFlowCredits', 0),
        flow_credits_monthly=plan_info.get('monthlyFlowCredits', 0),
        is_cached=False,
        cache_age_seconds=0
    )


def save_quota_to_cache(snapshot: QuotaSnapshot):
    """Save quota snapshot to cache file."""
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    
    data = {
        'email': snapshot.email,
        'plan_name': snapshot.plan_name,
        'timestamp': snapshot.timestamp,
        'prompt_credits_available': snapshot.prompt_credits_available,
        'prompt_credits_monthly': snapshot.prompt_credits_monthly,
        'flow_credits_available': snapshot.flow_credits_available,
        'flow_credits_monthly': snapshot.flow_credits_monthly,
        'models': [asdict(m) for m in snapshot.models]
    }
    
    with open(CACHE_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def load_quota_from_cache() -> Optional[QuotaSnapshot]:
    """Load quota snapshot from cache file."""
    if not CACHE_FILE.exists():
        return None
    
    try:
        with open(CACHE_FILE, 'r') as f:
            data = json.load(f)
        
        cached_time = datetime.fromisoformat(data['timestamp'].replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        cache_age = int((now - cached_time).total_seconds())
        
        models = [ModelQuota(**m) for m in data['models']]
        
        return QuotaSnapshot(
            email=data['email'],
            plan_name=data['plan_name'],
            models=models,
            timestamp=data['timestamp'],
            prompt_credits_available=data.get('prompt_credits_available', 0),
            prompt_credits_monthly=data.get('prompt_credits_monthly', 0),
            flow_credits_available=data.get('flow_credits_available', 0),
            flow_credits_monthly=data.get('flow_credits_monthly', 0),
            is_cached=True,
            cache_age_seconds=cache_age
        )
        
    except (json.JSONDecodeError, KeyError) as e:
        print(f"Error loading cache: {e}", file=sys.stderr)
        return None


@dataclass
class QuotaGroup:
    name: str
    remaining_percent: float
    reset_time: str
    models: List[str]


def get_quota_groups(models: List[ModelQuota]) -> List[QuotaGroup]:
    """Group models into 3 quota groups."""
    groups = {
        'Claude': {'models': [], 'pct': None, 'reset': None},
        'Gemini 3 Pro': {'models': [], 'pct': None, 'reset': None},
        'Gemini 3 Flash': {'models': [], 'pct': None, 'reset': None},
    }
    
    for m in models:
        label_lower = m.label.lower()
        
        if 'claude' in label_lower or 'gpt-oss' in label_lower or 'gpt oss' in label_lower:
            group = 'Claude'
        elif 'gemini 3 pro' in label_lower or 'gemini-3-pro' in label_lower:
            group = 'Gemini 3 Pro'
        elif 'gemini 3 flash' in label_lower or 'gemini-3-flash' in label_lower:
            group = 'Gemini 3 Flash'
        elif 'gemini' in label_lower:
            if 'flash' in label_lower:
                group = 'Gemini 3 Flash'
            elif 'pro' in label_lower:
                group = 'Gemini 3 Pro'
            else:
                continue
        else:
            continue
        
        groups[group]['models'].append(m.label)
        if groups[group]['pct'] is None:
            groups[group]['pct'] = m.remaining_percent
            groups[group]['reset'] = m.reset_time
    
    result = []
    for name in ['Claude', 'Gemini 3 Pro', 'Gemini 3 Flash']:
        g = groups[name]
        if g['models'] and g['pct'] is not None:
            result.append(QuotaGroup(
                name=name,
                remaining_percent=g['pct'],
                reset_time=g['reset'],
                models=g['models']
            ))
    
    return result


def format_time_remaining(reset_time_str: str) -> str:
    """Format the time remaining until reset."""
    if not reset_time_str:
        return "?"
    
    try:
        reset_time_str = reset_time_str.replace('Z', '+00:00')
        reset_time = datetime.fromisoformat(reset_time_str)
        now = datetime.now(timezone.utc)
        
        delta = reset_time - now
        total_seconds = delta.total_seconds()
        
        if total_seconds <= 0:
            return "Ready"
        
        hours = int(total_seconds // 3600)
        minutes = int((total_seconds % 3600) // 60)
        
        if hours > 0:
            return f"{hours}h{minutes}m"
        return f"{minutes}m"
    except:
        return "?"


def print_json(snapshot: QuotaSnapshot):
    """Print quota as JSON."""
    groups = get_quota_groups(snapshot.models)
    
    output = {
        "email": snapshot.email,
        "plan_name": snapshot.plan_name,
        "timestamp": snapshot.timestamp,
        "is_cached": snapshot.is_cached,
        "cache_age_seconds": snapshot.cache_age_seconds,
        "prompt_credits": {
            "available": snapshot.prompt_credits_available,
            "monthly": snapshot.prompt_credits_monthly
        },
        "flow_credits": {
            "available": snapshot.flow_credits_available,
            "monthly": snapshot.flow_credits_monthly
        },
        "groups": [
            {
                "name": g.name,
                "remaining_percent": g.remaining_percent,
                "reset_time": g.reset_time,
                "time_until_reset": format_time_remaining(g.reset_time),
                "models": g.models
            }
            for g in groups
        ],
        "models": [
            {
                "label": m.label,
                "model_id": m.model_id,
                "remaining_percent": m.remaining_percent,
                "reset_time": m.reset_time,
                "time_until_reset": format_time_remaining(m.reset_time),
                "is_exhausted": m.is_exhausted
            }
            for m in snapshot.models
        ]
    }
    print(json.dumps(output, indent=2))


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Fetch Antigravity quota via SSH tunnel')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--cached', action='store_true', help='Use cached data only')
    
    args = parser.parse_args()
    
    snapshot = None
    
    if not args.cached:
        print(f"Connecting to tunnel port {TUNNEL_PORT}...", file=sys.stderr)
        snapshot = fetch_quota_via_tunnel()
        
        if snapshot:
            save_quota_to_cache(snapshot)
            print("Quota fetched successfully via tunnel", file=sys.stderr)
    
    if not snapshot:
        snapshot = load_quota_from_cache()
        if not snapshot:
            print("Error: No quota data available", file=sys.stderr)
            sys.exit(1)
    
    if args.json:
        print_json(snapshot)
    else:
        # Simple text output
        groups = get_quota_groups(snapshot.models)
        print(f"\nAccount: {snapshot.email}")
        print(f"Plan: {snapshot.plan_name}")
        print("-" * 40)
        for g in groups:
            time_left = format_time_remaining(g.reset_time)
            print(f"{g.name}: {g.remaining_percent:.1f}% ({time_left})")


if __name__ == '__main__':
    main()
