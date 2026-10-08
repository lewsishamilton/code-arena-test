#!/usr/bin/env python3
"""CODE//ARENA Contest Server

A fast, lightweight contest server supporting in-browser code execution (Python/C/C++),
isolated Java execution, real-time leaderboard, and proctor control dashboard.

Database:
  Supports PostgreSQL for production (e.g. 60+ concurrent students across LAN or Cloudflare Tunnel)
  with seamless automatic fallback to SQLite (results/contest.db).

Usage:
  python3 serve.py                                                   # Default (SQLite)
  python3 serve.py --postgres "postgresql://user:pass@host:5432/db"   # PostgreSQL backend
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

# Optional PostgreSQL driver
try:
    import psycopg2
    from psycopg2 import pool
    HAVE_PSYCOPG2 = True
except ImportError:
    HAVE_PSYCOPG2 = False

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
RESULTS = ROOT / "results"
SUBMISSIONS = RESULTS / "submissions.jsonl"
DB_PATH = RESULTS / "contest.db"
FIREBASE_CONFIG_PATH = ROOT / "firebase-config.json"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Mlrit#2026-jrll")
ADMIN_TOKEN = hashlib.sha256((ADMIN_PASSWORD + "_codearena_salt").encode()).hexdigest()
JAVA_BUILDS = ROOT / ".java_builds"
MAX_BODY = 256 * 1024
MAX_JUDGE_BODY = 10 * 1024 * 1024

_lock = threading.Lock()
_builds_lock = threading.Lock()
_builds_cache = {}
_java_source_cache = {}


# =============================================================================
# DATABASE LAYER (PostgreSQL + SQLite Dual-Engine Adapter)
# =============================================================================

class DBManager:
    """Thread-safe database manager supporting PostgreSQL and SQLite transparently."""

    def __init__(self, postgres_url=None):
        self.postgres_url = postgres_url or os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
        self.is_postgres = False
        self._pool = None
        self._init_backend()

    def _init_backend(self):
        if self.postgres_url and HAVE_PSYCOPG2:
            try:
                import re
                safe_url = re.sub(r':([^:@]+)@', ':****@', self.postgres_url)
                test_conn = psycopg2.connect(self.postgres_url)
                test_conn.close()
                self._pool = pool.ThreadedConnectionPool(1, 35, self.postgres_url)
                self.is_postgres = True
                print(f"🐘 [DATABASE] Connected to PostgreSQL: {safe_url}")
                return
            except Exception as e:
                print(f"⚠️ [DATABASE] Failed to connect to PostgreSQL ({e}). Falling back to SQLite.")
                self.is_postgres = False

        RESULTS.mkdir(exist_ok=True)
        print(f"🗃️ [DATABASE] Using SQLite database at: {DB_PATH.name}")

    def get_connection(self):
        if self.is_postgres:
            return self._pool.getconn()
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def release_connection(self, conn):
        if self.is_postgres:
            self._pool.putconn(conn)
        else:
            conn.close()

    @contextmanager
    def cursor(self, commit=False):
        conn = self.get_connection()
        try:
            cur = conn.cursor()
            yield cur
            if commit:
                conn.commit()
        except Exception:
            if hasattr(conn, 'rollback'):
                conn.rollback()
            raise
        finally:
            cur.close()
            self.release_connection(conn)

    def execute(self, query, params=(), commit=False):
        if self.is_postgres:
            query = query.replace('?', '%s')
        with self.cursor(commit=commit) as cur:
            cur.execute(query, params)
            if not commit:
                return cur.fetchall()

    def query_row(self, query, params=()):
        if self.is_postgres:
            query = query.replace('?', '%s')
        with self.cursor(commit=False) as cur:
            cur.execute(query, params)
            return cur.fetchone()

    def query_all(self, query, params=()):
        if self.is_postgres:
            query = query.replace('?', '%s')
        with self.cursor(commit=False) as cur:
            cur.execute(query, params)
            return cur.fetchall()

    def query_dicts(self, query, params=()):
        if self.is_postgres:
            query = query.replace('?', '%s')
            with self.cursor(commit=False) as cur:
                cur.execute(query, params)
                cols = [desc[0] for desc in cur.description] if cur.description else []
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        else:
            with self.cursor(commit=False) as cur:
                cur.execute(query, params)
                return [dict(r) for r in cur.fetchall()]


# Global database instance
db = None


def init_db():
    """Create all required tables and indexes."""
    global db
    if db.is_postgres:
        id_type = "SERIAL PRIMARY KEY"
        bigint_type = "BIGINT"
        double_type = "DOUBLE PRECISION"
    else:
        id_type = "INTEGER PRIMARY KEY AUTOINCREMENT"
        bigint_type = "INTEGER"
        double_type = "REAL"

    with db.cursor(commit=True) as cur:
        # Submissions
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS submissions (
                id {id_type},
                roll VARCHAR(64) NOT NULL,
                name VARCHAR(255) NOT NULL,
                problem VARCHAR(16) NOT NULL,
                lang VARCHAR(16) NOT NULL,
                verdict VARCHAR(32) NOT NULL,
                passed INT DEFAULT 0,
                total INT DEFAULT 0,
                time_ms {double_type} DEFAULT 0,
                failed_test INT DEFAULT 0,
                source TEXT,
                submitted_at {bigint_type} NOT NULL,
                received_at {bigint_type} NOT NULL,
                ip VARCHAR(64)
            );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_subs_roll ON submissions(roll);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_subs_submitted_at ON submissions(submitted_at);")

        # Contest clock and state
        cur.execute("""
            CREATE TABLE IF NOT EXISTS contest_state (
                key VARCHAR(64) PRIMARY KEY,
                value TEXT
            );
        """)

        # Kicked contestants
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS kicked_users (
                roll VARCHAR(64) PRIMARY KEY,
                name VARCHAR(255),
                reason TEXT,
                kicked_at {bigint_type}
            );
        """)

        # Security violations (window blur, tab switch)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS security_violations (
                id {id_type},
                roll VARCHAR(64) NOT NULL,
                name VARCHAR(255),
                event_type VARCHAR(64) NOT NULL,
                detail TEXT,
                timestamp {bigint_type} NOT NULL,
                ip VARCHAR(64),
                status VARCHAR(32) DEFAULT 'active'
            );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_violations_roll ON security_violations(roll);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_violations_time ON security_violations(timestamp);")

        # Ensure default contest state exists
        now_ms = int(time.time() * 1000)
        dur = 120
        defaults = {
            "status": "running",
            "start_time": str(now_ms),
            "duration_min": str(dur),
            "extra_time_min": "0",
            "end_time": str(now_ms + dur * 60000),
            "announcement": "",
            "paused_time_left_ms": "0",
            "lockdown_block_blur": "true",
            "lockdown_block_tab": "true",
            "lockdown_block_devtools": "true",
            "lockdown_block_fullscreen": "false"
        }
        for k, v in defaults.items():
            ph = "%s" if db.is_postgres else "?"
            cur.execute(f"INSERT INTO contest_state (key, value) VALUES ({ph}, {ph}) ON CONFLICT (key) DO NOTHING;", (k, v))


# =============================================================================
# CONTEST STATE & PROCTOR CONTROLS
# =============================================================================

def get_lockdown_policy():
    with _lock:
        state_rows = db.query_all("SELECT key, value FROM contest_state WHERE key LIKE 'lockdown_%'")
        state = dict(state_rows)
        return {
            "blockBlur": state.get("lockdown_block_blur", "true").lower() in ("true", "1"),
            "blockTab": state.get("lockdown_block_tab", "true").lower() in ("true", "1"),
            "blockDevtools": state.get("lockdown_block_devtools", "true").lower() in ("true", "1"),
            "blockFullscreen": state.get("lockdown_block_fullscreen", "false").lower() in ("true", "1")
        }


def update_lockdown_policy(policy):
    with _lock:
        mapping = {
            "lockdown_block_blur": "true" if policy.get("blockBlur", True) else "false",
            "lockdown_block_tab": "true" if policy.get("blockTab", True) else "false",
            "lockdown_block_devtools": "true" if policy.get("blockDevtools", True) else "false",
            "lockdown_block_fullscreen": "true" if policy.get("blockFullscreen", False) else "false",
        }
        for k, v in mapping.items():
            db.execute(
                "INSERT INTO contest_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (k, v),
                commit=True
            )
    return get_lockdown_policy()


def get_contest_state(roll=None):
    with _lock:
        state_rows = db.query_all("SELECT key, value FROM contest_state")
        state = dict(state_rows)

        is_kicked = False
        kick_reason = ""
        violation_info = None

        if roll:
            roll_clean = str(roll).strip().upper()
            k_row = db.query_row("SELECT reason FROM kicked_users WHERE roll = ?", (roll_clean,))
            if k_row:
                is_kicked = True
                kick_reason = k_row[0]
            v_row = db.query_row("""
                SELECT event_type, detail, timestamp 
                FROM security_violations 
                WHERE roll = ? AND status = 'active' 
                ORDER BY timestamp DESC LIMIT 1
            """, (roll_clean,))
            if v_row:
                violation_info = {
                    "type": v_row[0],
                    "detail": v_row[1],
                    "timestamp": v_row[2]
                }

    start_time = int(state.get("start_time", 0))
    duration_min = int(state.get("duration_min", 120))
    extra_time_min = int(state.get("extra_time_min", 0))
    end_time = int(state.get("end_time", 0))
    status = state.get("status", "running")
    announcement = state.get("announcement", "")
    paused_left = int(state.get("paused_time_left_ms", 0))

    now_ms = int(time.time() * 1000)
    if status == "running" and end_time > 0 and now_ms >= end_time:
        status = "ended"

    time_left = max(0, end_time - now_ms) if status == "running" else (paused_left if status == "paused" else 0)

    res = {
        "status": status,
        "startTime": start_time,
        "durationMin": duration_min,
        "extraTimeMin": extra_time_min,
        "endTime": end_time,
        "announcement": announcement,
        "now": now_ms,
        "timeLeftMs": time_left,
        "lockdownPolicy": get_lockdown_policy()
    }
    if roll:
        res["isKicked"] = is_kicked
        res["kickReason"] = kick_reason
        if violation_info:
            res["isSecurityViolation"] = True
            res["violation"] = violation_info
    return res


def update_contest_timer(action, minutes=0):
    with _lock:
        state_rows = db.query_all("SELECT key, value FROM contest_state")
        state = dict(state_rows)

        now_ms = int(time.time() * 1000)
        status = state.get("status", "running")
        start_time = int(state.get("start_time", now_ms))
        duration_min = int(state.get("duration_min", 120))
        extra_time_min = int(state.get("extra_time_min", 0))
        end_time = int(state.get("end_time", now_ms + duration_min * 60000))
        paused_left = int(state.get("paused_time_left_ms", 0))

        if action == "start":
            status = "running"
            start_time = now_ms
            end_time = now_ms + (duration_min + extra_time_min) * 60000
            paused_left = 0
        elif action == "pause":
            if status == "running":
                status = "paused"
                paused_left = max(0, end_time - now_ms)
        elif action == "resume":
            if status == "paused":
                status = "running"
                end_time = now_ms + paused_left
                paused_left = 0
        elif action == "add_time":
            added_ms = int(minutes) * 60000
            extra_time_min += int(minutes)
            if status == "running":
                end_time += added_ms
            elif status == "paused":
                paused_left += added_ms
            elif status == "ended":
                status = "running"
                end_time = now_ms + added_ms
        elif action == "reset":
            duration_min = int(minutes) if minutes > 0 else 120
            extra_time_min = 0
            start_time = now_ms
            end_time = now_ms + duration_min * 60000
            paused_left = 0
            status = "running"
            # Automatically unblock all disqualified contestants when timer/test is reset
            db.execute("DELETE FROM kicked_users;", commit=True)
            db.execute("UPDATE security_violations SET status = 'unblocked' WHERE status = 'active';", commit=True)

        updates = {
            "status": status,
            "start_time": str(start_time),
            "duration_min": str(duration_min),
            "extra_time_min": str(extra_time_min),
            "end_time": str(end_time),
            "paused_time_left_ms": str(paused_left)
        }
        for k, v in updates.items():
            db.execute(
                "INSERT INTO contest_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (k, v),
                commit=True
            )

    return get_contest_state()


def set_announcement(msg):
    with _lock:
        db.execute(
            "INSERT INTO contest_state (key, value) VALUES ('announcement', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (str(msg),),
            commit=True
        )
    return {"ok": True, "announcement": msg}


def kick_user(roll, name="", reason="Disqualified by administrator"):
    roll_up = str(roll).strip().upper()
    with _lock:
        db.execute("""
            INSERT INTO kicked_users (roll, name, reason, kicked_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (roll) DO UPDATE SET name = excluded.name, reason = excluded.reason, kicked_at = excluded.kicked_at
        """, (roll_up, name, reason, int(time.time() * 1000)), commit=True)
    return {"ok": True, "kicked": roll_up}


def unkick_user(roll):
    roll_up = str(roll).strip().upper()
    with _lock:
        db.execute("DELETE FROM kicked_users WHERE roll = ?", (roll_up,), commit=True)
    return {"ok": True, "unkicked": roll_up}


def get_kicked_users():
    with _lock:
        return db.query_dicts("SELECT roll, name, reason, kicked_at FROM kicked_users ORDER BY kicked_at DESC")


def record_security_violation(roll, name="", event_type="window-blur", detail="Left exam window", timestamp=None, ip=""):
    roll_up = str(roll).strip().upper()
    ts = timestamp or int(time.time() * 1000)
    policy = get_lockdown_policy()

    # If the admin disabled blocking for this specific event type, record as ignored and do not kick
    if event_type == "window-blur" and not policy.get("blockBlur", True):
        return {"ok": True, "blocked": False, "ignored": True, "reason": "Window blur detection disabled by admin"}
    if event_type == "tab-switch" and not policy.get("blockTab", True):
        return {"ok": True, "blocked": False, "ignored": True, "reason": "Tab switch detection disabled by admin"}
    if event_type == "devtools-shortcut" and not policy.get("blockDevtools", True):
        return {"ok": True, "blocked": False, "ignored": True, "reason": "DevTools detection disabled by admin"}
    if event_type == "fullscreen-escape" and not policy.get("blockFullscreen", False):
        return {"ok": True, "blocked": False, "ignored": True, "reason": "Fullscreen escape detection disabled by admin"}

    with _lock:
        db.execute("""
            INSERT INTO security_violations (roll, name, event_type, detail, timestamp, ip, status)
            VALUES (?, ?, ?, ?, ?, ?, 'active')
        """, (roll_up, name, event_type, detail, ts, ip), commit=True)
    # Automatically freeze the session
    kick_user(roll_up, name, f"Exam Window Violation: {detail} [{event_type}]")
    return {"ok": True, "blocked": True, "roll": roll_up, "reason": detail}


def get_security_violations():
    with _lock:
        return db.query_dicts("""
            SELECT id, roll, name, event_type, detail, timestamp, ip, status 
            FROM security_violations 
            ORDER BY timestamp DESC LIMIT 200
        """)


def unblock_user(roll):
    roll_up = str(roll).strip().upper()
    with _lock:
        db.execute("UPDATE security_violations SET status = 'unblocked' WHERE roll = ?", (roll_up,), commit=True)
    unkick_user(roll_up)
    return {"ok": True, "unblocked": roll_up}


def get_submission_source(sub_id):
    with _lock:
        row = db.query_row("SELECT id, roll, name, problem, lang, verdict, source, submitted_at FROM submissions WHERE id = ?", (sub_id,))
        if not row:
            return None
        return {
            "id": row[0],
            "roll": row[1],
            "name": row[2],
            "problem": row[3],
            "lang": row[4],
            "verdict": row[5],
            "source": row[6],
            "submitted_at": row[7]
        }


def reset_contest(wipe_submissions=True, reset_timer=True):
    with _lock:
        if wipe_submissions:
            db.execute("DELETE FROM submissions;", commit=True)
            db.execute("DELETE FROM kicked_users;", commit=True)
            db.execute("DELETE FROM security_violations;", commit=True)
            if SUBMISSIONS.exists():
                SUBMISSIONS.write_text("", encoding="utf-8")
    if reset_timer:
        update_contest_timer("reset", 120)
    return {"ok": True}


def save_submission(sub):
    """Store submission in database and append to jsonl log."""
    with _lock:
        db.execute("""
            INSERT INTO submissions 
            (roll, name, problem, lang, verdict, passed, total, time_ms, failed_test, source, submitted_at, received_at, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            str(sub.get("roll", "")).upper(),
            sub.get("name", ""),
            sub.get("problem", ""),
            sub.get("lang", ""),
            sub.get("verdict", ""),
            sub.get("passed", 0),
            sub.get("total", 0),
            sub.get("timeMs", 0),
            sub.get("failedTest", 0),
            sub.get("source", ""),
            sub.get("at", 0),
            sub.get("receivedAt", 0),
            sub.get("ip", "")
        ), commit=True)
    # Transparent jsonl log
    try:
        with SUBMISSIONS.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(sub, ensure_ascii=False) + "\n")
    except Exception:
        pass


def get_recent_submissions(limit=100):
    with _lock:
        return db.query_dicts("""
            SELECT id, roll, name, problem, lang, verdict, passed, total, time_ms, failed_test, submitted_at, received_at, ip
            FROM submissions
            ORDER BY id DESC
            LIMIT ?
        """, (limit,))


PROBLEMS_JSON_PATH = PUBLIC / "data" / "problems.json"
PROBLEMS_JS_PATH = PUBLIC / "js" / "problems.js"
TESTS_DIR = PUBLIC / "data" / "tests"


def sync_problems_js():
    """Generates public/js/problems.js from public/data/problems.json while preserving language templates."""
    if not PROBLEMS_JSON_PATH.exists():
        return
    try:
        with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
            problems_data = json.load(f)
    except Exception as e:
        print(f"⚠️ [PROBLEMS] Error reading problems.json: {e}")
        return

    js_content = f"""/* =========================================================================
   Problem set. Statements are Markdown. Samples are public (Run Sample Tests);
   hidden tests live in data/tests/<id>.json and are fetched when a solution is submitted.
   Generated dynamically by CODE//ARENA Admin Panel.
   ========================================================================= */

export const PROBLEMS = {json.dumps(problems_data, indent=2)};

/** Starter code. Every template reads stdin and writes stdout. */
export const LANGUAGES = {{
  py: {{
    label: 'Python 3', file: 'main.py', monaco: 'python',
    template: t => `import sys


def main():
    data = sys.stdin.read().split()
    # TODO: solve "${{t}}"


if __name__ == "__main__":
    main()
`
  }},
  cpp: {{
    label: 'C++17', file: 'main.cpp', monaco: 'cpp',
    template: t => `#include <bits/stdc++.h>
using namespace std;

int main() {{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // TODO: solve "${{t}}"

    return 0;
}}
`
  }},
  c: {{
    label: 'C (C17)', file: 'main.c', monaco: 'c',
    template: t => `#include <stdio.h>

int main(void) {{
    // TODO: solve "${{t}}"
    // Read from stdin, print the answer to stdout.

    return 0;
}}
`
  }},
  java: {{
    label: 'Java 21', file: 'Main.java', monaco: 'java',
    template: t => `import java.io.*;
import java.util.*;

public class Main {{
    public static void main(String[] args) throws IOException {{
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        // TODO: solve "${{t}}"
    }}
}}
`
  }}
}};

/** JSCPP (the light C/C++ engine) understands neither <bits/stdc++.h> nor the STL. */
export const JSCPP_TEMPLATES = {{
  cpp: t => `#include <iostream>
using namespace std;

int main() {{
    // TODO: solve "${{t}}"
    return 0;
}}
`
}};
"""
    PROBLEMS_JS_PATH.write_text(js_content, encoding="utf-8")


def load_problems():
    """Problem ids and points, read from public/data/problems.json or problems.js."""
    if PROBLEMS_JSON_PATH.exists():
        try:
            with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {p["id"]: int(p.get("points", 100)) for p in data if "id" in p}
        except Exception:
            pass
    import re
    if PROBLEMS_JS_PATH.exists():
        src = PROBLEMS_JS_PATH.read_text(encoding="utf-8")
        return {pid: int(pts) for pid, pts in re.findall(r"id:\s*'(\w+)'[\s\S]*?points:\s*(\d+)", src)}
    return {}


def get_all_questions_admin():
    """Return all questions with hidden test counts."""
    if not PROBLEMS_JSON_PATH.exists():
        return []
    try:
        with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        TESTS_DIR.mkdir(parents=True, exist_ok=True)
        for q in data:
            qid = q.get("id")
            test_file = TESTS_DIR / f"{qid}.json"
            q["hiddenTestCount"] = 0
            if test_file.exists():
                try:
                    with open(test_file, "r", encoding="utf-8") as tf:
                        tests = json.load(tf)
                        q["hiddenTestCount"] = len(tests) if isinstance(tests, list) else 0
                except Exception:
                    pass
        return data
    except Exception as e:
        print(f"⚠️ Error reading questions: {e}")
        return []


def get_question_admin(qid):
    """Retrieve full details of a question including hidden test cases."""
    if not PROBLEMS_JSON_PATH.exists():
        return None, None
    try:
        with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        question = next((q for q in data if str(q.get("id")).strip().upper() == str(qid).strip().upper()), None)
        if not question:
            return None, None
        test_file = TESTS_DIR / f"{question['id']}.json"
        tests = []
        if test_file.exists():
            try:
                with open(test_file, "r", encoding="utf-8") as tf:
                    t_json = json.load(tf)
                    if isinstance(t_json, list):
                        tests = t_json
            except Exception:
                pass
        return question, tests
    except Exception as e:
        print(f"⚠️ Error fetching question {qid}: {e}")
        return None, None


def save_question_admin(q_data, tests_data=None):
    """Save or update question and its hidden tests."""
    try:
        qid = str(q_data.get("id", "")).strip().upper()
        if not qid:
            return False, "Question ID is required"
        import re
        if not re.match(r"^[A-Z0-9_-]+$", qid):
            return False, "Question ID must only contain letters, numbers, hyphens or underscores (e.g. A, B, P1)"

        title = str(q_data.get("title", "")).strip()
        if not title:
            return False, "Question title is required"

        difficulty = str(q_data.get("difficulty", "Medium")).strip().capitalize()
        if difficulty not in ("Easy", "Medium", "Hard"):
            difficulty = "Medium"

        try:
            points = int(q_data.get("points", 100))
        except (ValueError, TypeError):
            points = 100

        try:
            time_limit = int(q_data.get("timeLimitMs", 2000))
        except (ValueError, TypeError):
            time_limit = 2000

        statement = str(q_data.get("statement", "")).strip()

        raw_constraints = q_data.get("constraints", [])
        if isinstance(raw_constraints, str):
            constraints = [c.strip() for c in raw_constraints.split("\n") if c.strip()]
        elif isinstance(raw_constraints, list):
            constraints = [str(c).strip() for c in raw_constraints if str(c).strip()]
        else:
            constraints = []

        raw_samples = q_data.get("samples", [])
        samples = []
        if isinstance(raw_samples, list):
            for s in raw_samples:
                if isinstance(s, dict):
                    inp = str(s.get("input", ""))
                    out = str(s.get("output", ""))
                    if inp and not inp.endswith("\n"):
                        inp += "\n"
                    if out and not out.endswith("\n"):
                        out += "\n"
                    sample_obj = {"input": inp, "output": out}
                    if s.get("note"):
                        sample_obj["note"] = str(s["note"]).strip()
                    samples.append(sample_obj)

        new_q = {
            "id": qid,
            "title": title,
            "difficulty": difficulty,
            "points": points,
            "timeLimitMs": time_limit,
            "statement": statement,
            "constraints": constraints,
            "samples": samples
        }

        # Load existing questions
        data = []
        if PROBLEMS_JSON_PATH.exists():
            with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)

        idx = next((i for i, q in enumerate(data) if str(q.get("id")).strip().upper() == qid), -1)
        if idx != -1:
            data[idx] = new_q
        else:
            data.append(new_q)

        # Write problems.json
        PROBLEMS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROBLEMS_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        # Save hidden tests if provided
        if tests_data is not None:
            TESTS_DIR.mkdir(parents=True, exist_ok=True)
            formatted_tests = []
            if isinstance(tests_data, list):
                for t in tests_data:
                    if isinstance(t, dict):
                        t_in = str(t.get("input", ""))
                        t_out = str(t.get("output", ""))
                        if t_in and not t_in.endswith("\n"):
                            t_in += "\n"
                        if t_out and not t_out.endswith("\n"):
                            t_out += "\n"
                        formatted_tests.append({"input": t_in, "output": t_out})
            test_file = TESTS_DIR / f"{qid}.json"
            with open(test_file, "w", encoding="utf-8") as tf:
                json.dump(formatted_tests, tf, indent=2, ensure_ascii=False)

        sync_problems_js()
        return True, new_q
    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, str(e)


def delete_question_admin(qid):
    """Delete a question and its test files."""
    try:
        qid = str(qid).strip().upper()
        if not PROBLEMS_JSON_PATH.exists():
            return False, "No questions found"
        with open(PROBLEMS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        new_data = [q for q in data if str(q.get("id")).strip().upper() != qid]
        if len(new_data) == len(data):
            return False, f"Question '{qid}' not found"

        with open(PROBLEMS_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(new_data, f, indent=2, ensure_ascii=False)

        test_file = TESTS_DIR / f"{qid}.json"
        if test_file.exists():
            try:
                test_file.unlink()
            except Exception:
                pass

        sync_problems_js()
        return True, f"Question '{qid}' deleted successfully"
    except Exception as e:
        return False, str(e)


def scoreboard(problems):
    """Compute leaderboard with simple positive scoring, excluding kicked users."""
    best = {}
    with _lock:
        kicked_rows = db.query_all("SELECT roll FROM kicked_users")
        kicked_rolls = {r[0] for r in kicked_rows}
        rows = db.query_dicts("SELECT * FROM submissions ORDER BY submitted_at ASC")

    for r in rows:
        roll = str(r.get("roll", "")).upper()
        if roll in kicked_rolls:
            continue

        c = best.setdefault(roll, {
            "name": r.get("name", ""),
            "roll": roll,
            "problems": {},
            "score": 0,
            "solved": 0,
            "lastSolveAt": 0
        })
        p = c["problems"].setdefault(r.get("problem"), {"verdict": None, "attempts": 0, "solved": False})
        if p["solved"]:
            continue
        p["attempts"] += 1
        p["verdict"] = r.get("verdict")
        if r.get("verdict") == "AC":
            p["solved"] = True
            pts = problems.get(r.get("problem"), 0)
            c["score"] += pts
            c["solved"] += 1
            c["lastSolveAt"] = max(c["lastSolveAt"], r.get("submitted_at") or 0)

    ranked = sorted(best.values(), key=lambda x: (-x["score"], x["lastSolveAt"]))
    for i, c in enumerate(ranked, 1):
        c["rank"] = i
    return ranked


# =============================================================================
# ISOLATED JAVA RUNNER
# =============================================================================

def java_ping():
    remote_url = os.environ.get("JAVA_JUDGE_URL", "").strip()
    if remote_url:
        try:
            req = urllib.request.Request(remote_url, headers={"User-Agent": "CodeArena-VM"})
            with urllib.request.urlopen(req, timeout=4) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    return {
                        "ok": True,
                        "available": True,
                        "version": data.get("version", "Java 21 (Cloud Run)"),
                        "remote": True,
                        "remoteUrl": remote_url
                    }
        except Exception as e:
            return {"ok": False, "available": False, "error": f"Remote judge unreachable: {e}", "remote": True}

    have_javac = shutil.which("javac") is not None
    have_java = shutil.which("java") is not None
    version = ""
    if have_java:
        try:
            p = subprocess.run(["java", "-version"], capture_output=True, text=True, timeout=2)
            version = (p.stderr or p.stdout).splitlines()[0] if (p.stderr or p.stdout) else ""
        except Exception:
            pass
    avail = bool(have_javac and have_java)
    return {
        "ok": avail,
        "available": avail,
        "version": version or "Java 21",
        "javac": have_javac,
        "java": have_java,
        "remote": False
    }


def normalize_java_source(source: str) -> str:
    if not source:
        return ""
    # Convert public class/interface/enum/record to package-private so javac allows any class name in Solution.java
    return re.sub(r'\bpublic\s+(class|interface|enum|record)\b', r'\1', source)


def compile_java(source: str):
    source = normalize_java_source(source)
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    with _builds_lock:
        if source_hash in _builds_cache:
            entry = _builds_cache[source_hash]
            if Path(entry.get("dir", "")).exists():
                return entry

    build_id = f"b_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
    bdir = JAVA_BUILDS / build_id
    bdir.mkdir(parents=True, exist_ok=True)
    src_file = bdir / "Solution.java"
    src_file.write_text(source, encoding="utf-8")

    compile_cmd = ["javac", "-encoding", "UTF-8", "-d", str(bdir), str(src_file)]
    try:
        cp = subprocess.run(compile_cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        shutil.rmtree(bdir, ignore_errors=True)
        return {"ok": False, "error": "Compilation timed out (limit: 15s)"}
    except Exception as e:
        shutil.rmtree(bdir, ignore_errors=True)
        return {"ok": False, "error": f"Failed to invoke javac: {e}"}

    if cp.returncode != 0:
        err = cp.stderr or cp.stdout or "javac failed with non-zero exit code"
        shutil.rmtree(bdir, ignore_errors=True)
        return {"ok": False, "error": err}

    main_class = "Solution"
    if not (bdir / "Solution.class").exists():
        classes = [p.stem for p in bdir.glob("*.class")]
        if not classes:
            shutil.rmtree(bdir, ignore_errors=True)
            return {"ok": False, "error": "No .class file produced by javac"}
        main_class = classes[0]

    entry = {"ok": True, "buildId": build_id, "mainClass": main_class, "dir": str(bdir)}
    with _builds_lock:
        _builds_cache[source_hash] = entry
    return entry


def run_java_test(build_info, input_text: str, time_limit_ms: int = 10000):
    bdir = Path(build_info["dir"])
    if not bdir.exists():
        return {"ok": False, "verdict": "RE", "error": "Build cache expired"}

    main_class = build_info["mainClass"]
    timeout_s = max(0.5, (time_limit_ms + 1000) / 1000.0)

    cmd = [
        "java",
        "-Xmx256m",
        "-Xss8m",
        "-Dfile.encoding=UTF-8",
        "-cp", str(bdir),
        main_class
    ]

    t0 = time.perf_counter()
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = proc.communicate(input=input_text, timeout=timeout_s)
        wall_ms = (time.perf_counter() - t0) * 1000.0

        if proc.returncode != 0:
            return {"ok": False, "verdict": "RE", "error": stderr or f"Process exited with {proc.returncode}", "timeMs": wall_ms}
        if wall_ms > time_limit_ms:
            return {"ok": False, "verdict": "TLE", "error": f"Time Limit Exceeded ({wall_ms:.0f} ms > {time_limit_ms} ms)", "timeMs": wall_ms}
        return {"ok": True, "stdout": stdout, "timeMs": wall_ms}
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=0.5)
        except Exception:
            pass
        return {"ok": False, "verdict": "TLE", "error": f"Time Limit Exceeded (>{time_limit_ms} ms)", "timeMs": time_limit_ms}
    except Exception as e:
        return {"ok": False, "verdict": "RE", "error": str(e), "timeMs": 0}


def handle_java_judge(payload: dict):
    action = payload.get("action", "")
    source = payload.get("source", "")
    clean_source = normalize_java_source(source)
    remote_url = os.environ.get("JAVA_JUDGE_URL", "").strip()

    # -------------------------------------------------------------
    # 1. ACTION: compile
    # -------------------------------------------------------------
    if action == "compile":
        if not source.strip():
            return {"ok": False, "log": "Empty source code"}

        art_id = f"art_{hashlib.sha256(source.encode()).hexdigest()[:16]}"
        with _builds_lock:
            _java_source_cache[art_id] = clean_source

        if remote_url:
            try:
                req_data = json.dumps({"source": clean_source, "tests": []}).encode("utf-8")
                req = urllib.request.Request(
                    remote_url,
                    data=req_data,
                    headers={"Content-Type": "application/json", "User-Agent": "CodeArena-VM"}
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    if data.get("verdict") == "CE":
                        return {"ok": False, "log": data.get("compileError", "Compilation error")}
                    return {"ok": True, "artifactId": art_id, "log": ""}
            except Exception as e:
                print(f"⚠️ [JUDGE] Remote compile failed ({remote_url}): {e}")
                if not (shutil.which("javac") and shutil.which("java")):
                    return {"ok": False, "log": f"Java judge unavailable: {e}"}

        # Local compile fallback
        cres = compile_java(clean_source)
        if not cres.get("ok"):
            return {"ok": False, "log": cres.get("error", "Compilation failed")}
        return {"ok": True, "artifactId": cres.get("buildId", art_id), "log": ""}

    # -------------------------------------------------------------
    # 2. ACTION: run
    # -------------------------------------------------------------
    if action == "run":
        art_id = payload.get("artifactId", "")
        with _builds_lock:
            src = payload.get("source") or _java_source_cache.get(art_id, "")
        clean_src = normalize_java_source(src)
        if not clean_src:
            return {"status": "RE", "stdout": "", "stderr": "Source code not found for artifact", "timeMs": 0}

        inp = payload.get("input", "")
        time_limit_ms = max(int(payload.get("timeLimitMs") or 10000), 10000)

        if remote_url:
            try:
                req_data = json.dumps({
                    "source": clean_src,
                    "tests": [{"input": inp}],
                    "timeLimitMs": time_limit_ms
                }).encode("utf-8")
                req = urllib.request.Request(
                    remote_url,
                    data=req_data,
                    headers={"Content-Type": "application/json", "User-Agent": "CodeArena-VM"}
                )
                with urllib.request.urlopen(req, timeout=max(20, (time_limit_ms / 1000.0) + 10)) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    verdict = data.get("verdict", "RE")
                    time_ms = round(data.get("timeMs", 0))

                    if verdict in ("AC", "WA"):
                        return {"status": "OK", "stdout": data.get("got", ""), "stderr": "", "timeMs": time_ms}
                    elif verdict == "TLE":
                        return {"status": "TLE", "stdout": "", "stderr": data.get("error", "Time Limit Exceeded"), "timeMs": time_limit_ms}
                    elif verdict == "CE":
                        return {"status": "CE", "stdout": "", "stderr": data.get("compileError", "Compilation error"), "timeMs": 0}
                    else:
                        return {"status": "RE", "stdout": "", "stderr": data.get("error", "Runtime error"), "timeMs": time_ms}
            except Exception as e:
                print(f"⚠️ [JUDGE] Remote run failed ({remote_url}): {e}")
                if not (shutil.which("javac") and shutil.which("java")):
                    return {"status": "RE", "stdout": "", "stderr": f"Cloud Run execution failed: {e}", "timeMs": 0}

        # Local run fallback
        cres = compile_java(clean_src)
        if not cres.get("ok"):
            return {"status": "CE", "stdout": "", "stderr": cres.get("error", "Compilation failed"), "timeMs": 0}
        run_res = run_java_test(cres, inp, time_limit_ms)
        if run_res.get("ok"):
            return {"status": "OK", "stdout": run_res.get("stdout", ""), "stderr": "", "timeMs": round(run_res.get("timeMs", 0))}
        else:
            verdict = run_res.get("verdict", "RE")
            return {"status": verdict, "stdout": "", "stderr": run_res.get("error", ""), "timeMs": round(run_res.get("timeMs", 0))}

    # -------------------------------------------------------------
    # 3. ACTION: clean
    # -------------------------------------------------------------
    if action == "clean":
        art_id = payload.get("artifactId", "")
        with _builds_lock:
            _java_source_cache.pop(art_id, None)
        return {"ok": True}

    # -------------------------------------------------------------
    # 4. BATCH MODE (source + tests)
    # -------------------------------------------------------------
    tests = payload.get("tests", [])
    time_limit_ms = max(int(payload.get("timeLimitMs") or 10000), 10000)

    if remote_url:
        try:
            req_data = json.dumps({
                "source": clean_source,
                "tests": tests,
                "timeLimitMs": time_limit_ms
            }).encode("utf-8")
            req = urllib.request.Request(
                remote_url,
                data=req_data,
                headers={"Content-Type": "application/json", "User-Agent": "CodeArena-VM"}
            )
            with urllib.request.urlopen(req, timeout=35) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"⚠️ [JUDGE] Remote batch judge error ({remote_url}): {e}")
            return {
                "ok": True,
                "verdict": "NJ",
                "error": f"Cloud Run Java Judge unavailable: {e}",
                "passed": 0,
                "total": len(tests)
            }

    # Local batch execution fallback
    cres = compile_java(clean_source)
    if not cres.get("ok"):
        return {"ok": True, "verdict": "CE", "compileError": cres.get("error", "Compilation failed"), "passed": 0, "total": len(tests)}

    passed = 0
    max_ms = 0.0
    results = []

    for idx, test in enumerate(tests):
        inp = test.get("input", "")
        exp = test.get("output", "")
        run_res = run_java_test(cres, inp, time_limit_ms)

        if not run_res.get("ok"):
            return {
                "ok": True,
                "verdict": run_res.get("verdict", "RE"),
                "failedTest": idx + 1,
                "passed": passed,
                "total": len(tests),
                "error": run_res.get("error", ""),
                "timeMs": max_ms
            }

        got = run_res.get("stdout", "")
        max_ms = max(max_ms, run_res.get("timeMs", 0))

        if got.strip().splitlines() != exp.strip().splitlines():
            return {
                "ok": True,
                "verdict": "WA",
                "failedTest": idx + 1,
                "passed": passed,
                "total": len(tests),
                "got": got[:1000],
                "expected": exp[:1000],
                "timeMs": max_ms
            }
        passed += 1

    return {"ok": True, "verdict": "AC", "passed": passed, "total": len(tests), "timeMs": max_ms}


# =============================================================================
# FIRESTORE & FIREBASE AUTHENTICATION
# =============================================================================

FIREBASE_APP = None
FIREBASE_DB = None
SERVICE_ACCOUNT_PATH = ROOT / "serviceAccountKey.json"

def get_firebase_config():
    cfg = {
        "apiKey": os.environ.get("FIREBASE_API_KEY", ""),
        "projectId": os.environ.get("FIREBASE_PROJECT_ID", "codearena-31947"),
        "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", "codearena-31947.firebaseapp.com"),
        "requirePaid": os.environ.get("FIREBASE_REQUIRE_PAID", "true").lower() in ("1", "true", "yes"),
        "devDemoMode": os.environ.get("FIREBASE_DEV_DEMO_MODE", "false").lower() in ("1", "true", "yes"),
    }
    if FIREBASE_CONFIG_PATH.exists():
        try:
            with open(FIREBASE_CONFIG_PATH, "r", encoding="utf-8") as f:
                f_cfg = json.load(f)
                for k in ["apiKey", "projectId", "authDomain", "requirePaid", "devDemoMode"]:
                    if k in f_cfg and f_cfg[k] is not None:
                        cfg[k] = f_cfg[k]
        except Exception as e:
            print(f"⚠️ [FIREBASE] Error reading firebase-config.json: {e}")
    return cfg


def get_firestore_client():
    global FIREBASE_APP, FIREBASE_DB
    if FIREBASE_DB is not None:
        return FIREBASE_DB
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        if not firebase_admin._apps:
            if SERVICE_ACCOUNT_PATH.exists():
                cred = credentials.Certificate(str(SERVICE_ACCOUNT_PATH))
                FIREBASE_APP = firebase_admin.initialize_app(cred)
            else:
                FIREBASE_APP = firebase_admin.initialize_app()
        FIREBASE_DB = firestore.client()
        print("🔥 [FIREBASE] Firestore Admin Client initialized successfully.")
        return FIREBASE_DB
    except Exception as e:
        print(f"⚠️ [FIREBASE] Could not initialize Firestore client: {e}")
        return None


def verify_student_credentials(roll: str, password: str):
    clean_roll = str(roll).strip().upper()
    if not clean_roll or not password:
        return False, "Please enter both Roll Number and Password.", None

    cfg = get_firebase_config()
    api_key = cfg.get("apiKey", "").strip() or "AIzaSyAS8NMWRcKyU-6WK791X5QXy7lV4QgcNgU"
    require_paid = cfg.get("requirePaid", True)
    dev_demo = cfg.get("devDemoMode", False)

    fs_db = get_firestore_client()
    student_name = clean_roll
    student_uid = None

    # Step 1: Verify student exists in Firestore database
    if fs_db:
        try:
            matches = list(fs_db.collection("registrations").where("roll", "==", clean_roll).limit(1).stream())
            if not matches:
                # Also try case-insensitive or exact document id lookup
                matches = list(fs_db.collection("registrations").where("roll", "==", clean_roll.lower()).limit(1).stream())
            if not matches:
                return False, f"Roll number {clean_roll} is not registered in the system. Please register first.", None

            doc = matches[0]
            data = doc.to_dict()
            student_uid = doc.id
            student_name = data.get("name") or clean_roll

            if require_paid:
                is_paid = data.get("payment") == "paid" or data.get("paid") is True
                if not is_paid:
                    return False, f"Registration found for {clean_roll}, but fee payment is incomplete.", None
        except Exception as e:
            print(f"⚠️ [FIRESTORE] Warning during registration lookup: {e}")

    # Step 2: Authenticate password against Firebase Auth
    emails_to_try = [
        f"{clean_roll.lower()}@students.codearena.local",
        f"{clean_roll.lower()}_v2@students.codearena.local"
    ]

    auth_res = None
    last_err_msg = ""
    for email in emails_to_try:
        auth_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key}"
        auth_payload = json.dumps({
            "email": email,
            "password": password,
            "returnSecureToken": True
        }).encode("utf-8")
        req = urllib.request.Request(auth_url, data=auth_payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                auth_res = json.loads(resp.read().decode())
                break
        except urllib.error.HTTPError as e:
            try:
                err_data = json.loads(e.read().decode())
                last_err_msg = err_data.get("error", {}).get("message", "")
            except Exception:
                last_err_msg = str(e)
        except Exception as e:
            if dev_demo:
                print(f"⚠️ [FIREBASE] Dev demo mode fallback: {e}")
                return True, None, {"roll": clean_roll, "name": student_name, "uid": student_uid or f"demo_{clean_roll.lower()}"}
            return False, f"Could not connect to Firebase: {e}", None

    if not auth_res:
        if "INVALID_PASSWORD" in last_err_msg or "INVALID_LOGIN_CREDENTIALS" in last_err_msg:
            return False, f"Incorrect password for roll number {clean_roll}. Please enter your registered password.", None
        if "EMAIL_NOT_FOUND" in last_err_msg:
            return False, f"Roll number {clean_roll} has not created a password yet. Please complete registration.", None
        return False, "Invalid Roll Number or Password.", None

    uid = auth_res.get("localId") or student_uid
    return True, None, {"roll": clean_roll, "name": student_name, "uid": uid}


# =============================================================================
# HTTP REQUEST HANDLER
# =============================================================================

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".wav": "audio/x-wav"
    }

    def __init__(self, *args, problems=None, **kwargs):
        self.problems = problems or {}
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def is_admin(self):
        token = self.headers.get("X-Admin-Token") or self.headers.get("Authorization", "").replace("Bearer ", "").strip()
        pwd = self.headers.get("X-Admin-Password")
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        from urllib.parse import parse_qs
        qs = parse_qs(query)
        q_token = qs.get("token", [""])[0]
        q_key = qs.get("key", [""])[0] or qs.get("admin_key", [""])[0]

        if pwd == ADMIN_PASSWORD or q_key == ADMIN_PASSWORD:
            return True
        if token == ADMIN_TOKEN or q_token == ADMIN_TOKEN:
            return True
        return False

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        # Permissive CORS headers so external Firestore pages and API clients connect without issue
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- Routes ----------
    def do_GET(self):
        req_path = self.path.split("?")[0]

        # Contest state for contestants and admin
        if req_path == "/api/contest/state":
            from urllib.parse import parse_qs
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            roll = parse_qs(query).get("roll", [None])[0]
            return self.json(HTTPStatus.OK, get_contest_state(roll))

        # Scoreboard
        if req_path == "/api/scoreboard":
            return self.json(HTTPStatus.OK, scoreboard(load_problems()))

        # Admin APIs (Protected)
        if req_path == "/api/admin/state":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            return self.json(HTTPStatus.OK, {
                "contest": get_contest_state(),
                "kicked": get_kicked_users(),
                "violations": get_security_violations()
            })

        if req_path == "/api/admin/violations":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            return self.json(HTTPStatus.OK, {"violations": get_security_violations()})

        if req_path in ("/api/submissions", "/api/admin/submissions"):
            return self.json(HTTPStatus.OK, {"submissions": get_recent_submissions()})

        if req_path == "/api/admin/kicked":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            return self.json(HTTPStatus.OK, {"kicked": get_kicked_users()})

        # Admin Lockdown Policy
        if req_path == "/api/admin/lockdown/policy":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            return self.json(HTTPStatus.OK, {"policy": get_lockdown_policy()})

        # Admin Question Management
        if req_path == "/api/admin/questions":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            return self.json(HTTPStatus.OK, {"questions": get_all_questions_admin()})

        if req_path == "/api/admin/question":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            from urllib.parse import parse_qs
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            qid = parse_qs(query).get("id", [None])[0]
            if not qid:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Missing question ID"})
            question, tests = get_question_admin(qid)
            if not question:
                return self.json(HTTPStatus.NOT_FOUND, {"error": "Question not found"})
            return self.json(HTTPStatus.OK, {"question": question, "tests": tests})

        if (req_path.startswith("/api/admin/submission/") and req_path.endswith("/source")) or req_path == "/api/admin/source":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            from urllib.parse import parse_qs
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            sub_id = parse_qs(query).get("id", [None])[0]
            if not sub_id and "/api/admin/submission/" in req_path:
                sub_id = req_path.split("/")[4]
            data = get_submission_source(int(sub_id)) if sub_id else None
            if not data:
                return self.json(HTTPStatus.NOT_FOUND, {"error": "Submission not found"})
            return self.json(HTTPStatus.OK, data)

        if req_path == "/api/judge/java":
            return self.json(HTTPStatus.OK, java_ping())

        if req_path == "/api/auth/config":
            cfg = get_firebase_config()
            return self.json(HTTPStatus.OK, {
                "projectId": cfg.get("projectId"),
                "authDomain": cfg.get("authDomain"),
                "hasApiKey": bool(cfg.get("apiKey")),
                "requirePaid": cfg.get("requirePaid", True),
                "devDemoMode": cfg.get("devDemoMode", False)
            })

        return super().do_GET()

    def do_POST(self):
        req_path = self.path.split("?")[0]

        # Student Authentication & Firestore Verification
        if req_path == "/api/auth/login":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid request format"})
            roll = payload.get("roll", "")
            password = payload.get("password", "")
            ok, err, user = verify_student_credentials(roll, password)
            if not ok:
                return self.json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": err or "Invalid credentials"})
            return self.json(HTTPStatus.OK, {"ok": True, "user": user})

        # Admin Login
        if req_path == "/api/admin/login":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            if payload.get("password") == ADMIN_PASSWORD:
                return self.json(HTTPStatus.OK, {"ok": True, "token": ADMIN_TOKEN})
            return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Invalid admin password"})

        # Admin Timer Controls
        if req_path == "/api/admin/timer":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            action = payload.get("action", "")
            minutes = payload.get("minutes", 0)
            new_state = update_contest_timer(action, minutes)
            return self.json(HTTPStatus.OK, {"ok": True, "state": new_state})

        # Admin Kick Contestant
        if req_path == "/api/admin/kick":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            roll = payload.get("roll")
            name = payload.get("name", "")
            reason = payload.get("reason", "Disqualified by administrator")
            if not roll:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Missing roll number"})
            return self.json(HTTPStatus.OK, kick_user(roll, name, reason))

        # Security Violation Report (submitted by client when window un-focuses)
        if req_path == "/api/security/violation":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            roll = payload.get("roll")
            name = payload.get("name", "")
            event_type = payload.get("type", "window-blur")
            detail = payload.get("detail", "Contest window unfocused")
            ts = payload.get("timestamp")
            if not roll:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Missing roll number"})
            ip = self.client_address[0]
            return self.json(HTTPStatus.OK, record_security_violation(roll, name, event_type, detail, ts, ip))

        # Admin Unblock Contestant
        if req_path == "/api/admin/unblock":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            roll = payload.get("roll")
            if not roll:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Missing roll number"})
            return self.json(HTTPStatus.OK, unblock_user(roll))

        # Admin Broadcast Announcement
        if req_path == "/api/admin/announcement":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            msg = payload.get("announcement", "")
            return self.json(HTTPStatus.OK, set_announcement(msg))

        # Admin Update Lockdown Policy
        if req_path == "/api/admin/lockdown/policy":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return self.json(HTTPStatus.OK, {"ok": True, "policy": update_lockdown_policy(payload)})

        # Admin Wipe / Reset Contest
        if req_path == "/api/admin/reset":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                payload = {}
            wipe_subs = payload.get("wipeSubmissions", True)
            reset_timer = payload.get("resetTimer", True)
            return self.json(HTTPStatus.OK, reset_contest(wipe_subs, reset_timer))

        # Admin Question Save / Update
        if req_path == "/api/admin/question/save":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > 25 * 1024 * 1024:  # up to 25MB for large test suites
                return self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Payload exceeds 25MB limit"})
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception as e:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid JSON: {e}"})

            q_data = payload.get("question") if "question" in payload else payload
            tests_data = payload.get("tests", None)
            ok, result = save_question_admin(q_data, tests_data)
            if not ok:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": result})
            self.problems = load_problems()
            return self.json(HTTPStatus.OK, {"ok": True, "message": "Question saved successfully", "question": result})

        # Admin Question Delete
        if req_path == "/api/admin/question/delete":
            if not self.is_admin():
                return self.json(HTTPStatus.UNAUTHORIZED, {"error": "Admin password required"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            qid = payload.get("id")
            if not qid:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "Missing question ID"})
            ok, msg = delete_question_admin(qid)
            if not ok:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": msg})
            self.problems = load_problems()
            return self.json(HTTPStatus.OK, {"ok": True, "message": msg})

        # Java Execution
        if req_path == "/api/judge/java":
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_JUDGE_BODY:
                return self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return self.json(HTTPStatus.OK, handle_java_judge(payload))

        # Submissions
        if req_path != "/api/submissions":
            return self.json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
        try:
            sub = json.loads(self.rfile.read(length))
            assert isinstance(sub, dict) and sub.get("roll") and sub.get("problem") and sub.get("verdict")
        except Exception:
            return self.json(HTTPStatus.BAD_REQUEST, {"error": "invalid submission"})

        # Check if contestant is kicked/disqualified
        roll = str(sub.get("roll", "")).strip().upper()
        if db.query_row("SELECT reason FROM kicked_users WHERE roll = ?", (roll,)):
            return self.json(HTTPStatus.FORBIDDEN, {"error": "Contestant is disqualified"})

        sub["receivedAt"] = int(time.time() * 1000)
        sub["ip"] = self.client_address[0]
        save_submission(sub)
        return self.json(HTTPStatus.CREATED, {"ok": True})

    def log_message(self, fmt, *args):
        p = getattr(self, "path", "")
        if not (p.startswith("/api/scoreboard") or p.startswith("/api/contest/state") or p.startswith("/api/submissions") or p.startswith("/api/judge/java?action=ping")):
            super().log_message(fmt, *args)


def main():
    global db
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5517)))
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--postgres", "--db", default=os.environ.get("DATABASE_URL"), help="PostgreSQL connection URL (e.g. postgresql://user:pass@localhost:5432/codearena)")
    args = ap.parse_args()

    # Initialize Database (PostgreSQL with graceful SQLite fallback)
    db = DBManager(postgres_url=args.postgres)
    init_db()

    # Clean temporary builds if any
    if JAVA_BUILDS.exists():
        shutil.rmtree(JAVA_BUILDS, ignore_errors=True)
    JAVA_BUILDS.mkdir(parents=True, exist_ok=True)

    problems = load_problems()
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, problems=problems))

    db_type = "PostgreSQL" if db.is_postgres else "SQLite"
    print(f"⚡ CODE//ARENA active on http://localhost:{args.port} (Database: {db_type})")
    print(f"📊 Contest Problems: {', '.join(problems)}")
    print(f"🛡️  Admin Dashboard: http://localhost:{args.port}/admin.html (Password: {ADMIN_PASSWORD})")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if JAVA_BUILDS.exists():
            shutil.rmtree(JAVA_BUILDS, ignore_errors=True)


if __name__ == "__main__":
    main()
