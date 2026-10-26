const DEFAULT_PREFS = { format: 'mp3', bitrate: 192, monitor: true, saveAs: false };
const WAV_BYTES_PER_SEC = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit

const $ = (id) => document.getElementById(id);

let prefs = { ...DEFAULT_PREFS };
let activeTab = null;
let rec = { status: 'idle' };
let lastResult = null;
let tickTimer = null;
let levelTimer = null;

// ------------------------------------------------------------ helpers

function isRestricted(url) {
  if (!url) return false;
  return (
    /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search):/i.test(url) ||
    /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatLabel(format, bitrate) {
  if (format === 'wav') return 'WAV · lossless';
  return `${format.toUpperCase()} · ${bitrate} kbps`;
}

function estimateBytes(format, bitrate, ms) {
  const sec = ms / 1000;
  return format === 'wav' ? WAV_BYTES_PER_SEC * sec : (bitrate * 1000 * sec) / 8;
}

function elapsedOf(r) {
  return r.activeMs + (r.status === 'recording' ? Date.now() - r.resumedAt : 0);
}

function friendlyError(message = '') {
  if (/active stream/i.test(message)) return 'This tab is already being captured (maybe by another extension or a screen share). Stop that first.';
  if (/not been invoked|activeTab|permission/i.test(message)) return 'Open this popup from the tab you want to record, then try again.';
  if (/chrome pages|cannot be captured|cannot capture/i.test(message)) return "Chrome doesn't allow recording this page.";
  return message || 'Something went wrong.';
}

function showError(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = !message;
}

function send(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...data });
}

async function savePrefs() {
  await chrome.storage.local.set({ prefs });
}

// ------------------------------------------------------------ rendering

function renderSource() {
  const recordingOther = rec.status !== 'idle' && rec.tabId && (!activeTab || rec.tabId !== activeTab.id);
  const recording = rec.status === 'recording' || rec.status === 'paused' || rec.status === 'saving';
  const icon = $('srcIcon');
  const meta = $('srcMeta');

  if (recording) {
    $('srcTitle').textContent = rec.title || 'Recording';
    icon.src = rec.favIconUrl || 'icons/icon32.png';
    meta.textContent = hostOf(rec.url) + (recordingOther ? ' · another tab' : '');
  } else if (activeTab) {
    $('srcTitle').textContent = activeTab.title || 'This tab';
    icon.src = activeTab.favIconUrl || 'icons/icon32.png';
    meta.textContent = '';
    const host = document.createElement('span');
    host.textContent = hostOf(activeTab.url);
    meta.append(host);
    if (isRestricted(activeTab.url)) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = (host.textContent ? ' · ' : '') + "Chrome doesn't allow recording this page";
      meta.append(w);
    } else {
      const a = document.createElement('span');
      a.className = activeTab.audible ? 'audible' : '';
      a.textContent = (host.textContent ? ' · ' : '') + (activeTab.audible ? '● Playing audio' : 'No sound right now');
      meta.append(a);
    }
  }
  icon.onerror = () => {
    icon.onerror = null;
    icon.src = 'icons/icon32.png';
  };
}

function renderPrefs() {
  for (const b of $('formatSeg').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.format === prefs.format));
  }
  $('bitrate').value = String(prefs.bitrate);
  $('bitrate').disabled = prefs.format === 'wav';
  $('monitor').checked = !!prefs.monitor;
  $('saveAs').checked = !!prefs.saveAs;

  const hints = {
    mp3: `Plays everywhere · about ${fmtBytes(estimateBytes('mp3', prefs.bitrate, 60000))} per minute`,
    wav: `Uncompressed, best quality · about ${fmtBytes(WAV_BYTES_PER_SEC * 60)} per minute`,
    webm: `Opus audio, efficient · about ${fmtBytes(estimateBytes('webm', prefs.bitrate, 60000))} per minute`,
  };
  $('formatHint').textContent = hints[prefs.format];
}

function render() {
  const status = rec.status || 'idle';
  const pill = $('statusPill');
  pill.className = 'pill ' + status;
  pill.textContent = { idle: 'Ready', recording: '● Recording', paused: 'Paused', saving: 'Saving…' }[status] || 'Ready';

  $('idleView').hidden = status !== 'idle';
  $('activeView').hidden = status !== 'recording' && status !== 'paused';
  $('savingView').hidden = status !== 'saving';

  renderSource();

  if (status === 'idle') {
    renderPrefs();
    $('startBtn').disabled = !activeTab || isRestricted(activeTab.url);
    stopLoops();
  } else if (status === 'recording' || status === 'paused') {
    $('fmtLabel').textContent = formatLabel(rec.format, rec.bitrate);
    $('pauseBtn').textContent = status === 'paused' ? 'Resume' : 'Pause';
    $('liveDot').classList.toggle('paused', status === 'paused');
    $('gotoTab').hidden = !activeTab || rec.tabId === activeTab.id;
    tick();
    startLoops();
  } else {
    stopLoops();
  }

  // Last saved file / last error (only while idle)
  const showResult = status === 'idle' && lastResult && lastResult.ok;
  $('result').hidden = !showResult;
  if (showResult) {
    const bits = [lastResult.filename, fmtBytes(lastResult.size)];
    if (lastResult.durationSec) bits.push(fmtTime(lastResult.durationSec * 1000));
    $('resultFile').textContent = bits.join(' · ');
  }
  if (status === 'idle' && lastResult && !lastResult.ok) showError(lastResult.error);
}

// ------------------------------------------------------------ live updates

function tick() {
  if (rec.status !== 'recording' && rec.status !== 'paused') return;
  const ms = elapsedOf(rec);
  $('timer').textContent = fmtTime(ms);
  $('sizeEst').textContent = '≈ ' + fmtBytes(estimateBytes(rec.format, rec.bitrate, ms));
}

async function pollLevel() {
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'level' });
    const level = res && res.ok ? res.level : 0;
    // Perceptual-ish scaling so quiet music still moves the meter.
    const pct = Math.min(100, Math.round(Math.sqrt(level) * 100));
    $('meterFill').style.width = (rec.status === 'paused' ? 0 : pct) + '%';
  } catch {
    $('meterFill').style.width = '0%';
  }
}

function startLoops() {
  if (!tickTimer) tickTimer = setInterval(tick, 250);
  if (!levelTimer) levelTimer = setInterval(pollLevel, 90);
}

function stopLoops() {
  clearInterval(tickTimer);
  clearInterval(levelTimer);
  tickTimer = levelTimer = null;
}

// ------------------------------------------------------------ actions

async function start() {
  showError('');
  const btn = $('startBtn');
  btn.disabled = true;
  $('startLabel').textContent = 'Starting…';
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const res = await send('start', {
      streamId,
      prefs,
      tab: {
        id: activeTab.id,
        title: activeTab.title,
        url: activeTab.url,
        favIconUrl: activeTab.favIconUrl,
      },
    });
    if (!res || !res.ok) throw new Error(res && res.error);
  } catch (err) {
    showError(friendlyError(err && err.message));
  } finally {
    btn.disabled = false;
    $('startLabel').textContent = 'Start recording';
  }
}

async function command(type) {
  showError('');
  try {
    const res = await send(type);
    if (!res || !res.ok) throw new Error(res && res.error);
  } catch (err) {
    showError(friendlyError(err && err.message));
  }
}

// ------------------------------------------------------------ wiring

$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-format]');
  if (!b) return;
  prefs.format = b.dataset.format;
  savePrefs();
  renderPrefs();
});
$('bitrate').addEventListener('change', (e) => {
  prefs.bitrate = Number(e.target.value);
  savePrefs();
  renderPrefs();
});
$('monitor').addEventListener('change', (e) => {
  prefs.monitor = e.target.checked;
  savePrefs();
});
$('saveAs').addEventListener('change', (e) => {
  prefs.saveAs = e.target.checked;
  savePrefs();
});
$('startBtn').addEventListener('click', start);
$('stopBtn').addEventListener('click', () => command('stop'));
$('pauseBtn').addEventListener('click', () => command(rec.status === 'paused' ? 'resume' : 'pause'));
$('gotoTab').addEventListener('click', async () => {
  try {
    const t = await chrome.tabs.update(rec.tabId, { active: true });
    if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch {
    /* tab may be gone */
  }
});
$('showFile').addEventListener('click', () => {
  if (lastResult && lastResult.downloadId != null) chrome.downloads.show(lastResult.downloadId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.rec) rec = changes.rec.newValue || { status: 'idle' };
  if (changes.lastResult) {
    lastResult = changes.lastResult.newValue || null;
    if (!lastResult || lastResult.ok) showError('');
  }
  if (changes.rec || changes.lastResult) render();
});

(async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { prefs: saved } = await chrome.storage.local.get('prefs');
  prefs = { ...DEFAULT_PREFS, ...(saved || {}) };
  const session = await chrome.storage.session.get(['rec', 'lastResult']);
  rec = session.rec || { status: 'idle' };
  lastResult = session.lastResult || null;

  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'toggle-recording');
    const el = $('shortcut');
    if (c && c.shortcut) {
      el.textContent = 'Shortcut ';
      const k = document.createElement('kbd');
      k.textContent = c.shortcut;
      el.append(k);
    }
  } catch {
    /* ignore */
  }

  render();
})();
