/* Python 3 via Pyodide (CPython compiled to WebAssembly).
   Protocol:  init → ready | fatal      compile → compiled      run → result
   The main thread's watchdog terminates this worker on TLE, so nothing here
   needs to guard against infinite loops. */
importScripts('lockdown.js');

let judge = null, check = null;

const HARNESS = String.raw`
import sys, io, time, traceback

class _OutputLimit(BaseException):
    pass

class _Sink(io.RawIOBase):
    def __init__(self, limit):
        self.buf, self.limit = bytearray(), limit
    def writable(self):
        return True
    def write(self, b):
        if len(self.buf) + len(b) > self.limit:
            raise _OutputLimit()
        self.buf += b
        return len(b)

def _text(sink):
    return io.TextIOWrapper(io.BufferedWriter(sink), encoding="utf-8", newline="\n", write_through=True)

def _format(exc):
    # Keep only frames from the contestant's file, like a normal traceback.
    te = traceback.TracebackException.from_exception(exc)
    te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename == "main.py"])
    return "".join(te.format()).rstrip()

_baseline_modules = set(sys.modules)

def __check(src):
    try:
        compile(src, "main.py", "exec")
        return ""
    except (SyntaxError, ValueError) as e:
        return "".join(traceback.format_exception_only(type(e), e)).rstrip()

def __judge(src, data, limit):
    try:
        code = compile(src, "main.py", "exec")
    except (SyntaxError, ValueError) as e:
        return ("CE", "", "".join(traceback.format_exception_only(type(e), e)).rstrip(), 0.0)
    out, err = _Sink(limit), _Sink(65536)
    sys.stdin = io.TextIOWrapper(io.BytesIO(data.encode()), encoding="utf-8")
    sys.stdout, sys.stderr = _text(out), _text(err)
    status, message = "OK", ""
    t0 = time.perf_counter()
    try:
        exec(code, {"__name__": "__main__", "__builtins__": __builtins__})
        sys.stdout.flush()
    except SystemExit as e:
        if e.code not in (None, 0):
            status, message = "RE", f"SystemExit: {e.code}"
    except _OutputLimit:
        status, message = "OLE", "Output limit exceeded"
    except RecursionError as e:
        status, message = "RE", _format(e) + "\n(Recursion too deep — try sys.setrecursionlimit or an iterative approach)"
    except BaseException as e:
        status, message = "RE", _format(e)
    elapsed = (time.perf_counter() - t0) * 1000
    try:
        sys.stderr.flush()
    except BaseException:
        pass
    sys.stdin, sys.stdout, sys.stderr = sys.__stdin__, sys.__stdout__, sys.__stderr__
    for name in set(sys.modules) - _baseline_modules:   # fresh imports for every test
        del sys.modules[name]
    stderr = bytes(err.buf).decode("utf-8", "replace")
    if message:
        stderr = (stderr + "\n" + message).strip()
    return (status, bytes(out.buf).decode("utf-8", "replace"), stderr, elapsed)
`;

// Pyodide sometimes loses a failed download in an unawaited promise, so loadPyodide()
// never settles. Report it instead of leaving the student staring at a spinner.
let loading = false;
self.addEventListener('unhandledrejection', e => {
  if (!loading) return;
  loading = false;
  postMessage({ type: 'fatal', message: `Python runtime download failed (${e.reason?.message || e.reason}). Check the internet connection and press Run again.` });
});

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      postMessage({ type: 'loading', message: 'Downloading Python runtime (~12 MB, first run only)…' });
      loading = true;
      // Local mirror first, CDN if the mirror is missing.
      const bases = [msg.cdn.pyodide, msg.cdn.pyodideFallback].filter(Boolean).map(b => new URL(b, self.location.href).href);
      let base = null;
      for (const b of bases) {
        try { importScripts(b + 'pyodide.js'); base = b; break; } catch { /* try the next one */ }
      }
      if (!base) throw new Error('Could not download the Python runtime');
      const py = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
      py.runPython(HARNESS);
      judge = py.globals.get('__judge');
      check = py.globals.get('__check');
      loading = false;
      self.lockdown();
      postMessage({ type: 'ready' });
    } else if (msg.type === 'compile') {
      const log = check(msg.source);
      postMessage({ type: 'compiled', id: msg.id, ok: !log, log });
    } else if (msg.type === 'run') {
      const res = judge(msg.source, msg.input, msg.outputLimit);
      const [status, stdout, stderr, timeMs] = res.toJs();
      res.destroy();
      postMessage({ type: 'result', id: msg.id, status, stdout, stderr, timeMs });
    }
  } catch (e) {
    const message = String(e?.message || e);
    if (msg.type === 'init') { loading = false; postMessage({ type: 'fatal', message }); }
    else postMessage({ type: msg.type === 'run' ? 'result' : 'compiled', id: msg.id, status: 'RE', ok: false, stdout: '', stderr: message, log: message, timeMs: 0 });
  }
};
