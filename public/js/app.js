/* =========================================================================
   CODE//ARENA — contest client.
   Screen 1: contestant login.  Screen 2: coding arena.
   ========================================================================= */
import { CONFIG } from './config.js';
import { PROBLEMS, LANGUAGES, JSCPP_TEMPLATES } from './problems.js';
import { judge, prewarm, engineFor, VERDICTS } from './judge.js';
import { createEditor } from './editor.js';
import { marked } from '../vendor/marked.esm.js';

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const timeOfDay = (t = Date.now()) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const brandHTML = name => esc(name).replace('//', '<span class="sep">//</span>');
const truncate = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

const ICONS = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4.5M12 17.5h.01"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const hydrateIcons = (root = document) => $$('[data-icon]', root).forEach(el => { el.outerHTML = icon(el.dataset.icon); });

/** localStorage wrapper. Every read/write is guarded: private mode or blocked storage must not break the contest. */
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('ca.v1.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('ca.v1.' + key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem('ca.v1.' + key); } catch { /* ignore */ } }
};

function toast(message, tone = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `${icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'x' : 'alert')}<div>${message}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function confirmDialog({ title, body, confirm = 'Confirm', tone = 'primary' }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const ok = $('#modal-ok');
  ok.textContent = confirm;
  ok.className = `btn btn-${tone}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function show(screen) {
  $('#boot').hidden = true;
  for (const id of ['screen-login', 'screen-arena']) {
    const el = $('#' + id);
    if (el) el.hidden = id !== screen;
  }
}

/* =========================================================================
   BOOT
   ========================================================================= */
async function boot() {
  $$('[data-brand]').forEach(el => { el.innerHTML = brandHTML(CONFIG.contestName); });
  hydrateIcons();

  // Check URL parameters for seamless Firestore integration:
  // e.g. https://your-domain/?roll=25R21A05K9&name=John+Doe
  const params = new URLSearchParams(window.location.search);
  const qRoll = params.get('roll') || params.get('id');
  const qName = params.get('name') || params.get('student');

  if (qRoll) {
    const session = {
      name: (qName || qRoll).trim(),
      roll: qRoll.trim().toUpperCase(),
      loginAt: Date.now()
    };
    store.set('session', session);
    enterArena(session);
    return;
  }

  const session = store.get('session', null);
  if (session?.roll) enterArena(session);
  else showLogin();
}

/* =========================================================================
   SCREEN 1 — CONTESTANT ENTRY
   ========================================================================= */
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/;

function showLogin() {
  show('screen-login');
  $('#login-round').textContent = `${CONFIG.contestName} ${CONFIG.edition} · ${CONFIG.roundName}`;
  $('#login-meta').textContent = `${PROBLEMS.length} problems · ${CONFIG.contestEnd ? 'ends ' + new Date(CONFIG.contestEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : CONFIG.durationMin + ' min'} · Connected to Firestore`;

  const form = $('#login-form');
  const fields = { roll: $('#f-roll'), password: $('#f-password') };
  const alertBox = $('#login-alert');
  const showAlert = (msg, isInfo = false) => {
    if (!alertBox) return;
    alertBox.textContent = msg;
    alertBox.classList.toggle('info', isInfo);
    alertBox.hidden = false;
  };
  const hideAlert = () => { if (alertBox) alertBox.hidden = true; };

  const setInvalid = (key, bad) => form.querySelector(`[data-field="${key}"]`)?.classList.toggle('invalid', bad);
  for (const [key, input] of Object.entries(fields)) {
    if (input) input.addEventListener('input', () => {
      setInvalid(key, false);
      hideAlert();
    });
  }

  // Toggle show/hide password
  const toggleBtn = $('#btn-toggle-pw');
  if (toggleBtn && fields.password) {
    toggleBtn.onclick = () => {
      const isPw = fields.password.type === 'password';
      fields.password.type = isPw ? 'text' : 'password';
      toggleBtn.textContent = isPw ? '🔒' : '👁️';
    };
  }

  fields.roll?.focus();

  form.onsubmit = async e => {
    e.preventDefault();
    hideAlert();
    const roll = fields.roll?.value.trim().toUpperCase() || '';
    const password = fields.password?.value || '';
    const badRoll = !ROLL_RE.test(roll);
    const badPw = !password;
    setInvalid('roll', badRoll);
    setInvalid('password', badPw);
    if (badRoll) return fields.roll?.focus();
    if (badPw) return fields.password?.focus();

    const btn = $('#login-btn');
    const btnText = $('#login-btn-text');
    const origText = btnText ? btnText.textContent : 'Verify & Enter Contest';
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Verifying with Firestore…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roll, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Authentication failed. Please verify your credentials.');
      }

      const session = {
        name: data.user?.name || roll,
        roll: data.user?.roll || roll,
        uid: data.user?.uid,
        loginAt: Date.now()
      };
      store.set('session', session);
      if (CONFIG.lockdown?.autoFullscreen !== false) {
        await requestFullscreenSafely();
      }
      enterArena(session);
    } catch (err) {
      showAlert(err.message || 'Could not connect to Firestore service.');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = origText;
    }
  };
}

/* =========================================================================
   SCREEN 2 — ARENA
   ========================================================================= */
let A = null;   // arena runtime state, created once per session

function enterArena(session) {
  show('screen-arena');
  const key = `state.${session.roll}`;
  const state = store.get(key, null) || { startedAt: Date.now(), code: {}, lang: CONFIG.defaultLanguage, problem: 0, subs: [] };
  state.lang = LANGUAGES[state.lang] ? state.lang : 'py';
  state.problem = Math.min(state.problem || 0, PROBLEMS.length - 1);

  A = {
    session, state, editor: null, busy: false, ended: false,
    enteredAt: Date.now(),
    unblockedAt: 0,
    hidden: {},                                   // problem id → hidden tests (fetched on first submit)
    save: () => store.set(key, state),
    deadline: CONFIG.contestEnd ? Date.parse(CONFIG.contestEnd) : null,
    scoreboard: null, scoreboardError: null
  };
  A.save();

  $('#arena-event').textContent = `${CONFIG.contestName} ${CONFIG.edition} · ${CONFIG.roundName}`;
  $('#who').innerHTML = `<b>${esc(session.name)}</b> · <span class="mono">${esc(session.roll)}</span>`;
  $('#lang').innerHTML = Object.entries(LANGUAGES).map(([k, l]) => `<option value="${k}">${esc(l.label)}</option>`).join('');
  $('#lang').value = state.lang;

  renderProblemTabs();
  renderProblem();
  renderStatus();
  updateLangUI();
  wireArena();
  mountEditor();
  tick(); setInterval(tick, 1000);
  setupNetworkMonitor();
  setupFullscreenMonitor();
  if (CONFIG.lockdown?.autoFullscreen !== false) {
    requestFullscreenSafely();
  }
  updateFullscreenUI();
  initLockdown();
  pollScoreboard();
  prewarm(state.lang);
}

const problem = () => PROBLEMS[A.state.problem];
const codeKey = () => `${problem().id}:${A.state.lang}`;
const templateFor = (lang, p) => (CONFIG.judge.cppEngine === 'jscpp' && JSCPP_TEMPLATES[lang] ? JSCPP_TEMPLATES[lang] : LANGUAGES[lang].template)(p.title);
const currentCode = () => A.state.code[codeKey()] ?? templateFor(A.state.lang, problem());

/* ---------- Editor ---------- */
async function mountEditor() {
  let saveTimer;
  A.editor = await createEditor($('#editor'), {
    value: currentCode(),
    language: LANGUAGES[A.state.lang].monaco,
    onChange: value => {
      setSaveState('saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { A.state.code[codeKey()] = value; setSaveState(A.save() ? 'saved' : 'unsaved'); }, 400);
    },
    onRun: runSamples,
    onSubmit: submitSolution
  });
  if (A.editor.kind === 'basic') toast('Code editor CDN unavailable — using the basic editor.', 'warn');
  if (A.ended) A.editor.setReadOnly(true);
}

function setSaveState(s) {
  const el = $('#save-state');
  el.className = `save-state ${s}`;
  el.querySelector('span').textContent = { saving: 'Saving…', saved: 'Saved', unsaved: 'Not saved' }[s];
}

/** Flush the editor into state before switching problem or language. */
function stashCode() {
  if (!A.editor) return;
  A.state.code[codeKey()] = A.editor.getValue();
  A.save();
}

function loadCode() {
  if (!A.editor) return;
  A.editor.setValue(currentCode());
  A.editor.setLanguage(LANGUAGES[A.state.lang].monaco);
  setSaveState('saved');
}

function updateLangUI() {
  $('#file-name').textContent = LANGUAGES[A.state.lang].file;
  $('#engine-note').textContent = engineFor(A.state.lang).label;
}

/* ---------- Left pane ---------- */
function problemStatus(id) {
  const subs = A.state.subs.filter(s => s.problem === id && VERDICTS[s.verdict] && !['CE', 'NJ', 'IE'].includes(s.verdict));
  if (subs.some(s => s.verdict === 'AC')) return 'solved';
  return subs.length ? 'tried' : '';
}

function renderProblemTabs() {
  $('#q-tabs').innerHTML = PROBLEMS.map((p, i) => {
    const st = problemStatus(p.id);
    return `<button class="q-tab ${i === A.state.problem ? 'active' : ''} ${st}" role="tab" aria-selected="${i === A.state.problem}" data-q="${i}">
      <span class="l">${esc(p.id)}</span>
      <span><span class="t">${esc(p.title)}</span><small>${p.points} pts${st === 'solved' ? ' · solved' : ''}</small></span>
    </button>`;
  }).join('');
}

const DIFF_BADGE = { Easy: 'badge-ok', Medium: 'badge-warn', Hard: 'badge-bad' };

function renderProblem() {
  const p = problem();
  const limit = (p.timeLimitMs || CONFIG.judge.timeLimitMs) / 1000;
  const isC = A.state.lang === 'c' || A.state.lang === 'cpp';
  $('#view-problem').innerHTML = `<article class="prose">
    <h2>${esc(p.id)}. ${esc(p.title)}</h2>
    <div class="problem-meta">
      <span class="badge ${DIFF_BADGE[p.difficulty] || ''}">${esc(p.difficulty)}</span>
      <span class="badge plain">${p.points} points</span>
      <span class="badge plain">Time ${limit} s per test</span>
      ${isC && CONFIG.judge.cppEngine === 'clang' ? `<span class="badge plain">Memory ${CONFIG.judge.memoryLimitMb} MB</span>` : ''}
    </div>
    ${marked.parse(p.statement)}
    <h3>Constraints</h3>
    <ul>${p.constraints.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    ${p.samples.map((s, i) => `<h3>Sample ${i + 1}</h3>
      <div class="sample">
        <div><header>Input <button class="copy-btn" data-copy="${i}:input">Copy</button></header><pre>${esc(s.input.trimEnd())}</pre></div>
        <div><header>Output <button class="copy-btn" data-copy="${i}:output">Copy</button></header><pre>${esc(s.output.trimEnd())}</pre></div>
      </div>${s.note ? `<p class="sample-note">${esc(s.note)}</p>` : ''}`).join('')}
  </article>`;
  $('#view-problem').scrollTop = 0;
}

/* ---------- Scoring (local, mirrors serve.py) ---------- */
function standing(subs, startedAt) {
  const per = {};
  let score = 0, solved = 0;
  for (const p of PROBLEMS) {
    const mine = subs.filter(s => s.problem === p.id).sort((a, b) => a.at - b.at);
    let solvedAt = null;
    for (const s of mine) {
      if (s.verdict === 'AC') { solvedAt = s.at; break; }
    }
    per[p.id] = { attempts: mine.filter(s => s.verdict !== 'PENDING').length, solvedAt };
    if (solvedAt) {
      solved++; score += p.points;
    }
  }
  return { per, score, solved };
}

const verdictBadge = v => {
  if (v === 'PENDING') return '<span class="badge badge-info">Judging…</span>';
  const meta = VERDICTS[v];
  if (!meta) return esc(v);
  const cls = { ok: 'badge-ok', bad: 'badge-bad', warn: 'badge-warn', neutral: '' }[meta.tone];
  return `<span class="badge ${cls}" title="${esc(meta.label)}">${esc(meta.label)}</span>`;
};

function renderStatus() {
  const { per, score, solved } = standing(A.state.subs, A.state.startedAt);
  const board = A.scoreboard?.rows || null;
  const myRow = board?.find(r => r.roll === A.session.roll);
  const rank = myRow ? `${myRow.rank}<small class="muted" style="font-size:14px"> / ${board.length}</small>` : '—';

  const problemsTable = `<div class="panel table-wrap"><table class="table">
    <thead><tr><th>Problem</th><th>Status</th><th class="right">Attempts</th><th class="right">Solved at</th><th class="right">Points</th></tr></thead>
    <tbody>${PROBLEMS.map(p => {
      const st = per[p.id];
      const status = st.solvedAt ? '<span class="badge badge-ok">Solved</span>' : st.attempts ? '<span class="badge badge-info">Attempted</span>' : '<span class="badge plain">Not tried</span>';
      return `<tr><td class="strong">${esc(p.id)}. ${esc(p.title)}</td><td>${status}</td><td class="right num">${st.attempts}</td>
        <td class="right num">${st.solvedAt ? clock(st.solvedAt - A.state.startedAt) : '—'}</td><td class="right num">${st.solvedAt ? p.points : 0} / ${p.points}</td></tr>`;
    }).join('')}</tbody></table></div>`;

  let boardHTML;
  if (board?.length) {
    boardHTML = `<div class="panel table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Contestant</th>${PROBLEMS.map(p => `<th class="right">${esc(p.id)}</th>`).join('')}<th class="right">Total Score</th></tr></thead>
      <tbody>${board.slice(0, 50).map(r => `<tr class="${r.roll === A.session.roll ? 'me' : ''}">
        <td class="num">${r.rank}</td><td class="strong">${esc(r.name)} <span class="muted mono">${esc(r.roll)}</span></td>
        ${PROBLEMS.map(p => { const c = r.problems?.[p.id]; return `<td class="right num">${c?.solved ? '<span style="color:var(--ok)">✓</span>' : c?.attempts ? `<span class="muted">${c.attempts} att</span>` : '<span class="muted">·</span>'}</td>`; }).join('')}
        <td class="right num strong">${r.score}</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    boardHTML = `<div class="panel"><p class="empty">${A.scoreboardError
      ? 'The scoreboard server is not reachable, so only your own results are shown. They are kept on this computer and sent when the connection returns.'
      : CONFIG.api.scoreboard ? 'No submissions on the scoreboard yet.' : 'The live scoreboard is turned off for this contest.'}</p></div>`;
  }

  const subs = [...A.state.subs].reverse();
  const subsHTML = subs.length ? `<div class="panel table-wrap"><table class="table">
    <thead><tr><th>#</th><th>Time</th><th>Problem</th><th>Language</th><th>Verdict</th><th class="right">Tests</th><th class="right">Runtime</th></tr></thead>
    <tbody>${subs.map(s => `<tr><td class="num">${s.n}</td><td class="num">${clock(s.at - A.state.startedAt)}</td><td class="strong">${esc(s.problem)}</td>
      <td>${esc(LANGUAGES[s.lang]?.label || s.lang)}</td><td>${verdictBadge(s.verdict)}${s.failedTest && !['AC', 'NJ'].includes(s.verdict) ? ` <span class="muted">on test ${s.failedTest}</span>` : ''}</td>
      <td class="right num">${s.verdict === 'PENDING' ? '…' : `${s.passed}/${s.total}`}</td><td class="right num">${s.timeMs != null && s.verdict !== 'PENDING' ? s.timeMs + ' ms' : '—'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="panel"><p class="empty">No submissions yet. Submit a solution to have it judged against the hidden tests.</p></div>';

  const pending = store.get(`outbox.${A.session.roll}`, []).length;
  $('#view-status').innerHTML = `
    <div class="stat-strip">
      <div><strong>${score}</strong><span>Total Score</span></div>
      <div><strong>${solved}<small class="muted" style="font-size:14px"> / ${PROBLEMS.length}</small></strong><span>Solved</span></div>
      <div><strong>${rank}</strong><span>Rank</span></div>
    </div>
    <div class="section-title"><h3>Your problems</h3><span>Points awarded per solved problem • No penalties</span></div>
    ${problemsTable}
    <div class="section-title"><h3>Live scoreboard</h3><span>${A.scoreboard?.updatedAt ? 'Updated ' + timeOfDay(A.scoreboard.updatedAt) : ''}${pending ? ` · ${pending} result${pending > 1 ? 's' : ''} waiting to sync` : ''}</span></div>
    ${boardHTML}
    <div class="section-title"><h3>Your submissions</h3><span>${subs.length} total</span></div>
    ${subsHTML}`;
}

/* ---------- Result sync with serve.py (optional) ---------- */
async function flushOutbox() {
  if (!CONFIG.api.submissions) return;
  const key = `outbox.${A.session.roll}`;
  const outbox = store.get(key, []);
  while (outbox.length) {
    try {
      const res = await fetch(CONFIG.api.submissions, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outbox[0]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      outbox.shift();
      store.set(key, outbox);
    } catch { break; }
  }
}

/* =========================================================================
   LOCKDOWN VIOLATIONS & NETWORK INTEGRATION
   ========================================================================= */

function updateNetworkUI(online) {
  if (A) A.isOnline = online;
  const el = $('#network-pill');
  if (!el) return;
  if (online) {
    el.className = 'net-status net-online';
    el.innerHTML = '<span class="net-dot"></span><span>Online</span>';
    el.title = 'Connected to exam server';
  } else {
    // Graceful offline display: informs student their code is safe and offline work is NOT flagged
    el.className = 'net-status net-offline';
    el.innerHTML = '<span class="net-dot blink"></span><span>Reconnecting (Offline mode active)</span>';
    el.title = 'Network connection interrupted. Code is saved locally and will auto-sync. Network disconnects are NOT flagged as violations.';
  }
}

/* =========================================================================
   FULLSCREEN LOCKDOWN MANAGER
   ========================================================================= */
async function requestFullscreenSafely() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
    }
  } catch (err) {
    // Browser may require an explicit click gesture if launched without interaction
  }
  updateFullscreenUI();
}

async function exitFullscreenSafely() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
    }
  } catch (err) {}
  updateFullscreenUI();
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreenSafely();
  } else {
    requestFullscreenSafely();
  }
}

function updateFullscreenUI() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const banner = $('#fullscreen-banner');
  const btnLabel = $('#fullscreen-btn-label');
  const inArena = $('#screen-arena') && !$('#screen-arena').hidden;

  if (banner) {
    banner.hidden = isFs || !inArena;
  }
  if (btnLabel) {
    btnLabel.textContent = isFs ? 'Exit Full' : 'Fullscreen';
  }
}

let fullscreenMonitorSetup = false;
function setupFullscreenMonitor() {
  if (fullscreenMonitorSetup) return;
  fullscreenMonitorSetup = true;

  const handleFsChange = () => {
    updateFullscreenUI();
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFs && A?.session && !$('#screen-arena')?.hidden && !A.lockdownViolated && !A.kicked) {
      const pol = A.lockdownPolicy || {};
      if (pol.blockFullscreen && typeof triggerBrowserViolation === 'function') {
        triggerBrowserViolation('fullscreen-escape', 'Contestant exited required fullscreen exam mode');
      }
    }
  };

  document.addEventListener('fullscreenchange', handleFsChange);
  document.addEventListener('webkitfullscreenchange', handleFsChange);

  $('#fullscreen-btn')?.addEventListener('click', toggleFullscreen);
  $('#btn-banner-fullscreen')?.addEventListener('click', requestFullscreenSafely);

  // If a student reloaded the page (where auto-fullscreen requires a gesture),
  // their first click anywhere in the arena enters fullscreen
  window.addEventListener('click', () => {
    if (A?.session && !$('#screen-arena')?.hidden && !document.fullscreenElement && CONFIG.lockdown?.autoFullscreen !== false) {
      requestFullscreenSafely();
    }
  }, { once: true });
}

function setupNetworkMonitor() {
  window.addEventListener('online', () => {
    updateNetworkUI(true);
    toast('🌐 Network connection restored · Synchronizing data...', 'ok');
    flushOutbox();
    flushPendingViolations();
    pollScoreboard();
  });

  window.addEventListener('offline', () => {
    updateNetworkUI(false);
    toast('⚡ Network disconnected. Uninterrupted offline mode active · Your code is saved locally.', 'warn');
  });

  updateNetworkUI(navigator.onLine !== false);
}

async function flushPendingViolations() {
  const pending = store.get('pending_violations', []);
  if (!pending.length) return;
  const remaining = [];
  for (const v of pending) {
    try {
      await fetch('/api/security/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v)
      });
    } catch {
      remaining.push(v);
    }
  }
  store.set('pending_violations', remaining);
}

function showLockdownViolationUI(violation) {
  const overlay = $('#lockdown-violation-screen');
  if (!overlay) return;
  $('#violation-who').textContent = A?.session ? `${A.session.name} (${A.session.roll})` : '--';
  $('#violation-type').textContent = violation.type || 'window-blur';
  $('#violation-detail').textContent = violation.detail || 'Escaped exam environment';
  $('#violation-time').textContent = new Date(violation.timestamp || Date.now()).toLocaleTimeString();
  overlay.hidden = false;
}

function hideLockdownViolationUI() {
  const overlay = $('#lockdown-violation-screen');
  if (overlay) overlay.hidden = true;
}

async function handleLockdownViolation(violation) {
  if (!A || A.kicked || A.lockdownViolated) return;
  A.lockdownViolated = true;
  A.ended = true;
  A.editor?.setReadOnly(true);
  setButtons();

  $('#timer-val').textContent = 'EXAM BLOCKED';
  $('#timer').className = 'timer crit';
  $('#timer').querySelector('small').textContent = 'Violation detected';

  showLockdownViolationUI(violation);

  const payload = {
    roll: A.session?.roll || 'ANONYMOUS',
    name: A.session?.name || '',
    type: violation.type || 'window-blur',
    detail: violation.detail || 'Exam window escaped',
    timestamp: violation.timestamp || Date.now()
  };

  try {
    await fetch('/api/security/violation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    // If offline, store violation to deliver once connection recovers
    const pending = store.get('pending_violations', []);
    pending.push(payload);
    store.set('pending_violations', pending);
  }
}

let lockdownListenersAttached = false;
let triggerBrowserViolation = null;

function initLockdown() {
  // 1. Electron lockdown bridge (when running in standalone desktop app)
  if (window.electronLockdown?.onViolation) {
    window.electronLockdown.onViolation(violation => {
      handleLockdownViolation(violation);
    });
  }

  // 2. Standard Web Browser Focus & Escape Monitoring
  if (CONFIG.lockdown?.detectBlurInBrowser && !lockdownListenersAttached) {
    lockdownListenersAttached = true;

    triggerBrowserViolation = (type, detail) => {
      // Only monitor active contestants currently inside the arena
      if (!A?.session || !$('#screen-arena') || $('#screen-arena').hidden) return;
      if (A.lockdownViolated || A.kicked || A.ended) return;

      // Grace period: allow 3s after entering arena for initial layout and focus settling
      if (A.enteredAt && Date.now() - A.enteredAt < 3000) return;

      // Grace period: allow 8s after unblocking for contestant to re-focus window and re-enter fullscreen
      if (A.unblockedAt && Date.now() - A.unblockedAt < 8000) return;

      // Check dynamic live lockdown policy from admin
      const pol = A.lockdownPolicy || { blockBlur: true, blockTab: true, blockDevtools: true, blockFullscreen: false };
      if (type === 'window-blur' && pol.blockBlur === false) return;
      if (type === 'tab-switch' && pol.blockTab === false) return;
      if (type === 'devtools-shortcut' && pol.blockDevtools === false) return;
      if (type === 'fullscreen-escape' && pol.blockFullscreen === false) return;

      handleLockdownViolation({
        type: type || 'window-blur',
        detail: detail || 'Contestant unfocused the exam browser window',
        timestamp: Date.now()
      });
    };

    // Detected when contestant clicks outside browser, switches windows (Alt+Tab / Cmd+Tab), or docks
    window.addEventListener('blur', () => {
      triggerBrowserViolation('window-blur', 'Browser window lost focus (clicked outside or switched application)');
    });

    // Detected when contestant switches tabs or minimizes browser
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || document.visibilityState === 'hidden') {
        triggerBrowserViolation('tab-switch', 'Switched to a different browser tab or minimized window');
      }
    });

    // Block common DevTools shortcuts in standard browser
    window.addEventListener('keydown', (e) => {
      if (!A?.session || $('#screen-arena')?.hidden) return;

      const isDevKey = (
        e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(e.key)) ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U'))
      );

      if (isDevKey) {
        e.preventDefault();
        e.stopPropagation();
        triggerBrowserViolation('devtools-shortcut', `Attempted forbidden developer inspect shortcut (${e.key})`);
      }
    });

    // Disable right-click inspect context menu inside active arena
    window.addEventListener('contextmenu', (e) => {
      if (A?.session && !$('#screen-arena')?.hidden && !A.lockdownViolated) {
        e.preventDefault();
      }
    });
  }
}

async function pollScoreboard() {
  await flushOutbox();
  await flushPendingViolations();
  const roll = A.session?.roll || '';
  try {
    const [sbRes, stRes] = await Promise.all([
      fetch(CONFIG.api.scoreboard, { cache: 'no-store' }),
      fetch(`/api/contest/state?roll=${encodeURIComponent(roll)}`, { cache: 'no-store' })
    ]);
    if (sbRes.ok) {
      A.scoreboard = await sbRes.json();
      A.scoreboardError = null;
    }
    if (stRes.ok) {
      const state = await stRes.json();
      handleContestState(state);
    }
    updateNetworkUI(true);
  } catch (e) {
    A.scoreboardError = e;
    // CRITICAL: Network drops do NOT trigger security violations or block the student!
    updateNetworkUI(false);
  }
  renderStatus();
  setTimeout(pollScoreboard, 4000);
}

function handleContestState(state) {
  if (state.lockdownPolicy) {
    A.lockdownPolicy = state.lockdownPolicy;
  }

  // 1. Contestant is currently Kicked / Disqualified
  if (state.isKicked) {
    if (!A.kicked) {
      A.kicked = true;
      A.ended = true;
      A.editor?.setReadOnly(true);
      setButtons();
      $('#timer-val').textContent = 'EXAM BLOCKED';
      $('#timer').className = 'timer crit';
      $('#timer').querySelector('small').textContent = 'Session closed';

      if (state.isSecurityViolation && state.violation) {
        showLockdownViolationUI(state.violation);
      } else {
        modal({
          title: '🚫 Contest Disqualification',
          body: `<p style="color:var(--danger);font-weight:600;font-size:16px;">You have been disqualified by the administrator.</p><p class="muted">Reason: ${esc(state.kickReason || 'Removed by invigilator')}</p><p>Your session has been terminated and further submissions are blocked.</p>`,
          confirmText: 'Acknowledge',
          cancelText: ''
        });
      }
    }
    return;
  }

  // 2. Unblock / Pardon: contestant was previously blocked, but admin unblocked/pardoned them!
  const wasBlocked = A.kicked || A.lockdownViolated;
  if (!state.isKicked && wasBlocked) {
    A.kicked = false;
    A.lockdownViolated = false;
    A.unblockedAt = Date.now();
    hideLockdownViolationUI();
    $('#modal')?.close?.();
    toast('🎉 Exam access restored by administrator!', 'ok');
  }

  // 3. Announcements
  if (state.announcement && state.announcement !== A.lastAnnouncement) {
    A.lastAnnouncement = state.announcement;
    toast(`📢 Announcement: ${state.announcement}`, 'info');
  }

  // 4. Timer synchronization & Contest End Time
  if (state.endTime) {
    if (A.serverEndTime && state.endTime > A.serverEndTime) {
      const extraMin = Math.round((state.endTime - A.serverEndTime) / 60000);
      if (extraMin > 0) toast(`⏱️ Admin added +${extraMin} minutes to the contest!`, 'info');
    }
    A.serverEndTime = state.endTime;
    A.deadline = state.endTime;
  }

  // 5. Contest Lifecycle State: paused, waiting, ended, or active running!
  const now = Date.now();
  const timeRemaining = !!(A.deadline && A.deadline > now);

  if (state.status === 'paused') {
    A.paused = true;
    A.waiting = false;
    A.ended = false;
    A.editor?.setReadOnly(true);
    setButtons();
    return;
  } else if (state.status === 'waiting') {
    A.waiting = true;
    A.paused = false;
    A.ended = false;
    A.editor?.setReadOnly(true);
    setButtons();
    return;
  } else if (state.status === 'ended' || (A.deadline && !timeRemaining)) {
    A.paused = false;
    A.waiting = false;
    A.ended = true;
    A.editor?.setReadOnly(true);
    setButtons();
    return;
  } else {
    // Contest is live & running!
    const needsRestore = A.paused || A.waiting || A.ended || wasBlocked;
    A.paused = false;
    A.waiting = false;
    A.ended = false;
    A.busy = false;

    if (needsRestore) {
      A.editor?.setReadOnly(false);
      setButtons();
      window.focus();
      A.editor?.focus();
      if (!wasBlocked && state.status === 'running') {
        toast('Contest is live and active!', 'ok');
      }
    } else {
      setButtons();
    }
  }
}

/* ---------- Timer ---------- */
function tick() {
  if (A.kicked) {
    $('#timer-val').textContent = 'DISQUALIFIED';
    $('#timer').className = 'timer crit';
    $('#timer').querySelector('small').textContent = 'Session closed';
    return;
  }
  if (A.paused) {
    $('#timer-val').textContent = 'PAUSED';
    $('#timer').className = 'timer warn';
    $('#timer').querySelector('small').textContent = 'Contest paused';
    return;
  }
  if (A.waiting) {
    $('#timer-val').textContent = 'WAITING';
    $('#timer').className = 'timer';
    $('#timer').querySelector('small').textContent = 'Starting soon';
    return;
  }
  if (!A.deadline) {
    $('#timer-val').textContent = '--:--:--';
    return;
  }
  const left = A.deadline - Date.now();
  $('#timer-val').textContent = clock(left);
  $('#timer').className = `timer ${left < 2 * 60000 ? 'crit' : left < 10 * 60000 ? 'warn' : ''}`;
  $('#timer').querySelector('small').textContent = left <= 0 ? 'Contest over' : 'Time left';

  if (left <= 0) {
    if (!A.ended) {
      A.ended = true;
      A.editor?.setReadOnly(true);
      setButtons();
      toast('Time is up. Your code is saved; running and submitting are now closed.', 'warn');
    }
  } else {
    // Timer is running with active time left!
    // If A.ended was set to true (e.g. from restarted test or unblocked student), restore active state!
    if (A.ended && !A.kicked && !A.lockdownViolated && !A.paused && !A.waiting) {
      A.ended = false;
      A.editor?.setReadOnly(false);
      setButtons();
    }
  }
}

function setButtons() {
  const off = A.busy || A.ended || A.paused || A.waiting || A.kicked;
  $('#run-btn').disabled = off;
  $('#submit-btn').disabled = off;
  $('#reset-btn').disabled = A.ended || A.kicked;
  $('#lang').disabled = A.busy || A.kicked;
}

/* =========================================================================
   CONSOLE (bottom drawer)
   ========================================================================= */
const out = () => $('#console-out');
let liveLine = null;

function log(html, cls = '') {
  const line = document.createElement('span');
  line.className = cls;
  line.innerHTML = `<span class="dim">[${timeOfDay()}]</span> ${html}\n`;
  out().appendChild(line);
  const body = out().closest('.drawer-body');
  body.scrollTop = body.scrollHeight;
  return line;
}
/** A line that updates in place (progress, "Running Test 3/8 …"). */
function live(html, cls = '') {
  if (!liveLine) liveLine = log(html, cls);
  else { liveLine.className = cls; liveLine.innerHTML = `<span class="dim">[${timeOfDay()}]</span> ${html}\n`; }
}
const endLive = () => { liveLine = null; };
function block(text, cls = '') {
  const pre = document.createElement('span');
  pre.className = cls;
  pre.textContent = truncate(text).replace(/^/gm, '    ') + '\n';
  out().appendChild(pre);
}

function pill(text, tone = '') {
  const el = $('#status-pill');
  el.textContent = text;
  el.className = `status-pill ${tone}`;
}

function showTab(tab) {
  $$('#console-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.drawer [data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab; });
  openDrawer();
}

function openDrawer() {
  $('#drawer').classList.remove('collapsed');
  $('#drawer-toggle').setAttribute('aria-expanded', 'true');
  if (matchMedia('(max-width: 860px)').matches) setPanel('output');
}

/** Translate judge events into console lines and the status pill. */
function consoleListener(mode) {
  return ev => {
    switch (ev.type) {
      case 'queued':
        pill('In Queue', 'busy');
        log('In Queue', 'info');
        break;
      case 'loading': {
        const pct = ev.total ? ` ${Math.min(100, Math.round((ev.done / ev.total) * 100))}%` : '';
        pill('Loading runtime', 'busy');
        live(`${esc(ev.message)}${pct}`, 'dim');
        break;
      }
      case 'loaded':
        live(`${esc(ev.name)} runtime ready`, 'dim');
        endLive();
        break;
      case 'compiling':
        endLive();
        pill('Compiling', 'busy');
        log(`Compiling · ${esc(ev.engine)}`);
        break;
      case 'compiled':
        if (ev.ok && ev.log) { log(`${esc(ev.okText)} — with warnings:`, 'warn'); block(ev.log, 'warn'); }
        else if (ev.ok) log(esc(ev.okText), 'ok');
        break;
      case 'test-start':
        pill(`Running Test ${ev.index + 1}/${ev.total}`, 'busy');
        live(`Running Test ${ev.index + 1}/${ev.total} …`);
        break;
      case 'test-done': {
        const meta = VERDICTS[ev.verdict];
        const cls = ev.verdict === 'AC' ? 'ok' : meta.tone === 'warn' ? 'warn' : meta.tone === 'neutral' ? 'dim' : 'err';
        live(`Running Test ${ev.index + 1}/${ev.total} … <span class="${cls}">${ev.verdict === 'AC' ? '✓' : '✗'} ${esc(meta.label)}</span> <span class="dim">${ev.verdict === 'TLE' ? '> ' : ''}${ev.timeMs} ms</span>`);
        endLive();
        if (ev.stderr && ev.verdict !== 'AC' && ev.verdict !== 'TLE') block(mode === 'submit' ? ev.stderr.split('\n').slice(-6).join('\n') : ev.stderr, 'err');
        break;
      }
      case 'done': {
        if (ev.verdict === 'CE') liveLine?.remove();     // a lazily-compiling engine failed mid-test
        endLive();
        const meta = VERDICTS[ev.verdict];
        pill(`${meta.short} · ${meta.label}`, meta.tone === 'neutral' ? '' : meta.tone);
        if (ev.verdict === 'CE') { log('Compilation failed:', 'err'); block(ev.log || 'Unknown error', 'err'); }
        if (ev.verdict === 'IE') { log('The judge could not run your code:', 'err'); block(ev.log, 'err'); }
        break;
      }
    }
  };
}

function verdictBanner(summary, mode) {
  const meta = VERDICTS[summary.verdict];
  const counted = !['CE', 'IE', 'NJ'].includes(summary.verdict);
  const where = counted && summary.failedTest && summary.verdict !== 'AC' ? ` on ${mode === 'sample' ? 'sample' : 'test'} ${summary.failedTest}` : '';
  const detail = summary.verdict === 'NJ' ? 'Java is not executed in the browser. Your code is saved; this submission does not count as an attempt.'
    : counted ? `${summary.passed}/${summary.total} ${mode === 'sample' ? 'samples' : 'hidden tests'} passed · max ${summary.timeMs} ms` : '';
  const tone = meta.tone === 'neutral' ? '' : meta.tone;
  $('#verdict').innerHTML = `<div class="verdict-banner ${tone}"><strong>${esc(meta.label)} (${meta.short})${esc(where)}</strong><span class="muted">${detail}</span></div>`;
}

function renderSampleResults(summary, tests) {
  if (!summary.results.length) {
    $('#tests').innerHTML = `<div class="empty">${summary.verdict === 'CE' ? 'Fix the compilation error to run the samples.' : 'No sample results.'}</div>`;
    return;
  }
  $('#tests').innerHTML = summary.results.map((r, i) => `<section class="test-case">
    <header><b>Sample ${i + 1}</b>${verdictBadge(r.verdict)}<span class="t">${r.verdict === 'TLE' ? '> ' : ''}${r.timeMs} ms</span></header>
    <div class="io-grid">
      <div><h5>Input</h5><pre>${esc(truncate(tests[i].input, 2000))}</pre></div>
      <div><h5>Expected</h5><pre>${esc(tests[i].output)}</pre></div>
      <div><h5>Your output</h5><pre class="${r.verdict === 'WA' ? 'diff' : ''}">${esc(truncate(r.stdout, 2000)) || '<span class="muted">(empty)</span>'}</pre></div>
      ${r.stderr ? `<div class="stderr"><h5>stderr</h5><pre>${esc(truncate(r.stderr, 2000))}</pre></div>` : ''}
    </div>
  </section>`).join('');
}

/* =========================================================================
   RUN & SUBMIT
   ========================================================================= */
function startJob(title) {
  A.busy = true; setButtons();
  stashCode();
  out().innerHTML = '';
  $('#verdict').innerHTML = '';
  endLive();
  showTab('console');
  log(`<span class="hl">${esc(title)}</span>`);
}

async function runSamples() {
  if (A.busy || A.ended) return;
  const p = problem(), lang = A.state.lang;
  startJob(`Run sample tests · Problem ${p.id} · ${LANGUAGES[lang].label}`);
  const tests = p.samples.map(s => ({ input: s.input, output: s.output }));
  try {
    const summary = await judge({ lang, source: A.editor.getValue(), tests, timeLimitMs: p.timeLimitMs, mode: 'sample', onEvent: consoleListener('sample') });
    verdictBanner(summary, 'sample');
    renderSampleResults(summary, tests);
    if (summary.verdict === 'AC') log(`All ${summary.total} samples passed. Submit to run the hidden tests.`, 'ok');
  } finally {
    A.busy = false; setButtons();
  }
}

async function hiddenTests(p) {
  if (!A.hidden[p.id]) {
    const res = await fetch(`data/tests/${encodeURIComponent(p.id)}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load the hidden tests (HTTP ${res.status}). Tell an invigilator.`);
    A.hidden[p.id] = await res.json();
  }
  return A.hidden[p.id];
}

async function submitSolution() {
  if (A.busy || A.ended) return;
  const p = problem(), lang = A.state.lang, source = A.editor.getValue();
  if (!source.trim()) return toast('Your editor is empty.', 'warn');
  startJob(`Submit · Problem ${p.id} · ${LANGUAGES[lang].label}`);

  const sub = { n: A.state.subs.length + 1, at: Date.now(), problem: p.id, lang, verdict: 'PENDING', passed: 0, total: 0, timeMs: null, failedTest: null };
  A.state.subs.push(sub);
  A.save();
  renderStatus();

  try {
    let tests;
    try { tests = await hiddenTests(p); }
    catch (e) {
      log(esc(e.message), 'err');
      pill('Judge error', 'bad');
      A.state.subs.pop(); A.save();
      return;
    }
    const summary = await judge({ lang, source, tests, timeLimitMs: p.timeLimitMs, mode: 'submit', onEvent: consoleListener('submit') });
    Object.assign(sub, { verdict: summary.verdict, passed: summary.passed, total: summary.total, timeMs: summary.timeMs, failedTest: summary.failedTest });
    A.save();
    verdictBanner(summary, 'submit');
    $('#tests').innerHTML = `<div class="empty">Hidden test data is not shown. Submission #${sub.n}: ${esc(VERDICTS[summary.verdict].label)} · ${summary.passed}/${summary.total} tests passed.</div>`;

    const firstSolve = summary.verdict === 'AC' && A.state.subs.filter(s => s.problem === p.id && s.verdict === 'AC').length === 1;
    if (firstSolve) toast(`Problem ${esc(p.id)} accepted — +${p.points} points.`, 'ok');
    else if (summary.verdict === 'NJ') toast('Java is not executed in the browser, so this submission was saved but not judged.', 'warn');

    // Queue for the organiser's server (kept locally until it is delivered).
    if (CONFIG.api.submissions && summary.verdict !== 'IE') {
      const key = `outbox.${A.session.roll}`;
      const outbox = store.get(key, []);
      outbox.push({ name: A.session.name, roll: A.session.roll, startedAt: A.state.startedAt, ...sub, source });
      store.set(key, outbox);
      flushOutbox().then(renderStatus);
    }
  } finally {
    if (sub.verdict === 'PENDING') { sub.verdict = 'IE'; A.save(); }
    A.busy = false; setButtons();
    renderProblemTabs();
    renderStatus();
  }
}

/* =========================================================================
   WIRING
   ========================================================================= */
function setPanel(name) {
  $('#arena').dataset.panel = name;
  $$('#panel-tabs button').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
}

function wireArena() {
  $('#q-tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-q]');
    if (!btn || Number(btn.dataset.q) === A.state.problem) return;
    stashCode();
    A.state.problem = Number(btn.dataset.q);
    A.save();
    renderProblemTabs(); renderProblem(); loadCode();
    selectView('problem');
  });

  const selectView = view => {
    $$('#view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#view-problem').hidden = view !== 'problem';
    $('#view-status').hidden = view !== 'status';
  };
  $('#view-tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) selectView(b.dataset.view); });

  $('#view-problem').addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const [i, field] = btn.dataset.copy.split(':');
    const text = problem().samples[i][field];
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });

  $('#lang').addEventListener('change', e => {
    stashCode();
    A.state.lang = e.target.value;
    A.save();
    loadCode(); updateLangUI(); renderProblem();
    prewarm(A.state.lang);
  });

  $('#reset-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Reset to the starter template?', body: `Your ${esc(LANGUAGES[A.state.lang].label)} code for problem ${esc(problem().id)} will be replaced. This cannot be undone.`, confirm: 'Reset code', tone: 'danger' });
    if (!ok) return;
    delete A.state.code[codeKey()];
    A.save();
    loadCode();
  });

  $('#run-btn').addEventListener('click', runSamples);
  $('#submit-btn').addEventListener('click', submitSolution);
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
    e.preventDefault();
    e.shiftKey ? submitSolution() : runSamples();
  });

  $('#console-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('#drawer-toggle').addEventListener('click', () => {
    const collapsed = $('#drawer').classList.toggle('collapsed');
    $('#drawer-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('#drawer-toggle').setAttribute('aria-label', collapsed ? 'Expand console' : 'Collapse console');
  });
  $('#panel-tabs').addEventListener('click', e => { const b = e.target.closest('[data-panel]'); if (b) setPanel(b.dataset.panel); });

  $('#end-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'End your session?',
      body: 'Your code and results stay saved on this computer. You can sign back in with the same roll number — the contest clock keeps running.',
      confirm: 'End session', tone: 'danger'
    });
    if (!ok) return;
    stashCode();
    store.remove('session');
    location.reload();
  });

  wireResizers();
  window.addEventListener('beforeunload', stashCode);
}

/** Drag the split between panes and the console height. Sizes persist per browser. */
function wireResizers() {
  const root = document.documentElement.style;
  const saved = store.get('layout', {});
  if (saved.left) root.setProperty('--left-w', saved.left);
  if (saved.drawer) root.setProperty('--drawer-h', saved.drawer);

  const drag = (handle, onMove) => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const move = ev => onMove(ev);
      const up = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        store.set('layout', { left: root.getPropertyValue('--left-w'), drawer: root.getPropertyValue('--drawer-h') });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  };
  drag($('#split-handle'), e => {
    const pct = Math.min(70, Math.max(22, (e.clientX / window.innerWidth) * 100));
    root.setProperty('--left-w', pct.toFixed(1) + '%');
  });
  drag($('#drawer-grip'), e => {
    const right = $('.arena-right').getBoundingClientRect();
    const h = Math.min(right.height - 120, Math.max(120, right.bottom - e.clientY));
    root.setProperty('--drawer-h', Math.round(h) + 'px');
  });
  const nudge = (prop, delta, min, max, unit) => {
    const v = parseFloat(root.getPropertyValue(prop) || getComputedStyle(document.documentElement).getPropertyValue(prop));
    root.setProperty(prop, Math.min(max, Math.max(min, v + delta)) + unit);
  };
  $('#split-handle').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') nudge('--left-w', -2, 22, 70, '%');
    if (e.key === 'ArrowRight') nudge('--left-w', 2, 22, 70, '%');
  });
  $('#drawer-grip').addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') nudge('--drawer-h', 24, 120, 700, 'px');
    if (e.key === 'ArrowDown') nudge('--drawer-h', -24, 120, 700, 'px');
  });
}

boot().catch(err => {
  console.error(err);
  $('#boot').innerHTML = `<span>Could not start the contest: ${esc(err.message)}</span>`;
});
