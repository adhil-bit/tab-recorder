// Floating control bar injected into the page when the toolbar icon is clicked.
// Reads recording state from chrome.storage.session and sends commands to the
// service worker. Lives in a closed shadow root so page styles can't touch it.

(() => {
  if (window.__tabAudioRecorderBar) {
    window.__tabAudioRecorderBar.show();
    return;
  }

  const SAVED_VISIBLE_MS = 8000;
  const ERROR_VISIBLE_MS = 10000;

  const ICON = {
    pause:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>',
    play:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 2.9v10.2a.8.8 0 0 0 1.22.68l8.1-5.1a.8.8 0 0 0 0-1.36l-8.1-5.1A.8.8 0 0 0 4.5 2.9z" fill="currentColor"/></svg>',
    stop:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.2" fill="currentColor"/></svg>',
    close:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    folder:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.6 1.6h4.7A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert:
      '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 3.5v5.5M8 12v.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .bar {
      display: flex; align-items: center; gap: 2px;
      padding: 5px;
      background: rgba(26, 27, 30, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 999px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
      font: 500 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #ececf1;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      animation: pop 0.18s ease-out;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } }
    .status {
      display: flex; align-items: center; gap: 9px;
      height: 34px; padding: 0 13px 0 11px;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 999px;
      cursor: grab; touch-action: none;
    }
    .status:active { cursor: grabbing; }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #ff4757; display: grid; place-items: center; }
    .dot.rec { animation: pulse 1.4s ease-in-out infinite; }
    .dot.paused { background: #f5a524; }
    .dot.ok { width: 18px; height: 18px; background: #34c98a; color: #fff; }
    .dot.err { width: 18px; height: 18px; background: #f5a524; color: #1a1b1e; }
    .dot.spin { width: 14px; height: 14px; background: none; border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff; animation: spin 0.8s linear infinite; }
    @keyframes pulse { 50% { opacity: 0.3; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .time { font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; min-width: 40px; }
    .meter { display: flex; align-items: center; gap: 2px; height: 16px; }
    .meter i { display: block; width: 3px; height: 3px; border-radius: 2px; background: #9fa3ad; transition: height 0.09s linear; }
    .msg { color: #c9cbd3; max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sep { flex: none; width: 1px; height: 20px; background: rgba(255, 255, 255, 0.12); margin: 0 5px; }
    button {
      all: unset;
      width: 34px; height: 34px; border-radius: 50%;
      display: grid; place-items: center;
      color: #d4d5db; cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
    button:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
    button.stop { color: #ff4757; }
    button.stop:hover { color: #ff6b78; }
    [hidden] { display: none !important; }
  `;

  // ------------------------------------------------------------- DOM

  const host = document.createElement('tab-audio-recorder-bar');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 24px; bottom: 24px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="bar" role="toolbar" aria-label="Tab Audio Recorder">
      <div class="status" title="Drag to move">
        <span class="dot"></span>
        <span class="time">00:00</span>
        <span class="meter"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="msg"></span>
      </div>
      <span class="sep sep1"></span>
      <button class="pause" type="button" title="Pause" aria-label="Pause">${ICON.pause}</button>
      <button class="stop" type="button" title="Stop and save" aria-label="Stop and save">${ICON.stop}</button>
      <button class="folder" type="button" title="Show in folder" aria-label="Show in folder">${ICON.folder}</button>
      <span class="sep sep2"></span>
      <button class="close" type="button" title="Hide" aria-label="Hide">${ICON.close}</button>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    status: $('.status'),
    dot: $('.dot'),
    time: $('.time'),
    meter: $('.meter'),
    bars: [...root.querySelectorAll('.meter i')],
    msg: $('.msg'),
    sep1: $('.sep1'),
    pause: $('.pause'),
    stop: $('.stop'),
    folder: $('.folder'),
    close: $('.close'),
  };

  // ------------------------------------------------------------- state

  let rec = { status: 'idle' };
  let lastResult = null;
  let mounted = false;
  let tickTimer = null;
  let levelTimer = null;
  let hideTimer = null;
  const levels = [0, 0, 0, 0, 0];

  const alive = () => {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  };

  function send(type, data = {}) {
    if (!alive()) return destroy();
    return chrome.runtime.sendMessage({ target: 'background', type, ...data }).catch(() => {});
  }

  function fmtTime(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  function fmtBytes(b) {
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  }

  const elapsed = () => rec.activeMs + (rec.status === 'recording' ? Date.now() - rec.resumedAt : 0);

  // ------------------------------------------------------------- mount / position

  async function mount() {
    if (mounted) return;
    mounted = true;
    (document.documentElement || document.body).appendChild(host);
    try {
      const { overlayPos } = await chrome.storage.local.get('overlayPos');
      if (overlayPos) placeAt(overlayPos.left, overlayPos.top);
    } catch {
      /* ignore */
    }
  }

  function unmount() {
    mounted = false;
    host.remove();
    stopLoops();
    clearTimeout(hideTimer);
  }

  function placeAt(left, top) {
    const r = host.getBoundingClientRect();
    const w = r.width || 260;
    const h = r.height || 46;
    const x = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    const y = Math.min(Math.max(8, top), window.innerHeight - h - 8);
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  el.status.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    el.status.setPointerCapture(e.pointerId);
    const move = (ev) => placeAt(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      el.status.removeEventListener('pointermove', move);
      el.status.removeEventListener('pointerup', up);
      el.status.removeEventListener('pointercancel', up);
      const nr = host.getBoundingClientRect();
      if (alive()) chrome.storage.local.set({ overlayPos: { left: nr.left, top: nr.top } }).catch(() => {});
    };
    el.status.addEventListener('pointermove', move);
    el.status.addEventListener('pointerup', up);
    el.status.addEventListener('pointercancel', up);
  });

  window.addEventListener('resize', () => {
    if (!mounted || host.style.left === '') return;
    placeAt(parseFloat(host.style.left), parseFloat(host.style.top));
  });

  // ------------------------------------------------------------- render

  function setDot(kind) {
    el.dot.className = 'dot ' + kind;
    el.dot.innerHTML = kind === 'ok' ? ICON.check : kind === 'err' ? ICON.alert : '';
  }

  function show_(parts) {
    el.time.hidden = !parts.time;
    el.meter.hidden = !parts.meter;
    el.msg.hidden = !parts.msg;
    el.pause.hidden = !parts.pause;
    el.stop.hidden = !parts.stop;
    el.folder.hidden = !parts.folder;
    el.sep1.hidden = !(parts.pause || parts.stop || parts.folder);
  }

  function render() {
    clearTimeout(hideTimer);
    const s = rec.status;

    if (s === 'recording' || s === 'paused') {
      if (rec.overlayHidden) return unmount();
      mount();
      const paused = s === 'paused';
      setDot(paused ? 'paused' : 'rec');
      el.msg.textContent = 'Paused';
      show_({ time: true, meter: !paused, msg: paused, pause: true, stop: true });
      el.pause.innerHTML = paused ? ICON.play : ICON.pause;
      el.pause.title = paused ? 'Resume' : 'Pause';
      el.pause.setAttribute('aria-label', el.pause.title);
      el.close.title = 'Hide (keeps recording)';
      el.time.textContent = fmtTime(elapsed());
      startLoops(paused);
      return;
    }

    stopLoops();

    if (s === 'saving') {
      mount();
      setDot('spin');
      el.msg.textContent = 'Saving…';
      show_({ msg: true });
      el.close.title = 'Hide';
      return;
    }

    // idle: show the last result briefly, otherwise go away
    const recent = lastResult && Date.now() - (lastResult.at || 0) < 15000;
    if (!recent) return unmount();
    mount();
    el.close.title = 'Close';
    if (lastResult.ok) {
      setDot('ok');
      const bits = ['Saved'];
      if (lastResult.durationSec) bits.push(fmtTime(lastResult.durationSec * 1000));
      if (lastResult.size) bits.push(fmtBytes(lastResult.size));
      el.msg.textContent = bits.join(' · ');
      el.status.title = lastResult.filename || '';
      show_({ msg: true, folder: lastResult.downloadId != null });
      hideTimer = setTimeout(unmount, SAVED_VISIBLE_MS);
    } else {
      setDot('err');
      el.msg.textContent = lastResult.error || 'Something went wrong';
      el.status.title = lastResult.error || '';
      show_({ msg: true });
      hideTimer = setTimeout(unmount, ERROR_VISIBLE_MS);
    }
  }

  // ------------------------------------------------------------- live loops

  function tick() {
    el.time.textContent = fmtTime(elapsed());
  }

  async function pollLevel() {
    if (!alive()) return destroy();
    let level = 0;
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'level' });
      level = res && res.ok ? res.level : 0;
    } catch {
      /* offscreen not ready */
    }
    levels.shift();
    levels.push(Math.min(1, Math.sqrt(level)));
    el.bars.forEach((b, i) => {
      b.style.height = 3 + Math.round(levels[i] * 13) + 'px';
    });
  }

  function startLoops(paused) {
    if (!tickTimer) tickTimer = setInterval(tick, 250);
    if (paused) {
      clearInterval(levelTimer);
      levelTimer = null;
    } else if (!levelTimer) {
      levelTimer = setInterval(pollLevel, 110);
    }
  }

  function stopLoops() {
    clearInterval(tickTimer);
    clearInterval(levelTimer);
    tickTimer = levelTimer = null;
  }

  // ------------------------------------------------------------- actions

  el.pause.addEventListener('click', () => send(rec.status === 'paused' ? 'resume' : 'pause'));
  el.stop.addEventListener('click', () => send('stop'));
  el.folder.addEventListener('click', () => {
    if (lastResult && lastResult.downloadId != null) send('show-download', { id: lastResult.downloadId });
  });
  el.close.addEventListener('click', () => {
    if (rec.status === 'recording' || rec.status === 'paused') send('hide-overlay');
    unmount();
  });
  host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  host.addEventListener('mouseleave', () => {
    if (rec.status === 'idle' && mounted) hideTimer = setTimeout(unmount, 3000);
  });

  // ------------------------------------------------------------- sync with extension state

  function onStorage(changes, area) {
    if (area !== 'session') return;
    if (changes.rec) rec = changes.rec.newValue || { status: 'idle' };
    if (changes.lastResult) lastResult = changes.lastResult.newValue || null;
    if (changes.rec || changes.lastResult) render();
  }

  async function show() {
    if (!alive()) return destroy();
    try {
      const s = await chrome.storage.session.get(['rec', 'lastResult']);
      rec = s.rec || { status: 'idle' };
      lastResult = s.lastResult || null;
    } catch {
      return;
    }
    render();
  }

  function destroy() {
    unmount();
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* context gone */
    }
    delete window.__tabAudioRecorderBar;
  }

  chrome.storage.onChanged.addListener(onStorage);
  window.__tabAudioRecorderBar = { show };
  show();
})();
