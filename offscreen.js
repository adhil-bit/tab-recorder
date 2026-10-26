/* global TabAudioRecorder */
// Offscreen document: owns the captured tab stream and the recorder.
// The service worker talks to it with { target: 'offscreen', type, ... } messages.

let recorder = null;

const handlers = {
  async start({ streamId, format, bitrate, monitor }) {
    if (recorder) throw new Error('A recording is already in progress.');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    const rec = new TabAudioRecorder({ stream, format, bitrate, monitor });
    recorder = rec;

    // Tab closed or capture revoked: let the service worker finish and save.
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (recorder === rec && (rec.state === 'recording' || rec.state === 'paused')) {
        chrome.runtime.sendMessage({ target: 'background', type: 'capture-ended' }).catch(() => {});
      }
    });

    try {
      await rec.start();
    } catch (err) {
      rec.teardown();
      recorder = null;
      throw err;
    }
  },

  pause() {
    if (recorder) recorder.pause();
  },

  resume() {
    if (recorder) recorder.resume();
  },

  level() {
    return {
      level: recorder ? recorder.getLevel() : 0,
      elapsedMs: recorder ? recorder.elapsedMs() : 0,
    };
  },

  async stop() {
    if (!recorder) throw new Error('Nothing is being recorded.');
    if (recorder.state === 'stopping') throw new Error('Already saving.');
    const rec = recorder;
    try {
      const result = await rec.stop();
      return {
        url: URL.createObjectURL(result.blob),
        ext: result.ext,
        mime: result.mime,
        size: result.size,
        durationSec: result.durationSec,
      };
    } finally {
      recorder = null;
    }
  },

  revoke({ url }) {
    if (url) URL.revokeObjectURL(url);
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || !handlers[msg.type]) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg))
    .then(
      (res) => sendResponse({ ok: true, ...(res || {}) }),
      (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
    );
  return true;
});
