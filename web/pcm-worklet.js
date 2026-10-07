class LecturePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
    this.accepting = true;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return;
      this.accepting = false;
      this.flush();
      // Port messages are ordered: the final samples arrive before this ack.
      this.port.postMessage({ type: 'flushed' });
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.length === this.buffer.length ? this.buffer : this.buffer.slice(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
    this.buffer = new Float32Array(2048);
    this.length = 0;
  }

  process(inputs) {
    if (!this.accepting) return true;
    const channel = inputs[0]?.[0];
    let offset = 0;
    while (channel && offset < channel.length) {
      const count = Math.min(this.buffer.length - this.length, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + count), this.length);
      this.length += count;
      offset += count;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor('lecture-pcm-processor', LecturePcmProcessor);
