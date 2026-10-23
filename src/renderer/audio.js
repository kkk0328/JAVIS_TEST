// 마이크 캡처 + 에너지 기반 음성 구간 검출(VAD)
class MicEngine {
  constructor({ onSpeechStart, onSpeechEnd } = {}) {
    this.onSpeechStart = onSpeechStart || (() => {});
    this.onSpeechEnd = onSpeechEnd || (() => {});
    this.sampleRate = 16000;
    this.gated = false;

    this.noise = 0.004;
    this.speaking = false;
    this.overCount = 0;
    this.silenceMs = 0;
    this.preroll = [];
    this.chunks = [];
    this.speechMs = 0;
    this.level = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = this.stream.getAudioTracks()[0];
    window.jarvis.log('mic device', track && track.label);
    // 장치 기본 샘플레이트로 열고, 16kHz 변환은 worklet 에서 한다
    this.ctx = new AudioContext();
    this.ctx.onerror = (e) => console.error('AudioContext error', e);
    const src = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    src.connect(this.analyser);

    await this.ctx.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(this.ctx, 'capture-processor');
    node.port.onmessage = (e) => this._frame(e.data);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(this.ctx.destination);
  }

  setGated(g) {
    this.gated = g;
    if (g) this._reset();
  }

  _reset() {
    this.speaking = false;
    this.overCount = 0;
    this.silenceMs = 0;
    this.chunks = [];
    this.speechMs = 0;
  }

  _frame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = rms;
    const frameMs = (frame.length / this.sampleRate) * 1000;

    if (this.gated) return;

    const startTh = Math.max(this.noise * 3.2, 0.012);
    const endTh = Math.max(this.noise * 2.0, 0.008);

    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > 10) this.preroll.shift();
      // 말하지 않는 동안 배경 소음 수준을 천천히 추적
      this.noise = Math.min(0.05, Math.max(0.002, this.noise * 0.97 + rms * 0.03));
      if (rms > startTh) {
        if (++this.overCount >= 3) {
          this.speaking = true;
          this.chunks = this.preroll.slice();
          this.preroll = [];
          this.silenceMs = 0;
          this.speechMs = this.chunks.length * frameMs;
          this.onSpeechStart();
        }
      } else {
        this.overCount = 0;
      }
      return;
    }

    this.chunks.push(frame);
    this.speechMs += frameMs;
    this.silenceMs = rms < endTh ? this.silenceMs + frameMs : 0;

    if (this.silenceMs >= 750 || this.speechMs >= 15000) {
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total);
      let off = 0;
      for (const c of this.chunks) { pcm.set(c, off); off += c.length; }
      const voicedMs = this.speechMs - this.silenceMs;
      this._reset();
      this.onSpeechEnd(voicedMs >= 250 ? pcm : null);
    }
  }
}
