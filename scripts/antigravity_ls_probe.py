#!/usr/bin/env python3
"""Probe Antigravity language server auth + quota endpoints.

This script is intentionally self-contained (no external Python deps).
It spawns Antigravity's `language_server_macos_arm`, feeds the required
stdin protobuf Metadata handshake, then performs Connect RPC calls over
HTTPS + HTTP/2 (matching what the bundled extension does).

It is meant for local debugging only.

Usage:
  python3 scripts/antigravity_ls_probe.py

Optional env vars:
  AG_LS_PATH               Path to language_server_macos_arm
  AG_CERT_PEM              Path to languageServer/cert.pem CA
  AG_GEMINI_DIR            Path to gemini dir (default: ~/.gemini)
  AG_APP_DATA_DIR          App data dir name (default: antigravity)
  AG_CLOUD_CODE_ENDPOINT   Cloud code endpoint
  AG_OAUTH_CREDS_JSON      Path to oauth_creds.json
  AG_SERVER_PORT           Fixed HTTPS port for LS
  AG_CSRF_TOKEN            CSRF token header + CLI arg

Notes:
- This uses Connect RPC binary format with Content-Type: application/proto.
- It uses curl with --http2 to ensure HTTP/2 is used.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, NoReturn


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v is not None and v != "" else default


LS_PATH = _env(
    "AG_LS_PATH",
    "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
)
CERT_PEM = _env(
    "AG_CERT_PEM",
    "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/languageServer/cert.pem",
)
GEMINI_DIR = _env("AG_GEMINI_DIR", str(Path.home() / ".gemini"))
APP_DATA_DIR = _env("AG_APP_DATA_DIR", "antigravity")
CLOUD_CODE_ENDPOINT = _env(
    "AG_CLOUD_CODE_ENDPOINT", "https://daily-cloudcode-pa.sandbox.googleapis.com"
)
OAUTH_CREDS_JSON = _env(
    "AG_OAUTH_CREDS_JSON", str(Path.home() / ".gemini" / "oauth_creds.json")
)
OPENCODE_ACCOUNTS_JSON = _env(
    "AG_OPENCODE_ACCOUNTS_JSON",
    str(Path.home() / ".local" / "share" / "opencode" / "antigravity-accounts.json"),
)

# OAuth client configuration.
# For safety, do NOT hardcode the Antigravity client secret in this repo.
OAUTH_CLIENT_ID = _env(
    "AG_OAUTH_CLIENT_ID",
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
)
OAUTH_CLIENT_SECRET = _env("AG_OAUTH_CLIENT_SECRET", "")
OPENCODE_AUTH_REPO = _env(
    "AG_OPENCODE_AUTH_REPO", "/Users/shady/github/shekohex/opencode-antigravity-auth"
)

# Token source preference: "opencode" or "gemini".
TOKEN_SOURCE = _env("AG_TOKEN_SOURCE", "")

SERVER_PORT = int(_env("AG_SERVER_PORT", "56112"))
CSRF_TOKEN = _env("AG_CSRF_TOKEN", "1b4c5a39-1d8d-4eaf-9bdf-3dc1c3ce3b9a")


def _die(msg: str) -> NoReturn:
    print(msg, file=sys.stderr)
    raise SystemExit(2)


# --- minimal protobuf encoder (varint + length-delimited) ---


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


def _msg(field_no: int, payload: bytes) -> bytes:
    return _ld(field_no, payload)


def _ts(seconds: int) -> bytes:
    # google.protobuf.Timestamp: seconds=1 (varint)
    return _key(1, 0) + _varint(seconds)


def _load_oauth_creds(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        _die(f"Missing OAuth creds file: {path}")
    except json.JSONDecodeError as e:
        _die(f"Invalid JSON in {path}: {e}")


def _load_opencode_accounts(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        _die(f"Missing opencode accounts file: {path}")
    except json.JSONDecodeError as e:
        _die(f"Invalid JSON in {path}: {e}")


def _pick_opencode_account_refresh(accounts_json: dict[str, Any]) -> tuple[str, str]:
    """Returns (refresh_token, project_id)."""

    accounts = accounts_json.get("accounts")
    if not isinstance(accounts, list) or not accounts:
        _die("opencode accounts JSON missing 'accounts' list")

    active_index = accounts_json.get("activeIndex")
    idx = int(active_index) if isinstance(active_index, int) else 0
    if idx < 0 or idx >= len(accounts):
        idx = 0

    account = accounts[idx]
    if not isinstance(account, dict):
        _die("opencode accounts JSON has invalid account entry")

    refresh_token = account.get("refreshToken")
    project_id = account.get("projectId")
    if not isinstance(refresh_token, str) or not refresh_token:
        _die("opencode accounts JSON missing refreshToken")

    return refresh_token, project_id if isinstance(project_id, str) else ""


def _load_client_secret_from_opencode_repo() -> str | None:
    constants_ts = Path(OPENCODE_AUTH_REPO) / "src" / "constants.ts"
    if not constants_ts.exists():
        return None

    try:
        text = constants_ts.read_text("utf-8", errors="replace")
    except OSError:
        return None

    m = re.search(r"\bANTIGRAVITY_CLIENT_SECRET\b\s*=\s*\"([^\"]+)\"", text)
    return m.group(1) if m else None


def _refresh_access_token(refresh_token: str) -> dict[str, Any]:
    """Refresh access token using Google's token endpoint.

    This uses curl to avoid external Python deps.
    """

    client_secret = OAUTH_CLIENT_SECRET
    if not client_secret:
        client_secret = _load_client_secret_from_opencode_repo() or ""

    form = [
        "-H",
        "Content-Type: application/x-www-form-urlencoded",
        "--data-urlencode",
        f"client_id={OAUTH_CLIENT_ID}",
        "--data-urlencode",
        "grant_type=refresh_token",
        "--data-urlencode",
        f"refresh_token={refresh_token}",
    ]
    if client_secret:
        form += ["--data-urlencode", f"client_secret={client_secret}"]

    cmd = [
        "curl",
        "--silent",
        "--show-error",
        "--location",
        "--request",
        "POST",
        *form,
        "https://oauth2.googleapis.com/token",
    ]

    cp = subprocess.run(cmd, check=False, text=True, capture_output=True)
    out = (cp.stdout or "").strip()
    err = (cp.stderr or "").strip()

    # Never print token material.
    if cp.returncode != 0 and not out:
        _die(f"Token refresh failed (curl rc={cp.returncode}): {err or 'no stderr'}")

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        # The error response might be plain text; show only a short prefix.
        prefix = out[:300]
        _die(f"Token refresh returned non-JSON response (prefix): {prefix}")

    if "error" in data:
        # Example: {"error":"invalid_client", "error_description":"..."}
        msg = str(data.get("error_description") or data.get("error") or "unknown error")
        _die(f"Token refresh error: {msg}")

    return data


def _load_token_info() -> tuple[str, str, str, int, str]:
    """Returns (access_token, refresh_token, token_type, expiry_sec, source)."""

    source = TOKEN_SOURCE.strip().lower()

    if not source:
        # Auto: prefer opencode accounts if present.
        if Path(OPENCODE_ACCOUNTS_JSON).exists():
            source = "opencode"
        else:
            source = "gemini"

    if source == "opencode":
        accounts = _load_opencode_accounts(OPENCODE_ACCOUNTS_JSON)
        refresh_token, _project_id = _pick_opencode_account_refresh(accounts)
        token = _refresh_access_token(refresh_token)
        access_token = str(token.get("access_token") or "")
        token_type = str(token.get("token_type") or "Bearer")
        expires_in = int(token.get("expires_in") or 0)
        expiry_sec = int(time.time()) + max(0, expires_in)
        if not access_token:
            _die("Token refresh succeeded but access_token missing")
        return access_token, refresh_token, token_type, expiry_sec, source

    if source == "gemini":
        creds = _load_oauth_creds(OAUTH_CREDS_JSON)
        access_token = str(creds.get("access_token") or "")
        refresh_token = str(creds.get("refresh_token") or "")
        token_type = str(creds.get("token_type") or "Bearer")
        expiry_ms = int(creds.get("expiry_date") or 0)
        expiry_sec = max(0, expiry_ms // 1000)
        if not access_token:
            _die(f"No access_token found in {OAUTH_CREDS_JSON}")
        return access_token, refresh_token, token_type, expiry_sec, source

    _die(f"Unknown AG_TOKEN_SOURCE: {source}")


def _build_metadata(access_token: str) -> bytes:
    # exa.codeium_common_pb.Metadata fields used by Antigravity:
    # ide_name=1, api_key=3, locale=4, os=5, ide_version=7,
    # extension_name=12, extension_path=17, device_fingerprint=24, trigger_id=25
    #
    # NOTE: field numbers were inferred from Antigravity's bundled extension.
    return b"".join(
        [
            _s(1, "antigravity"),
            _s(3, access_token),
            _s(4, "en-US"),
            _s(5, "macOS"),
            _s(7, "0"),
            _s(12, "google.antigravity"),
            _s(
                17,
                "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity",
            ),
            _s(24, "opencode-launcher"),
            _s(25, "manual"),
        ]
    )


def _build_save_oauth_token_info_request(
    access_token: str,
    refresh_token: str,
    token_type: str,
    expiry_sec: int,
) -> bytes:
    # exa.language_server_pb.OAuthTokenInfo fields:
    # 1 access_token, 2 token_type, 3 refresh_token, 4 expiry (Timestamp)
    token_info = b"".join(
        [
            _s(1, access_token),
            _s(2, token_type or "Bearer"),
            _s(3, refresh_token) if refresh_token else b"",
            _msg(4, _ts(expiry_sec)) if expiry_sec else b"",
        ]
    )

    # exa.language_server_pb.SaveOAuthTokenInfoRequest:
    # 1 token_info (OAuthTokenInfo)
    return _msg(1, token_info)


def _build_get_user_status_request(metadata: bytes) -> bytes:
    # exa.language_server_pb.GetUserStatusRequest: 1 metadata
    return _msg(1, metadata)


def _curl_post(
    path: str, body: bytes, use_json: bool = False
) -> tuple[int, str, bytes]:
    """Call Connect unary endpoint (HTTP/2 + TLS).

    Returns: (status_code, response_headers_text, response_body_bytes)

    Connect unary (binary) uses Content-Type: application/proto.
    If use_json=True, uses application/json (body must be empty or valid JSON).
    """

    content_type = "application/json" if use_json else "application/proto"
    accept = "application/json" if use_json else "application/proto"

    with tempfile.NamedTemporaryFile(delete=False) as req:
        req.write(body)
        req_path = req.name
    resp_path = tempfile.mktemp(prefix="ag_resp_")
    hdr_path = tempfile.mktemp(prefix="ag_hdr_")

    try:
        url = f"https://127.0.0.1:{SERVER_PORT}{path}"
        cmd = [
            "curl",
            "--silent",
            "--show-error",
            "--http2",
            "--cacert",
            CERT_PEM,
            "-H",
            f"Content-Type: {content_type}",
            "-H",
            f"Accept: {accept}",
            "-H",
            "Connect-Protocol-Version: 1",
            "-H",
            f"x-codeium-csrf-token: {CSRF_TOKEN}",
            "--data-binary",
            f"@{req_path}",
            url,
            "-D",
            hdr_path,
            "--output",
            resp_path,
            "-w",
            "%{http_code}",
        ]

        cp = subprocess.run(cmd, check=True, text=True, capture_output=True)
        code = int((cp.stdout or "0").strip())
        hdr = Path(hdr_path).read_text(errors="replace")
        resp = Path(resp_path).read_bytes()
        return code, hdr, resp
    finally:
        for pth in (req_path, resp_path, hdr_path):
            try:
                os.unlink(pth)
            except OSError:
                pass


def _header_value(headers_text: str, header_name: str) -> str | None:
    for line in headers_text.splitlines():
        if line.lower().startswith(header_name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return None


def main() -> int:
    access_token, refresh_token, token_type, expiry_sec, source = _load_token_info()

    metadata = _build_metadata(access_token)
    save_oauth_req = _build_save_oauth_token_info_request(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type=token_type,
        expiry_sec=expiry_sec,
    )
    get_user_status_req = _build_get_user_status_request(metadata)

    # Start LS
    args = [
        LS_PATH,
        "-server_port",
        str(SERVER_PORT),
        "-random_port=false",
        "-enable_lsp=false",
        "-csrf_token",
        CSRF_TOKEN,
        "-cloud_code_endpoint",
        CLOUD_CODE_ENDPOINT,
        "-gemini_dir",
        GEMINI_DIR,
        "-app_data_dir",
        APP_DATA_DIR,
    ]

    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        assert proc.stdin is not None
        proc.stdin.write(metadata)
        proc.stdin.close()

        # Wait until server responds.
        ready = False
        for _ in range(120):
            if proc.poll() is not None:
                _die(f"language server exited early: {proc.returncode}")
            try:
                _curl_post(
                    "/exa.language_server_pb.LanguageServerService/GetStatus", b""
                )
                ready = True
                break
            except subprocess.CalledProcessError:
                time.sleep(0.1)

        print(f"ls_ready={ready} server_port={SERVER_PORT}")

        code, _, _ = _curl_post(
            "/exa.language_server_pb.LanguageServerService/SaveOAuthTokenInfo",
            save_oauth_req,
        )
        print(
            "SaveOAuthTokenInfo"
            f" http={code} source={source} refresh_present={bool(refresh_token)}"
        )

        code, hdr, body = _curl_post(
            "/exa.language_server_pb.LanguageServerService/GetUserStatus",
            get_user_status_req,
        )
        ct = _header_value(hdr, "Content-Type")
        print(
            f"GetUserStatus (proto) http={code} content_type={ct} resp_bytes={len(body)}"
        )

        # Also probe JSON endpoint to inspect readable response
        # Note: We send empty JSON object {} because we can't easily encode the protobuf request to JSON here
        # without external deps. The server might accept empty body or {} for GetUserStatus if fields are optional.
        # But GetUserStatus requires metadata.
        # However, for debugging, let's try sending just {} and see if it returns partial status or error.
        # Actually, since we can't encode Metadata to JSON easily without `protobuf` lib, we'll skip the request body
        # and hope the server uses the auth token/session state or defaults.
        # Update: Connect-RPC usually requires a valid JSON body matching the message structure.
        # If we can't provide it, we might get an error.
        # BUT: We can construct a minimal JSON payload manually since we know the structure!
        # Metadata field is 1. JSON name is "metadata".
        # Inside metadata: api_key is 3 -> "apiKey".
        # Let's try constructing a minimal valid JSON request.

        json_req = json.dumps(
            {
                "metadata": {
                    "ideName": "antigravity",
                    "apiKey": access_token,
                    "ideVersion": "0",
                    "extensionName": "google.antigravity",
                    "extensionVersion": "0.0.0",
                }
            }
        ).encode("utf-8")

        code_json, hdr_json, body_json = _curl_post(
            "/exa.language_server_pb.LanguageServerService/GetUserStatus",
            json_req,
            use_json=True,
        )
        print(f"GetUserStatus (json) http={code_json} resp_bytes={len(body_json)}")
        if code_json == 200:
            try:
                parsed = json.loads(body_json)
                print(json.dumps(parsed, indent=2))
            except:
                print("Failed to parse JSON response")
                print(body_json.decode("utf-8", "replace")[:1000])

        if ct and "json" in ct.lower():
            # This should be a Connect error payload.
            # Avoid printing anything token-shaped; this should only contain error strings.
            prefix = body[:600].decode("utf-8", "replace")
            print("GetUserStatus error:")
            print(prefix)

        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
