const DEFAULT_PREFS = { format: 'mp3', bitrate: 192, monitor: true, saveAs: false };
const WAV_BYTES_PER_SEC = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit

const $ = (id) => document.getElementById(id);
let prefs = { ...DEFAULT_PREFS };
let savedTimer = null;

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function render() {
  for (const b of $('formatSeg').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.format === prefs.format));
  }
  $('bitrate').value = String(prefs.bitrate);
  $('bitrate').disabled = prefs.format === 'wav';
  $('monitor').checked = !!prefs.monitor;
  $('saveAs').checked = !!prefs.saveAs;

  const perMin = (prefs.bitrate * 1000 * 60) / 8;
  $('formatHint').textContent = {
    mp3: `Plays everywhere · about ${fmtBytes(perMin)} per minute`,
    wav: `Uncompressed, best quality · about ${fmtBytes(WAV_BYTES_PER_SEC * 60)} per minute`,
    webm: `Opus audio, efficient · about ${fmtBytes(perMin)} per minute`,
  }[prefs.format];
}

async function save() {
  await chrome.storage.local.set({ prefs });
  render();
  $('savedNote').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('savedNote').textContent = ''), 1500);
}

$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-format]');
  if (!b) return;
  prefs.format = b.dataset.format;
  save();
});
$('bitrate').addEventListener('change', (e) => {
  prefs.bitrate = Number(e.target.value);
  save();
});
$('monitor').addEventListener('change', (e) => {
  prefs.monitor = e.target.checked;
  save();
});
$('saveAs').addEventListener('change', (e) => {
  prefs.saveAs = e.target.checked;
  save();
});
$('editShortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

(async function init() {
  const { prefs: stored } = await chrome.storage.local.get('prefs');
  prefs = { ...DEFAULT_PREFS, ...(stored || {}) };
  render();

  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-recording');
    if (cmd && cmd.shortcut) {
      const k = document.createElement('kbd');
      k.textContent = cmd.shortcut;
      $('shortcut').replaceChildren(k);
    }
  } catch {
    /* ignore */
  }
})();
