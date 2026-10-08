/* Java runtime runner.
   Uses the server judge API (/api/judge/java) powered by OpenJDK javac and java.
   Falls back gracefully to client-side structural validation if the server runner
   is unreachable, so the platform functions under pure static hosting as well.
   Protocol: init → ready | fatal      compile → compiled      run → result
*/

let serverRunner = false;
let serverVersion = 'Java 21';

function apiUrl(endpoint) {
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null') ? location.origin : '';
  return `${origin}${endpoint}`;
}

function strip(src) {
  // Blank out comments and string/char literals, keeping line breaks for line numbers.
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/gm, m => m.replace(/[^\n]/g, ' '));
}

function check(src) {
  const code = strip(src);
  const pairs = { ')': '(', ']': '[', '}': '{' }, stack = [];
  let line = 1;
  for (const ch of code) {
    if (ch === '\n') line++;
    else if ('([{'.includes(ch)) stack.push({ ch, line });
    else if (pairs[ch]) {
      if (stack.at(-1)?.ch !== pairs[ch]) return `Main.java:${line}: error: illegal start of type '${ch}'\n1 error`;
      stack.pop();
    }
  }
  if (stack.length) return `Main.java:${line}: error: reached end of file while parsing (unclosed '${stack.at(-1).ch}' from line ${stack.at(-1).line})\n1 error`;
  if (!/\bclass\s+Main\b/.test(code)) return 'Main.java:1: error: the entry class must be named Main\n1 error';
  if (!/public\s+static\s+void\s+main\s*\(\s*(final\s+)?String\s*(\[\s*\]\s*\w+|\.\.\.\s*\w+|\w+\s*\[\s*\])\s*\)/.test(code)) {
    return 'Main.java:1: error: missing method: public static void main(String[] args)\n1 error';
  }
  return '';
}

async function probeServer() {
  try {
    const res = await fetch(apiUrl('/api/judge/java?action=ping'));
    if (res.ok) {
      const data = await res.json();
      if (data.ok || data.available) {
        serverRunner = true;
        serverVersion = data.version || 'Java 21';
        return true;
      }
    }
  } catch {
    // Server is unreachable or running in pure static mode
  }
  serverRunner = false;
  return false;
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      await probeServer();
      return postMessage({ type: 'ready', serverRunner, version: serverVersion });
    }

    if (msg.type === 'compile') {
      if (serverRunner) {
        try {
          const res = await fetch(apiUrl('/api/judge/java'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': msg.auth || '' },
            body: JSON.stringify({ action: 'compile', source: msg.source })
          });
          if (res.ok) {
            const data = await res.json();
            return postMessage({
              type: 'compiled',
              id: msg.id,
              ok: !!data.ok,
              log: data.log || '',
              artifact: data.ok ? { artifactId: data.artifactId, source: msg.source } : null
            });
          }
        } catch {
          // Fall back if server request failed
        }
      }

      // Fallback: structural validation
      const log = check(msg.source);
      return postMessage({
        type: 'compiled',
        id: msg.id,
        ok: !log,
        log,
        artifact: { source: msg.source, fallback: true }
      });
    }

    if (msg.type === 'run') {
      const artifact = msg.artifact || (typeof msg.source === 'object' ? msg.source : { source: msg.source });
      if (serverRunner && artifact?.artifactId) {
        try {
          const res = await fetch(apiUrl('/api/judge/java'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': msg.auth || '' },
            body: JSON.stringify({
              action: 'run',
              artifactId: artifact.artifactId,
              source: artifact.source,
              input: msg.input || '',
              timeLimitMs: Math.max(msg.timeLimitMs || 10000, 10000),
              outputLimit: msg.outputLimit || (1 << 20)
            })
          });
          if (res.ok) {
            const data = await res.json();
            return postMessage({
              type: 'result',
              id: msg.id,
              status: data.status || 'RE',
              stdout: data.stdout || '',
              stderr: data.stderr || '',
              timeMs: data.timeMs || 0
            });
          }
        } catch (err) {
          return postMessage({
            type: 'result',
            id: msg.id,
            status: 'RE',
            stdout: '',
            stderr: `Java execution request failed: ${err.message}`,
            timeMs: 0
          });
        }
      }

      // Fallback verdict when server runner is not available
      return postMessage({
        type: 'result',
        id: msg.id,
        status: 'UNSUPPORTED',
        stdout: '',
        timeMs: 0,
        stderr: 'Java runner is not available on this server. Your code passed the structural check and is saved, but it was not judged.'
      });
    }

    if (msg.type === 'clean') {
      const artifact = msg.artifact;
      if (serverRunner && artifact?.artifactId) {
        fetch(apiUrl('/api/judge/java'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Token': msg.auth || '' },
          body: JSON.stringify({ action: 'clean', artifactId: artifact.artifactId })
        }).catch(() => {});
      }
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (msg.type === 'compile') {
      postMessage({ type: 'compiled', id: msg.id, ok: false, log: message });
    } else if (msg.type === 'run') {
      postMessage({ type: 'result', id: msg.id, status: 'RE', stdout: '', stderr: message, timeMs: 0 });
    }
  }
};
