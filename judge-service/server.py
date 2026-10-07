#!/usr/bin/env python3
"""CODE//ARENA Standalone Java Judge Service for Google Cloud Run

Receives Java code and test cases over HTTP POST, compiles with javac in an isolated
sandbox directory, executes test cases with strict CPU/memory limits, and returns verdicts.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8080"))
HOST = "0.0.0.0"
JAVA_BUILDS = Path("/tmp/java_builds")
JAVA_BUILDS.mkdir(parents=True, exist_ok=True)

_builds_lock = threading.Lock()
_builds_cache = {}


def normalize_java_source(source: str) -> str:
    if not source:
        return ""
    return re.sub(r'\bpublic\s+(class|interface|enum|record)\b', r'\1', source)


def compile_java(source: str):
    source = normalize_java_source(source)
    source_hash = hashlib.sha256(source.encode()).hexdigest()
    with _builds_lock:
        cached = _builds_cache.get(source_hash)
        if cached and Path(cached["dir"]).exists():
            return cached

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
        err = cp.stderr or cp.stdout or "javac compilation failed"
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


def run_java_test(build_info, input_text: str, time_limit_ms: int = 2000):
    bdir = Path(build_info["dir"])
    if not bdir.exists():
        return {"ok": False, "verdict": "RE", "error": "Build cache expired"}

    main_class = build_info["mainClass"]
    timeout_s = max(0.2, (time_limit_ms + 400) / 1000.0)

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


def execute_judge(payload: dict):
    source = payload.get("source", "")
    tests = payload.get("tests", [])
    time_limit_ms = int(payload.get("timeLimitMs") or 2000)

    cres = compile_java(source)
    if not cres.get("ok"):
        return {
            "ok": True,
            "verdict": "CE",
            "compileError": cres.get("error", "Compilation failed"),
            "passed": 0,
            "total": len(tests)
        }

    passed = 0
    max_ms = 0.0

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


class JudgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging
        print(f"[{self.log_date_time_string()}] {self.command} {self.path} - {args[0]}")

    def send_json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        # Health check & version ping
        self.send_json(HTTPStatus.OK, {
            "ok": True,
            "status": "online",
            "service": "codearena-java-judge",
            "version": "Java 21 (Eclipse Temurin / OpenJDK)"
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 25 * 1024 * 1024:
            return self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "Payload exceeds 25MB limit"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Invalid JSON payload: {e}"})

        action = payload.get("action")
        if action == "compile":
            source = payload.get("source", "")
            res = compile_java(source)
            if not res.get("ok"):
                return self.send_json(HTTPStatus.OK, {"ok": False, "log": res.get("error", "Compilation failed")})
            return self.send_json(HTTPStatus.OK, {"ok": True, "artifactId": res.get("buildId"), "log": ""})

        if action == "run":
            source = payload.get("source", "")
            inp = payload.get("input", "")
            limit = int(payload.get("timeLimitMs") or 2000)
            res = compile_java(source)
            if not res.get("ok"):
                return self.send_json(HTTPStatus.OK, {"status": "CE", "stdout": "", "stderr": res.get("error", "Compilation failed"), "timeMs": 0})
            run_res = run_java_test(res, inp, limit)
            if run_res.get("ok"):
                return self.send_json(HTTPStatus.OK, {"status": "OK", "stdout": run_res.get("stdout", ""), "stderr": "", "timeMs": round(run_res.get("timeMs", 0))})
            else:
                verdict = run_res.get("verdict", "RE")
                return self.send_json(HTTPStatus.OK, {"status": verdict, "stdout": "", "stderr": run_res.get("error", ""), "timeMs": round(run_res.get("timeMs", 0))})

        if action == "clean":
            return self.send_json(HTTPStatus.OK, {"ok": True})

        result = execute_judge(payload)
        self.send_json(HTTPStatus.OK, result)


def run_server():
    server = ThreadingHTTPServer((HOST, PORT), JudgeHandler)
    print(f"🚀 CodeArena Java Judge listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
