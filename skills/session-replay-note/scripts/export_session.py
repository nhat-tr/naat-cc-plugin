#!/usr/bin/env python3
"""
Export a Claude Code session (.jsonl) to an Obsidian note.

The note renders human prompts as ```claude-you``` blocks and each assistant
turn (text + tool calls + tool results) as a ```claude``` block — the same
fenced-block convention the session-replay-note demo notes use, so a demo note
can [[link]] or ![[embed]] a turn, and you can copy a real exchange straight
out of it instead of digging through the terminal.

Schema ported from the user's nvim claude_jsonl renderer (the authoritative
source for the on-disk format): entry.type / message.role / message.content
blocks (text | thinking | tool_use | tool_result), assistant-chunk dedup by
message.id, skipping file-history-snapshot / isMeta, turn_duration totals,
token summing, ANSI stripping.

Usage:
  export_session.py                      # export the latest session anywhere
  export_session.py --list               # list recent sessions, pick one
  export_session.py --session <id|path>  # a specific session (id substring or .jsonl path)
  export_session.py --project <substr>   # restrict to a project dir matching substr
  export_session.py --into <demo-slug>   # write into <vault>/Notes/<demo-slug>/_session.md
  export_session.py --out <path>         # explicit output path
Flags:
  --vault <path>      Obsidian vault root (default: ~/Vaults/N8W)
  --with-thinking     include [thinking] blocks (default: off)
  --no-tools          omit tool calls / results entirely
  --full              don't truncate long tool results (default: cap ~30 lines)
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
DEFAULT_VAULT = os.path.expanduser("~/Vaults/N8W")
RESULT_CAP = 30

_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[@-_]")


def strip_ansi(s):
    return _ANSI.sub("", s) if isinstance(s, str) else s


def short_model(model):
    if not isinstance(model, str):
        return model
    return re.sub(r"-20\d+.*$", "", model.replace("claude-", ""))


def hhmm(ts):
    m = re.match(r"(\d+)-(\d+)-(\d+)T(\d+):(\d+)", ts or "")
    return f"{m.group(4)}:{m.group(5)}" if m else ""


def date_of(ts):
    m = re.match(r"(\d+-\d+-\d+)T", ts or "")
    return m.group(1) if m else datetime.now().strftime("%Y-%m-%d")


def fence(text):
    """Return a backtick fence longer than any run inside `text` (min 3)."""
    longest = max((len(r) for r in re.findall(r"`+", text or "")), default=0)
    return "`" * max(3, longest + 1)


# ---------------------------------------------------------------------------
# session discovery
# ---------------------------------------------------------------------------
def all_sessions(project_substr=None):
    paths = glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl"))
    if project_substr:
        paths = [p for p in paths if project_substr in p]
    return sorted(paths, key=os.path.getmtime, reverse=True)


def find_by_id(sid):
    """Resolve a session id to its .jsonl path across all project dirs."""
    if not sid:
        return None
    matches = glob.glob(os.path.join(PROJECTS_DIR, "*", f"*{sid}*.jsonl"))
    return matches[0] if matches else None


def resolve_session(arg, project_substr, require_current=False):
    """Resolution order: explicit path/id > CLAUDE_CODE_SESSION_ID (the running
    session) > latest by mtime. mtime is a last resort because a sibling session
    file can have a newer mtime than the one you're actually in."""
    if arg and os.path.isfile(arg):
        return arg, "explicit path"
    if arg:
        sessions = all_sessions(project_substr)
        matches = [p for p in sessions if arg in os.path.basename(p)]
        if not matches:
            sys.exit(f"No session matches id/substring: {arg}")
        if len(matches) > 1:
            sys.exit("Ambiguous session id; matches:\n  " + "\n  ".join(matches))
        return matches[0], "explicit id"

    env_id = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if env_id:
        p = find_by_id(env_id)
        if p:
            return p, "current session (CLAUDE_CODE_SESSION_ID)"
        if require_current:
            sys.exit(f"CLAUDE_CODE_SESSION_ID={env_id} set but no matching .jsonl found")
    if require_current:
        sys.exit("--current requested but CLAUDE_CODE_SESSION_ID is not set "
                 "(are you running inside a Claude Code session?)")

    sessions = all_sessions(project_substr)
    if not sessions:
        sys.exit("No sessions found under ~/.claude/projects")
    return sessions[0], "latest by mtime (fallback)"


def first_prompt(path):
    try:
        for line in open(path, encoding="utf-8"):
            o = json.loads(line)
            if o.get("type") == "user" and not o.get("isMeta"):
                c = (o.get("message") or {}).get("content")
                txt = c if isinstance(c, str) else " ".join(
                    b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
                ) if isinstance(c, list) else ""
                txt = re.sub(r"<[^>]+>", " ", txt).strip()
                if txt:
                    return txt[:70]
    except Exception:
        pass
    return ""


def cmd_list(project_substr):
    for p in all_sessions(project_substr)[:25]:
        sid = os.path.basename(p)[:8]
        proj = os.path.basename(os.path.dirname(p))
        when = datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d %H:%M")
        print(f"{sid}  {when}  {proj}\n          {first_prompt(p)}")


# ---------------------------------------------------------------------------
# parsing (ported from the nvim renderer)
# ---------------------------------------------------------------------------
def load_entries(path):
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(o, dict):
            out.append(o)
    return out


def dedupe_assistant_chunks(entries):
    """Streamed assistant messages share message.id across chunks; merge each
    id's earlier content blocks into its final chunk and drop the earlier ones."""
    def mid(e):
        return (e.get("message") or {}).get("id") if e.get("type") == "assistant" else None

    last_idx = {}
    for i, e in enumerate(entries):
        m = mid(e)
        if m:
            last_idx[m] = i

    earlier = {}
    for i, e in enumerate(entries):
        m = mid(e)
        if m and last_idx[m] != i:
            blocks = (e.get("message") or {}).get("content")
            if isinstance(blocks, list):
                earlier.setdefault(m, []).extend(b for b in blocks if isinstance(b, dict))

    for m, blocks in earlier.items():
        final = entries[last_idx[m]]
        content = (final.get("message") or {}).get("content")
        if isinstance(content, list):
            final["message"]["content"] = blocks + content

    skip = {i for i, e in enumerate(entries) if (mid(e) and last_idx[mid(e)] != i)}
    return skip


def extract_parts(content):
    """Return ordered list of (kind, payload). kinds: text, thinking, tool_use, result."""
    parts = []
    if isinstance(content, str):
        if content.strip():
            parts.append(("text", content))
        return parts
    if not isinstance(content, list):
        return parts
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "thinking":
            tx = b.get("thinking") or b.get("text")
            if tx:
                parts.append(("thinking", str(tx)))
        elif t == "text" and b.get("text"):
            parts.append(("text", str(b["text"])))
        elif t == "tool_use":
            parts.append(("tool_use", b))
        elif t == "tool_result":
            c = b.get("content")
            if isinstance(c, str):
                txt = c
            elif isinstance(c, list):
                txt = "\n".join(str(i.get("text", "")) for i in c if isinstance(i, dict))
            else:
                txt = ""
            if txt.strip():
                parts.append(("result", strip_ansi(txt)))
    return parts


def has_human_text(parts):
    return any(k == "text" for k, _ in parts)


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
def fmt_tool_use(b):
    name = b.get("name", "tool")
    inp = b.get("input") or {}
    if not isinstance(inp, dict):
        return [f"⏺ {name}"]
    if name == "Bash":
        head = "⏺ Bash"
        desc = inp.get("description")
        if isinstance(desc, str) and desc:
            head += f"  # {desc}"
        lines = [head]
        cmd = inp.get("command", "")
        if isinstance(cmd, str) and cmd:
            for i, l in enumerate(cmd.splitlines()):
                lines.append(("  $ " if i == 0 else "    ") + l)
        return lines
    key_order = ["file_path", "path", "pattern", "glob", "query", "description",
                 "prompt", "subagent_type", "url", "old_string", "new_string"]
    parts = []
    for k in key_order:
        v = inp.get(k)
        if isinstance(v, (str, int, float, bool)) and str(v) != "":
            s = str(v).splitlines()[0]
            if len(s) > 80:
                s = s[:80] + "…"
            parts.append(f"{k}={s}")
        if len(parts) >= 3:
            break
    return [f"⏺ {name}(" + ", ".join(parts) + ")"]


def fmt_result(text, full):
    lines = text.splitlines()
    if not full and len(lines) > RESULT_CAP:
        shown = lines[:RESULT_CAP]
        shown.append(f"… ({len(lines) - RESULT_CAP} more lines)")
        lines = shown
    out = []
    for i, l in enumerate(lines):
        out.append(("⎿  " if i == 0 else "   ") + l)
    return out


def build_turns(entries, skip, opts):
    turns = []
    cur = None
    for i, e in enumerate(entries):
        if i in skip or e.get("isMeta"):
            continue
        t = e.get("type")
        if t == "file-history-snapshot":
            continue
        if t == "system":
            continue
        msg = e.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        parts = extract_parts(msg.get("content"))
        if not parts:
            continue
        if role == "user" and has_human_text(parts):
            cur = {"ts": e.get("timestamp"), "prompt": "", "lines": [], "tools": 0}
            turns.append(cur)
            cur["prompt"] = "\n".join(p for k, p in parts if k == "text")
            continue
        if role == "assistant":
            if cur is None:
                cur = {"ts": e.get("timestamp"), "prompt": None, "lines": [], "tools": 0}
                turns.append(cur)
            for k, p in parts:
                if k == "text":
                    if cur["lines"]:
                        cur["lines"].append("")
                    cur["lines"] += [("⏺ " + ln if j == 0 else "  " + ln)
                                     for j, ln in enumerate(p.splitlines())]
                elif k == "thinking" and opts["thinking"]:
                    cur["lines"].append("[thinking]")
                    cur["lines"] += ["  " + ln for ln in p.splitlines()]
                elif k == "tool_use" and opts["tools"]:
                    cur["lines"] += fmt_tool_use(p)
                    cur["tools"] += 1
            continue
        if role == "user":  # tool_result follow-up
            # Suppress orphaned results: a ⎿ with no preceding ⏺ tool call in this turn
            # (e.g. a leftover result recorded right after a human prompt).
            if cur is not None and opts["tools"] and cur["tools"] > 0:
                for k, p in parts:
                    if k == "result":
                        cur["lines"] += fmt_result(p, opts["full"])
    return turns


def totals(entries):
    tin = tout = tcache = dur = 0
    model = None
    for e in entries:
        if e.get("type") == "system" and e.get("subtype") == "turn_duration":
            dur += e.get("durationMs") or 0
        if e.get("type") == "assistant":
            u = (e.get("message") or {}).get("usage") or {}
            tin += (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
            tout += u.get("output_tokens") or 0
            tcache += u.get("cache_read_input_tokens") or 0
            if not model:
                model = (e.get("message") or {}).get("model")
    return tin, tout, tcache, dur, short_model(model)


def fmt_dur(ms):
    if not ms:
        return ""
    s = ms / 1000
    if s < 60:
        return f"{s:.0f}s"
    return f"{int(s // 60)}m{int(s % 60):02d}s"


def render(path, entries, opts):
    skip = dedupe_assistant_chunks(entries)
    turns = build_turns(entries, skip, opts)
    tin, tout, tcache, dur, model = totals(entries)
    sid = next((e.get("sessionId") for e in entries if e.get("sessionId")), os.path.basename(path)[:8])
    cwd = next((e.get("cwd") for e in entries if e.get("cwd")), "")
    first_ts = next((e.get("timestamp") for e in entries if e.get("timestamp")), None)

    out = []
    out.append("---")
    out.append(f"session: {sid}")
    if cwd:
        out.append(f"project: {cwd}")
    if model:
        out.append(f"model: {model}")
    out.append(f"date: {date_of(first_ts)}")
    out.append(f"tokens: in {tin} / out {tout} / cached {tcache}")
    if dur:
        out.append(f"duration: {fmt_dur(dur)}")
    out.append("tags: [claude-session]")
    out.append(f"source: {path}")
    out.append("---")
    out.append("")
    out.append(f"# Session {str(sid)[:8]} — {date_of(first_ts)}")
    out.append("")

    n = 0
    for tr in turns:
        if not tr["lines"] and not tr["prompt"]:
            continue
        n += 1
        out.append(f"## ▷ turn {n} · {hhmm(tr['ts'])}")
        out.append("")
        if tr["prompt"]:
            body = "> " + "\n> ".join(tr["prompt"].splitlines())
            f = fence(body)
            out.append(f + "claude-you")
            out.append(body)
            out.append(f)
            out.append("")
        if tr["lines"]:
            body = "\n".join(tr["lines"])
            f = fence(body)
            out.append(f + "claude")
            out.append(body)
            out.append(f)
            out.append("")
    return "\n".join(out), n


def default_out(vault, path, into, sess_date):
    sid = os.path.basename(path)[:8]
    if into:
        d = os.path.join(vault, "Notes", into)
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "_session.md")
    d = os.path.join(vault, "Notes", "_sessions")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{sess_date}_{sid}.md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session")
    ap.add_argument("--project")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--into")
    ap.add_argument("--out")
    ap.add_argument("--current", action="store_true",
                    help="export the running session (CLAUDE_CODE_SESSION_ID); error if unknown")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--with-thinking", action="store_true")
    ap.add_argument("--no-tools", action="store_true")
    ap.add_argument("--full", action="store_true")
    a = ap.parse_args()

    if a.list:
        cmd_list(a.project)
        return

    path, how = resolve_session(a.session, a.project, require_current=a.current)
    print(f"Session: {os.path.basename(path)[:8]} ({how})")
    entries = load_entries(path)
    opts = {"thinking": a.with_thinking, "tools": not a.no_tools, "full": a.full}
    md, n = render(path, entries, opts)
    first_ts = next((e.get("timestamp") for e in entries if e.get("timestamp")), None)
    out = a.out or default_out(a.vault, path, a.into, date_of(first_ts))
    with open(out, "w", encoding="utf-8") as f:
        f.write(md)
    rel = os.path.relpath(out, a.vault) if out.startswith(a.vault) else out
    print(f"Exported {n} turns from {os.path.basename(path)}")
    print(f"  -> {out}")
    print(f"  vault-relative: {rel}")


if __name__ == "__main__":
    main()
