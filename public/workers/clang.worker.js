/* C / C++ compiler: Clang 21 + wasm-ld compiled to WebAssembly (YoWASP).
   Module worker. Only compiles — the resulting .wasm runs in wasi.worker.js,
   a separate worker the watchdog can kill without losing this warm compiler.
   Protocol:  init → loading… → ready | fatal      compile → compiled { ok, log, wasm } */

// libc++ has no <bits/stdc++.h>; contestants expect it, so we provide one.
const STDCPP_H = [
  'algorithm', 'array', 'bitset', 'cassert', 'cctype', 'cfloat', 'cinttypes', 'climits', 'cmath',
  'complex', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'deque', 'functional', 'iomanip',
  'iostream', 'iterator', 'limits', 'list', 'map', 'memory', 'numeric', 'optional', 'queue', 'random',
  'set', 'sstream', 'stack', 'string', 'string_view', 'tuple', 'type_traits', 'unordered_map',
  'unordered_set', 'utility', 'variant', 'vector', 'chrono'
].map(h => `#include <${h}>`).join('\n') + '\n';

let runClang = null;

function flags(lang, memoryLimitMb) {
  const common = [
    '-O2', '-fno-color-diagnostics', '-ferror-limit=20',
    '-Wl,--stack-first', '-Wl,-z,stack-size=8388608',        // 8 MB stack; overflow traps instead of corrupting the heap
    `-Wl,--max-memory=${memoryLimitMb * 1024 * 1024}`        // memory limit: malloc / new fail beyond this
  ];
  return lang === 'c'
    ? { file: 'main.c', args: ['clang', '-std=c17', ...common, 'main.c', '-o', 'main.wasm', '-lm'] }
    : { file: 'main.cpp', args: ['clang++', '-std=c++17', '-fno-exceptions', '-Iinc', ...common, 'main.cpp', '-o', 'main.wasm'] };
}

async function compile(lang, source, memoryLimitMb) {
  const { file, args } = flags(lang, memoryLimitMb);
  const decoder = new TextDecoder();
  let log = '';
  const files = { [file]: source, inc: { bits: { 'stdc++.h': STDCPP_H } } };
  try {
    const out = await runClang(args, files, {
      stdout: () => {},
      stderr: b => { if (b) log += decoder.decode(b, { stream: true }); }
    });
    return { ok: true, log: log.trim(), wasm: out['main.wasm'] };
  } catch (e) {
    if (typeof e?.code === 'number') return { ok: false, log: tidy(log) || `Compiler exited with status ${e.code}` };
    throw e;
  }
}

// Clang prints paths of its temporary object files; they mean nothing to a contestant.
const tidy = log => log.replace(/\/tmp\/main-\w+\.o: /g, '').replace(/clang(\+\+)?: error: linker command failed.*$/m, '').trim();

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      postMessage({ type: 'loading', message: 'Loading C/C++ compiler…' });
      ({ runClang } = await import(msg.cdn.clang));
      // runClang(null) only fetches the toolchain (~23 MB over the wire, cached afterwards).
      // Doing it explicitly is the only way to receive progress events.
      await runClang(null, {}, {
        fetchProgress: ({ totalLength, doneLength }) =>
          postMessage({ type: 'loading', message: 'Downloading C/C++ compiler…', done: doneLength, total: totalLength })
      });
      postMessage({ type: 'loading', message: 'Warming up C/C++ compiler…' });
      await compile('cpp', 'int main(){return 0;}', 64);
      postMessage({ type: 'ready' });
    } else if (msg.type === 'compile') {
      const res = await compile(msg.lang, msg.source, msg.memoryLimitMb);
      postMessage({ type: 'compiled', id: msg.id, ...res }, res.wasm ? [res.wasm.buffer] : []);
    }
  } catch (e) {
    const message = String(e?.message || e);
    if (msg.type === 'init') postMessage({ type: 'fatal', message });
    else postMessage({ type: 'compiled', id: msg.id, ok: false, log: `Internal compiler error: ${message}` });
  }
};
