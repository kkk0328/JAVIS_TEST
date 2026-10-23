// 마이크 입력을 16kHz로 다운샘플링해서 512 샘플(32ms) 단위로 메인 스레드에 넘긴다.
const TARGET_RATE = 16000;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.buf = new Float32Array(512);
    this.len = 0;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        // 출력 샘플 하나에 해당하는 입력 구간을 평균(간단한 저역통과)
        this.acc += ch[i];
        this.accN++;
        this.pos += 1;
        if (this.pos >= this.ratio) {
          this.pos -= this.ratio;
          this.buf[this.len++] = this.acc / this.accN;
          this.acc = 0;
          this.accN = 0;
          if (this.len === this.buf.length) {
            this.port.postMessage(this.buf.slice(0));
            this.len = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
