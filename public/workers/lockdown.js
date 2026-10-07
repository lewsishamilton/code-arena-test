/* Strips network, storage and script-loading APIs from a worker before any
   contestant code runs in it. Without this, a Python submission could
   `import js; js.fetch('data/tests/A.json')` and print the hidden answers.
   Call it only after the runtime itself has finished loading. */
self.lockdown = function lockdown() {
  const names = [
    'fetch', 'Request', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource',
    'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel',
    'indexedDB', 'caches', 'CacheStorage', 'FileReaderSync', 'Notification'
  ];
  for (const name of names) {
    for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      try { if (Object.prototype.hasOwnProperty.call(o, name)) delete o[name]; } catch { /* non-configurable */ }
    }
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch { /* already locked */ }
  }
};
