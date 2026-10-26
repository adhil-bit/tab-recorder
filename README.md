# Tab Recorder

A Chrome extension that records the **audio or video** of any browser tab (YouTube, Spotify Web Player, SoundCloud, podcasts, web calls) and saves it as **MP3**, **WAV** or **WebM** audio, or as **MP4**/**WebM** video.

## Features

- **Simple popup.** Click the toolbar icon to choose audio or video, the format and the quality, then press **Start**.
- **Quick start.** Right-click the icon and choose **Record audio of this tab** or **Record video of this tab** to skip the popup.
- **Floating control bar** shows a timer and live level, with buttons to pause or resume, stop and save, and hide.
  - Audio recordings: the bar sits on the page. Drag it anywhere and it stays where you put it.
  - Video recordings: the bar opens in its own small window, so it doesn't show up in your video.
- Audio formats: MP3 (128–320 kbps), WAV (lossless) or WebM/Opus
- Video formats: MP4 (H.264) or WebM (VP9), at 720p or 1080p. The video keeps the tab's own shape, so there are no black bars.
- You keep hearing the audio while it records. Turn this off in settings to record silently.
- Files are named after the tab, e.g. `Downloads/Tab Recordings/Song Title - 2026-10-26 14.03.22.mp3`
- **Alt+Shift+R** starts and stops recording
- If the tab is closed, the recording stops and saves on its own
- A **REC** badge on the toolbar icon shows when a recording is running, even after you hide the controls

## Install (load unpacked)

1. Download this repo (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped `tab-recorder` folder.
5. Pin the extension from the puzzle-piece menu so the icon is easy to reach.

Requires Chrome 116 or newer. MP4 video needs Chrome 126 or newer. On older versions it falls back to WebM. Should also work in other Chromium browsers such as Edge, Brave or Arc.

## Usage

1. Open the tab you want to record.
2. Click the extension icon. In the popup, choose **Audio** or **Video**, pick a format and quality, and press **Start**. To skip the popup, right-click the icon and choose **Record audio of this tab** or **Record video of this tab**.
3. The popup closes and the control bar appears. Use it to **pause/resume**, **stop** (saves the file), or **×** to hide it. Hiding the controls doesn't stop the recording. While recording, clicking the icon opens the popup with a timer and its own pause and stop buttons.
4. After saving, the bar shows the length and file size, with a button that opens the file's folder.

The popup remembers your last choices. The same settings are on the **Options** page (right-click the icon → **Options**).

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 config with the `tabCapture`, `offscreen`, `scripting`, `contextMenus`, `downloads`, `storage` and `activeTab` permissions |
| `background.js` | Service worker. It handles starting from the popup, the right-click menu and the shortcut, plus pause, stop, saving and the badge. |
| `overlay.js` | The control bar. It's injected into the page for audio, or runs in `controls.html` for video. It sits inside a closed shadow root so the page's styles can't affect it. |
| `controls.html` | The small window that holds the control bar during video recordings |
| `popup.html/css/js` | Toolbar popup: choose audio or video, format and quality, then start. While recording it shows a timer with pause and stop. |
| `options.html/css/js` | Settings page (same settings as the popup) |
| `offscreen.html/js` | Offscreen document that holds the captured tab stream in the background |
| `recorder-core.js` | Recording engine. MediaRecorder handles video and WebM audio. An AudioWorklet feeds raw PCM to the MP3 and WAV encoders. |
| `recorder-worklet.js` | AudioWorklet that collects PCM samples |
| `lib/lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL, see `lib/LAMEJS-LICENSE.txt`) |
| `lib/fix-webm-duration.js` | [fix-webm-duration](https://github.com/yusitnikov/fix-webm-duration), which adds the missing duration to WebM files so they can be seeked (MIT, see `lib/FIX-WEBM-DURATION-LICENSE.txt`) |

When you start a recording, the service worker gets a stream ID from `chrome.tabCapture.getMediaStreamId()`. The offscreen document opens that stream (audio, plus video in video mode) and sends the audio back to your speakers, because capturing a tab mutes it otherwise. It encodes as it records. On stop, the service worker saves the file with `chrome.downloads`.

## Notes

- Chrome blocks capture on its own pages (`chrome://…`, the Web Store), so the extension can't record there. The icon badge shows `ERR` instead.
- DRM-protected video (Netflix, Prime Video, Disney+ and similar) records as a black screen. That's Chrome's protection, not a bug. YouTube and most other sites record normally.
- Only one tab can be recorded at a time. A tab that is already being captured, for example by a screen share, can't be recorded until that capture ends.
- File sizes: WAV is about 11 MB per minute. 1080p video is about 60 MB per minute, and 720p about 40 MB per minute.
- Respect copyright and each site's terms of service. Many streaming services don't allow saving their content, so use this for personal use where it's allowed, or for your own content.
