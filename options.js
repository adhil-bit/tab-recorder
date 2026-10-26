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
let savedTimer = null;

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function mp4Supported() {
  try {
    return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'].some((t) => MediaRecorder.isTypeSupported(t));
  } catch {
    return false;
  }
}

function check(container, attr, value) {
  for (const b of container.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset[attr] === String(value)));
  }
}

function render() {
  check($('modeSeg'), 'mode', prefs.mode);
  check($('videoFormatSeg'), 'vformat', prefs.videoFormat);
  check($('formatSeg'), 'format', prefs.format);

  $('videoGroup').hidden = prefs.mode !== 'video';
  $('audioGroup').hidden = prefs.mode === 'video';

  $('videoQuality').value = String(prefs.videoQuality);
  const vPerMin = ((VIDEO_BITRATE[prefs.videoQuality] || VIDEO_BITRATE[1080]) + 192000) * 60 / 8;
  const mp4Note = prefs.videoFormat === 'mp4' && !mp4Supported() ? ' · MP4 not supported in this browser, WebM will be used' : '';
  $('videoHint').textContent = `About ${fmtBytes(vPerMin)} per minute${mp4Note}`;

  $('bitrate').value = String(prefs.bitrate);
  $('bitrate').disabled = prefs.format === 'wav';
  const perMin = (prefs.bitrate * 1000 * 60) / 8;
  $('formatHint').textContent = {
    mp3: `Plays everywhere · about ${fmtBytes(perMin)} per minute`,
    wav: `Uncompressed, best quality · about ${fmtBytes(WAV_BYTES_PER_SEC * 60)} per minute`,
    webm: `Opus audio, efficient · about ${fmtBytes(perMin)} per minute`,
  }[prefs.format];

  $('monitor').checked = !!prefs.monitor;
  $('saveAs').checked = !!prefs.saveAs;
}

async function save() {
  await chrome.storage.local.set({ prefs });
  render();
  $('savedNote').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('savedNote').textContent = ''), 1500);
}

function onSeg(id, attr, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest(`button[data-${attr}]`);
    if (!b) return;
    prefs[key] = b.dataset[attr];
    save();
  });
}

onSeg('modeSeg', 'mode', 'mode');
onSeg('videoFormatSeg', 'vformat', 'videoFormat');
onSeg('formatSeg', 'format', 'format');

$('videoQuality').addEventListener('change', (e) => {
  prefs.videoQuality = e.target.value;
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
