export function wavFromSamples(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) { const value = Math.max(-1, Math.min(1, samples[index])); view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return buffer;
}

export class MicrophoneCapture {
  stream: MediaStream | null = null;
  context: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  recording = false;
  chunks: Float32Array[] = [];
  count = 0;
  hasVoice = false;
  onLimit: (() => void) | null = null;
  private flushed: (() => void) | null = null;
  async open(deviceId: string, onLevel: (level: number) => void) {
    await this.close();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(new URL('./voice-capture.worklet.js?no-inline', import.meta.url).href);
      this.node = new AudioWorkletNode(this.context, 'agentrix-voice');
      this.node.port.onmessage = event => {
        if (event.data.flushed) { this.recording = false; this.flushed?.(); this.flushed = null; return; }
        const { samples, level } = event.data as { samples: Float32Array; level: number };
        onLevel(level);
        if (!this.recording) return;
        const maximum = (this.context?.sampleRate || 48000) * 300;
        const part = samples.subarray(0, Math.max(0, maximum - this.count));
        if (part.length) { this.chunks.push(part); this.count += part.length; if (level > .003) this.hasVoice = true; }
        if (this.count >= maximum) this.onLimit?.();
      };
      const source = this.context.createMediaStreamSource(this.stream), silent = this.context.createGain();
      silent.gain.value = 0; source.connect(this.node); this.node.connect(silent); silent.connect(this.context.destination);
      await this.context.resume();
    } catch (error) { await this.close(); throw error; }
  }
  startRecording() { this.chunks = []; this.count = 0; this.hasVoice = false; this.recording = true; }
  async stopRecording() {
    if (!this.node || !this.context) throw new Error('麦克风尚未连接。');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('麦克风没有响应，请重试。')), 2000);
      this.flushed = () => { clearTimeout(timer); resolve(); }; this.node!.port.postMessage('flush');
    });
    if (!this.hasVoice) throw new Error('未检测到声音，请检查麦克风后重试。');
    const combined = new Float32Array(this.count); let offset = 0;
    for (const chunk of this.chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(combined.length * 16000 / this.context.sampleRate)), 16000);
    const input = offline.createBuffer(1, combined.length, this.context.sampleRate); input.copyToChannel(combined, 0);
    const source = offline.createBufferSource(); source.buffer = input; source.connect(offline.destination); source.start();
    const audio = await offline.startRendering(); return wavFromSamples(audio.getChannelData(0));
  }
  async close() {
    this.recording = false; this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.node?.disconnect(); this.node?.port.close(); this.node = null;
    await this.context?.close().catch(() => {}); this.context = null; this.chunks = []; this.count = 0;
    this.onLimit = null;
  }
}
