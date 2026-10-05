# CODE//ARENA — contest client

A lightweight coding-contest platform that judges code **inside the contestant's browser**. It's built to run under Safe Exam Browser (SEB), but works in any modern browser while you test it.

```bash
python3 serve.py
```

Then open <http://localhost:5517>. The default access code is `ARENA-2026`.

Only Python 3 is needed. There's no build step and nothing to install.

---

## Screens

1. **Login.** Full name, roll number / student ID, and contest access code → **Enter contest**.
2. **Arena.**
   - **Left:** the problem (Markdown), constraints, samples with copy buttons, and a **Scoreboard & status** tab showing your score, per-problem status, the live scoreboard and your submissions.
   - **Right:** a Monaco editor with Python 3, C++17, C17 and Java 21, per-problem starter code, and **Run sample tests** (Ctrl/⌘ + Enter) and **Submit solution** (Ctrl/⌘ + Shift + Enter).
   - **Bottom drawer:** a terminal-style console that streams `In Queue` → `Compiling` → `Running Test 3/8` → the verdict (`AC`, `WA`, `TLE`, `RE`, `CE`, `OLE`). Its "Test results" tab shows expected and actual output for samples. Hidden test data is never shown.

Code autosaves per problem and language. A page refresh or an accidental "End session" loses nothing, and the contest clock keeps running per roll number. When time runs out, the editor becomes read-only and Run and Submit are disabled.

## How judging works

```
 UI thread (never runs contestant code)
   │  judge.js: queue → compile → for each test: post to worker + start 2.0 s watchdog
   │                                   ├─ worker answers first  → compare output → AC / WA / RE …
   │                                   └─ watchdog fires first  → worker.terminate() → TLE
   ▼
 Web Workers (one per runtime, respawned after a kill)
   python.worker.js  Pyodide 0.29 (CPython → WASM)
   clang.worker.js   Clang 21 + wasm-ld (→ WASM)  ──.wasm──▶  wasi.worker.js  runs the program
   jscpp.worker.js   JSCPP interpreter (optional light C/C++ engine)
   java.worker.js    placeholder (structural check only, see below)
```

- **Infinite loops can't freeze the page.** Contestant code only runs in workers. A test that doesn't answer within the time limit (2.0 s by default, set per problem) gets its worker killed with `terminate()`. The next test gets a fresh worker. Loading or reloading a runtime is never counted against the time limit.
- **Short-circuiting.** A submission stops at the first test that isn't Accepted and reports that verdict, for example `Wrong Answer on test 3`. Running samples executes every sample so you see all the diffs.
- **Comparison** ignores trailing spaces on each line and trailing blank lines.
- **Sandboxing.** Before contestant code runs, each worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, IndexedDB and similar APIs. Without this, Python code could `import js` and download the hidden answers. Compiled C/C++ programs get only a minimal WASI shim: stdin, stdout and stderr, with no files and no network.

| Language | Engine | First load | Notes |
|---|---|---|---|
| Python 3 | Pyodide | ~10 MB from CDN, then cached | Standard library only (no numpy). Recursion depth is bounded by the browser stack. |
| C++17 / C17 | Clang 21 → WebAssembly | ~23 MB from CDN, then cached for a year | Real compiler: full STL, `<bits/stdc++.h>`, `-O2`, 256 MB memory limit, 8 MB stack. Compiles take about 1–2 s. Exceptions are disabled (`-fno-exceptions`). |
| C/C++ (optional) | JSCPP | bundled, 430 KB | Set `cppEngine: 'jscpp'`. Tiny, but a subset of C++ (no STL or `std::string`) and thousands of times slower. Only for emergencies. |
| Java 21 | placeholder | — | See "Java" below. |

The runtime for the selected language starts loading as soon as the arena opens, while the contestant reads the problem.

**Java.** No JVM plus `javac` currently runs well inside a Web Worker. The Java worker uses the same message protocol as the others and checks the code's structure (braces, `class Main`, `main(String[])`). It then returns **Not Judged**. Those submissions are saved and sent to the server, but they don't count as attempts. To add real Java support, replace `public/workers/java.worker.js` with a runtime that uses the same protocol (`init` → `ready`, `compile` → `compiled`, `run` → `result`). Nothing else needs to change.

## Safe Exam Browser

There are two layers, and production needs both.

| | Test mode (now) | Production |
|---|---|---|
| `public/js/config.js` | `ENABLE_SEB_CHECK = false` | `ENABLE_SEB_CHECK = true` |
| Server | `python3 serve.py` | `SEB_CONFIG_KEYS=<key> python3 serve.py --seb` |

- **In the page** (`js/seb.js`): this layer requires SEB's user agent or its JavaScript API. If you list your Config Key in `CONFIG.seb.configKeys`, it also checks `SafeExamBrowser.security.configKey` against `SHA-256(page URL + Config Key)`, which proves the contestant is using *your* `.seb` file.
- **On the server** (`serve.py --seb`): this layer checks every request's `X-SafeExamBrowser-ConfigKeyHash` (or `X-SafeExamBrowser-RequestHash`) header against `SHA-256(absolute URL + key)`. It returns **403** otherwise, so a normal browser never receives the page or the hidden tests. If you run behind a reverse proxy, set `SEB_PUBLIC_ORIGIN=https://contest.example.edu` so URLs are hashed exactly as SEB sees them.

**SEB configuration checklist**

1. Start URL: `http(s)://<server>:5517/`.
2. Turn on "Send Config Key", then copy the Config Key into `SEB_CONFIG_KEYS` (and optionally `CONFIG.seb.configKeys`).
3. Allow these hosts in the URL filter: `cdn.jsdelivr.net` (Pyodide, Clang), `cdnjs.cloudflare.com` (Monaco), and `fonts.googleapis.com` / `fonts.gstatic.com`. For an offline lab, mirror them and point `CONFIG.cdn` at the mirror. If Monaco is blocked, the app falls back to a basic editor automatically.
4. Rehearse once with your exact SEB version. SEB versions differ in which requests (worker scripts, `fetch`) carry the hash headers.

## Running a contest

- **Access codes:** the code itself never ships, only its hash. Get one with `printf 'NEW-CODE' | shasum -a 256` and paste it into `CONFIG.accessCodeHashes`.
- **Timing:** `durationMin` (counted from each contestant's first login) or a fixed `contestEnd`.
- **Results:** every judged submission, *including its source code*, is appended to `results/submissions.jsonl`. `GET /api/scoreboard` ranks contestants by score, then penalty: minutes to solve plus 10 per earlier wrong attempt. CE and Not Judged add no penalty. If the server can't be reached, results queue in the browser and sync when it's back.
- **Problems:** edit `public/js/problems.js` (Markdown statement, constraints, samples). Then add a generator and reference solution in `tools/build_tests.py` and run `python3 tools/build_tests.py`. It checks the reference against your samples and writes `public/data/tests/<ID>.json`. `tools/` is never served.

## Security model and known limits

This is client-side judging. That's a deliberate trade-off (no judge servers) with consequences you should know:

- **Verdicts are computed and reported by the contestant's browser.** Inside SEB (no devtools, no other apps) that's reasonable for a campus round. A determined attacker in an ordinary browser could forge a submission. For high-stakes rounds, re-judge `results/submissions.jsonl` (the source is stored) on a trusted machine before announcing winners.
- Hidden tests reach the browser when a solution is submitted. Contestant code can't read them (worker lockdown), but someone with devtools could. SEB is what prevents that.
- Memory limits are enforced only for C/C++ (WebAssembly max memory). Very deep recursion (above about 10k frames) overflows the browser stack and shows up as a Runtime Error with a hint.
- Timing is wall-clock on the contestant's machine, so a slow lab PC is slower. The 2 s default leaves wide headroom: reference solutions run in 2–20 ms.

## Files

```
serve.py                 static server + SEB header check + results API (stdlib only)
tools/build_tests.py     hidden-test generator with reference solutions (not served)
public/
  index.html             the three screens (SEB required · login · arena)
  css/app.css            design tokens and components carried over from the template
  js/config.js           ← organisers edit this
  js/problems.js         problem statements, samples, starter code
  js/app.js              login + arena UI, scoring, result sync
  js/judge.js            worker hosts, watchdog, short-circuit, verdicts
  js/editor.js           Monaco + fallback editor
  js/seb.js              SEB detection + SHA-256
  workers/*.worker.js    one file per runtime, same message protocol
  vendor/                marked (Markdown), JSCPP
  data/tests/*.json      hidden tests (generated)
```
# code-arena-test
