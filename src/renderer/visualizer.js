// 주파수 링 + 파동 + 입자로 구성된 자비스 오브 비주얼라이저
const STATE_STYLE = {
  booting:    { hue: 200, sat: 30, light: 55, glow: 0.35, gain: 0.4 },
  idle:       { hue: 192, sat: 85, light: 55, glow: 0.55, gain: 0.75 },
  listening:  { hue: 186, sat: 100, light: 62, glow: 1.0, gain: 1.35 },
  processing: { hue: 268, sat: 90, light: 66, glow: 0.9, gain: 0.6 },
  speaking:   { hue: 205, sat: 100, light: 64, glow: 1.0, gain: 1.0 },
  error:      { hue: 2, sat: 85, light: 58, glow: 0.8, gain: 0.6 },
};

class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.freq = null;
    this.speaker = null;
    this.state = 'booting';
    this.style = { ...STATE_STYLE.booting };
    this.N = 72; // 한쪽 반원의 막대 수
    this.bars = new Float32Array(this.N);
    this.energy = 0;
    this.t = 0;
    this.particles = Array.from({ length: 110 }, () => this._newParticle(true));
    window.addEventListener('resize', () => this._resize());
    this._resize();
    requestAnimationFrame((ts) => this._loop(ts));
  }

  attach(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  setState(s) {
    this.state = STATE_STYLE[s] ? s : 'idle';
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const { innerWidth: w, innerHeight: h } = window;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  _newParticle(init) {
    return {
      a: Math.random() * Math.PI * 2,
      r: init ? 0.4 + Math.random() * 2.2 : 0.9 + Math.random() * 0.3,
      v: 0.002 + Math.random() * 0.004,
      spin: (Math.random() - 0.5) * 0.004,
      size: 0.4 + Math.random() * 1.6,
    };
  }

  // 막대 값(0~1) 계산: 대기/청취는 마이크, 말할 때는 TTS 리듬으로 합성
  _sample() {
    const N = this.N;
    const target = new Float32Array(N);
    const st = this.state;

    if (st === 'speaking' && this.speaker) {
      this.speaker.pulse *= 0.9;
      const env = 0.32 + 0.5 * this.speaker.pulse + 0.12 * Math.sin(this.t * 9.0);
      for (let i = 0; i < N; i++) {
        const fall = Math.pow(1 - i / N, 1.4);
        const n = 0.5 + 0.5 * Math.sin(i * 0.9 + this.t * 13) * Math.cos(i * 0.37 - this.t * 7);
        target[i] = Math.max(0, env * fall * (0.45 + 0.75 * n));
      }
    } else if (this.analyser) {
      this.analyser.getByteFrequencyData(this.freq);
      // 음성 대역(약 80Hz~3.5kHz)을 로그 스케일로 펼친다
      const hz = this.analyser.context.sampleRate / this.analyser.fftSize;
      const lo = Math.max(1, Math.round(80 / hz));
      const hi = Math.min(this.freq.length - 1, Math.round(3600 / hz));
      for (let i = 0; i < N; i++) {
        const a = Math.floor(lo * Math.pow(hi / lo, i / N));
        const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / N)));
        let m = 0;
        for (let k = a; k < b; k++) m = Math.max(m, this.freq[k]);
        const v = Math.max(0, (m - 70) / 150); // 노이즈 바닥 제거
        target[i] = Math.min(1, v * (1 + i / N * 0.8)) * this.style.gain;
      }
    }

    if (st === 'processing') {
      for (let i = 0; i < N; i++) {
        target[i] = target[i] * 0.4 + 0.12 + 0.1 * Math.sin(i * 0.5 - this.t * 6);
      }
    }

    let e = 0;
    for (let i = 0; i < N; i++) {
      const cur = this.bars[i];
      const k = target[i] > cur ? 0.45 : 0.12; // 빠르게 오르고 천천히 내려온다
      this.bars[i] = cur + (target[i] - cur) * k;
      e += this.bars[i];
    }
    this.energy += (e / N - this.energy) * 0.2;
  }

  _lerpStyle() {
    const tgt = STATE_STYLE[this.state];
    for (const k of Object.keys(tgt)) this.style[k] += (tgt[k] - this.style[k]) * 0.06;
  }

  _color(alpha, dl = 0, dh = 0) {
    const s = this.style;
    return `hsla(${s.hue + dh}, ${s.sat}%, ${Math.min(95, s.light + dl)}%, ${alpha})`;
  }

  _loop(ts) {
    this.t = ts / 1000;
    this._lerpStyle();
    this._sample();
    this._draw();
    requestAnimationFrame((t) => this._loop(t));
  }

  _draw() {
    const { ctx, w, h } = this;
    const cx = w / 2;
    const cy = h * 0.43;
    const R = Math.min(w, h) * 0.16;
    const E = this.energy;
    const glow = this.style.glow;

    // 잔상이 남도록 반투명하게 지운다
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(3, 6, 12, 0.32)';
    ctx.fillRect(0, 0, w, h);

    // 배경 빛 번짐
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 4.5);
    bg.addColorStop(0, this._color(0.10 * glow + E * 0.12, -10));
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';

    this._drawHud(cx, cy, R);
    this._drawParticles(cx, cy, R, E);
    this._drawWaves(cx, cy, R, E);
    this._drawBars(cx, cy, R);
    if (this.state === 'processing' || this.state === 'booting') this._drawSpinner(cx, cy, R);
    this._drawCore(cx, cy, R, E);
  }

  _drawHud(cx, cy, R) {
    const { ctx } = this;
    const rings = [
      { r: R * 2.15, dash: [2, 10], speed: 0.05, a: 0.22, lw: 1 },
      { r: R * 2.5, dash: [40, 8, 4, 8], speed: -0.03, a: 0.14, lw: 1 },
      { r: R * 2.95, dash: [1, 4], speed: 0.015, a: 0.1, lw: 2 },
    ];
    for (const ring of rings) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.t * ring.speed);
      ctx.setLineDash(ring.dash);
      ctx.strokeStyle = this._color(ring.a * (0.6 + this.style.glow * 0.6));
      ctx.lineWidth = ring.lw;
      ctx.beginPath();
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);
  }

  _drawParticles(cx, cy, R, E) {
    const { ctx } = this;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.r += p.v * (1 + E * 6);
      p.a += p.spin + (this.state === 'processing' ? 0.01 : 0);
      if (p.r > 3.2) this.particles[i] = this._newParticle(false);
      const rr = p.r * R;
      const x = cx + Math.cos(p.a) * rr;
      const y = cy + Math.sin(p.a) * rr;
      const life = Math.max(0, 1 - (p.r - 0.9) / 2.3);
      ctx.fillStyle = this._color(0.5 * life * (0.4 + this.style.glow), 15);
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 + E), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawWaves(cx, cy, R, E) {
    const { ctx, t } = this;
    const layers = [
      { k: [3, 5], sp: 0.9, amp: 0.22, dh: 0, a: 0.55, lw: 1.6 },
      { k: [4, 7], sp: -0.7, amp: 0.18, dh: 25, a: 0.4, lw: 1.2 },
      { k: [2, 6], sp: 0.5, amp: 0.26, dh: -20, a: 0.32, lw: 1 },
    ];
    for (const L of layers) {
      ctx.beginPath();
      const steps = 180;
      for (let s = 0; s <= steps; s++) {
        const th = (s / steps) * Math.PI * 2;
        // 각도에 대응하는 막대 값으로 파동을 흔든다
        const idx = Math.floor((Math.abs(Math.sin(th / 2)) * (this.N - 1)));
        const bar = this.bars[idx] || 0;
        const wob =
          Math.sin(th * L.k[0] + t * L.sp * 2) * 0.5 +
          Math.sin(th * L.k[1] - t * L.sp * 3) * 0.5;
        const r = R * (0.92 + (0.04 + E * L.amp * 2.2) * wob + bar * 0.25);
        const x = cx + Math.cos(th) * r;
        const y = cy + Math.sin(th) * r;
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = this._color(L.a * (0.5 + this.style.glow * 0.6), 5, L.dh);
      ctx.lineWidth = L.lw;
      ctx.shadowColor = this._color(0.9, 10, L.dh);
      ctx.shadowBlur = 12 * this.style.glow;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  _drawBars(cx, cy, R) {
    const { ctx, N } = this;
    const inner = R * 1.18;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, R * 0.022);
    ctx.shadowBlur = 14 * this.style.glow;
    ctx.shadowColor = this._color(0.9, 10);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < N; i++) {
        const v = this.bars[i];
        // 아래(저음)에서 위(고음)로 좌우 대칭 배치
        const th = Math.PI / 2 - side * ((i + 0.5) / N) * Math.PI;
        const len = R * 0.04 + v * R * 0.95;
        const c = Math.cos(th), s = Math.sin(th);
        ctx.strokeStyle = this._color(0.35 + v * 0.65, v * 25, -v * 15);
        ctx.beginPath();
        ctx.moveTo(cx + c * inner, cy + s * inner);
        ctx.lineTo(cx + c * (inner + len), cy + s * (inner + len));
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }

  _drawSpinner(cx, cy, R) {
    const { ctx, t } = this;
    const arcs = [
      { r: R * 1.32, len: 1.1, sp: 2.4, lw: 2.5 },
      { r: R * 1.48, len: 0.6, sp: -1.7, lw: 1.5 },
      { r: R * 1.62, len: 1.8, sp: 1.1, lw: 1 },
    ];
    for (const a of arcs) {
      const start = t * a.sp;
      ctx.strokeStyle = this._color(0.8, 10);
      ctx.lineWidth = a.lw;
      ctx.shadowBlur = 16;
      ctx.shadowColor = this._color(1, 15);
      ctx.beginPath();
      ctx.arc(cx, cy, a.r, start, start + a.len);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, a.r, start + Math.PI, start + Math.PI + a.len);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  _drawCore(cx, cy, R, E) {
    const { ctx, t } = this;
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.6);
    const cr = R * (0.42 + E * 0.35 + breathe * 0.03);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 1.6);
    g.addColorStop(0, this._color(0.95, 35));
    g.addColorStop(0.25, this._color(0.55 * this.style.glow + 0.2, 15));
    g.addColorStop(0.7, this._color(0.12, 0));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, cr * 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = this._color(0.5 + E * 0.5, 20);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2);
    ctx.stroke();
  }
}
