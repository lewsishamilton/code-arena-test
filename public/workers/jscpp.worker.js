/* Lightweight C/C++ engine: JSCPP, a C++ interpreter written in JavaScript.
   Bundled locally (no download), but it supports only a subset of C++
   (no STL, no std::string) and runs ~1000× slower than compiled code.
   Enable with CONFIG.judge.cppEngine = 'jscpp'. */
importScripts('lockdown.js', '../vendor/JSCPP.es5.min.js');
self.lockdown();

class OutputLimit {}

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'init') return postMessage({ type: 'ready' });
  // JSCPP parses and runs in one step, so syntax errors surface during the first test.
  if (msg.type === 'compile') return postMessage({ type: 'compiled', id: msg.id, ok: true, log: '' });
  if (msg.type !== 'run') return;

  let stdout = '', status = 'OK', stderr = '';
  const t0 = performance.now();
  try {
    const code = JSCPP.run(msg.source, msg.input, {
      stdio: { write: s => { stdout += s; if (stdout.length > msg.outputLimit) throw new OutputLimit(); } }
    });
    if (code !== 0) { status = 'RE'; stderr = `Process exited with code ${code}`; }
  } catch (e) {
    if (e instanceof OutputLimit) { status = 'OLE'; stderr = 'Output limit exceeded'; }
    else {
      stderr = String(e?.message || e);
      status = /Parsing Failure|cannot find library|not defined|undefined/i.test(stderr) && !stdout ? 'CE' : 'RE';
      if (/cannot find library/.test(stderr)) stderr += '\nThe lightweight C/C++ runner supports iostream, cstdio, cmath, cstring, cstdlib and cctype only.';
    }
  }
  postMessage({ type: 'result', id: msg.id, status, stdout, stderr, timeMs: performance.now() - t0 });
};
