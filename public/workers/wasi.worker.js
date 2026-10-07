/* Runs a compiled C/C++ program (wasm32-wasi) against one input.
   A minimal WASI preview1 shim: stdin from the test input, stdout/stderr
   captured, no filesystem, no network. Programs run synchronously; the main
   thread's watchdog terminates this worker on TLE. */
importScripts('lockdown.js');
self.lockdown();   // nothing to load, so lock before any program runs

const E = { SUCCESS: 0, BADF: 8, NOENT: 44, NOSYS: 52, SPIPE: 70, NOTCAPABLE: 76 };
class ExitSignal { constructor(code) { this.code = code; } }
class OutputLimit {}

let cache = { key: null, module: null };

function run(module, input, outputLimit) {
  const stdin = new TextEncoder().encode(input);
  let inPos = 0, outLen = 0, errLen = 0, memory;
  const out = [], err = [];
  const mem = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  const iovecs = (ptr, count) => Array.from({ length: count }, (_, i) =>
    [mem().getUint32(ptr + i * 8, true), mem().getUint32(ptr + i * 8 + 4, true)]);

  const wasi = {
    args_sizes_get(argc, size) { mem().setUint32(argc, 1, true); mem().setUint32(size, 5, true); return E.SUCCESS; },
    args_get(argv, buf) { mem().setUint32(argv, buf, true); u8().set([109, 97, 105, 110, 0], buf); return E.SUCCESS; }, // "main"
    environ_sizes_get(count, size) { mem().setUint32(count, 0, true); mem().setUint32(size, 0, true); return E.SUCCESS; },
    environ_get() { return E.SUCCESS; },
    clock_res_get(id, res) { mem().setBigUint64(res, 1000n, true); return E.SUCCESS; },
    clock_time_get(id, precision, res) {
      const ms = id === 0 ? Date.now() : performance.now();
      mem().setBigUint64(res, BigInt(Math.round(ms * 1e6)), true);
      return E.SUCCESS;
    },
    fd_read(fd, iovs, count, nread) {
      if (fd !== 0) return E.BADF;
      let n = 0;
      for (const [ptr, len] of iovecs(iovs, count)) {
        const take = Math.min(len, stdin.length - inPos);
        u8().set(stdin.subarray(inPos, inPos + take), ptr);
        inPos += take; n += take;
        if (take < len) break;
      }
      mem().setUint32(nread, n, true);
      return E.SUCCESS;
    },
    fd_write(fd, iovs, count, nwritten) {
      if (fd !== 1 && fd !== 2) return E.BADF;
      let n = 0;
      for (const [ptr, len] of iovecs(iovs, count)) {
        const chunk = u8().slice(ptr, ptr + len);
        if (fd === 1) {
          outLen += len;
          if (outLen > outputLimit) throw new OutputLimit();
          out.push(chunk);
        } else if (errLen < 65536) {
          errLen += len; err.push(chunk);
        }
        n += len;
      }
      mem().setUint32(nwritten, n, true);
      return E.SUCCESS;
    },
    fd_fdstat_get(fd, stat) {
      if (fd > 2) return E.BADF;
      const v = mem();
      v.setUint8(stat, 2);                         // filetype: character device
      v.setUint16(stat + 2, 0, true);              // flags
      v.setBigUint64(stat + 8, 0xffffffffffffffffn, true);
      v.setBigUint64(stat + 16, 0xffffffffffffffffn, true);
      return E.SUCCESS;
    },
    fd_filestat_get(fd, buf) {
      if (fd > 2) return E.BADF;
      u8().fill(0, buf, buf + 64);
      mem().setUint8(buf + 16, 2);
      return E.SUCCESS;
    },
    fd_fdstat_set_flags() { return E.SUCCESS; },
    fd_close() { return E.SUCCESS; },
    fd_seek(fd) { return fd <= 2 ? E.SPIPE : E.BADF; },
    fd_prestat_get() { return E.BADF; },         // no preopened directories → no filesystem
    fd_prestat_dir_name() { return E.BADF; },
    path_open() { return E.NOTCAPABLE; },
    random_get(buf, len) {
      for (let off = 0; off < len; off += 65536) crypto.getRandomValues(u8().subarray(buf + off, buf + Math.min(len, off + 65536)));
      return E.SUCCESS;
    },
    sched_yield() { return E.SUCCESS; },
    proc_exit(code) { throw new ExitSignal(code); }
  };

  // Anything else the program imports gets a stub, so linking never fails here.
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue;
    imports[imp.module] ||= {};
    imports[imp.module][imp.name] = imp.module === 'wasi_snapshot_preview1' && wasi[imp.name]
      ? wasi[imp.name]
      : () => { if (imp.module === 'wasi_snapshot_preview1') return E.NOSYS; throw new Error(`unsupported import ${imp.module}.${imp.name}`); };
  }

  const instance = new WebAssembly.Instance(module, imports);
  memory = instance.exports.memory;

  let status = 'OK', message = '';
  const t0 = performance.now();
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof ExitSignal) {
      if (e.code !== 0) { status = 'RE'; message = `Process exited with code ${e.code}`; }
    } else if (e instanceof OutputLimit) {
      status = 'OLE'; message = 'Output limit exceeded';
    } else if (e instanceof RangeError) {
      status = 'RE'; message = 'Stack overflow — recursion too deep for the browser (try an iterative approach)';
    } else if (e instanceof WebAssembly.RuntimeError) {
      status = 'RE'; message = explainTrap(e.message);
    } else {
      status = 'RE'; message = String(e?.message || e);
    }
  }
  const timeMs = performance.now() - t0;
  const decode = parts => new TextDecoder().decode(concat(parts));
  const stderr = [decode(err).trim(), message].filter(Boolean).join('\n');
  return { status, stdout: decode(out), stderr, timeMs };
}

function explainTrap(msg) {
  if (/unreachable/.test(msg)) return 'Runtime error: program aborted (abort(), failed assert, out-of-range access, or out of memory)';
  if (/out of bounds/.test(msg)) return 'Runtime error: invalid memory access (segmentation fault)';
  if (/divide by zero|division by zero/.test(msg)) return 'Runtime error: integer division by zero';
  if (/integer overflow/.test(msg)) return 'Runtime error: integer overflow in division';
  return `Runtime error: ${msg}`;
}

function concat(parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return all;
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init') return postMessage({ type: 'ready' });
  if (msg.type !== 'run') return;
  try {
    if (cache.key !== msg.artifactKey) cache = { key: msg.artifactKey, module: await WebAssembly.compile(msg.wasm) };
    postMessage({ type: 'result', id: msg.id, ...run(cache.module, msg.input, msg.outputLimit) });
  } catch (e) {
    postMessage({ type: 'result', id: msg.id, status: 'RE', stdout: '', stderr: String(e?.message || e), timeMs: 0 });
  }
};
