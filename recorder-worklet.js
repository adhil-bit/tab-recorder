// AudioWorklet that collects raw PCM from its input and posts it to the main
// thread in fixed-size stereo blocks. Used for MP3 and WAV output.

const BLOCK = 4096;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(BLOCK);
    this.right = new Float32Array(BLOCK);
    this.count = 0;
    this.capturing = true;

    this.port.onmessage = ({ data }) => {
      if (data === 'pause') {
        this.flush();
        this.capturing = false;
      } else if (data === 'resume') {
        this.capturing = true;
      } else if (data === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  flush() {
    if (!this.count) return;
    const l = this.left.slice(0, this.count);
    const r = this.right.slice(0, this.count);
    this.count = 0;
    this.port.postMessage({ type: 'pcm', l, r }, [l.buffer, r.buffer]);
  }

  process(inputs) {
    if (!this.capturing) return true;

    const input = inputs[0];
    // A disconnected/idle input has no channels: record silence so timing stays correct.
    const frames = input && input.length ? input[0].length : 128;
    const l = input && input.length ? input[0] : null;
    const r = input && input.length > 1 ? input[1] : l;

    for (let i = 0; i < frames; i++) {
      this.left[this.count] = l ? l[i] : 0;
      this.right[this.count] = r ? r[i] : 0;
      this.count++;
      if (this.count === BLOCK) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
