/* global lamejs */
/* global ysFixWebmDuration */
// Recording engine: takes a MediaStream (the captured tab) and turns it into an
// MP3, WAV or WebM audio file, or an MP4/WebM video. Kept free of chrome.* APIs
// so it can be tested on its own.

(function (global) {
  'use strict';

  const SAMPLE_RATE = 48000;

  const FORMATS = {
    mp3: { ext: 'mp3', mime: 'audio/mpeg' },
    wav: { ext: 'wav', mime: 'audio/wav' },
    webm: { ext: 'webm', mime: 'audio/webm' },
  };

  // Video containers, best first. Chrome 126+ can record MP4 (H.264 + AAC);
  // otherwise fall back to WebM (VP9/VP8 + Opus).
  const VIDEO_TYPES = {
    mp4: [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1,opus',
      'video/mp4',
    ],
    webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  };

  function pickVideoType(preferred) {
    const order = preferred === 'webm' ? ['webm', 'mp4'] : ['mp4', 'webm'];
    for (const container of order) {
      for (const mimeType of VIDEO_TYPES[container]) {
        if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, container };
      }
    }
    throw new Error('Video recording is not supported in this browser');
  }

  // MediaRecorder writes WebM files without a duration, which breaks seeking in
  // some players. Patch it in when the file is small enough to rewrite in memory.
  async function fixWebmDuration(blob, durationMs) {
    if (typeof ysFixWebmDuration !== 'function' || blob.size > 512 * 1024 * 1024) return blob;
    try {
      return await ysFixWebmDuration(blob, durationMs, { logger: false });
    } catch (e) {
      return blob;
    }
  }

  function floatToInt16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  class Mp3Writer {
    constructor(sampleRate, kbps) {
      if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
        throw new Error('MP3 encoder failed to load');
      }
      this.encoder = new lamejs.Mp3Encoder(2, sampleRate, kbps);
      this.parts = [];
      this.frames = 0;
    }
    write(l, r) {
      this.frames += l.length;
      const out = this.encoder.encodeBuffer(floatToInt16(l), floatToInt16(r));
      if (out.length) this.parts.push(out);
    }
    finish() {
      const out = this.encoder.flush();
      if (out.length) this.parts.push(out);
      return new Blob(this.parts, { type: FORMATS.mp3.mime });
    }
  }

  class WavWriter {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.parts = [];
      this.dataBytes = 0;
      this.frames = 0;
    }
    write(l, r) {
      const n = l.length;
      const out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const a = l[i] < -1 ? -1 : l[i] > 1 ? 1 : l[i];
        const b = r[i] < -1 ? -1 : r[i] > 1 ? 1 : r[i];
        out[i * 2] = a < 0 ? a * 0x8000 : a * 0x7fff;
        out[i * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
      }
      this.parts.push(out);
      this.dataBytes += out.byteLength;
      this.frames += n;
    }
    finish() {
      const channels = 2;
      const bytesPerSample = 2;
      const header = new DataView(new ArrayBuffer(44));
      const ascii = (offset, s) => {
        for (let i = 0; i < s.length; i++) header.setUint8(offset + i, s.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      header.setUint32(4, 36 + this.dataBytes, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      header.setUint32(16, 16, true); // PCM chunk size
      header.setUint16(20, 1, true); // PCM format
      header.setUint16(22, channels, true);
      header.setUint32(24, this.sampleRate, true);
      header.setUint32(28, this.sampleRate * channels * bytesPerSample, true);
      header.setUint16(32, channels * bytesPerSample, true);
      header.setUint16(34, 16, true); // bits per sample
      ascii(36, 'data');
      header.setUint32(40, this.dataBytes, true);
      return new Blob([header.buffer, ...this.parts], { type: FORMATS.wav.mime });
    }
  }

  class TabAudioRecorder {
    /**
     * @param {object} opts
     * @param {MediaStream} opts.stream  audio stream to record
     * @param {'mp3'|'wav'|'webm'} opts.format
     * @param {number} opts.bitrate      kbps (MP3 / WebM)
     * @param {boolean} opts.monitor     keep playing the audio to the speakers
     * @param {string} opts.workletUrl
     * @param {boolean} opts.video       record the stream's video track too
     * @param {'mp4'|'webm'} opts.videoFormat  preferred video container
     * @param {number} opts.videoBitrate bits per second
     */
    constructor({
      stream,
      format = 'mp3',
      bitrate = 192,
      monitor = true,
      workletUrl = 'recorder-worklet.js',
      video = false,
      videoFormat = 'mp4',
      videoBitrate = 8000000,
    }) {
      if (!video && !FORMATS[format]) throw new Error('Unknown format: ' + format);
      this.stream = stream;
      this.format = format;
      this.bitrate = bitrate;
      this.monitor = monitor;
      this.workletUrl = workletUrl;
      this.video = video;
      this.videoFormat = videoFormat;
      this.videoBitrate = videoBitrate;
      this.state = 'idle';
      this.activeMs = 0;
      this.resumedAt = 0;
    }

    async start() {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

      this.source = this.ctx.createMediaStreamSource(this.stream);
      // Capturing a tab mutes it, so route the audio back out unless the user opted out.
      if (this.monitor) this.source.connect(this.ctx.destination);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.levelBuf = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);

      if (this.video || this.format === 'webm') {
        let options;
        if (this.video) {
          const picked = pickVideoType(this.videoFormat);
          this.container = picked.container;
          this.outMime = 'video/' + picked.container;
          options = {
            mimeType: picked.mimeType,
            videoBitsPerSecond: this.videoBitrate,
            audioBitsPerSecond: 192000,
          };
        } else {
          const mimeType = 'audio/webm;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('WebM/Opus recording is not supported');
          this.container = 'webm';
          this.outMime = FORMATS.webm.mime;
          options = { mimeType, audioBitsPerSecond: this.bitrate * 1000 };
        }
        this.chunks = [];
        this.mediaRecorder = new MediaRecorder(this.stream, options);
        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size) this.chunks.push(e.data);
        };
        this.recorderStopped = new Promise((resolve) => {
          this.mediaRecorder.onstop = resolve;
        });
        this.mediaRecorder.start(1000);
      } else {
        await this.ctx.audioWorklet.addModule(this.workletUrl);
        this.writer =
          this.format === 'wav'
            ? new WavWriter(this.ctx.sampleRate)
            : new Mp3Writer(this.ctx.sampleRate, this.bitrate);
        this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        this.node.port.onmessage = ({ data }) => {
          if (data.type === 'pcm') this.writer.write(data.l, data.r);
          else if (data.type === 'flushed' && this.onFlushed) this.onFlushed();
        };
        this.source.connect(this.node);
        // The node outputs silence; connecting it keeps it pulled by the audio graph.
        this.node.connect(this.ctx.destination);
      }

      this.state = 'recording';
      this.resumedAt = performance.now();
    }

    pause() {
      if (this.state !== 'recording') return;
      if (this.mediaRecorder) this.mediaRecorder.pause();
      if (this.node) this.node.port.postMessage('pause');
      this.activeMs += performance.now() - this.resumedAt;
      this.state = 'paused';
    }

    resume() {
      if (this.state !== 'paused') return;
      if (this.mediaRecorder) this.mediaRecorder.resume();
      if (this.node) this.node.port.postMessage('resume');
      this.resumedAt = performance.now();
      this.state = 'recording';
    }

    elapsedMs() {
      return this.activeMs + (this.state === 'recording' ? performance.now() - this.resumedAt : 0);
    }

    getLevel() {
      if (!this.analyser) return 0;
      this.analyser.getFloatTimeDomainData(this.levelBuf);
      let peak = 0;
      for (let i = 0; i < this.levelBuf.length; i++) {
        const v = Math.abs(this.levelBuf[i]);
        if (v > peak) peak = v;
      }
      return Math.min(1, peak);
    }

    async stop() {
      if (this.state === 'idle' || this.state === 'stopped') throw new Error('Not recording');
      const elapsed = this.elapsedMs();
      this.state = 'stopping';
      let blob;
      let durationSec = elapsed / 1000;

      if (this.mediaRecorder) {
        if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
        await this.recorderStopped;
        blob = new Blob(this.chunks, { type: this.outMime });
        if (this.container === 'webm') blob = await fixWebmDuration(blob, elapsed);
      } else {
        await new Promise((resolve) => {
          this.onFlushed = resolve;
          this.node.port.postMessage('flush');
          setTimeout(resolve, 2000); // safety net
        });
        blob = this.writer.finish();
        durationSec = this.writer.frames / this.ctx.sampleRate;
      }

      this.teardown();
      this.state = 'stopped';
      const { ext, mime } = this.video
        ? { ext: this.container, mime: this.outMime }
        : FORMATS[this.format];
      return { blob, ext, mime, durationSec, size: blob.size, video: this.video };
    }

    teardown() {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      try { this.source && this.source.disconnect(); } catch (e) { /* ignore */ }
      try { this.node && this.node.disconnect(); } catch (e) { /* ignore */ }
      try { this.ctx && this.ctx.close(); } catch (e) { /* ignore */ }
    }
  }

  TabAudioRecorder.FORMATS = FORMATS;
  global.TabAudioRecorder = TabAudioRecorder;
})(typeof self !== 'undefined' ? self : this);
