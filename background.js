// Service worker: clicking the toolbar icon starts recording the tab and shows
// a floating control bar (overlay.js) on the page. It coordinates the
// offscreen recorder and saving. Recording state lives in
// chrome.storage.session so it survives the worker being suspended, and so the
// floating bar can read it directly.

const OFFSCREEN_PATH = 'offscreen.html';
const DOWNLOAD_FOLDER = 'Tab Recordings';
const DEFAULT_TITLE = 'Record this tab (right-click for audio or video)';
const DEFAULT_PREFS = {
  mode: 'audio', // 'audio' | 'video'
  format: 'mp3',
  bitrate: 192,
  videoFormat: 'mp4',
  videoQuality: '1080',
  monitor: true,
  saveAs: false,
};

// Let the floating bar (a content script) read the recording state.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

// ---------------------------------------------------------------- state

async function getRec() {
  const { rec } = await chrome.storage.session.get('rec');
  return rec || { status: 'idle' };
}

async function setRec(rec) {
  await chrome.storage.session.set({ rec });
  updateBadge(rec);
}

async function setLastResult(lastResult) {
  await chrome.storage.session.set({ lastResult });
}

const isActive = (rec) => rec.status === 'recording' || rec.status === 'paused';

function updateBadge(rec) {
  const looks = {
    recording: ['REC', '#e5383b'],
    paused: ['||', '#d98e04'],
    saving: ['…', '#5c6370'],
  };
  const [text, color] = looks[rec.status] || ['', '#000000'];
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor && text) chrome.action.setBadgeTextColor({ color: '#ffffff' });
  const what = rec.mode === 'video' ? 'video' : 'audio';
  chrome.action.setTitle({
    title:
      rec.status === 'recording'
        ? `Recording ${what}: ${rec.title} (click to show controls)`
        : rec.status === 'paused'
          ? `Paused: ${rec.title} (click to show controls)`
          : DEFAULT_TITLE,
  });
}

async function flashError(message) {
  await setLastResult({ ok: false, error: message, at: Date.now() });
  chrome.action.setBadgeText({ text: 'ERR' });
  chrome.action.setBadgeBackgroundColor({ color: '#5c6370' });
  chrome.action.setTitle({ title: `Tab Recorder: ${message}` });
  setTimeout(async () => updateBadge(await getRec()), 4000);
}

function friendlyError(message = '') {
  if (/active stream/i.test(message)) return 'This tab is already being recorded or shared.';
  if (/not been invoked|activeTab/i.test(message)) return 'Click the extension icon on the tab you want to record.';
  if (/chrome pages|cannot be captured|cannot capture/i.test(message)) return "Chrome doesn't allow recording this page.";
  return message || 'Something went wrong.';
}

// ---------------------------------------------------------------- offscreen

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Record the audio of the tab the user chose.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

function toOffscreen(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
}

async function closeOffscreenIfIdle() {
  const rec = await getRec();
  const { pending = {} } = await chrome.storage.session.get('pending');
  if (rec.status === 'idle' && Object.keys(pending).length === 0 && (await hasOffscreen())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ---------------------------------------------------------------- floating bar

async function showOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    return true;
  } catch {
    return false; // e.g. chrome:// pages, the Web Store, PDFs
  }
}

// Video recordings get their controls in a small separate window, because
// anything drawn on the page would be captured in the video.
const CONTROLS_W = 340;
const CONTROLS_H = 110;

async function showControlsWindow(nearWindowId) {
  const { controlsWinId } = await chrome.storage.session.get('controlsWinId');
  if (controlsWinId != null) {
    try {
      await chrome.windows.update(controlsWinId, { focused: true });
      return;
    } catch {
      /* it was closed */
    }
  }
  const opts = { url: 'controls.html', type: 'popup', width: CONTROLS_W, height: CONTROLS_H, focused: true };
  try {
    const near = nearWindowId != null ? await chrome.windows.get(nearWindowId) : await chrome.windows.getLastFocused();
    if (near && near.left != null) {
      opts.left = Math.max(0, near.left + near.width - CONTROLS_W - 24);
      opts.top = Math.max(0, near.top + near.height - CONTROLS_H - 24);
    }
  } catch {
    /* let Chrome place it */
  }
  let win;
  try {
    win = await chrome.windows.create(opts);
  } catch {
    // Position rejected (e.g. partly off-screen): let Chrome place it.
    delete opts.left;
    delete opts.top;
    win = await chrome.windows.create(opts).catch(() => null);
  }
  if (win) await chrome.storage.session.set({ controlsWinId: win.id });
}

async function showControls(tab) {
  const rec = await getRec();
  if (rec.mode === 'video' && rec.status !== 'idle') return showControlsWindow(tab && tab.windowId);
  return showOverlay(tab.id);
}

// ---------------------------------------------------------------- helpers

function cleanTitle(title) {
  const t = (title || '')
    .replace(/^\(\d+\)\s*/, '') // "(3) Video" notification counts
    .replace(/\s*[-–|]\s*YouTube(\s*Music)?\s*$/i, '')
    .trim();
  return t || 'Recording';
}

function buildFilename(title, ext, startedAt, simple = false) {
  const d = new Date(startedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  if (simple) return `${DOWNLOAD_FOLDER}/recording ${stamp}.${ext}`;
  const safe =
    title
      .replace(/[\\/:*?"<>|~\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      .replace(/^[.\s]+|[.\s]+$/g, '') || 'Recording';
  return `${DOWNLOAD_FOLDER}/${safe} - ${stamp}.${ext}`;
}

async function download(url, rec, ext) {
  const opts = { url, saveAs: !!rec.saveAs, conflictAction: 'uniquify' };
  try {
    return { id: await chrome.downloads.download({ ...opts, filename: buildFilename(rec.title, ext, rec.startedAt) }) };
  } catch (err) {
    if (/cancel/i.test(err.message)) throw err;
    // Some titles still produce a filename Chrome rejects; fall back to a plain one.
    return { id: await chrome.downloads.download({ ...opts, filename: buildFilename('', ext, rec.startedAt, true) }) };
  }
}

// ---------------------------------------------------------------- actions

async function startRecording({ streamId, tab, prefs, mode }) {
  const current = await getRec();
  if (current.status !== 'idle') throw new Error('A recording is already in progress.');

  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  if (mode) p.mode = mode;
  const video = p.mode === 'video';
  await ensureOffscreen();
  const res = await toOffscreen('start', {
    streamId,
    format: p.format,
    bitrate: Number(p.bitrate),
    monitor: !!p.monitor,
    video,
    videoFormat: p.videoFormat,
    videoQuality: String(p.videoQuality),
    tabWidth: tab.width,
    tabHeight: tab.height,
  });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start recording.');

  const now = Date.now();
  await chrome.storage.session.remove('lastResult');
  await setRec({
    status: 'recording',
    tabId: tab.id,
    title: cleanTitle(tab.title),
    favIconUrl: tab.favIconUrl || '',
    url: tab.url || '',
    mode: video ? 'video' : 'audio',
    format: video ? p.videoFormat : p.format,
    bitrate: Number(p.bitrate),
    saveAs: !!p.saveAs,
    startedAt: now,
    activeMs: 0,
    resumedAt: now,
    overlayHidden: false,
  });
}

async function pauseRecording() {
  const rec = await getRec();
  if (rec.status !== 'recording') return;
  await toOffscreen('pause');
  const now = Date.now();
  await setRec({ ...rec, status: 'paused', activeMs: rec.activeMs + (now - rec.resumedAt) });
}

async function resumeRecording() {
  const rec = await getRec();
  if (rec.status !== 'paused') return;
  await toOffscreen('resume');
  await setRec({ ...rec, status: 'recording', resumedAt: Date.now() });
}

let stopping = null;

function stopRecording() {
  if (!stopping) stopping = doStop().finally(() => (stopping = null));
  return stopping;
}

async function doStop() {
  const rec = await getRec();
  if (!isActive(rec)) return;
  await setRec({ ...rec, status: 'saving' });

  try {
    const res = await toOffscreen('stop');
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not finish the recording.');

    let downloadId;
    try {
      ({ id: downloadId } = await download(res.url, rec, res.ext));
    } catch (err) {
      toOffscreen('revoke', { url: res.url }).catch(() => {});
      throw new Error(/cancel/i.test(err.message) ? 'Save was cancelled — recording discarded.' : err.message);
    }

    const { pending = {} } = await chrome.storage.session.get('pending');
    pending[downloadId] = res.url;
    await chrome.storage.session.set({ pending });

    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    const filename = item && item.filename ? item.filename.split(/[\\/]/).pop() : `${rec.title}.${res.ext}`;
    await setLastResult({
      ok: true,
      downloadId,
      filename,
      size: res.size,
      durationSec: res.durationSec,
      format: rec.format,
      at: Date.now(),
    });
  } catch (err) {
    await setLastResult({ ok: false, error: err.message, at: Date.now() });
  } finally {
    await setRec({ status: 'idle' });
    closeOffscreenIfIdle();
    // Video recording whose controls window was closed: confirm the save on the page.
    if (rec.mode === 'video') {
      const { controlsWinId } = await chrome.storage.session.get('controlsWinId');
      if (controlsWinId == null && rec.tabId != null) showOverlay(rec.tabId);
    }
  }
}

// Toolbar click, keyboard shortcut or the icon's right-click menu.
// `mode` overrides the default from settings for this one recording.
async function handleUserInvoke(tab, { stopIfActive = false, mode } = {}) {
  if (!tab || tab.id == null) return;
  const rec = await getRec();

  if (isActive(rec)) {
    if (stopIfActive) return stopRecording();
    // Already recording: just bring the controls back.
    await setRec({ ...rec, overlayHidden: false });
    await showControls(tab);
    return;
  }

  if (rec.status === 'saving') {
    await showControls(tab);
    return;
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const { prefs } = await chrome.storage.local.get('prefs');
    await startRecording({ streamId, tab, prefs, mode });
  } catch (err) {
    await flashError(friendlyError(err && err.message));
  }
  await showControls(tab); // errors show on the page; nothing is being recorded then
}

// ---------------------------------------------------------------- events

chrome.action.onClicked.addListener((tab) => handleUserInvoke(tab));

// Right-click the toolbar icon to choose audio or video for one recording.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'record-audio', title: 'Record audio of this tab', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'record-video', title: 'Record video of this tab', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'record-audio') handleUserInvoke(tab, { mode: 'audio' });
  if (info.menuItemId === 'record-video') handleUserInvoke(tab, { mode: 'video' });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') handleUserInvoke(tab, { stopIfActive: true });
});

const actions = {
  start: (msg) => startRecording(msg),
  stop: () => stopRecording(),
  pause: () => pauseRecording(),
  resume: () => resumeRecording(),
  'capture-ended': () => stopRecording(),
  'hide-overlay': async () => {
    const rec = await getRec();
    if (isActive(rec)) await setRec({ ...rec, overlayHidden: true });
  },
  'show-download': async ({ id }) => {
    if (typeof id === 'number') chrome.downloads.show(id);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || msg.target !== 'background' || !actions[msg.type]) return false;
  actions[msg.type](msg).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true;
});

// Bring the bar back after the recorded tab reloads or navigates (audio only;
// video recordings use the separate controls window).
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const rec = await getRec();
  if (rec.tabId === tabId && isActive(rec) && !rec.overlayHidden && rec.mode !== 'video') showOverlay(tabId);
});

// Closing the controls window during a recording just hides the controls.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { controlsWinId } = await chrome.storage.session.get('controlsWinId');
  if (windowId !== controlsWinId) return;
  await chrome.storage.session.remove('controlsWinId');
  const rec = await getRec();
  if (isActive(rec) && !rec.overlayHidden) await setRec({ ...rec, overlayHidden: true });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec.tabId === tabId && isActive(rec)) stopRecording();
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.filename && delta.filename.current) {
    const { lastResult } = await chrome.storage.session.get('lastResult');
    if (lastResult && lastResult.ok && lastResult.downloadId === delta.id) {
      await setLastResult({ ...lastResult, filename: delta.filename.current.split(/[\\/]/).pop() });
    }
  }
  if (!delta.state || delta.state.current === 'in_progress') return;
  const { pending = {} } = await chrome.storage.session.get('pending');
  const url = pending[delta.id];
  if (!url) return;
  delete pending[delta.id];
  await chrome.storage.session.set({ pending });

  if (delta.state.current === 'interrupted') {
    const { lastResult } = await chrome.storage.session.get('lastResult');
    if (lastResult && lastResult.downloadId === delta.id) {
      await setLastResult({ ok: false, error: 'The download was cancelled or failed.', at: Date.now() });
    }
  }

  toOffscreen('revoke', { url }).catch(() => {});
  closeOffscreenIfIdle();
});

// If the extension was reloaded mid-recording, the recorder is gone: reset.
(async () => {
  const rec = await getRec();
  if (rec.status !== 'idle' && !(await hasOffscreen())) await setRec({ status: 'idle' });
  else updateBadge(rec);
})();
