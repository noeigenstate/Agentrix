"""Agentrix's Linux worker: every terminal opened on the host, each a channel of it, over one SSH connection."""
import base64
import calendar
import concurrent.futures
import glob
import hashlib
import json
import math
import os
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from email.utils import parsedate_tz, mktime_tz

PAGE_BYTES = 256 * 1024
MAX_READ = 256 * 1024
MAX_MESSAGE = 2 * 1024 * 1024
PREFIX = "PGW1 "
IMAGE_TYPES = {".png": "image/png", ".apng": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}

# Presence of a route override is enough to reject the official-account query. Values never leave the CLI host.
CLAUDE_ROUTE_ENV = frozenset("""ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_UNIX_SOCKET
ANTHROPIC_FOUNDRY_API_KEY ANTHROPIC_FOUNDRY_AUTH_TOKEN ANTHROPIC_AWS_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_GATEWAY
CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_SESSIONS_OAUTH_TOKEN CCR_OAUTH_TOKEN_FILE CLAUDE_CODE_PROFILE ANTHROPIC_PROFILE CLAUDE_CODE_CUSTOM_OAUTH_URL CLAUDE_CODE_OAUTH_CLIENT_ID""".split())

def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)

def read_account_json(filename):
    try:
        with open(filename, "rb") as source: data = source.read(1024 * 1024 + 1)
    except FileNotFoundError: return None
    if len(data) > 1024 * 1024: raise ValueError("account-size")
    value = json.loads(data)
    if not isinstance(value, dict): raise ValueError("account-shape")
    return value

def write_skill_reference(filename, text):
    """The same fingerprint may be installed by several channels or SSH processes at once."""
    data = text.encode("utf-8")
    if os.path.islink(filename): raise ValueError("Unsafe remote skill reference.")
    try:
        with open(filename, "rb") as source:
            if source.read(len(data) + 1) == data:
                os.chmod(filename, 0o400)
                return
    except FileNotFoundError: pass
    descriptor, temporary = tempfile.mkstemp(prefix=".skill-", dir=os.path.dirname(filename))
    try:
        with os.fdopen(descriptor, "wb") as target: target.write(data)
        try: os.replace(temporary, filename)
        except PermissionError:
            # Windows cannot replace a read-only file. A competing identical install is already complete.
            with open(filename, "rb") as source: same = source.read(len(data) + 1) == data
            if not same:
                os.chmod(filename, 0o600)
                os.replace(temporary, filename)
        os.chmod(filename, 0o400)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def official_claude_route(route, cwd):
    if not isinstance(route, dict) or route.get("overridden") is not False: return False
    folders = [route.get("home"), route.get("configDir"), route.get("secureDir")]
    if not all(value is None or isinstance(value, str) and os.path.isabs(value) and len(value) <= 4096 and "\0" not in value for value in folders): return False
    if not route.get("home"): return False
    config = route.get("configDir") or os.path.join(route["home"], ".claude")
    files = [os.path.join(config, "settings.json")]
    if cwd: files.extend(os.path.join(cwd, ".claude", name) for name in ("settings.json", "settings.local.json"))
    for filename in files:
        settings = read_account_json(filename)
        if settings is None: continue
        env = settings.get("env") or {}
        if not isinstance(env, dict) or any(str(key).upper() in CLAUDE_ROUTE_ENV for key in env): return False
        if any(settings.get(key) is not None for key in ("apiKeyHelper", "inferenceCredentialHelper")): return False
        if settings.get("forceLoginMethod") not in (None, "claudeai"): return False
    return True

class NoAccountRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs): return None

def account_retry_after(value, now):
    try:
        if not isinstance(value, str): return 0
        value = value.strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", value): delay = float(value) * 1000
        else:
            date = parsedate_tz(value)
            delay = mktime_tz(date) * 1000 - now if date else 0
        return min(900000, max(0, delay)) if math.isfinite(delay) else 0
    except Exception: return 0

def query_claude_account(route, now, open_url=None):
    """One GET with a freshly read credential. Only numeric limits and fixed status words escape, even on errors."""
    try:
        folder = route.get("secureDir") or route.get("configDir") or os.path.join(route["home"], ".claude")
        stored = read_account_json(os.path.join(folder, ".credentials.json"))
        oauth = stored.get("claudeAiOauth") if stored else None
        if not isinstance(oauth, dict): return {"state": "skipped", "reason": "credentials"}
        token = oauth.get("accessToken")
        if not isinstance(token, str) or not token.strip() or "\r" in token or "\n" in token: return {"state": "skipped", "reason": "credentials"}
        scopes = oauth.get("scopes")
        if not isinstance(scopes, list) or not all(scope in scopes for scope in ("user:inference", "user:profile")): return {"state": "skipped", "reason": "scope"}
        if not finite_number(oauth.get("expiresAt")) or oauth["expiresAt"] <= now: return {"state": "skipped", "reason": "expired"}
        request = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
            "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.312 (external, cli)",
            "Content-Type": "application/json", "Accept": "application/json, text/plain, */*"}, method="GET")
        opener = open_url or urllib.request.build_opener(NoAccountRedirect()).open
        with opener(request, timeout=5) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024: return {"state": "error", "reason": "response"}
        body, limits = json.loads(data), []
        if not isinstance(body, dict): return {"state": "error", "reason": "response"}
        for key, minutes in (("five_hour", 300), ("seven_day", 10080)):
            value = body.get(key)
            if not isinstance(value, dict) or not finite_number(value.get("utilization")) or value["utilization"] < 0: continue
            reset = record_time(value.get("resets_at")) if isinstance(value.get("resets_at"), str) else 0
            limits.append({"minutes": minutes, "percent": value["utilization"], "resetsAt": reset or None})
        return {"state": "ready", "account": {"limits": limits, "at": now, "source": "Claude"}} if limits else {"state": "error", "reason": "response"}
    except urllib.error.HTTPError as error:
        retry = error.headers.get("Retry-After", "") if error.headers else ""
        try: error.close()
        except Exception: pass
        return {"state": "error", "reason": "http", "status": error.code,
                "retryAfterMs": account_retry_after(retry, now) if error.code == 429 or error.code >= 500 else 0}
    except (TimeoutError, socket.timeout): return {"state": "error", "reason": "timeout"}
    except Exception: return {"state": "error", "reason": "query"}

class RemoteClaudeAccounts:
    def __init__(self, now=None, query=None):
        self.now = now or (lambda: int(time.time() * 1000))
        self.query = query or query_claude_account
        self.lock, self.results = threading.Lock(), {}

    def read(self, route, cwd):
        try:
            # Validate each project's live route before sharing any host-local numeric result.
            if not official_claude_route(route, cwd): return {"state": "skipped", "reason": "route"}
            key = tuple(route.get(name) for name in ("home", "configDir", "secureDir"))
            with self.lock:
                now = self.now()
                cached = self.results.get(key)
                if cached and now < cached[0]: return cached[1]
                result = self.query(route, now)
                transient = result.get("state") == "error" and (result.get("status") == 429 or result.get("status", 0) >= 500 or result.get("reason") in ("query", "timeout"))
                failures = (cached[2] if cached else 0) + 1 if transient else 0
                delay = max(min(900000, 60000 * 2 ** min(max(0, failures - 1), 4)), result.get("retryAfterMs", 0))
                self.results[key] = (now + delay, result, failures)
                if len(self.results) > 64: self.results.pop(next(iter(self.results)))
                return result
        except Exception: return {"state": "error", "reason": "query"}

NOTIFY_SOURCE = 'CLAUDE_ROUTE_ENV = ' + repr(tuple(sorted(CLAUDE_ROUTE_ENV))) + '\n' + r'''import hashlib,json,os,re,socket,stat,sys,time
def deliver_skills(hook, identity):
    if not re.fullmatch(r"[\w-]{1,100}", identity): return
    source=hook.get("source")
    if source not in ("startup","resume","compact","clear"): return
    state_dir=os.environ.get("AGENTRIX_SKILL_STATE_DIR")
    key_file=os.environ.get("AGENTRIX_SKILL_KEY_FILE")
    if not state_dir or not key_file: return
    with open(key_file,encoding="utf-8") as source_file: key=source_file.read(65)
    if not re.fullmatch(r"[a-f0-9]{64}",key): return
    manifest=os.path.join(os.path.dirname(state_dir),"references",key,"instructions.md")
    with open(manifest,encoding="utf-8") as source_file: instructions=source_file.read(2*1024*1024+1)
    if not instructions.strip() or len(instructions)>2*1024*1024: return
    os.makedirs(state_dir,mode=0o700,exist_ok=True)
    info=os.lstat(state_dir)
    if not stat.S_ISDIR(info.st_mode) or (hasattr(os,"getuid") and (info.st_uid!=os.getuid() or info.st_mode&0o077)): return
    filename=os.path.join(state_dir,hashlib.sha256((identity+":"+key).encode()).hexdigest())
    try:
        descriptor=os.open(filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.close(descriptor)
    except FileExistsError:
        if source not in ("compact","clear"): return
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Agentrix skill instructions:\n"+instructions}}))
try:
    mode=sys.argv[1]
    event={"type":mode,"token":os.environ["AGENTRIX_TOKEN"],"cwd":os.getcwd(),"codexHome":os.environ.get("CODEX_HOME",os.path.expanduser("~/.codex")),"sentAt":int(time.time()*1000)}
    if mode=="notify":
        payload=json.loads(sys.argv[2])
        if payload.get("type")!="agent-turn-complete": sys.exit(0)
        identity=str(payload.get("thread-id",""))+":"+str(payload.get("turn-id",""))
        if identity==":": sys.exit(0)
        event.update(type="turn-complete",eventId=hashlib.sha256(identity.encode()).hexdigest(),threadId=payload.get("thread-id"),turnId=payload.get("turn-id"))
    elif mode=="claude-hook":
        states={"start":"working","stop":"complete","notify":"attention","session":"session"}
        kind=sys.argv[2]
        if kind not in states: sys.exit(0)
        hook=json.load(sys.stdin)
        if kind=="notify" and hook.get("notification_type") not in ("permission_prompt","elicitation_dialog","elicitation_url_dialog"): sys.exit(0)
        identity=str(hook.get("session_id") or "")
        if not identity: sys.exit(0)
        event.update(type="agent-activity",agent="claude",state=states[kind],sessionId=identity,
                     transcriptPath=str(hook.get("transcript_path") or ""),eventId=identity+":"+kind+":"+str(time.time_ns() if hasattr(time,"time_ns") else int(time.time()*1000000000)),
                     message=str(hook.get("message") or "")[:300] if kind=="notify" else None,
                     prompt=str(hook["prompt"])[:2000] if kind=="start" and hook.get("prompt") else None)
        if kind=="session":
            try: deliver_skills(hook,identity)
            except Exception: pass
    elif mode=="shell-prompt":
        event["codexAvailable"]=len(sys.argv)>2 and sys.argv[2]=="1"
        event["claudeAvailable"]=len(sys.argv)>3 and sys.argv[3]=="1"
    elif mode in ("codex-started","codex-exited"):
        event["agent"]="claude" if len(sys.argv)>3 and sys.argv[3]=="claude" else "codex"
        if mode=="codex-exited": event["exitCode"]=int(sys.argv[2])
        elif len(sys.argv)>2 and sys.argv[2]: event["command"]=sys.argv[2][:24]
    if event.get("agent")=="claude":
        home=os.path.expanduser("~")
        event["accountRoute"]={"home":home,"configDir":os.environ.get("CLAUDE_CONFIG_DIR") or None,
            "secureDir":(os.environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR") or os.path.join(home,".claude")) if "CLAUDE_SECURESTORAGE_CONFIG_DIR" in os.environ else None,
            "overridden":any(name.upper() in CLAUDE_ROUTE_ENV for name in os.environ)}
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(5 if mode == "codex-started" else 2)
        client.connect(os.environ["AGENTRIX_SOCKET"])
        client.sendall((json.dumps(event)+"\n").encode())
        if mode == "codex-started": client.recv(1)
except Exception: pass
'''

BASH_SOURCE = r'''if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
cd -- "$AGENTRIX_ROOT" || exit 1
__pg_note=$AGENTRIX_READING_NOTE; unset AGENTRIX_READING_NOTE
__pg_note_file=$AGENTRIX_READING_NOTE_FILE; unset AGENTRIX_READING_NOTE_FILE
__pg_reading_note() { if [ -r "$__pg_note_file" ]; then cat -- "$__pg_note_file"; else printf '%s' "$__pg_note"; fi; }
unalias codex 2>/dev/null || true
unalias claude 2>/dev/null || true
__pg_emit() { "$AGENTRIX_PYTHON" "$AGENTRIX_NOTIFY_FILE" "$@" >/dev/null 2>&1; }
# The first word given to an agent when it is a subcommand or an option (update, --version): Agentrix tells such a run
# from a conversation by it. Anything else is not sent.
__pg_command() { local pattern='^-{0,2}[A-Za-z][A-Za-z-]{0,23}$'; [[ ${1-} =~ $pattern ]] && printf '%s' "$1"; return 0; }
function codex {
    local executable result
    executable=$(type -P codex)
    if [ -z "$executable" ]; then printf 'Codex CLI was not found on this SSH host.\n'; return 127; fi
    __pg_emit codex-started "$(__pg_command "$@")"
    # What the reading view can show (electron/features/agents/reading-note.cjs); the user's own -c comes later and wins.
    local -a note=()
    local current_note=$(__pg_reading_note)
    [ -n "$current_note" ] && note=(-c "developer_instructions=\"$current_note\"")
    "$executable" -c "notify=$AGENTRIX_NOTIFY_COMMAND" -c 'tui.terminal_title=["session-id"]' "${note[@]}" "$@"
    result=$?
    __pg_emit codex-exited "$result"
    return "$result"
}
function claude {
    local executable result settings
    executable=$(type -P claude)
    if [ -z "$executable" ]; then printf 'Claude Code CLI was not found on this SSH host.\n'; return 127; fi
    __pg_emit codex-started "$(__pg_command "$@")" claude
    # Claude runs hooks with sh, so quote each argument for that shell, including paths with spaces.
    settings=$("$AGENTRIX_PYTHON" - "$AGENTRIX_NOTIFY_FILE" <<'PY'
import json,shlex,sys
command=" ".join(shlex.quote(word) for word in (sys.executable,sys.argv[1],"claude-hook"))
hooks={name:[{"hooks":[{"type":"command","command":command+" "+kind}]}] for name,kind in
       (("UserPromptSubmit","start"),("Stop","stop"),("Notification","notify"),("SessionStart","session"))}
print(json.dumps({"hooks":hooks}))
PY
    )
    local -a note=()
    local current_note=$(__pg_reading_note)
    if [[ $current_note == *" Agentrix skill delivery: "* ]]; then
        current_note="${current_note%%" Agentrix skill delivery: "*} Agentrix delivers skill instructions through its SessionStart hook."
    fi
    [[ -n $current_note ]] && note=(--append-system-prompt "$current_note")
    AGENTRIX_READING_NOTE_FILE="$__pg_note_file" "$executable" --settings "$settings" "${note[@]}" "$@"
    result=$?
    __pg_emit codex-exited "$result" claude
    return "$result"
}
__pg_prompt() {
    local result=$? available=0 claude_available=0
    if type -P codex >/dev/null; then available=1; fi
    if type -P claude >/dev/null; then claude_available=1; fi
    __pg_emit shell-prompt "$available" "$claude_available"
    return "$result"
}
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
    PROMPT_COMMAND=(__pg_prompt "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__pg_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
# Keep Shift+Enter as an inserted newline at the Bash prompt as well as in
# TUIs such as Codex. These bindings are private to this generated shell rc.
bind -m emacs-standard '"\e[13;2u":"\C-v\C-j"' 2>/dev/null || true
bind -m vi-insertion '"\e[13;2u":"\C-v\C-j"' 2>/dev/null || true
printf '\033[36m  AGENTRIX / SSH\033[0m\n  Type codex or claude to start, codex resume or claude --resume to continue.\n\n'
'''

def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if data.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data.startswith(b"BM"): return "image/bmp"
    if data.startswith(b"\0\0\1\0"): return "image/x-icon"
    if data[4:8] == b"ftyp" and (b"avif" in data[8:] or b"avis" in data[8:]): return "image/avif"
    return None

HISTORY_WINDOW = 8 * 1024 * 1024
LIVE_READ_LIMIT = 4 * 1024 * 1024

def transcript_window(size):
    offset = max(0, size - HISTORY_WINDOW)
    return offset, offset > 0

def json_records(filename, history_window=False):
    """Skip oversized transcript messages; lifecycle events remain small."""
    with open(filename, "rb") as source:
        if history_window:
            offset, skipping = transcript_window(os.fstat(source.fileno()).st_size)
            source.seek(offset)
            if skipping:
                line = source.readline(1024 * 1024 + 1)
                while line and not line.endswith(b"\n"): line = source.readline(1024 * 1024 + 1)
        while True:
            line = source.readline(1024 * 1024 + 1)
            if not line: break
            if len(line) > 1024 * 1024:
                while line and not line.endswith(b"\n"): line = source.readline(1024 * 1024 + 1)
                continue
            try: yield json.loads(line)
            except (ValueError, UnicodeError): continue

def first_record(filename):
    records = json_records(filename)
    try: return next(records, {})
    finally: records.close()

def rollout_files(home, thread_id=None):
    for folder, dirs, entries in os.walk(os.path.join(home, "sessions")):
        dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(folder, name))]
        for name in entries:
            if not (name.startswith("rollout-") and name.endswith(".jsonl")): continue
            if thread_id and thread_id.lower() not in name.lower(): continue
            filename = os.path.join(folder, name)
            try: yield os.stat(filename).st_mtime, filename
            except OSError: pass

def prompt_provenance(record):
    kept = {key: record[key] for key in ("isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "queueTranscriptOnly", "promptSource", "turnOrigin", "humanTurn", "commandMode") if key in record}
    if isinstance(record.get("origin"), dict) and isinstance(record["origin"].get("kind"), str):
        kept["origin"] = {"kind": record["origin"]["kind"]}
    return kept


def compact_claude_record(record):
    """The messages, tool calls, results and settings the other computer needs, with the model route, context and token
    usage kept for the activity pane. Pictures and outputs stay here."""
    if not isinstance(record, dict) or record.get("isSidechain"): return None
    if record.get("type") == "system" and record.get("subtype") == "stop_hook_summary":
        return {key: record[key] for key in ("type", "subtype", "timestamp", "uuid") if key in record}
    provenance = prompt_provenance(record)
    # A message Claude queued while it worked, and when it took it up: the reading view marks the message as waiting.
    if record.get("type") == "queue-operation":
        kept = {**provenance, **{key: record.get(key) for key in ("type", "operation", "timestamp", "reason") if isinstance(record.get(key), str)}}
        if isinstance(record.get("content"), str): kept["content"] = clip(record["content"])
        elif isinstance(record.get("content"), list): kept["content"] = [{"type": "text", "text": clip(block["text"])} for block in record["content"] if isinstance(block, dict) and isinstance(block.get("text"), str)]
        return kept
    if record.get("type") == "attachment":
        attachment = record.get("attachment") or {}
        if not isinstance(attachment, dict) or attachment.get("type") != "queued_command" or attachment.get("commandMode") == "bash": return None
        prompt = attachment.get("prompt")
        if isinstance(prompt, list): prompt = [{"type": "text", "text": clip(block.get("text"))} for block in prompt if isinstance(block, dict) and block.get("type") == "text"]
        return {**provenance, "type": "attachment", "uuid": record.get("uuid"), "timestamp": record.get("timestamp"),
                "attachment": {**prompt_provenance(attachment), "type": "queued_command", "commandMode": attachment.get("commandMode"), "prompt": clip(prompt)}}
    if record.get("type") not in ("user", "assistant"): return None
    message = record.get("message") if isinstance(record.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str): parts = clip(content)
    elif isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict): continue
            kind = block.get("type")
            if kind == "text": parts.append({"type": "text", "text": clip(block.get("text"))})
            elif kind == "tool_use":
                arguments = block.get("input") if isinstance(block.get("input"), dict) else {}
                parts.append({"type": "tool_use", "id": block.get("id"), "name": block.get("name"),
                              "input": {key: clip(value, 600) for key, value in arguments.items() if isinstance(value, (str, int, float, bool))}})
            elif kind == "tool_result": parts.append({"type": "tool_result", "tool_use_id": block.get("tool_use_id"), "is_error": bool(block.get("is_error")), "content": ""})
    else: return None
    kept = {**provenance, **{key: record.get(key) for key in ("type", "uuid", "parentUuid", "timestamp", "cwd", "sessionId", "effort", "perTurnEffort", "isApiErrorMessage") if key in record}}
    kept["message"] = {"role": message.get("role"), "content": parts}
    if "stop_reason" in message: kept["message"]["stop_reason"] = message["stop_reason"]
    result = record.get("toolUseResult")
    if isinstance(result, dict):
        work = {key: result[key] for key in ("backgroundTaskId", "agentId", "isAsync", "status") if key in result}
        if isinstance(result.get("task"), dict): work["task"] = {key: result["task"][key] for key in ("task_id", "status") if key in result["task"]}
        if work: kept["toolUseResult"] = work
    if isinstance(message.get("model"), str): kept["message"]["model"] = message["model"]
    if isinstance(message.get("id"), str): kept["message"]["id"] = message["id"]
    usage = message.get("usage") or {}
    if isinstance(usage, dict):
        numbers = {key: usage[key] for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens") if type(usage.get(key)) is int}
        if isinstance(usage.get("speed"), str): numbers["speed"] = usage["speed"]
        if numbers: kept["message"]["usage"] = numbers
    return kept

def history_records(root, codex_home, claude_home, per_agent=4, budget=1200 * 1024):
    """The folder's latest conversations with Codex and Claude Code, compacted, for the development memory kept on the
    other computer (electron/features/agents/project-memory.cjs): the newest first, each from the end of its file."""
    found, size = {"codex": [], "claude": []}, 0
    rollouts = list(rollout_files(codex_home))
    claude_folder = os.path.join(claude_home, "projects", re.sub(r"[^A-Za-z0-9]", "-", root))
    transcripts = []
    try:
        for name in os.listdir(claude_folder):
            if name.endswith(".jsonl"):
                try: transcripts.append((os.stat(os.path.join(claude_folder, name)).st_mtime, os.path.join(claude_folder, name)))
                except OSError: pass
    except OSError: pass
    def take(agent, filename, identity, compact):
        nonlocal size
        records = []
        try:
            for record in json_records(filename, history_window=True):
                kept = compact(record)
                if kept is None: continue
                if agent == "codex" and kept.get("type") == "event_msg" and kept["payload"].get("type") == "token_count": continue
                if kept.get("type") == "queue-operation": continue
                records.append(kept)
        except (OSError, ValueError): return
        while records and size + len(json.dumps(records, ensure_ascii=True)) > budget: records = records[len(records) // 4 + 1:]
        if records:
            size += len(json.dumps(records, ensure_ascii=True))
            found[agent].append({"id": identity, "records": records})
    for _, filename in sorted(rollouts, reverse=True)[:3000]:
        if len(found["codex"]) >= per_agent or size >= budget: break
        try: first = first_record(filename)
        except (OSError, ValueError): continue
        meta = first.get("payload", {}) if first.get("type") == "session_meta" else {}
        if meta.get("source", "cli") not in ("cli", "vscode") or os.path.realpath(meta.get("cwd", "")) != os.path.realpath(root): continue
        take("codex", filename, meta.get("id", ""), compact_record)
    for _, filename in sorted(transcripts, reverse=True)[:per_agent]:
        if size >= budget: break
        take("claude", filename, os.path.basename(filename)[:-6], compact_claude_record)
    return found

def recent_session(root, codex_home, thread_id=None):
    for modified, filename in sorted(rollout_files(codex_home), reverse=True):
        try:
            meta = first_record(filename)
            payload = meta.get("payload", {})
            source = payload.get("source", "cli")
            if meta.get("type") != "session_meta" or source not in ("cli", "vscode") or os.path.realpath(payload.get("cwd", "")) != root: continue
            identity = payload.get("id", "")
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", identity): continue
            if thread_id and identity != thread_id: continue
            state = "unknown"
            for record in json_records(filename, history_window=True):
                item = record.get("payload", {})
                if record.get("type") == "event_msg":
                    event = item.get("type")
                    if event in ("task_started", "turn_started", "user_message"): state = "interrupted"
                    elif event in ("task_complete", "turn_completed"): state = "complete"
                    elif event in ("turn_aborted", "turn_interrupted"): state = "interrupted"
                elif record.get("type") == "response_item" and item.get("type") == "message":
                    if item.get("role") == "user": state = "interrupted"
                    elif item.get("role") == "assistant" and item.get("phase") == "final": state = "complete"
            return {"id": identity, "state": state, "modifiedAt": int(modified * 1000)}
        except (OSError, ValueError, TypeError): continue
    return None

CONVERSATION_EVENTS = ("item_completed", "user_message", "agent_message", "task_started", "turn_started", "task_complete", "turn_completed", "turn_aborted", "turn_interrupted")
TOOL_CALLS = ("custom_tool_call", "function_call", "local_shell_call")
TOOL_OUTPUTS = ("custom_tool_call_output", "function_call_output", "local_shell_call_output")
RECORD_TEXT_LIMIT, RECORDS_BUDGET = 64 * 1024, 1024 * 1024

def record_time(text):
    """A rollout timestamp ("2026-10-12T05:56:02.121Z") in milliseconds, 0 when unreadable. Python 3.6 has no
    datetime.fromisoformat, so the UTC time is read field by field."""
    match = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$", text or "")
    if not match: return 0
    try:
        seconds = calendar.timegm(tuple(int(part) for part in match.groups()[:6]) + (0, 0, 0))
        zone = match.group(8) or "Z"
        if zone != "Z":
            sign, hours, minutes = (1 if zone[0] == "+" else -1), int(zone[1:3]), int(zone[-2:])
            seconds -= sign * (hours * 3600 + minutes * 60)
        return int(seconds * 1000 + int((match.group(7) or "0")[:3].ljust(3, "0")))
    except (ValueError, OverflowError): return 0

def clip(value, limit=RECORD_TEXT_LIMIT):
    return value[:limit] if isinstance(value, str) else value

def completion_output(value):
    """Keep task/session identities and terminal statuses, never command output or worker replies."""
    texts = [value] if isinstance(value, str) else [part.get("text", "") for part in value or [] if isinstance(part, dict)]
    kept = []
    for text in texts:
        for line in text.splitlines():
            if re.fullmatch(r"Script running with cell ID [\w-]+|Process running with session ID \d+|Session ID: \d+|Process exited with code -?\d+", line):
                kept.append(line)
            try: item = json.loads(line)
            except (ValueError, TypeError): continue
            if not isinstance(item, dict): continue
            fields = {key: item[key] for key in ("agent_id", "task_name", "session_id", "exit_code") if isinstance(item.get(key), (str, int))}
            if isinstance(item.get("agents"), list):
                fields["agents"] = []
                for entry in item["agents"]:
                    if not isinstance(entry, dict): continue
                    status = entry.get("agent_status")
                    if isinstance(status, dict): status = {key: True for key in status}
                    fields["agents"].append({"agent_name": entry.get("agent_name"), "agent_status": status})
            if isinstance(item.get("status"), dict):
                fields["status"] = {key: {status: True for status in state if status in ("completed", "complete", "failed", "killed", "stopped", "errored", "shutdown", "idle", "not_found")} for key, state in item["status"].items() if isinstance(state, dict)}
            if fields: kept.append(json.dumps(fields))
    return "\n".join(kept)

def compact_record(record):
    """What the reading view and the activity pane on the other computer take from one rollout record, small: the
    conversation's messages, the tools called and which call finished. The model route, context and token usage are
    kept for the activity pane. Outputs, reasoning and instructions stay here."""
    kind, payload, at = record.get("type"), record.get("payload") or {}, record.get("timestamp")
    if kind == "session_meta":
        kept = {"id": payload.get("id"), "cwd": payload.get("cwd"), "source": payload.get("source")}
        if isinstance(payload.get("model_provider"), str): kept["model_provider"] = payload["model_provider"]
        return {"type": kind, "timestamp": at, "payload": kept}
    # A turn's model and effort, and the settings applied (fast mode is the "priority" tier), for the reading view.
    if kind == "turn_context":
        kept = {"cwd": payload.get("cwd")}
        kept.update((key, payload.get(key)) for key in ("model", "effort") if isinstance(payload.get(key), str))
        return {"type": kind, "timestamp": at, "payload": kept}
    if kind == "event_msg" and payload.get("type") == "thread_settings_applied":
        settings = payload.get("thread_settings") if isinstance(payload.get("thread_settings"), dict) else {}
        return {"type": kind, "timestamp": at, "payload": {"type": "thread_settings_applied", "thread_settings": dict((key, settings.get(key)) for key in ("model", "reasoning_effort", "service_tier") if key in settings)}}
    if kind == "event_msg" and payload.get("type") == "token_count":
        info = payload.get("info")
        kept = {"type": "token_count", "info": None}
        if isinstance(info, dict):
            context = {}
            for key in ("total_token_usage", "last_token_usage"):
                usage = info.get(key)
                if isinstance(usage, dict):
                    context[key] = {name: usage[name] for name in ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens") if type(usage.get(name)) is int}
            if type(info.get("model_context_window")) is int: context["model_context_window"] = info["model_context_window"]
            kept["info"] = context
        limits = payload.get("rate_limits")
        if isinstance(limits, dict):
            windows = {}
            for key in ("primary", "secondary"):
                window = limits.get(key)
                windows[key] = None
                if isinstance(window, dict):
                    windows[key] = {name: window[name] for name in ("used_percent", "window_minutes", "resets_at") if type(window.get(name)) in ((int, float) if name == "used_percent" else (int,))}
            kept["rate_limits"] = windows
        return {"type": kind, "timestamp": at, "payload": kept}
    if kind == "event_msg" and payload.get("type") in CONVERSATION_EVENTS:
        item = payload.get("item")
        if payload.get("type") == "item_completed":
            if not isinstance(item, dict) or item.get("type") not in ("UserMessage", "AgentMessage"): return None
            content = [{"type": "text", "text": clip(part.get("text"))} for part in item.get("content") or [] if isinstance(part, dict) and isinstance(part.get("text"), str)]
            return {"type": kind, "timestamp": at, "payload": {"type": "item_completed", "item": {"type": item.get("type"), "id": item.get("id"), "content": content}}}
        return {"type": kind, "timestamp": at, "payload": {key: clip(value) for key, value in payload.items() if key in ("type", "turn_id", "message")}}
    if kind == "response_item" and payload.get("type") == "agent_message":
        content = payload.get("content")
        body = content if isinstance(content, str) else "\n".join(part.get("text", "") for part in content or [] if isinstance(part, dict))
        if not re.search(r"^Message Type: FINAL_ANSWER\s*$", body, re.M): return None
        return {"type": kind, "timestamp": at, "payload": {"type": "agent_message", "author": payload.get("author"), "content": "\n".join(body.splitlines()[:3])}}
    if kind == "response_item" and payload.get("type") in TOOL_OUTPUTS:
        kept = {"type": payload.get("type"), "call_id": payload.get("call_id")}
        work = completion_output(payload.get("output"))
        if work: kept["output"] = work
        return {"type": kind, "timestamp": at, "payload": kept}
    if kind == "response_item" and payload.get("type") in TOOL_CALLS:
        return {"type": kind, "timestamp": at, "payload": {key: clip(value) for key, value in payload.items() if key in ("type", "name", "call_id", "id", "input", "arguments", "action")}}
    return None

def take_records(reader):
    """The records waiting, up to a budget per answer; the rest go with the next one."""
    batch, size = [], 0
    while reader.outbox and (not batch or size + len(json.dumps(reader.outbox[0], ensure_ascii=True)) <= RECORDS_BUDGET):
        record = reader.outbox.pop(0); size += len(json.dumps(record, ensure_ascii=True)); batch.append(record)
    reset, reader.reset = reader.reset, False
    result = {"records": batch, "reset": reset, "historyDone": bool(reader.filename) and not reader.history_pending and not reader.outbox}
    if getattr(getattr(reader, "work_history", None), "uncertain", False): result["completionUncertain"] = True
    return result

def read_transcript(reader, source, size, receive):
    source.seek(reader.offset)
    end = size if reader.history_pending else min(size, reader.offset + LIVE_READ_LIMIT)
    while reader.offset < end:
        chunk = source.read(min(65536, end - reader.offset))
        if not chunk: break
        reader.offset += len(chunk)
        reader.buffer += chunk
        while b"\n" in reader.buffer:
            line, reader.buffer = reader.buffer.split(b"\n", 1)
            if not reader.skipping and len(line) <= 1024 * 1024:
                try: receive(json.loads(line))
                except (ValueError, UnicodeError, TypeError): pass
            reader.skipping = False
        if len(reader.buffer) > 1024 * 1024: reader.buffer, reader.skipping = b"", True
    if reader.offset >= size: reader.history_pending = False

class CompletionHistory:
    def __init__(self, end):
        self.end, self.offset, self.buffer = end, 0, b""
        self.done, self.skipping, self.uncertain = not end, False, False

    def read(self, source, receive):
        source.seek(self.offset)
        limit = self.offset + LIVE_READ_LIMIT
        while not self.done and self.offset < limit:
            chunk = source.read(min(65536, limit - self.offset))
            if not chunk: return False
            self.offset += len(chunk); self.buffer += chunk
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if not self.skipping:
                    try: receive(json.loads(line))
                    except (ValueError, UnicodeError, TypeError): self.uncertain = True
                self.skipping = False
                if self.offset - len(self.buffer) > self.end:
                    self.done = True; break
            if len(self.buffer) > 16 * 1024 * 1024:
                self.buffer, self.skipping, self.uncertain = b"", True, True
        return self.done

class ClaudeTranscriptReader:
    """Follow the transcript named by Claude's hooks, with bounded history and the same response budget as Codex."""
    def __init__(self, filename, since):
        self.filename, self.since = filename, since
        self.offset, self.buffer, self.skipping = 0, b"", False
        self.file_identity, self.file_size, self.history_pending = None, 0, True
        self.outbox, self.reset = [], True

    def record(self, record, work_only=False):
        kept = compact_claude_record(record)
        if kept is not None:
            if work_only: kept["workOnly"] = True
            self.outbox.append(kept)

    def read(self):
        try: source = open(self.filename, "rb")
        except FileNotFoundError: return
        with source:
            info = os.fstat(source.fileno())
            size, identity = info.st_size, (info.st_dev, info.st_ino)
            if self.file_identity != identity or size < self.file_size:
                self.offset, self.skipping = transcript_window(size)
                self.work_history = CompletionHistory(self.offset)
                self.buffer, self.history_pending = b"", True
                self.outbox, self.reset = [], True
            self.file_identity, self.file_size = identity, size
            if not self.work_history.read(source, lambda record: self.record(record, True)): return
            read_transcript(self, source, size, self.record)

    def take(self): return take_records(self)

class CodexActivityReader:
    """Incrementally read the interactive parent's records: its lifecycle, and (compacted) what the reading view shows."""
    def __init__(self, root, home, since, thread_id=None):
        self.root, self.home, self.since = root, home, since
        self.thread_id = thread_id
        self.filename, self.snapshot = None, None
        self.offset, self.buffer, self.skipping, self.next_discovery = 0, b"", False, 0
        self.file_identity, self.file_size, self.history_pending = None, 0, True
        # Records for the other computer, and whether its conversation starts over (a new file, or the file replaced).
        self.outbox, self.reset = [], False

    def take(self):
        return take_records(self)

    def discover(self):
        if time.monotonic() < self.next_discovery: return
        self.next_discovery = time.monotonic() + 2
        candidates = []
        for modified, filename in rollout_files(self.home, self.thread_id):
            modified *= 1000
            if self.thread_id or modified >= self.since - 2000: candidates.append((modified, filename))
        for _, filename in sorted(candidates, reverse=True):
            if filename == self.filename: return
            try:
                record = first_record(filename)
                meta = record.get("payload", {})
                if record.get("type") != "session_meta" or meta.get("source", "cli") not in ("cli", "vscode"): continue
                if os.path.realpath(meta.get("cwd", "")) != os.path.realpath(self.root) or not re.fullmatch(r"[a-fA-F0-9-]{36}", meta.get("id", "")): continue
                # The id the terminal title showed may be cut short (Codex caps its title): it is how the id begins.
                if self.thread_id and not meta.get("id", "").lower().startswith(self.thread_id.lower()): continue
                self.filename = filename
                self.file_identity, self.history_pending = None, True
                self.snapshot = {"threadId": meta["id"], "turnId": None, "state": "unknown", "updatedAt": 0}
                self.outbox, self.reset = [], True
                return
            except (OSError, ValueError, TypeError): pass

    def record(self, record, work_only=False):
        compact = compact_record(record)
        if compact is not None:
            if work_only: compact["workOnly"] = True
            self.outbox.append(compact)
            if len(self.outbox) > 20000:
                del self.outbox[:len(self.outbox) - 20000]
                if getattr(self, "work_history", None): self.work_history.uncertain = True
        if work_only or record.get("type") != "event_msg": return
        item = record.get("payload", {})
        kind, turn = item.get("type"), item.get("turn_id")
        updated = record_time(record.get("timestamp"))
        if kind in ("task_started", "turn_started") and isinstance(turn, str) and turn:
            self.snapshot.update(turnId=turn, state="working", updatedAt=updated)
        elif kind in ("task_complete", "turn_completed", "turn_aborted", "turn_interrupted"):
            if not self.snapshot["turnId"] or turn and turn != self.snapshot["turnId"]: return
            self.snapshot.update(state="complete" if kind in ("task_complete", "turn_completed") else "interrupted", updatedAt=updated)

    def read(self):
        if not self.filename or self.snapshot["state"] != "working": self.discover()
        if not self.filename: return None
        with open(self.filename, "rb") as source:
            stat = os.fstat(source.fileno())
            size, identity = stat.st_size, (stat.st_dev, stat.st_ino)
            if self.file_identity != identity or size < self.file_size:
                self.offset, self.skipping = transcript_window(size)
                self.work_history = CompletionHistory(self.offset)
                self.buffer, self.history_pending = b"", True
                self.snapshot.update(turnId=None, state="unknown", updatedAt=0)
                self.outbox, self.reset = [], True
            self.file_identity, self.file_size = identity, size
            if not self.work_history.read(source, lambda record: self.record(record, True)): return None
            read_transcript(self, source, size, self.record)
            return dict(self.snapshot) if self.offset >= size else None

class Worker:
    def __init__(self, emit, accounts=None):
        self.emit = emit
        self.root = None
        self.temp = None
        self.skills_bundle = None
        self.dispatch_source = None
        self.dispatch_note = None
        self.skill_paths = {}
        self.skill_state_dir = None
        self.skill_note_ready = threading.Event()
        self.skill_note_sequence = None
        self.master = None
        self.child = None
        self.stopping = False
        self.sequence = 0
        self.sequence_lock = threading.Lock()
        self.codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
        self.claude_home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
        self.claude_route = None
        self.claude_accounts = accounts or RemoteClaudeAccounts()
        self.uploads = {}
        self.activity_reader = None
        self.claude_reader = None
        self.activity_lock = threading.Lock()
        # Its channel opens in a thread of its own (main): a shutdown that arrives meanwhile waits for the shell.
        self.lock = threading.RLock()

    def codex_status(self, since, thread_id=None):
        if not isinstance(since, (int, float)) or since <= 0: raise ValueError("无效的会话时间。")
        with self.activity_lock:
            if thread_id is not None and not re.fullmatch(r"[a-fA-F0-9]{8}-[a-fA-F0-9-]{8,27}", thread_id): raise ValueError("无效的会话标识。")
            if self.activity_reader is None or self.activity_reader.since != since or self.activity_reader.thread_id != thread_id:
                self.activity_reader = CodexActivityReader(self.coding_root, self.codex_home, since, thread_id)
            # The lifecycle snapshot (None while history is still being read), with the conversation's records.
            snapshot = self.activity_reader.read()
            return {"snapshot": snapshot, **self.activity_reader.take()}

    def claude_status(self, path, since):
        if not isinstance(path, str) or not os.path.isabs(path) or len(path) > 4096 or "\0" in path: raise ValueError("Invalid Claude transcript path.")
        if not isinstance(since, (int, float)) or since <= 0: raise ValueError("Invalid session time.")
        projects = os.path.realpath(os.path.join(self.claude_home, "projects"))
        filename = os.path.realpath(path)
        if filename == projects or os.path.commonpath([projects, filename]) != projects: raise ValueError("Claude transcript lies outside the projects folder.")
        with self.activity_lock:
            if self.claude_reader is None or self.claude_reader.filename != filename or self.claude_reader.since != since:
                self.claude_reader = ClaudeTranscriptReader(filename, since)
            self.claude_reader.read()
            return self.claude_reader.take()

    def claude_account(self):
        route = self.claude_route
        if self.stopping: return {"state": "skipped", "reason": "cancelled"}
        result = self.claude_accounts.read(route, self.coding_root)
        return result if not self.stopping and route is self.claude_route else {"state": "skipped", "reason": "cancelled"}

    def initialize(self, config):
        self.root = os.path.realpath(os.path.expanduser(config["path"]))
        if not os.path.isdir(self.root): raise ValueError("远程项目目录不存在或不是文件夹。")
        self.coding_root = os.path.realpath(os.path.expanduser(config.get("codingPath") or self.root))
        if not os.path.isdir(self.coding_root): raise ValueError("上次工作的远程目录已不存在。")
        self.token = config["token"]
        self.project_id = config["projectId"]
        self.skills_bundle = config.get("skills")
        self.dispatch_source = config.get("dispatchHelper")
        self.dispatch_modules = config.get("dispatchModules", {})
        branch = ""
        try:
            # rev-parse names the branch on every Git; branch --show-current needs 2.22 and -C needs 1.8.5.
            result = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=3)
            if result.returncode == 0 and result.stdout.strip() != "HEAD": branch = result.stdout.strip()[:120]
        except (OSError, subprocess.TimeoutExpired): pass
        return {"root": self.root, "branch": branch, "platform": sys.platform}

    def resolve(self, relative=""):
        if not isinstance(relative, str) or len(relative) > 4096 or "\0" in relative or "\\" in relative or os.path.isabs(relative) or ".." in relative.split("/"): raise ValueError("无效的远程文件路径。")
        filename = os.path.realpath(os.path.join(self.root, relative))
        if os.path.commonpath([self.root, filename]) != self.root: raise ValueError("该链接指向远程项目目录之外。")
        return filename

    def metadata(self, relative):
        filename = self.resolve(relative)
        info = os.stat(filename)
        return {"path": relative, "name": os.path.basename(filename), "size": info.st_size, "modifiedAt": int(info.st_mtime * 1000), "realPath": os.path.relpath(filename, self.root).replace(os.sep, "/"), "directory": stat.S_ISDIR(info.st_mode), "file": stat.S_ISREG(info.st_mode), "link": os.path.islink(os.path.join(self.root, relative))}

    def git_version(self):
        """Git's version as (major, minor, patch); None when it cannot be told. Asked once."""
        if not hasattr(self, "_git_version"):
            try:
                found = subprocess.run(["git", "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=3).stdout
                parts = [int(part) for part in re.findall(r"\d+", found)[:3]]
                self._git_version = tuple(parts + [0] * (3 - len(parts))) if len(parts) >= 2 else None
            except (OSError, ValueError, subprocess.TimeoutExpired): self._git_version = None
        return self._git_version

    def no_relative(self):
        """--no-relative keeps paths from the top of the repository despite diff.relative; both came in Git 2.28, so
        older Git neither needs nor knows it."""
        version = self.git_version()
        return [] if version and version < (2, 28) else ["--no-relative"]

    def git(self, action, value=None):
        if action not in ("status", "history", "files", "diff", "apply"): raise ValueError("无效的 Git 请求。")
        # The Git panel reads porcelain v2 status (Git 2.11) and ISO dates (2.2). An older Git, such as CentOS 7's
        # 1.8.3, is named instead of failing on an option it does not know.
        version = self.git_version()
        if version and version < (2, 11): raise ValueError("远程 Git 版本 %s 太旧，Git 面板需要 2.11 或更高版本。" % ".".join(str(part) for part in version))
        if action == "history" and (type(value) is not int or not 0 <= value <= 100000): raise ValueError("无效的历史页码。")
        if action == "files" and (not isinstance(value, str) or not re.fullmatch(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})", value)): raise ValueError("无效的提交标识。")
        if action == "diff":
            target = value.get("path") if isinstance(value, dict) else None
            if not isinstance(target, str) or not target or len(target) > 4096 or "\0" in target or "\\" in target or target.startswith("/") or ".." in target.split("/"): raise ValueError("无效的文件路径。")
        if action == "apply" and (not isinstance(value, dict) or not isinstance(value.get("patch"), str) or not value["patch"] or len(value["patch"]) > 1024 * 1024): raise ValueError("无效的补丁。")
        env = {key: val for key, val in os.environ.items() if key.upper() not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")}
        env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", LC_ALL="C")
        # text: a patch for git's standard input. ok: exit codes whose output is still wanted.
        # cwd: the folder git runs in (given this way, not as -C, which CentOS 7's git 1.8.3 does not know).
        def run(args, text=None, ok=(0,), cwd=None):
            # Spool subprocess output to temporary files so a large worktree does
            # not build an unbounded Python/JSON buffer. Both files close on error.
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
                try:
                    result = subprocess.run(["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "color.ui=false", "-c", "i18n.logOutputEncoding=UTF-8"] + args, cwd=cwd or self.root, stdout=output, stderr=error, env=env, timeout=8, input=None if text is None else text.encode("utf-8"))
                except FileNotFoundError: raise ValueError("远程主机未找到 Git。")
                except subprocess.TimeoutExpired: raise ValueError("远程 Git 读取超时，请稍后重试。")
                if output.tell() > 1024 * 1024: raise ValueError("Git 结果过大，请缩小项目范围后重试。")
                if result.returncode not in ok:
                    error.seek(0)
                    raise ValueError(error.read(2400).decode("utf-8", "replace").strip()[:600])
                output.seek(0)
                return output.read(1024 * 1024).decode("utf-8", "replace")
        try:
            prefix = re.sub(r"\r?\n$", "", run(["rev-parse", "--show-prefix"]))
            if action == "status": data = run(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=none", "--", "."])
            elif action == "history":
                try: data = run(["log", "--topo-order", "-z", "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s", "--max-count=41", "--skip=" + str(value)] + (["--full-history", "--", "."] if prefix else ["--"]))
                except ValueError as error:
                    # No commits yet: new Git says so, Git before 2.24 calls HEAD a bad revision.
                    if "does not have any commits yet" in str(error) or "bad default revision" in str(error): data = ""
                    else: raise
            elif action == "diff":
                options = ["--no-color", "--no-ext-diff", "--no-textconv"] + self.no_relative() + ["-U3"]
                if value.get("untracked") is True:
                    # Nothing in the index to compare with: against nothing, from the top of the repository
                    # so the header names the file the way every other patch does.
                    top = re.sub(r"\r?\n$", "", run(["rev-parse", "--show-toplevel"]))
                    data = run(["diff", "--no-index"] + options + ["--", "/dev/null", prefix + value["path"]], ok=(0, 1), cwd=top)
                else: data = run(["diff"] + (["--cached"] if value.get("staged") is True else []) + options + ["--", value["path"]])
            elif action == "apply":
                run(["apply"] + (["-R"] if value.get("reverse") is True else []) + (["--cached"] if value.get("cached") is True else []) + ["--whitespace=nowarn", "-"], text=value["patch"])
                data = ""
            else:
                parents = run(["show", "-s", "--format=%P", value + "^{commit}", "--"]).strip().split()
                args = ["diff"] + self.no_relative() + ["--name-status", "-z", "--no-ext-diff", "--no-textconv", "-M", parents[0], value, "--", "."] if parents else ["diff-tree", "--root"] + self.no_relative() + ["--no-commit-id", "-r", "--name-status", "-z", "--no-ext-diff", "--no-textconv", value, "--", "."]
                data = run(args)
            value = {"repository": True, "prefix": prefix, "output": data}
            if len(json.dumps(value, ensure_ascii=True)) > MAX_MESSAGE - 256: raise ValueError("Git 结果过大，请缩小项目范围后重试。")
            return value
        except ValueError as error:
            if "not a git repository" in str(error).lower() or "must be run in a work tree" in str(error).lower(): return {"repository": False, "prefix": "", "output": ""}
            raise

    def entry_path(self, relative):
        if not relative or relative == ".": raise ValueError("不能删除或重命名项目根目录。")
        self.resolve(os.path.dirname(relative))
        if not isinstance(relative, str) or "\0" in relative or "\\" in relative or os.path.isabs(relative) or ".." in relative.split("/"): raise ValueError("无效的文件路径。")
        parent = self.resolve(os.path.dirname(relative))
        return os.path.join(parent, os.path.basename(relative))

    def name(self, value):
        if not isinstance(value, str) or not value or len(value) > 255 or value in (".", "..") or any(ord(char) < 32 for char in value) or "/" in value or "\\" in value: raise ValueError("无效的文件名。")
        return value

    def unique_name(self, directory, name):
        stem, extension = os.path.splitext(name)
        for number in range(10000):
            candidate = name if number == 0 else "%s - 副本%s%s" % (stem, " (%s)" % number if number > 1 else "", extension)
            if not os.path.lexists(os.path.join(directory, candidate)): return candidate
        raise ValueError("同名文件过多。")

    def create(self, relative, name, kind, unique=False):
        parent = self.resolve(relative)
        if not os.path.isdir(parent): raise ValueError("请选择文件夹。")
        name = self.name(name)
        if unique: name = self.unique_name(parent, name)
        target = os.path.join(parent, name)
        if kind == "directory": os.mkdir(target)
        elif kind == "file":
            with open(target, "xb"): pass
        else: raise ValueError("无效的文件类型。")
        return {"path": "/".join(filter(None, [relative, name])), "kind": kind}

    def rename(self, relative, name):
        source = self.entry_path(relative)
        target = os.path.join(os.path.dirname(source), self.name(name))
        if source != target:
            if os.path.lexists(target): raise ValueError("已存在同名文件。")
            if os.path.islink(source) or not os.path.isdir(source):
                os.link(source, target, follow_symlinks=False)
                os.unlink(source)
            else: os.rename(source, target)
        return {"path": os.path.relpath(target, self.root).replace(os.sep, "/")}

    def remove(self, relative):
        filename = self.entry_path(relative)
        if os.path.islink(filename) or not os.path.isdir(filename): os.unlink(filename)
        else: shutil.rmtree(filename)
        return True

    def start_upload(self, relative, name, size):
        if type(size) is not int or size < 0 or size > 9007199254740991: raise ValueError("无效的文件大小。")
        parent = self.resolve(relative)
        name = self.unique_name(parent, self.name(name))
        descriptor, temporary = tempfile.mkstemp(prefix=".agentrix-upload-", dir=parent)
        identity = os.urandom(16).hex()
        self.uploads[identity] = {"file": os.fdopen(descriptor, "wb"), "temporary": temporary, "target": os.path.join(parent, name), "size": size, "written": 0}
        return {"id": identity}

    # A picture pasted for the agent here: the CLI on this machine cannot read the other computer's clipboard (no
    # display to reach), so the picture comes over as a file in this machine's temporary folder, and its absolute path
    # goes with the message for the agent to open. A week later the next one clears it away.
    def start_image(self, extension, size):
        if extension not in ("png", "jpg", "webp", "gif"): raise ValueError("只能附加 PNG、JPEG、WebP 或 GIF 图片。")
        if type(size) is not int or size <= 0 or size > 25 * 1024 * 1024: raise ValueError("图片太大（超过 25 MB），请压缩后再粘贴。")
        folder = os.path.join(tempfile.gettempdir(), "agentrix-images-" + str(os.getuid()))
        os.makedirs(folder, mode=0o700, exist_ok=True)
        if os.path.islink(folder) or os.stat(folder).st_uid != os.getuid(): raise ValueError("临时图片目录不安全。")
        cutoff = time.time() - 7 * 86400
        for name in os.listdir(folder):
            try:
                existing = os.path.join(folder, name)
                if os.lstat(existing).st_mtime < cutoff: os.unlink(existing)
            except OSError: pass
        target = os.path.join(folder, time.strftime("%Y%m%d-%H%M%S-") + os.urandom(4).hex() + "." + extension)
        descriptor, temporary = tempfile.mkstemp(prefix=".agentrix-upload-", dir=folder)
        identity = os.urandom(16).hex()
        self.uploads[identity] = {"file": os.fdopen(descriptor, "wb"), "temporary": temporary, "target": target, "size": size, "written": 0, "absolute": True}
        return {"id": identity}

    def upload_chunk(self, identity, offset, data):
        upload = self.uploads[identity]
        chunk = base64.b64decode(data, validate=True)
        if offset != upload["written"] or len(chunk) > MAX_READ or upload["written"] + len(chunk) > upload["size"]: raise ValueError("上传数据位置不正确。")
        upload["file"].write(chunk); upload["written"] += len(chunk)
        return True

    def finish_upload(self, identity):
        upload = self.uploads[identity]
        if upload["written"] != upload["size"]: raise ValueError("文件尚未完整上传。")
        upload["file"].flush(); os.fsync(upload["file"].fileno()); upload["file"].close()
        # A hard link installs a completed file atomically without overwriting
        # anything created by another process during the transfer.
        os.link(upload["temporary"], upload["target"])
        os.unlink(upload["temporary"]); del self.uploads[identity]
        if upload.get("absolute"): return {"path": upload["target"]}
        return {"path": os.path.relpath(upload["target"], self.root).replace(os.sep, "/")}

    def cancel_upload(self, identity):
        upload = self.uploads.pop(identity, None)
        if upload:
            upload["file"].close()
            try: os.unlink(upload["temporary"])
            except OSError: pass
        return True

    def directory(self, relative, offset):
        if type(offset) is not int or offset < 0: raise ValueError("无效的目录页码。")
        with os.scandir(self.resolve(relative)) as iterator:
            entries = [{"name": entry.name, "path": "/".join(filter(None, [relative, entry.name])), "kind": "link" if entry.is_symlink() else "directory" if entry.is_dir() else "file"} for entry in iterator]
        entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].casefold()))
        return {"path": relative, "entries": entries[offset:offset + 200], "total": len(entries), "nextOffset": offset + 200 if offset + 200 < len(entries) else None}

    def read(self, relative, offset, length):
        if type(offset) is not int or offset < 0 or type(length) is not int or not 0 <= length <= MAX_READ: raise ValueError("无效的文件读取范围。")
        filename = self.resolve(relative)
        with open(filename, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError("只能预览普通文件。")
            source.seek(offset)
            return base64.b64encode(source.read(length)).decode("ascii")

    def document(self, filename, length):
        """A Markdown file an agent wrote anywhere on this computer (its memory, a note in a temporary folder), for the
        reading view's card and popup on the other computer: only Markdown, only a regular file, at most 2 MB of it."""
        if not isinstance(filename, str) or not filename.startswith("/") or "\0" in filename or not filename.lower().endswith((".md", ".markdown", ".mdx")): raise ValueError("只能预览 Markdown 文件。")
        if type(length) is not int or length < 0: raise ValueError("无效的文件读取范围。")
        with open(filename, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode): raise ValueError("只能预览 Markdown 文件。")
            data = source.read(min(length, 2 * 1024 * 1024))
        return {"size": info.st_size, "modifiedAt": int(info.st_mtime * 1000), "data": base64.b64encode(data).decode("ascii")}

    def preview(self, relative, page_index):
        if type(page_index) is not int or page_index < 0: raise ValueError("无效的文件页码。")
        meta = self.metadata(relative)
        if not meta["file"]: raise ValueError("只能预览普通文件。")
        base = {key: meta[key] for key in ("path", "name", "size", "modifiedAt")}
        base["revision"] = self.file_revision(os.stat(self.resolve(relative)))
        extension = os.path.splitext(relative)[1].lower()
        with open(self.resolve(relative), "rb") as source:
            prefix = source.read(64)
            mime = image_type(prefix) or IMAGE_TYPES.get(extension)
            if mime: return dict(base, kind="image", mimeType=mime)
            if extension in VIDEO_TYPES: return dict(base, kind="video", mimeType=VIDEO_TYPES[extension])
            encoding, bom = "utf-8", 0
            if prefix.startswith(b"\xff\xfe"): encoding, bom = "utf-16le", 2
            elif prefix.startswith(b"\xfe\xff"): encoding, bom = "utf-16be", 2
            elif prefix.startswith(b"\xef\xbb\xbf"): bom = 3
            count = max(1, (meta["size"] - bom + PAGE_BYTES - 1) // PAGE_BYTES)
            index = min(page_index, count - 1)
            start = bom + index * PAGE_BYTES
            end = min(meta["size"], start + PAGE_BYTES)
            read_start = max(bom, start - 2)
            source.seek(read_start)
            data = source.read(max(0, min(meta["size"], end + 4) - read_start))
            # Match local paging: adjacent pages move past the same character or CRLF pair.
            def boundary(position):
                offset = max(0, min(len(data), position - read_start))
                if encoding == "utf-8":
                    while offset < len(data) and data[offset] & 0xc0 == 0x80: offset += 1
                    if 0 < offset < len(data) and data[offset - 1:offset + 1] == b"\r\n": offset += 1
                elif offset >= 2 and offset + 1 < len(data):
                    order = "little" if encoding == "utf-16le" else "big"
                    unit = int.from_bytes(data[offset:offset + 2], order)
                    previous = int.from_bytes(data[offset - 2:offset], order)
                    if 0xdc00 <= unit <= 0xdfff and 0xd800 <= previous <= 0xdbff: offset += 2
                    elif previous == 13 and unit == 10: offset += 2
                return offset
            byte_start, byte_end = boundary(start), boundary(end)
            page = data[byte_start:byte_end]
            if encoding == "utf-8" and b"\0" in page: return dict(base, kind="unsupported", reason="二进制文件不支持文本预览。")
            try: content = page.decode(encoding)
            except UnicodeError: return dict(base, kind="unsupported", reason="此文件的编码不支持预览。")
            return dict(base, kind="html" if extension in (".html", ".htm") else "markdown" if extension in (".md", ".markdown", ".mdown", ".mkd") else "text", content=content, page={"index": index, "count": count, "byteStart": read_start + byte_start, "byteEnd": read_start + byte_end, "encoding": encoding})

    @staticmethod
    def file_revision(info):
        return "%s:%s:%s:%s:%s" % (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def save_file(self, relative, page_index, revision, data):
        content_bytes = base64.b64decode(data, validate=True)
        if len(content_bytes) > 1024 * 1024: raise ValueError("本次编辑内容超过 1 MB，请分段保存。")
        content = content_bytes.decode("utf-8")
        preview = self.preview(relative, page_index)
        if preview["kind"] not in ("text", "html", "markdown"): raise ValueError("此文件不支持文本编辑。")
        if preview["revision"] != revision: raise ValueError("文件已被其他程序修改，请刷新后重新编辑，避免覆盖新内容。")
        filename = self.resolve(relative)
        temporary = None
        with open(filename, "r+b") as source:
            info, opened = os.stat(filename), os.fstat(source.fileno())
            if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino) or self.file_revision(info) != revision: raise ValueError("文件已变化，请刷新后重新编辑。")
            if "\r\n" in preview["content"]: content = re.sub(r"\r?\n", "\r\n", content)
            descriptor, temporary = tempfile.mkstemp(prefix=".agentrix-edit-", dir=os.path.dirname(filename))
            try:
                with os.fdopen(descriptor, "wb") as destination:
                    os.chmod(temporary, stat.S_IMODE(info.st_mode))
                    def copy_range(start, end):
                        source.seek(start)
                        remaining = end - start
                        while remaining:
                            chunk = source.read(min(65536, remaining))
                            if not chunk: raise ValueError("保存时文件发生变化，请刷新后重试。")
                            destination.write(chunk)
                            remaining -= len(chunk)
                    copy_range(0, preview["page"]["byteStart"])
                    destination.write(content.encode(preview["page"]["encoding"]))
                    copy_range(preview["page"]["byteEnd"], info.st_size)
                    destination.flush(); os.fsync(destination.fileno())
                source.close()
                if self.file_revision(os.stat(filename)) != revision: raise ValueError("文件已被其他程序修改，本次保存已取消。")
                os.replace(temporary, filename)
                temporary = None
            finally:
                if temporary and os.path.exists(temporary): os.unlink(temporary)
        return self.preview(relative, page_index)

    def handoff_path(self):
        """Where this terminal's handoff of the folder's earlier work lies on this computer: a private temporary folder."""
        name = re.sub(r"[^A-Za-z0-9-]", "", str(self.project_id or "terminal"))[:80] or "terminal"
        return os.path.join(tempfile.gettempdir(), "agentrix-handoff-" + str(os.getuid()), name + ".md")

    def write_handoff(self, text):
        """The handoff written for the CLI that starts here (the other computer keeps the memory); none when empty."""
        path = self.handoff_path()
        if not isinstance(text, str) or not text.strip():
            try: os.unlink(path)
            except OSError: pass
            return None
        folder = os.path.dirname(path)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        if os.path.islink(folder) or os.stat(folder).st_uid != os.getuid(): raise ValueError("交接目录不安全。")
        descriptor, temporary = tempfile.mkstemp(prefix=".handoff-", dir=folder)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output: output.write(text[:256 * 1024])
        os.replace(temporary, path)
        return path

    def install_skills(self, reading_note):
        """Private reference copies survive resume; project skills remain in the remote repository."""
        bundle = self.skills_bundle if self.skills_bundle is not None else {}
        if not isinstance(bundle, dict) or not isinstance(bundle.get("files", []), list): raise ValueError("Invalid remote skills bundle.")
        key = bundle.get("key") or hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key): raise ValueError("Invalid remote skills key.")
        folder = os.path.join(self.skill_state_dir, "references", key) if self.skill_state_dir else os.path.join(self.temp, "skills")
        os.makedirs(folder, mode=0o700, exist_ok=True)
        info = os.lstat(folder)
        if not stat.S_ISDIR(info.st_mode) or hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077): raise ValueError("Unsafe remote skill folder.")
        agents = "Installed agents: Claude Code %s; Codex %s." % tuple("installed" if shutil.which(name) else "missing" for name in ("claude", "codex"))
        def expand(text):
            return text.replace("{AGENTRIX_SKILLS}", folder.replace(os.sep, "/")).replace("{AGENTRIX_AGENTS}", agents)
        self.skill_paths = {}
        for skill in bundle.get("files", []):
            if not isinstance(skill, dict) or not isinstance(skill.get("id"), str) or skill.get("assets"): raise ValueError("Only remote SKILL.md text is supported.")
            name, scope, text = skill.get("name"), skill.get("scope"), skill.get("text")
            if not isinstance(name, str) or not re.fullmatch(r"[\w][\w.-]{0,119}", name) or name.endswith(".") or scope not in ("builtin", "global"):
                raise ValueError("Invalid remote skill.")
            if not isinstance(text, str) or len(text.encode("utf-8")) > 512 * 1024: raise ValueError("Remote skill is too large.")
            directory = os.path.join(folder, scope, name)
            os.makedirs(directory, mode=0o700, exist_ok=True)
            filename = os.path.join(directory, "SKILL.md")
            write_skill_reference(filename, text)
            self.skill_paths[skill["id"]] = filename.replace(os.sep, "/")
        os.makedirs(os.path.join(folder, "global"), mode=0o700, exist_ok=True)
        instructions = bundle.get("instructions", "")
        if not isinstance(instructions, str) or len(instructions.encode("utf-8")) > 2 * 1024 * 1024: raise ValueError("Remote skill manifest is too large.")
        write_skill_reference(os.path.join(folder, "instructions.md"), expand(instructions))
        with open(os.path.join(self.temp, "skill-key.txt"), "w", encoding="utf-8") as output: output.write(key)
        return expand(reading_note) if isinstance(reading_note, str) else ""

    def startup_note(self, reading_note):
        # Expand every placeholder before applying the shell's existing limit; long notes must not kill a channel.
        note = self.install_skills(reading_note).replace("{AGENTRIX_HANDOFF}", self.handoff_path())
        if "{AGENTRIX_DISPATCH_NOTE}" in note:
            note = note.replace("{AGENTRIX_DISPATCH_NOTE}", self.install_dispatch())
        return note[:8000] if not set('"\\\n\r') & set(note) else ""

    def install_dispatch(self):
        if self.dispatch_note is not None: return self.dispatch_note
        source = self.dispatch_source
        if not shutil.which("node") or not isinstance(source, str) or not source or len(source.encode("utf-8")) > 256 * 1024:
            self.dispatch_note = "Dispatch helper: unavailable over SSH (remote Node.js or helper missing); command-line workers run unseen in Agentrix."
            return self.dispatch_note
        filename = os.path.join(self.temp, "dispatch.cjs")
        modules = getattr(self, "dispatch_modules", {})
        if not isinstance(modules, dict) or len(modules) > 32 or any(
                not isinstance(name, str) or not re.fullmatch(r"[\w-]+(?:/[\w-]+)*\.cjs", name)
                or not isinstance(text, str) for name, text in modules.items()) or sum(
                len(text.encode("utf-8")) for text in modules.values()) > 256 * 1024:
            raise ValueError("Invalid dispatch modules.")
        for name, text in modules.items():
            target = os.path.join(self.temp, "electron", *name.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as output: output.write(text)
            os.chmod(target, 0o600)
        with open(filename, "w", encoding="utf-8") as output: output.write(source)
        os.chmod(filename, 0o600)
        bootstrap = os.path.join(self.temp, "dispatch.json")
        with open(bootstrap, "w", encoding="utf-8") as output:
            json.dump({"pipeName": os.path.join(self.temp, "events.sock"), "sessionKey": self.token, "projectId": self.project_id}, output)
        os.chmod(bootstrap, 0o600)
        self.dispatch_note = "Dispatch helper: node %s — start every command-line Codex or Claude worker through it (see the agent-dispatch rules)." % filename.replace(os.sep, "/")
        return self.dispatch_note

    def update_skill_note(self, sequence, note, bundle):
        if sequence != self.skill_note_sequence: raise ValueError("Agent launch changed.")
        try:
            self.skills_bundle = bundle
            text = self.startup_note(note)
            filename = os.path.join(self.temp, "skill-note.txt")
            with open(filename, "w", encoding="utf-8") as output: output.write(text)
            os.chmod(filename, 0o600)
            return self.skill_paths
        finally: self.skill_note_ready.set()

    def start_terminal(self, cols, rows, reading_note=""):
        with self.lock:
            if not self.stopping: self.spawn_terminal(cols, rows, reading_note)

    def spawn_terminal(self, cols, rows, reading_note):
        if os.name != "posix": raise ValueError("SSH 远端目前需要 Linux、Python 3 和 Bash。")
        import pty
        bash = shutil.which("bash")
        if not bash: raise ValueError("远端没有找到 Bash。")
        self.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.skill_state_dir = os.path.join(os.path.expanduser("~"), ".local", "state", "agentrix", "ssh-skills")
        reading_note = self.startup_note(reading_note)
        with open(os.path.join(self.temp, "skill-note.txt"), "w", encoding="utf-8") as output: output.write(reading_note)
        os.chmod(os.path.join(self.temp, "skill-note.txt"), 0o600)
        notify_file = os.path.join(self.temp, "notify.py")
        rc_file = os.path.join(self.temp, "bashrc")
        for filename, content in ((notify_file, NOTIFY_SOURCE), (rc_file, BASH_SOURCE)):
            with open(filename, "w", encoding="utf-8") as target: target.write(content)
            os.chmod(filename, 0o600)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket_path = os.path.join(self.temp, "events.sock")
        self.listener.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        self.listener.listen(8)
        self.listener.settimeout(0.5)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", AGENTRIX_ROOT=self.coding_root, AGENTRIX_PYTHON=sys.executable, AGENTRIX_NOTIFY_FILE=notify_file, AGENTRIX_SOCKET=self.socket_path, AGENTRIX_TOKEN=self.token, AGENTRIX_NOTIFY_COMMAND=json.dumps([sys.executable, notify_file, "notify"]))
        if os.path.isfile(os.path.join(self.temp, "dispatch.json")): env["AGENTRIX_BOOTSTRAP"] = os.path.join(self.temp, "dispatch.json")
        # Plain words for the Codex wrapper in BASH_SOURCE; anything that could break its TOML string is left out.
        # The note names where this terminal's handoff of earlier work is written on this computer (write_handoff).
        if reading_note: env["AGENTRIX_READING_NOTE"] = reading_note
        env["AGENTRIX_READING_NOTE_FILE"] = os.path.join(self.temp, "skill-note.txt")
        env["AGENTRIX_SKILL_KEY_FILE"] = os.path.join(self.temp, "skill-key.txt")
        env["AGENTRIX_SKILL_STATE_DIR"] = os.path.join(self.skill_state_dir, "delivered")
        for key in ("NO_COLOR", "NODE_DISABLE_COLORS"): env.pop(key, None)
        if env.get("FORCE_COLOR") == "0": env.pop("FORCE_COLOR", None)
        child, master = pty.fork()
        if child == 0:
            os.chdir(self.coding_root)
            os.execve(bash, [bash, "--noprofile", "--rcfile", rc_file, "-i"], env)
        self.child, self.master = child, master
        self.resize(cols, rows)
        threading.Thread(target=self.events_loop, daemon=True).start()
        threading.Thread(target=self.terminal_loop, daemon=True).start()

    def events_loop(self):
        while not self.stopping:
            try: client, _ = self.listener.accept()
            except socket.timeout: continue
            except OSError: break
            with client:
                client.settimeout(2)
                data = b""
                try:
                    while len(data) <= 65536 and b"\n" not in data:
                        chunk = client.recv(4096)
                        if not chunk: break
                        data += chunk
                    if len(data) > 65536: continue
                    event = json.loads(data)
                    if not isinstance(event, dict): continue
                    dispatch = str(event.get("type", "")).startswith("dispatch-")
                    if dispatch:
                        if event.pop("sessionKey", None) != self.token or event.get("projectId") != self.project_id: continue
                    elif event.pop("token", None) != self.token: continue
                    route = event.pop("accountRoute", None)
                    if not dispatch and event.get("agent") == "claude":
                        # No credential values cross even the host-local socket. Never forward route paths to Agentrix.
                        valid = isinstance(route, dict) and set(route) == {"home", "configDir", "secureDir", "overridden"} and type(route["overridden"]) is bool
                        if valid and all(value is None or isinstance(value, str) and os.path.isabs(value) and len(value) <= 4096 and "\0" not in value
                                         for value in (route["home"], route["configDir"], route["secureDir"])) and route["home"]:
                            if self.claude_route != route: self.claude_route = route
                            self.claude_home = route["configDir"] or os.path.join(route["home"], ".claude")
                        else: self.claude_route = None
                    codex_home = event.pop("codexHome", None)
                    if event.get("type") in ("shell-prompt", "codex-started"):
                        if isinstance(codex_home, str) and os.path.isabs(codex_home): self.codex_home = codex_home
                        if isinstance(event.get("cwd"), str) and os.path.isabs(event["cwd"]): self.coding_root = event["cwd"]
                    with self.sequence_lock:
                        self.sequence += 1
                        event.update(projectId=self.project_id, sessionKey=self.token, sequence=self.sequence)
                        if event.get("type") == "codex-started":
                            self.skill_note_sequence = self.sequence
                            self.skill_note_ready.clear()
                        self.emit({"type": "event", "event": event})
                    if event.get("type") == "codex-started":
                        self.skill_note_ready.wait(4)
                        client.sendall(b"\n")
                except (OSError, ValueError): pass

    def terminal_loop(self):
        import select
        try:
            while not self.stopping:
                readable, _, _ = select.select([self.master], [], [], 0.5)
                if not readable: continue
                data = os.read(self.master, 32768)
                if not data: break
                self.emit({"type": "data", "data": base64.b64encode(data).decode("ascii")})
        except (OSError, ValueError): pass
        if not self.stopping:
            _, status = os.waitpid(self.child, 0)
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            self.emit({"type": "exit", "code": code})

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 500 or not 1 <= rows <= 250: raise ValueError("无效的终端尺寸。")
        if self.master is not None:
            import fcntl
            import termios
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def input(self, encoded):
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 1024 * 1024: raise ValueError("终端输入过大。")
        if self.master is not None:
            while data and not self.stopping:
                written = os.write(self.master, data)
                data = data[written:]

    def stop(self):
        with self.lock:
            if self.stopping: return
            self.stopping = True
        for identity in list(self.uploads): self.cancel_upload(identity)
        if self.master is not None:
            try: os.close(self.master)
            except OSError: pass
        if self.child:
            try: os.killpg(self.child, signal.SIGHUP)
            except OSError: pass
        if hasattr(self, "listener"): self.listener.close()
        if self.temp and os.path.dirname(os.path.realpath(self.temp)) == os.path.realpath(tempfile.gettempdir()) and os.path.basename(self.temp).startswith("agentrix-"):
            shutil.rmtree(self.temp, ignore_errors=True)

class Channel:
    """One terminal of the host: a worker of its own (folder, shell, readers), whose messages carry the channel's name
    both ways, so every terminal opened on the host shares this process and its SSH connection
    (electron/remote-connection.cjs)."""
    def __init__(self, name, write, accounts=None):
        self.worker = Worker(lambda message: write(dict(message, channel=name)), accounts)
        self.requests = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.typing = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    def open(self, config):
        worker = self.worker
        try:
            info = worker.initialize(config)
            # The shell starts before "ready", so the size and keys sent after it find the terminal there.
            worker.start_terminal(config.get("cols", 90), config.get("rows", 24), config.get("readingNote", ""))
            info["skills"] = worker.skill_paths
            worker.emit({"type": "ready", "info": info})
        except Exception as error:
            worker.emit({"type": "error", "error": str(error)[:1000]})
            self.close()

    def receive(self, message):
        op, worker = message.get("op"), self.worker
        if op == "resize": worker.resize(message["cols"], message["rows"])
        elif op == "input": self.typing.submit(worker.input, message["data"])
        else: self.requests.submit(self.dispatch, message)

    def dispatch(self, message):
        worker, identity = self.worker, message.get("id")
        try:
            op = message["op"]
            if op == "directory": value = worker.directory(message.get("path", ""), message.get("offset", 0))
            elif op == "git": value = worker.git(message.get("action"), message.get("value"))
            elif op == "stat": value = worker.metadata(message["path"])
            elif op == "read": value = worker.read(message["path"], message["offset"], message["length"])
            elif op == "document": value = worker.document(message.get("path"), message.get("length", 8192))
            elif op == "preview": value = worker.preview(message["path"], message.get("page", 0))
            elif op == "save-file": value = worker.save_file(message["path"], message.get("page", 0), message.get("revision"), message["data"])
            elif op == "resume-info": value = recent_session(worker.coding_root, worker.codex_home, message.get("threadId"))
            elif op == "codex-status": value = worker.codex_status(message.get("since"), message.get("threadId"))
            elif op == "claude-status": value = worker.claude_status(message.get("path"), message.get("since"))
            elif op == "claude-account": value = worker.claude_account()
            elif op == "history": value = history_records(worker.coding_root, worker.codex_home, os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))
            elif op == "write-handoff": value = worker.write_handoff(message.get("text"))
            elif op == "skill-note": value = worker.update_skill_note(message.get("sequence"), message.get("note"), message.get("skills"))
            elif op == "create": value = worker.create(message.get("path", ""), message["name"], message["kind"], message.get("unique", False))
            elif op == "rename": value = worker.rename(message["path"], message["name"])
            elif op == "remove": value = worker.remove(message["path"])
            elif op == "upload-start": value = worker.start_upload(message.get("path", ""), message["name"], message["size"])
            elif op == "image-start": value = worker.start_image(message.get("extension"), message.get("size"))
            elif op == "upload-chunk": value = worker.upload_chunk(message["transfer"], message["offset"], message["data"])
            elif op == "upload-finish": value = worker.finish_upload(message["transfer"])
            elif op == "upload-cancel": value = worker.cancel_upload(message["transfer"])
            else: raise ValueError("不支持的远程请求。")
            worker.emit({"type": "response", "id": identity, "ok": True, "value": value})
        except Exception as error: worker.emit({"type": "response", "id": identity, "ok": False, "error": str(error)[:1000]})

    def close(self):
        self.worker.stop()
        self.requests.shutdown(wait=False)
        self.typing.shutdown(wait=False)

def serve(read_line, write, channels):
    """Runs the channels the lines read open ("open"), feed and close ("shutdown") until the input ends."""
    cached_key, cached_bundle = None, None
    accounts = RemoteClaudeAccounts()
    try:
        while True:
            line = read_line(MAX_MESSAGE + 1)
            if not line: break
            # Open envelopes put channel first, allowing a bounded read to identify a failed channel.
            prefix = re.match(br'^\s*\{\s*"channel"\s*:\s*([0-9]{1,16})\s*[,}]', line)
            name = int(prefix.group(1)) if prefix else None
            try:
                if len(line) > MAX_MESSAGE:
                    while line and not line.endswith(b"\n"): line = read_line(MAX_MESSAGE + 1)
                    raise ValueError("远程请求过大。")
                message = json.loads(line)
                if not isinstance(message, dict): raise ValueError("Invalid remote message.")
                name, op = message.get("channel"), message.get("op")
                if type(name) is not int or name <= 0:
                    name = None
                    raise ValueError("Invalid remote channel.")
                channel = channels.get(name)
                if op == "open":
                    key, bundle = message.get("skillsKey"), message.get("skills")
                    if key is not None:
                        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key): raise ValueError("Invalid remote skills key.")
                        if bundle is None:
                            if key != cached_key: raise ValueError("Remote skills bundle is missing.")
                            message["skills"] = cached_bundle
                        else:
                            if not isinstance(bundle, dict) or bundle.get("key") != key: raise ValueError("Invalid remote skills bundle.")
                            cached_key, cached_bundle = key, bundle
                    if channel is None:
                        channels[name] = channel = Channel(name, write, accounts)
                        # Its folder and Git are read in a thread of its own, so other terminals' keys go on meanwhile.
                        threading.Thread(target=channel.open, args=(message,), daemon=True).start()
                elif channel is None: continue
                elif op == "shutdown": channels.pop(name).close()
                else: channel.receive(message)
            except Exception as error:
                # Unidentifiable garbage is discarded. An unscoped error would disconnect every terminal on this host.
                if name is not None:
                    channel = channels.pop(name, None)
                    if channel: channel.close()
                    write({"type": "error", "channel": name, "error": str(error)[:1000]})
    finally:
        for channel in list(channels.values()): channel.close()

def main():
    output_lock = threading.Lock()
    def write(message):
        with output_lock:
            sys.stdout.write(PREFIX + json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    channels = {}
    def shutdown(*_):
        for channel in list(channels.values()): channel.worker.stop()
        os._exit(0)
    for event in (signal.SIGTERM, signal.SIGHUP): signal.signal(event, shutdown)
    serve(sys.stdin.buffer.readline, write, channels)

if __name__ == "__main__": main()
