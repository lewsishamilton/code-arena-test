export const CONFIG = {
  contestName: 'CODE//ARENA',
  edition: '2026',
  roundName: 'Main round',

  /** Contest length, counted from each contestant's first login. */
  durationMin: 120,
  /** Fixed end time (ISO 8601, e.g. '2026-11-14T12:30:00+05:30'). Overrides durationMin when set. */
  contestEnd: null,

  lockdown: {
    /** Detect blur / tab switch in standard browser (notifies proctor and locks screen on escape) */
    detectBlurInBrowser: true,
    /** Automatically request fullscreen upon launch/entering arena to prevent accidental tab switching */
    autoFullscreen: true
  },

  judge: {
    /** Per-test wall-clock limit enforced by the watchdog (problems can override). */
    timeLimitMs: 2000,
    /** Compile limit — generous because the first C/C++ compile also warms the compiler. */
    compileTimeoutMs: 60000,
    /** C/C++ memory limit (WebAssembly max memory). malloc/new fail beyond it. */
    memoryLimitMb: 256,
    /** Max stdout kept per test; more than this is Output Limit Exceeded. */
    outputLimitBytes: 1 << 20,
    /**
     * C/C++ engine:
     *   'clang' — real Clang 21 compiled to WebAssembly. Full C17 / C++17 + STL, native-ish speed.
     *             First use downloads ~23 MB (cached by the browser afterwards).
     *   'jscpp' — tiny JS interpreter (~430 KB, bundled). Subset of C/C++, no STL, thousands of
     *             times slower: only for emergencies with tiny inputs (a 10-character sample takes ~1 s).
     */
    cppEngine: 'clang'
  },

  defaultLanguage: 'cpp',

  /**
   * Result collection. serve.py implements both endpoints; set either to ''
   * when hosting on a plain static server (results then stay in the browser).
   */
  api: {
    submissions: 'api/submissions',
    scoreboard: 'api/scoreboard',
    auth: 'api/auth/login',
    pollMs: 20000
  },

  /** Firebase and Firestore settings for student verification. */
  firebase: {
    apiKey: 'AIzaSyAS8NMWRcKyU-6WK791X5QXy7lV4QgcNgU',
    projectId: 'codearena-31947',
    authDomain: 'codearena-31947.firebaseapp.com',
    storageBucket: 'codearena-31947.firebasestorage.app',
    messagingSenderId: '230297718679',
    appId: '1:230297718679:web:8ebac4710f6062494b3ed2'
  },

  /** Heavy runtimes load from CDNs. Point these at a local mirror for an offline lab. */
  cdn: {
    pyodide: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',
    clang: 'https://cdn.jsdelivr.net/npm/@yowasp/clang@21.1.4-3/gen/bundle.js',
    monaco: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
  }
};
