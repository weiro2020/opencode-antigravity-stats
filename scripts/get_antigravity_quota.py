#!/usr/bin/env python3
"""
Antigravity Quota Fetcher with Offline Cache

Detects the running Antigravity Language Server and fetches real quota data.
Caches the data for offline use when Antigravity is not connected.

Usage:
    python3 get_antigravity_quota.py          # Pretty print quota
    python3 get_antigravity_quota.py --json   # JSON output for integration
    python3 get_antigravity_quota.py --save   # Fetch and save to cache
    python3 get_antigravity_quota.py --cached # Use cached data only
"""

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any

# Cache file location
CACHE_FILE = Path.home() / ".antigravity-standalone" / "quota_cache.json"


@dataclass
class LanguageServerInfo:
    """Information about a running Language Server."""
    pid: int
    csrf_token: str
    ports: List[int]
    http_port: Optional[int] = None


@dataclass 
class ModelQuota:
    """Quota information for a single model."""
    label: str
    model_id: str
    remaining_percent: float
    reset_time: str
    is_exhausted: bool


@dataclass
class QuotaSnapshot:
    """Complete quota snapshot for a user."""
    email: str
    plan_name: str
    models: List[ModelQuota]
    timestamp: str  # ISO format
    prompt_credits_available: int = 0
    prompt_credits_monthly: int = 0
    flow_credits_available: int = 0
    flow_credits_monthly: int = 0
    is_cached: bool = False
    cache_age_seconds: int = 0


def find_language_server() -> Optional[LanguageServerInfo]:
    """Find a running Antigravity Language Server."""
    try:
        result = subprocess.run(
            ["ps", "aux"],
            capture_output=True,
            text=True,
            check=True
        )
        
        for line in result.stdout.split('\n'):
            if 'language_server_linux' in line and '--csrf_token' in line:
                parts = line.split()
                pid = int(parts[1])
                
                csrf_match = re.search(r'--csrf_token\s+(\S+)', line)
                if not csrf_match:
                    continue
                csrf_token = csrf_match.group(1)
                
                ports = get_process_ports(pid)
                if not ports:
                    continue
                
                http_port = find_http_port(ports, csrf_token)
                
                return LanguageServerInfo(
                    pid=pid,
                    csrf_token=csrf_token,
                    ports=ports,
                    http_port=http_port
                )
                
    except subprocess.CalledProcessError:
        pass
    
    return None


def get_process_ports(pid: int) -> List[int]:
    """Get listening ports for a process."""
    ports = []
    try:
        result = subprocess.run(
            ["ss", "-tlnp"],
            capture_output=True,
            text=True,
            check=True
        )
        
        for line in result.stdout.split('\n'):
            if f'pid={pid}' in line:
                match = re.search(r':(\d+)\s', line)
                if match:
                    ports.append(int(match.group(1)))
                    
    except subprocess.CalledProcessError:
        pass
    
    return ports


def find_http_port(ports: List[int], csrf_token: str) -> Optional[int]:
    """Find the port that responds to HTTP Connect RPC (not HTTPS)."""
    for port in ports:
        try:
            result = subprocess.run(
                [
                    "curl", "-s", "-X", "POST",
                    f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus",
                    "-H", "Content-Type: application/json",
                    "-H", "Accept: application/json",
                    "-H", "Connect-Protocol-Version: 1",
                    "-H", f"x-codeium-csrf-token: {csrf_token}",
                    "-d", '{"metadata":{}}',
                    "--connect-timeout", "2"
                ],
                capture_output=True,
                text=True,
                timeout=5
            )
            # Check if response contains userStatus (success) or is HTTPS error
            output = result.stdout.strip()
            if 'userStatus' in output or 'email' in output:
                return port
            # Skip HTTPS ports
            if 'HTTPS' in output or not output:
                continue
        except:
            continue
    
    return None


def fetch_quota(ls_info: LanguageServerInfo) -> Optional[QuotaSnapshot]:
    """Fetch quota from the Language Server."""
    if not ls_info.http_port:
        return None
    
    try:
        result = subprocess.run(
            [
                "curl", "-s", "-X", "POST",
                f"http://127.0.0.1:{ls_info.http_port}/exa.language_server_pb.LanguageServerService/GetUserStatus",
                "-H", "Content-Type: application/json",
                "-H", "Accept: application/json",
                "-H", "Connect-Protocol-Version: 1",
                "-H", f"x-codeium-csrf-token: {ls_info.csrf_token}",
                "-d", '{"metadata":{"ideName":"antigravity","apiKey":"","locale":"en-US","os":"linux"}}'
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=10
        )
        
        data = json.loads(result.stdout)
        return parse_quota_response(data)
        
    except (subprocess.CalledProcessError, json.JSONDecodeError, subprocess.TimeoutExpired) as e:
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
    
    # Convert to dict for JSON serialization
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
    
    print(f"Quota cached to {CACHE_FILE}", file=sys.stderr)


def load_quota_from_cache() -> Optional[QuotaSnapshot]:
    """Load quota snapshot from cache file."""
    if not CACHE_FILE.exists():
        return None
    
    try:
        with open(CACHE_FILE, 'r') as f:
            data = json.load(f)
        
        # Calculate cache age
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


def format_cache_age(seconds: int) -> str:
    """Format cache age in human readable form."""
    if seconds < 60:
        return f"{seconds}s ago"
    elif seconds < 3600:
        return f"{seconds // 60}m ago"
    else:
        hours = seconds // 3600
        mins = (seconds % 3600) // 60
        return f"{hours}h{mins}m ago"


@dataclass
class QuotaGroup:
    """Aggregated quota for a group of models."""
    name: str
    remaining_percent: float
    reset_time: str
    models: List[str]


def get_quota_groups(models: List[ModelQuota]) -> List[QuotaGroup]:
    """
    Group models into 3 quota groups:
    - Claude: All Claude models + GPT-OSS (share same quota)
    - Gemini 3 Pro: Gemini 3 Pro High/Low (share same quota)  
    - Gemini 3 Flash: Gemini 3 Flash
    """
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
        # Use the first model's quota (they share the same quota within group)
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


def print_quota(snapshot: QuotaSnapshot, use_color: bool = True):
    """Pretty print the quota information."""
    if use_color:
        GREEN = '\033[92m'
        YELLOW = '\033[93m'
        RED = '\033[91m'
        CYAN = '\033[96m'
        BOLD = '\033[1m'
        DIM = '\033[2m'
        RESET = '\033[0m'
    else:
        GREEN = YELLOW = RED = CYAN = BOLD = DIM = RESET = ''
    
    print(f"\n{BOLD}Antigravity Quota Status{RESET}")
    print("=" * 55)
    
    if snapshot.is_cached:
        age_str = format_cache_age(snapshot.cache_age_seconds)
        print(f"{DIM}[CACHED - {age_str}]{RESET}")
    else:
        print(f"{GREEN}[LIVE]{RESET}")
    
    print(f"Email: {snapshot.email}")
    print(f"Plan: {snapshot.plan_name}")
    
    if snapshot.prompt_credits_monthly > 0:
        print(f"Prompt Credits: {snapshot.prompt_credits_available:,} / {snapshot.prompt_credits_monthly:,}")
    
    print()
    print(f"{BOLD}Quota por Grupo:{RESET}")
    print("-" * 55)
    
    # Get grouped quotas
    groups = get_quota_groups(snapshot.models)
    
    for group in sorted(groups, key=lambda g: g.remaining_percent):
        pct = group.remaining_percent
        
        if pct >= 70:
            color = GREEN
        elif pct >= 30:
            color = YELLOW
        else:
            color = RED
        
        time_remaining = format_time_remaining(group.reset_time)
        bar_width = 20
        filled = int(pct / 100 * bar_width)
        bar = '█' * filled + '░' * (bar_width - filled)
        
        print(f"  {group.name:18} {color}{bar}{RESET} {pct:5.1f}% ({time_remaining})")
    
    print()


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
    
    parser = argparse.ArgumentParser(description='Fetch Antigravity quota information')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--save', action='store_true', help='Save to cache after fetching')
    parser.add_argument('--cached', action='store_true', help='Use cached data only (no live fetch)')
    parser.add_argument('--no-color', action='store_true', help='Disable color output')
    parser.add_argument('--quiet', action='store_true', help='Suppress status messages')
    
    args = parser.parse_args()
    
    snapshot = None
    
    # Try live fetch first (unless --cached)
    if not args.cached:
        ls_info = find_language_server()
        
        if ls_info:
            if not args.quiet:
                print(f"Found Language Server (PID: {ls_info.pid}, Port: {ls_info.http_port})", file=sys.stderr)
            snapshot = fetch_quota(ls_info)
            
            if snapshot and args.save:
                save_quota_to_cache(snapshot)
        else:
            if not args.quiet:
                print("No Language Server found, using cache...", file=sys.stderr)
    
    # Fall back to cache
    if not snapshot:
        snapshot = load_quota_from_cache()
        
        if not snapshot:
            print("Error: No quota data available (no LS running and no cache).", file=sys.stderr)
            sys.exit(1)
    
    # Output
    if args.json:
        print_json(snapshot)
    else:
        print_quota(snapshot, use_color=not args.no_color)


if __name__ == '__main__':
    main()
