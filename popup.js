// Toolbar popup: choose audio or video, format and quality, then start.
// After starting, the popup closes and the floating control bar takes over
// (on the page for audio, in a small window for video).

const DEFAULT_PREFS = {
  mode: 'audio',
  format: 'mp3',
  bitrate: 192,
  videoFormat: 'mp4',
  videoQuality: '1080',
  monitor: true,
  saveAs: false,
};
const WAV_BYTES_PER_SEC = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit
const VIDEO_BITRATE = { 720: 5000000, 1080: 8000000 };

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

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function bytesPerSec(r) {
  if (r.mode === 'video') return ((VIDEO_BITRATE[r.videoQuality] || VIDEO_BITRATE[1080]) + 192000) / 8;
  if (r.format === 'wav') return WAV_BYTES_PER_SEC;
  return (r.bitrate * 1000) / 8;
}

function elapsedOf(r) {
  return r.activeMs + (r.status === 'recording' ? Date.now() - r.resumedAt : 0);
}

function friendlyError(message = '') {
  if (/active stream/i.test(message)) return 'This tab is already being recorded or shared. Stop that first.';
  if (/not been invoked|activeTab/i.test(message)) return 'Open this popup from the tab you want to record, then try again.';
  if (/chrome pages|cannot be captured|cannot capture/i.test(message)) return "Chrome doesn't allow recording this page.";
  return message || 'Something went wrong.';
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function send(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...data });
}

function savePrefs() {
  return chrome.storage.local.set({ prefs });
}

function check(seg, value) {
  for (const b of seg.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
  }
}

// ------------------------------------------------------------ rendering

function renderPrefs() {
  const video = prefs.mode === 'video';
  check($('modeSeg'), prefs.mode);
  check($('audioFormatSeg'), prefs.format);
  check($('videoFormatSeg'), prefs.videoFormat);

  $('audioFormatSeg').hidden = video;
  $('videoFormatSeg').hidden = !video;
  $('bitrate').hidden = video;
  $('videoQuality').hidden = !video;

  $('bitrate').value = String(prefs.bitrate);
  $('bitrate').disabled = prefs.format === 'wav';
  $('videoQuality').value = String(prefs.videoQuality);
  $('monitor').checked = !!prefs.monitor;
  $('saveAs').checked = !!prefs.saveAs;

  const perMin = fmtBytes(bytesPerSec({ ...prefs, status: 'idle' }) * 60);
  $('formatHint').textContent = video
    ? `${prefs.videoFormat === 'mp4' ? 'MP4 plays everywhere' : 'WebM, efficient'} · about ${perMin} per minute`
    : {
        mp3: `Plays everywhere · about ${perMin} per minute`,
        wav: `Uncompressed, best quality · about ${perMin} per minute`,
        webm: `Opus audio, efficient · about ${perMin} per minute`,
      }[prefs.format];

  $('startLabel').textContent = video ? 'Start video recording' : 'Start audio recording';
}

function render() {
  const status = rec.status || 'idle';
  const pill = $('statusPill');
  pill.className = 'pill ' + status;
  pill.textContent = { idle: 'Ready', recording: '● Recording', paused: 'Paused', saving: 'Saving…' }[status] || 'Ready';

  $('idleView').hidden = status !== 'idle';
  $('activeView').hidden = status !== 'recording' && status !== 'paused';
  $('savingView').hidden = status !== 'saving';

  if (status === 'idle') {
    renderPrefs();
    const restricted = !activeTab || isRestricted(activeTab.url);
    $('startBtn').disabled = restricted;
    $('pageNote').hidden = !restricted;
    $('pageNote').textContent = "Chrome doesn't allow recording this page. Open a normal website tab.";
    stopLoops();
  } else if (status === 'recording' || status === 'paused') {
    const what = rec.mode === 'video' ? 'Video' : 'Audio';
    const fmt = rec.mode === 'video' ? `${(rec.format || 'mp4').toUpperCase()} ${rec.videoQuality || 1080}p` : rec.format === 'wav' ? 'WAV' : `${rec.format.toUpperCase()} ${rec.bitrate} kbps`;
    $('fmtLabel').textContent = `${what} · ${fmt}`;
    $('pauseBtn').textContent = status === 'paused' ? 'Resume' : 'Pause';
    $('liveDot').classList.toggle('paused', status === 'paused');
    $('showBar').hidden = !rec.overlayHidden;
    tick();
    startLoops();
  } else {
    stopLoops();
  }

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
  $('sizeEst').textContent = '≈ ' + fmtBytes(bytesPerSec(rec) * (ms / 1000));
}

async function pollLevel() {
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'level' });
    const level = res && res.ok ? res.level : 0;
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
        windowId: activeTab.windowId,
        title: activeTab.title,
        url: activeTab.url,
        favIconUrl: activeTab.favIconUrl,
        width: activeTab.width,
        height: activeTab.height,
      },
    });
    if (!res || !res.ok) throw new Error(res && res.error);
    window.close(); // the floating controls take over from here
  } catch (err) {
    showError(friendlyError(err && err.message));
    btn.disabled = false;
    renderPrefs();
  }
}

async function command(type, data) {
  showError('');
  try {
    const res = await send(type, data);
    if (!res || !res.ok) throw new Error(res && res.error);
  } catch (err) {
    showError(friendlyError(err && err.message));
  }
}

// ------------------------------------------------------------ wiring

function onSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    prefs[key] = b.dataset.value;
    savePrefs();
    renderPrefs();
  });
}

onSeg('modeSeg', 'mode');
onSeg('audioFormatSeg', 'format');
onSeg('videoFormatSeg', 'videoFormat');

$('bitrate').addEventListener('change', (e) => {
  prefs.bitrate = Number(e.target.value);
  savePrefs();
  renderPrefs();
});
$('videoQuality').addEventListener('change', (e) => {
  prefs.videoQuality = e.target.value;
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
$('showBar').addEventListener('click', async () => {
  await command('show-controls', { tab: activeTab && { id: activeTab.id, windowId: activeTab.windowId } });
  window.close();
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
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-recording');
    if (cmd && cmd.shortcut) {
      const el = $('shortcut');
      el.textContent = 'Shortcut ';
      const k = document.createElement('kbd');
      k.textContent = cmd.shortcut;
      el.append(k);
    }
  } catch {
    /* ignore */
  }

  render();
})();
