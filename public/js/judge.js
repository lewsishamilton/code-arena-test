/* =========================================================================
   Judge: runs contestant code in Web Workers under a watchdog.

   Every test is posted to a worker and raced against a timer. If the timer
   wins, the worker is terminated on the spot (the only way to stop a
   synchronous infinite loop) and the test is Time Limit Exceeded. The UI
   thread never executes contestant code, so it can't freeze.

   Runtime warm-up (downloading Pyodide or Clang) happens before the timer
   starts and never counts against the time limit.
   ========================================================================= */
import { CONFIG } from './config.js';

export const VERDICTS = {
  AC: { label: 'Accepted', short: 'AC', tone: 'ok' },
  WA: { label: 'Wrong Answer', short: 'WA', tone: 'bad' },
  TLE: { label: 'Time Limit Exceeded', short: 'TLE', tone: 'warn' },
  RE: { label: 'Runtime Error', short: 'RE', tone: 'bad' },
  CE: { label: 'Compilation Error', short: 'CE', tone: 'bad' },
  OLE: { label: 'Output Limit Exceeded', short: 'OLE', tone: 'bad' },
  NJ: { label: 'Not Judged', short: 'NJ', tone: 'neutral' },
  IE: { label: 'Judge Error', short: 'IE', tone: 'neutral' }
};

const LOAD_TIMEOUT_MS = 600000;   // first-time runtime download (~12 MB for Python) on a slow, shared lab network

/* ---------- One worker, restartable ---------- */
class WorkerHost {
  constructor(name, url, { module = false } = {}) {
    this.name = name; this.url = url; this.module = module;
    this.worker = null; this.readyPromise = null; this.isReady = false; this.pending = new Map();
    this.onLoading = null;   // (message, done, total) — set by whoever is waiting
    this.seq = 0;
  }

  /** Spawn (if needed) and wait for the runtime inside to finish loading. */
  ready() {
    if (this.readyPromise) return this.readyPromise;
    const worker = new Worker(new URL(this.url, import.meta.url), this.module ? { type: 'module' } : undefined);
    this.worker = worker;
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(`${this.name} runtime could not be downloaded within ${LOAD_TIMEOUT_MS / 60000} min. Check the internet connection and press Run again.`), LOAD_TIMEOUT_MS);
      const fail = message => { clearTimeout(timer); this.kill(); reject(new Error(message)); };
      worker.onerror = e => { e.preventDefault?.(); fail(e.message || `${this.name} worker failed to start`); };
      worker.onmessage = ({ data }) => {
        if (data.type === 'loading') this.onLoading?.(data.message, data.done, data.total);
        else if (data.type === 'fatal') fail(data.message);
        else if (data.type === 'ready') { clearTimeout(timer); this.isReady = true; worker.onmessage = e => this.dispatch(e.data); worker.onerror = e => this.crash(e); resolve(); }
      };
      worker.postMessage({ type: 'init', cdn: CONFIG.cdn });
    });
    return this.readyPromise;
  }

  dispatch(data) {
    const job = this.pending.get(data.id);
    if (!job) return;
    this.pending.delete(data.id);
    clearTimeout(job.timer);
    job.resolve(data);
  }

  crash(e) {
    e?.preventDefault?.();
    const message = e?.message || 'Worker crashed';
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.resolve({ crashed: true, message }); }
    this.pending.clear();
    this.kill();
  }

  /**
   * Post one request and race it against `timeoutMs`.
   * Resolves { timedOut: true, elapsedMs } if the watchdog fires — by then the worker is gone.
   */
  async call(msg, timeoutMs, transfer = []) {
    await this.ready();
    const id = ++this.seq;
    return new Promise(resolve => {
      const started = performance.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();                                   // hard stop: worker.terminate()
        resolve({ timedOut: true, elapsedMs: performance.now() - started });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.isReady = false;
  }

  /** Start loading in the background; errors surface on the next real call. */
  prewarm() { this.ready().catch(() => {}); }
}

const hosts = {};
const host = (key, url, opts) => (hosts[key] ||= new WorkerHost(key, url, opts));

/* ---------- Engines: prepare (compile) once, then run each test ---------- */
const ENGINES = {
  python: () => {
    const h = host('Python', '../workers/python.worker.js');
    return {
      label: 'Python 3 (Pyodide)', okText: 'Syntax OK', hosts: [h],
      prepare: async source => {
        const r = await h.call({ type: 'compile', source }, 15000);
        return r.timedOut ? { ok: false, log: 'Syntax check timed out' } : { ok: r.ok, log: r.log, artifact: source };
      },
      run: (artifact, input, limit) => h.call({ type: 'run', source: artifact, input, outputLimit: CONFIG.judge.outputLimitBytes }, limit)
    };
  },
  clang: lang => {
    const cc = host('Clang', '../workers/clang.worker.js', { module: true });
    const rt = host('WASI', '../workers/wasi.worker.js');
    let artifacts = 0;
    return {
      label: lang === 'c' ? 'C17 (Clang → WebAssembly)' : 'C++17 (Clang → WebAssembly)', okText: 'Compiled successfully', hosts: [cc, rt],
      prepare: async source => {
        const r = await cc.call({ type: 'compile', lang, source, memoryLimitMb: CONFIG.judge.memoryLimitMb || 256 }, CONFIG.judge.compileTimeoutMs);
        if (r.timedOut) return { ok: false, log: `Compilation took longer than ${CONFIG.judge.compileTimeoutMs / 1000} s` };
        if (r.crashed) return { ok: false, log: `Compiler crashed: ${r.message}` };
        return { ok: r.ok, log: r.log, artifact: r.ok ? { key: `${Date.now()}-${++artifacts}`, wasm: r.wasm } : null };
      },
      run: (artifact, input, limit) => rt.call({ type: 'run', artifactKey: artifact.key, wasm: artifact.wasm, input, outputLimit: CONFIG.judge.outputLimitBytes }, limit)
    };
  },
  jscpp: () => {
    const h = host('JSCPP', '../workers/jscpp.worker.js');
    return {
      label: 'C/C++ (JSCPP interpreter)', okText: 'Interpreter ready (code is parsed when the first test runs)', hosts: [h],
      prepare: async source => ({ ok: true, log: '', artifact: source }),
      run: (artifact, input, limit) => h.call({ type: 'run', source: artifact, input, outputLimit: CONFIG.judge.outputLimitBytes }, limit)
    };
  },
  java: () => {
    const h = host('Java', '../workers/java.worker.js');
    return {
      label: 'Java 21 (OpenJDK)', okText: 'Compiled successfully', hosts: [h],
      prepare: async source => {
        const r = await h.call({ type: 'compile', source }, CONFIG.judge.compileTimeoutMs || 30000);
        if (r.timedOut) return { ok: false, log: 'Compilation timed out' };
        if (r.crashed) return { ok: false, log: `Runner crashed: ${r.message}` };
        return { ok: r.ok, log: r.log, artifact: r.artifact || source };
      },
      run: (artifact, input, limit) => {
        // Allow up to 10 seconds (10,000 ms) for Java execution before killing as infinite loop / TLE
        const javaLimit = Math.max(limit || 10000, 10000);
        return h.call({
          type: 'run',
          artifact,
          source: typeof artifact === 'object' ? artifact.source : artifact,
          input,
          outputLimit: CONFIG.judge.outputLimitBytes,
          timeLimitMs: javaLimit
        }, javaLimit + 5000);
      },
      clean: artifact => h.call({ type: 'clean', artifact }, 2000).catch(() => {})
    };
  }
};

export function engineFor(lang) {
  if (lang === 'py') return ENGINES.python();
  if (lang === 'java') return ENGINES.java();
  return CONFIG.judge.cppEngine === 'jscpp' ? ENGINES.jscpp() : ENGINES.clang(lang);
}

/** Load the runtime for `lang` in the background so the first Run is fast. */
export function prewarm(lang) {
  for (const h of engineFor(lang).hosts) h.prewarm();
}

/* ---------- Output comparison: ignore trailing spaces and trailing blank lines ---------- */
const normalise = s => String(s).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
export const sameOutput = (actual, expected) => normalise(actual) === normalise(expected);

/* ---------- Queue: one judging job at a time ---------- */
let queue = Promise.resolve();

/**
 * Judge `source` against `tests`.
 *   mode 'sample' — run every test and report each one (visible tests).
 *   mode 'submit' — stop at the first failing test (hidden tests).
 * onEvent receives: queued · loading · loaded · compiling · compiled · test-start · test-done · done
 * Resolves the final { verdict, passed, total, timeMs, failedTest, log, results }.
 */
let jobsInFlight = 0;

export function judge({ lang, source, tests, timeLimitMs, mode, onEvent = () => {} }) {
  if (jobsInFlight > 0) onEvent({ type: 'queued' });   // only when actually waiting behind another job
  jobsInFlight++;
  const job = queue.then(() => runJob({ lang, source, tests, timeLimitMs, mode, onEvent }));
  queue = job.catch(() => {});
  job.finally(() => { jobsInFlight--; });
  return job;
}

async function runJob({ lang, source, tests, timeLimitMs, mode, onEvent }) {
  const engine = engineFor(lang);
  const limit = timeLimitMs || CONFIG.judge.timeLimitMs;
  const finish = summary => { onEvent({ type: 'done', ...summary }); return summary; };
  const total = tests.length;

  try {
    // 1. Runtime warm-up (not timed)
    for (const h of engine.hosts) {
      if (h.isReady) continue;
      // The first load downloads the whole runtime from the CDN, which can take minutes
      // on a busy lab network. Tick an elapsed counter so it never looks frozen.
      const t0 = Date.now();
      let last = { message: `Downloading ${h.name} runtime (first run only)…` };
      const show = () => onEvent({ type: 'loading', ...last, message: `${last.message} ${Math.round((Date.now() - t0) / 1000)} s` });
      h.onLoading = (message, done, total) => { last = { message, done, total }; show(); };
      show();
      const ticker = setInterval(show, 1000);
      try { await h.ready(); }
      finally { clearInterval(ticker); h.onLoading = null; }
      onEvent({ type: 'loaded', name: h.name });
    }

    // 2. Compile / syntax check
    onEvent({ type: 'compiling', engine: engine.label });
    const prep = await engine.prepare(source);
    onEvent({ type: 'compiled', ok: prep.ok, log: prep.log, okText: engine.okText });
    if (!prep.ok) return finish({ verdict: 'CE', passed: 0, total, timeMs: 0, failedTest: null, log: prep.log, results: [] });

    // 3. Tests, sequentially
    const results = [];
    let verdict = 'AC', failedTest = null, maxTime = 0;
    for (let i = 0; i < total; i++) {
      onEvent({ type: 'test-start', index: i, total });
      for (const h of engine.hosts) await h.ready();     // respawned after a TLE — not timed
      const r = await engine.run(prep.artifact, tests[i].input, limit);
      const res = classify(r, tests[i].output, limit);
      results.push(res);
      maxTime = Math.max(maxTime, res.timeMs || 0);
      if (res.verdict === 'CE') {                                  // engines that compile lazily (JSCPP)
        engine.clean?.(prep.artifact);
        return finish({ verdict: 'CE', passed: 0, total, timeMs: 0, failedTest: null, log: res.stderr, results: [] });
      }
      onEvent({ type: 'test-done', index: i, total, ...res });

      if (res.verdict !== 'AC' && verdict === 'AC') { verdict = res.verdict; failedTest = i + 1; }
      if (res.verdict !== 'AC' && mode === 'submit') break;        // short-circuit
      if (res.verdict === 'NJ') break;
    }
    engine.clean?.(prep.artifact);
    const passed = results.filter(r => r.verdict === 'AC').length;
    return finish({ verdict, passed, total, timeMs: Math.round(maxTime), failedTest, log: prep.log, results });
  } catch (e) {
    for (const h of engine.hosts) h.onLoading = null;
    return finish({ verdict: 'IE', passed: 0, total, timeMs: 0, failedTest: null, log: String(e?.message || e), results: [] });
  }
}

function classify(r, expected, limit) {
  if (r.timedOut) return { verdict: 'TLE', timeMs: limit, stdout: '', stderr: `Killed after ${(limit / 1000).toFixed(1)} s` };
  if (r.crashed) return { verdict: 'RE', timeMs: 0, stdout: '', stderr: r.message };
  const base = { timeMs: Math.round(r.timeMs || 0), stdout: r.stdout || '', stderr: r.stderr || '' };
  switch (r.status) {
    case 'OK': return { ...base, verdict: sameOutput(r.stdout, expected) ? 'AC' : 'WA' };
    case 'CE': return { ...base, verdict: 'CE' };
    case 'OLE': return { ...base, verdict: 'OLE' };
    case 'TLE': return { ...base, verdict: 'TLE', timeMs: Math.max(base.timeMs, limit) };
    case 'UNSUPPORTED': return { ...base, verdict: 'NJ' };
    default: return { ...base, verdict: 'RE' };
  }
}
