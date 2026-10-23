// Windows 내장 음성(Microsoft Heami 등)을 쓰는 speechSynthesis 래퍼. 문장 단위 큐로 읽는다.
class Speaker {
  constructor({ rate = 1.05, onBusyChange } = {}) {
    this.rate = rate;
    this.onBusyChange = onBusyChange || (() => {});
    this.queue = [];
    this.busy = false;
    this.pulse = 0; // 비주얼라이저용: 단어 경계마다 튀는 값
    this.voice = null;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice =
        voices.find((v) => /heami/i.test(v.name)) ||
        voices.find((v) => /^ko/i.test(v.lang)) ||
        null;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  }

  speak(text) {
    const clean = Speaker.clean(text);
    if (!clean) return;
    // 긴 문장은 Chromium 에서 onend 가 누락되는 경우가 있어 문장 단위로 나눈다
    const parts = clean.match(/[^.!?。]+[.!?。]*/g) || [clean];
    for (const p of parts) if (p.trim()) this.queue.push(p.trim());
    if (!this.busy) this._next();
  }

  cancel() {
    this.queue = [];
    clearTimeout(this.watchdog);
    speechSynthesis.cancel();
    this._setBusy(false);
  }

  _setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.onBusyChange(b);
  }

  _next() {
    const text = this.queue.shift();
    if (!text) return this._setBusy(false);
    this._setBusy(true);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.onboundary = () => { this.pulse = 1; };
    u.onstart = () => { this.pulse = 1; };
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      clearTimeout(this.watchdog);
      this._next();
    };
    u.onend = u.onerror = next;
    // onend 가 오지 않을 때를 대비한 안전장치 (글자당 약 0.2초 + 여유)
    this.watchdog = setTimeout(() => { speechSynthesis.cancel(); next(); }, 4000 + text.length * 220 / this.rate);
    speechSynthesis.speak(u);
  }

  static clean(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_#>|~]/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
