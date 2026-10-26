# Tab Audio Recorder

A Chrome extension that records the audio playing in any browser tab (YouTube, Spotify Web Player, SoundCloud, podcasts, web calls) and saves it as **MP3**, **WAV** or **WebM**.

## Features

- **One click to record.** Click the toolbar icon and the current tab starts recording right away.
- **Floating control bar** on the page shows a timer and live level, with buttons to pause or resume, stop and save, and hide. Drag it anywhere and it stays where you put it.
- Saves as MP3 (128–320 kbps), WAV (lossless) or WebM/Opus
- You keep hearing the audio while it records. Turn this off in settings to record silently.
- Files are named after the tab, e.g. `Downloads/Tab Recordings/Song Title - 2026-10-26 14.03.22.mp3`
- **Alt+Shift+R** starts and stops recording
- If the tab is closed, the recording stops and saves on its own
- A **REC** badge on the toolbar icon shows when a recording is running, even after you hide the bar

## Install (load unpacked)

1. Download this repo (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped `tab-audio-recorder` folder.
5. Pin the extension from the puzzle-piece menu so the icon is easy to reach.

Requires Chrome 116 or newer. Should also work in other Chromium browsers such as Edge, Brave or Arc.

## Usage

1. Open the tab that is playing audio.
2. Click the extension icon. Recording starts and the floating bar appears in the bottom-right corner.
3. Use the bar to **pause/resume**, **stop** (saves the file), or **×** to hide it. Hiding the bar doesn't stop the recording. Click the icon again to bring the bar back.
4. After saving, the bar shows the length and file size, with a button that opens the file's folder.

**Settings:** right-click the toolbar icon and choose **Options** to set the format, quality, whether you keep hearing the audio, and whether Chrome asks where to save each file.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 config with the `tabCapture`, `offscreen`, `scripting`, `downloads`, `storage` and `activeTab` permissions |
| `background.js` | Service worker. It handles the icon click and shortcut, start, pause, stop and saving, and the badge. |
| `overlay.js` | The floating control bar. It runs inside a closed shadow root so the page's styles can't affect it. |
| `options.html/css/js` | Settings page |
| `offscreen.html/js` | Offscreen document that holds the captured tab stream in the background |
| `recorder-core.js` | Recording engine. MediaRecorder handles WebM. An AudioWorklet feeds raw PCM to the MP3 and WAV encoders. |
| `recorder-worklet.js` | AudioWorklet that collects PCM samples |
| `lib/lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL, see `lib/LAMEJS-LICENSE.txt`) |

When you click the icon, the service worker gets a stream ID from `chrome.tabCapture.getMediaStreamId()`. The offscreen document opens that stream and sends it back to your speakers, because capturing a tab mutes it otherwise. It encodes the audio as it records. On stop, the service worker saves the file with `chrome.downloads`.

## Notes

- Chrome blocks capture on its own pages (`chrome://…`, the Web Store), so the extension can't record there. The icon badge shows `ERR` instead.
- Only one tab can be recorded at a time. A tab that is already being captured, for example by a screen share, can't be recorded until that capture ends.
- WAV files are large, about 11 MB per minute.
- Respect copyright and each site's terms of service. Many streaming services don't allow saving their content, so use this for personal use where it's allowed, or for your own content.
