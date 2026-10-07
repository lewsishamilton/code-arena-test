/* =========================================================================
   Code editor: Monaco from a CDN, with a plain-textarea fallback so the
   contest still works if the CDN is blocked (e.g. by an SEB URL filter).
   ========================================================================= */
import { CONFIG } from './config.js';

const MONACO_TIMEOUT_MS = 15000;

function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  const base = CONFIG.cdn.monaco;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Monaco load timed out')), MONACO_TIMEOUT_MS);
    // Monaco's own helpers run in a worker; cross-origin workers need this blob shim.
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob(
        [`self.MonacoEnvironment={baseUrl:'${base}/../'};importScripts('${base}/base/worker/workerMain.js');`],
        { type: 'text/javascript' }))
    };
    const script = document.createElement('script');
    script.src = `${base}/loader.min.js`;
    script.onerror = () => { clearTimeout(timer); reject(new Error('Monaco loader failed')); };
    script.onload = () => {
      window.require.config({ paths: { vs: base } });
      window.require(['vs/editor/editor.main'], () => { clearTimeout(timer); resolve(window.monaco); }, err => { clearTimeout(timer); reject(err); });
    };
    document.head.appendChild(script);
  });
}

function defineTheme(monaco) {
  monaco.editor.defineTheme('arena', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'type', foreground: '82aaff' },
      { token: 'string', foreground: 'a5d6a7' },
      { token: 'number', foreground: 'f2a36b' },
      { token: 'comment', foreground: '5d675c', fontStyle: 'italic' },
      { token: 'keyword.directive', foreground: '89c4c1' },
      { token: 'delimiter', foreground: 'a4aca2' }
    ],
    colors: {
      'editor.background': '#111411',
      'editor.foreground': '#d6ddd3',
      'editorLineNumber.foreground': '#4b544a',
      'editorLineNumber.activeForeground': '#a4aca2',
      'editor.lineHighlightBackground': '#191d19',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#2ab40640',
      'editor.inactiveSelectionBackground': '#2ab40622',
      'editorCursor.foreground': '#f2f4ef',
      'editorIndentGuide.background1': '#232823',
      'editorIndentGuide.activeBackground1': '#3c463c',
      'editorWidget.background': '#202520',
      'editorWidget.border': '#3c463c',
      'editorSuggestWidget.background': '#202520',
      'editorSuggestWidget.selectedBackground': '#2d342d',
      'scrollbarSlider.background': '#30383080',
      'scrollbarSlider.hoverBackground': '#3c463cb0'
    }
  });
}

/**
 * @param {HTMLElement} el
 * @param {{ value: string, language: string, onChange: Function, onRun: Function, onSubmit: Function }} opts
 * @returns {Promise<{ kind, getValue, setValue, setLanguage, focus, setReadOnly }>}
 */
export async function createEditor(el, { value, language, onChange, onRun, onSubmit }) {
  try {
    const monaco = await loadMonaco();
    defineTheme(monaco);
    el.textContent = '';
    const editor = monaco.editor.create(el, {
      value, language, theme: 'arena',
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13.5, lineHeight: 22, tabSize: 4, insertSpaces: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 },
      renderLineHighlight: 'line',
      smoothScrolling: true,
      bracketPairColorization: { enabled: true },
      // No AI/telemetry features exist in Monaco; keep word-based suggestions, drop the noisy ones.
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'currentDocument',
      parameterHints: { enabled: false },
      contextmenu: false,
      fixedOverflowWidgets: true
    });
    editor.onDidChangeModelContent(() => onChange?.(editor.getValue()));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRun?.());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => onSubmit?.());
    return {
      kind: 'monaco',
      getValue: () => editor.getValue(),
      setValue: v => { editor.setValue(v); editor.setScrollTop(0); },
      setLanguage: lang => monaco.editor.setModelLanguage(editor.getModel(), lang),
      focus: () => editor.focus(),
      setReadOnly: ro => editor.updateOptions({ readOnly: ro })
    };
  } catch (err) {
    console.warn('[editor] Monaco unavailable, using the basic editor:', err);
    return textareaEditor(el, { value, onChange });
  }
}

/** Minimal fallback: monospace textarea with Tab indentation. */
function textareaEditor(el, { value, onChange }) {
  el.textContent = '';
  const ta = document.createElement('textarea');
  ta.className = 'fallback-editor';
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('aria-label', 'Code editor. Tab indents; press Escape then Tab to move focus out.');
  ta.value = value;
  let escaped = false;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key !== 'Tab' || escaped) { escaped = false; return; }
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end } = ta;
    ta.setRangeText('    ', s, end, 'end');
    onChange?.(ta.value);
  });
  ta.addEventListener('input', () => onChange?.(ta.value));
  el.appendChild(ta);
  return {
    kind: 'basic',
    getValue: () => ta.value,
    setValue: v => { ta.value = v; ta.scrollTop = 0; },
    setLanguage: () => {},
    focus: () => ta.focus(),
    setReadOnly: ro => { ta.readOnly = ro; }
  };
}
