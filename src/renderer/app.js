// 자비스 상태 머신: 호출어 감지 → 명령 인식 → Claude Code 실행 → 음성 응답
const $ = (id) => document.getElementById(id);

const AWAKE_MS = 8000;      // "네 부르셨나요?" 이후 명령을 기다리는 시간
const FOLLOWUP_MS = 6000;   // 응답 후 호출어 없이 이어서 말할 수 있는 시간
const CANCEL_RE = /(그만|중지|취소|멈춰|스톱|stop)/i;
// Whisper가 무음/잡음에서 자주 지어내는 문장
const HALLUCINATIONS = [/시청해\s*주셔서/, /구독.*좋아요/, /MBC\s*뉴스/, /^감사합니다\.?$/, /^[\s\p{P}\p{S}]*$/u, /자막/, /^네\.?$/];

const app = {
  awake: false,
  awakeTimer: null,
  claudeBusy: false,
  hadText: false,
  speechActive: false,
  error: null,
  wakeRe: null,
};

const viz = new Visualizer($('viz'));
const speaker = new Speaker({ onBusyChange: onSpeakerBusy });
viz.speaker = speaker;

const mic = new MicEngine({
  onSpeechStart: () => {
    window.jarvis.log('speech start, noise', mic.noise.toFixed(4));
    app.speechActive = true;
    pauseAwakeTimer();
    render();
  },
  onSpeechEnd: (pcm) => {
    window.jarvis.log('speech end', pcm ? (pcm.length / 16000).toFixed(1) + 's' : 'too short');
    app.speechActive = false;
    if (pcm) handleUtterance(pcm);
    else resumeAwakeTimer();
    render();
  },
});

// ---------- 화면 ----------
function displayState() {
  if (app.error) return 'error';
  if (!app.sttReady) return 'booting';
  if (speaker.busy) return 'speaking';
  if (app.claudeBusy) return 'processing';
  if (app.awake || app.speechActive) return 'listening';
  return 'idle';
}

const LABELS = {
  booting: ['INITIALIZING', '음성 인식 모델을 불러오는 중입니다'],
  idle: ['STANDBY', '"자비스"라고 불러주세요'],
  listening: ['LISTENING', '말씀하세요'],
  processing: ['PROCESSING', 'Claude Code가 작업 중입니다'],
  speaking: ['RESPONDING', ''],
  error: ['ERROR', ''],
};

function render() {
  const s = displayState();
  viz.setState(s);
  document.body.dataset.state = s;
  const [label, hint] = LABELS[s];
  $('statusLabel').textContent = label;
  $('statusHint').textContent = s === 'error' ? app.error : (s === 'idle' && !app.awake && app.speechActive ? '' : hint);
}

function setUserLine(text, ignored = false) {
  const el = $('userLine');
  el.textContent = text;
  el.classList.toggle('ignored', ignored);
}

function setJarvisLine(text, append = false) {
  const el = $('jarvisLine');
  el.textContent = append && el.textContent ? el.textContent + ' ' + text : text;
}

function logTool(name, input) {
  const ul = $('toolLog');
  const li = document.createElement('li');
  li.textContent = input ? `${name}  ${input}` : name;
  ul.appendChild(li);
  while (ul.children.length > 3) ul.removeChild(ul.firstChild);
}

function say(text, append = false) {
  setJarvisLine(text, append);
  speaker.speak(text);
}

// ---------- 호출 상태 ----------
function setAwake(on, ms = AWAKE_MS) {
  clearTimeout(app.awakeTimer);
  app.awake = on;
  app.awakeMs = ms;
  if (on && !speaker.busy) app.awakeTimer = setTimeout(() => setAwake(false), ms);
  render();
}
function pauseAwakeTimer() { clearTimeout(app.awakeTimer); }
function resumeAwakeTimer() {
  if (app.awake && !speaker.busy) app.awakeTimer = setTimeout(() => setAwake(false), app.awakeMs || AWAKE_MS);
}

function onSpeakerBusy(busy) {
  window.jarvis.log('tts busy', busy);
  // 자기 목소리를 다시 인식하지 않도록 말하는 동안 마이크를 막는다
  if (busy) {
    mic.setGated(true);
    pauseAwakeTimer();
  } else {
    setTimeout(() => {
      if (!speaker.busy) mic.setGated(false);
    }, 350);
    resumeAwakeTimer();
  }
  render();
}

function wakeUp() {
  setJarvisLine('');
  $('toolLog').innerHTML = '';
  setAwake(true, AWAKE_MS);
  say('네, 부르셨나요?');
}

// ---------- 음성 처리 ----------
function hasWake(text) {
  app.wakeRe.lastIndex = 0;
  return app.wakeRe.test(text);
}
function stripWake(text) {
  return text.replace(app.wakeRe, ' ').replace(/^[\s,.!?~]+|[\s,.!?~]+$/g, '').trim();
}

async function handleUtterance(pcm) {
  let text = '';
  try {
    const res = await window.jarvis.transcribe(pcm);
    text = (res.text || '').trim();
  } catch (e) {
    console.error(e);
  }
  if (!text || HALLUCINATIONS.some((re) => re.test(text))) {
    resumeAwakeTimer();
    return;
  }

  const wake = hasWake(text);
  window.jarvis.log('heard', JSON.stringify(text), 'wake', wake, 'awake', app.awake, 'busy', app.claudeBusy);
  const rest = stripWake(text);

  // 작업 중: 호출어 + "그만" 이면 중단, 호출어 + 새 명령이면 교체
  if (app.claudeBusy && !app.awake) {
    if (!wake) return setUserLine(text, true);
    setUserLine(text);
    if (!rest || CANCEL_RE.test(rest)) return cancelAll(true);
    return execute(rest);
  }

  if (app.awake) {
    if (CANCEL_RE.test(rest) && rest.length <= 6) {
      setUserLine(text);
      setAwake(false);
      return say('알겠습니다.');
    }
    if (rest.length >= 2) return execute(rest, text);
    if (wake) return wakeUp();
    return resumeAwakeTimer();
  }

  if (wake) {
    setUserLine(text);
    if (rest.length >= 2) return execute(rest, text);
    return wakeUp();
  }

  setUserLine(text, true); // 호출어 없는 말은 무시
}

function execute(command, shown = command) {
  setAwake(false);
  setUserLine(shown);
  setJarvisLine('');
  $('toolLog').innerHTML = '';
  speaker.cancel();
  app.error = null;
  app.claudeBusy = true;
  app.hadText = false;
  window.jarvis.runClaude(command);
  render();
}

function cancelAll(announce) {
  window.jarvis.cancelClaude();
  speaker.cancel();
  app.claudeBusy = false;
  setAwake(false);
  if (announce) say('작업을 중단했습니다.');
  render();
}

window.jarvis.onClaudeEvent((ev) => {
  if (!app.claudeBusy && ev.type !== 'error') return;
  if (ev.type === 'text') {
    say(ev.text, app.hadText);
    app.hadText = true;
  } else if (ev.type === 'tool') {
    logTool(ev.name, ev.input);
  } else if (ev.type === 'done') {
    app.claudeBusy = false;
    if (!ev.cancelled) {
      if (!app.hadText) say('완료했습니다.');
      setAwake(true, FOLLOWUP_MS); // 이어서 말할 수 있게 잠깐 대기
    }
  } else if (ev.type === 'error') {
    app.claudeBusy = false;
    say('죄송합니다. ' + ev.message);
  }
  render();
});

// ---------- 입력 ----------
$('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('cmdInput').value.trim();
  if (!v) return;
  $('cmdInput').value = '';
  if (hasWake(v) && stripWake(v).length < 2) return wakeUp();
  execute(stripWake(v) || v, v);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelAll(false);
});

$('btnMin').onclick = () => window.jarvis.minimize();
$('btnClose').onclick = () => window.jarvis.close();
window.jarvis.onWake(() => wakeUp());

// ---------- 시작 ----------
function setDot(id, cls, title) {
  const el = $(id);
  el.className = 'dot ' + cls;
  el.title = title || '';
}

function applySttStatus(s) {
  app.sttReady = !!s.ready;
  if (s.ready) {
    setDot('sysStt', 'ok', `음성 인식 준비됨 (${s.device})`);
    if (app.error && app.error.startsWith('음성')) app.error = null;
    if (!app.greeted) {
      app.greeted = true;
      say('자비스 온라인. 부르시면 대기하겠습니다.');
    }
  } else if (s.error) {
    setDot('sysStt', 'bad', s.error);
    app.error = '음성 인식: ' + s.error;
  } else {
    setDot('sysStt', 'wait', '음성 인식 모델 로딩 중');
  }
  render();
}

(async function boot() {
  const cfg = await window.jarvis.getConfig();
  const words = cfg.wakeWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  app.wakeRe = new RegExp(`(${words.join('|')})(야|아|님|씨)?[\\s,.!?~]*`, 'gi');
  speaker.rate = cfg.ttsRate || 1.05;
  setDot('sysClaude', cfg.claudeFound ? 'ok' : 'bad', cfg.claudePath || 'Claude Code를 찾지 못함');

  window.jarvis.onSttStatus(applySttStatus);
  applySttStatus(await window.jarvis.sttStatus());

  try {
    await mic.start();
    viz.attach(mic.analyser);
  } catch (e) {
    app.error = '마이크를 사용할 수 없습니다: ' + e.message;
  }
  render();
  setInterval(() => window.jarvis.log('mic level', mic.level.toFixed(4), 'noise', mic.noise.toFixed(4),
    'gated', mic.gated, 'ctx', mic.ctx && mic.ctx.state, 'state', displayState()), 5000);
})();
