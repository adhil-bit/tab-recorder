# Tab Audio Recorder

A Chrome extension that records the audio playing in any browser tab (YouTube, Spotify Web Player, SoundCloud, podcasts, web calls) and saves it as **MP3**, **WAV** or **WebM**.

## Features

- Record the audio of the current tab with one click, or with the **Alt+Shift+R** shortcut
- Save as MP3 (128–320 kbps), WAV (lossless) or WebM/Opus
- Pause and resume while recording
- Live timer, level meter and file-size estimate
- You keep hearing the audio while it records. Turn this off to record silently.
- Files are named after the tab, e.g. `Downloads/Tab Recordings/Song Title - 2026-10-26 14.03.22.mp3`
- If the tab is closed, the recording stops and saves on its own
- A **REC** badge on the toolbar icon shows when a recording is running

## Install (load unpacked)

1. Download this repo (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped `tab-audio-recorder` folder.
5. Pin the extension from the puzzle-piece menu so the icon is easy to reach.

Requires Chrome 116 or newer. Should also work in other Chromium browsers such as Edge, Brave or Arc.

## Usage

1. Open the tab that is playing audio.
2. Click the extension icon, pick a format and quality, then click **Start recording**.
3. Click **Stop & save** when you're done. The file goes to `Downloads/Tab Recordings/`. To pick a different location each time, turn on "Ask where to save each file".

You can close the popup while recording. The recording keeps going in the background.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 config with the `tabCapture`, `offscreen`, `downloads`, `storage` and `activeTab` permissions |
| `popup.html/css/js` | The toolbar popup UI |
| `background.js` | Service worker that coordinates start, stop, pause and saving, and updates the badge |
| `offscreen.html/js` | Offscreen document that holds the captured tab stream while the popup is closed |
| `recorder-core.js` | Recording engine. MediaRecorder handles WebM. An AudioWorklet feeds raw PCM to the MP3 and WAV encoders. |
| `recorder-worklet.js` | AudioWorklet that collects PCM samples |
| `lib/lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL, see `lib/LAMEJS-LICENSE.txt`) |

The popup gets a stream ID from `chrome.tabCapture.getMediaStreamId()`. The offscreen document opens that stream and sends it back to your speakers, because capturing a tab mutes it otherwise. It encodes the audio as it records. On stop, the service worker saves the result with `chrome.downloads`.

## Notes

- Chrome blocks capture on its own pages (`chrome://…`, the Web Store), so the extension can't record there.
- Only one tab can be recorded at a time. A tab that is already being captured, for example by a screen share, can't be recorded until that capture ends.
- WAV files are large, about 11 MB per minute.
- Respect copyright and each site's terms of service. Many streaming services don't allow saving their content, so use this for personal use where it's allowed, or for your own content.
