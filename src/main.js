const { app, BrowserWindow, ipcMain, session, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ClaudeRunner } = require('./claude');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let win = null;

// 진단용 로그: 프로젝트 폴더의 jarvis.log
const LOG_PATH = path.join(ROOT, 'jarvis.log');
fs.writeFileSync(LOG_PATH, '');
function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  fs.appendFileSync(LOG_PATH, `[${t}] ${args.join(' ')}
`);
}
ipcMain.on('log', (_e, msg) => log('[ui]', msg));
let stt = { proc: null, port: null, device: null, ready: false, error: null };
const claude = new ClaudeRunner(config);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- 음성 인식 서버 ----------
function startStt() {
  const script = path.join(ROOT, 'stt', 'server.py');
  const proc = spawn(config.pythonPath || 'python', ['-u', script], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  stt.proc = proc;
  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/READY (\d+) (\w+)/);
    if (m && !stt.ready) {
      stt = { ...stt, port: Number(m[1]), device: m[2], ready: true };
      send('stt:status', { ready: true, device: stt.device });
      log('STT ready', stt.device);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { process.stderr.write('[stt] ' + d); log('[stt]', String(d).trim()); });
  proc.on('error', (err) => {
    stt.error = `Python 실행 실패: ${err.message}`;
    send('stt:status', { ready: false, error: stt.error });
  });
  proc.on('exit', (code) => {
    if (!stt.ready || code !== null) {
      stt.ready = false;
      stt.error = stt.error || `음성 인식 서버가 종료되었습니다 (코드 ${code}).`;
      send('stt:status', { ready: false, error: stt.error });
    }
  });
}

ipcMain.handle('stt:status', () => ({ ready: stt.ready, device: stt.device, error: stt.error }));

ipcMain.handle('stt:transcribe', async (_e, pcm) => {
  if (!stt.ready) return { text: '', error: '음성 인식 서버 준비 중' };
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const res = await fetch(`http://127.0.0.1:${stt.port}/transcribe`, { method: 'POST', body });
  const json = await res.json();
  log('STT', `${(pcm.length / 16000).toFixed(1)}s ->`, JSON.stringify(json.text ?? json.error));
  return json;
});

// ---------- Claude Code ----------
ipcMain.handle('jarvis:config', () => ({
  wakeWords: config.wakeWords,
  ttsRate: config.ttsRate,
  claudeFound: !!claude.exe,
  claudePath: claude.exe,
}));

ipcMain.on('claude:run', (_e, text) => {
  if (claude.busy) claude.cancel();
  log('CLAUDE run', text);
  claude.run(text, (ev) => { log('CLAUDE', JSON.stringify(ev)); send('claude:event', ev); });
});

ipcMain.on('claude:cancel', () => claude.cancel());

// ---------- 게코(데스크탑 펫) 연동 ----------
// 게코 앱이 켜져 있으면 자비스 상태와 링 위치를 알려 준다. 꺼져 있으면 조용히 무시한다.
let uiState = 'booting';

function notifyGecko() {
  if (!config.geckoUrl || !win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  // 링 위치는 visualizer.js 의 _draw() 와 같은 비율 (cx = w/2, cy = h*0.43, R = min(w,h)*0.16)
  const ring = { x: b.x + b.width / 2, y: b.y + b.height * 0.43, r: Math.min(b.width, b.height) * 0.16 };
  fetch(`${config.geckoUrl}/jarvis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: uiState, visible: win.isVisible() && !win.isMinimized(), bounds: b, ring }),
    signal: AbortSignal.timeout(500),
  }).catch(() => {});
}

ipcMain.on('gecko:state', (_e, s) => {
  uiState = s;
  notifyGecko();
});

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:close', () => win && win.close());

// ---------- 창 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    frame: false,
    backgroundColor: '#03060c',
    title: 'J.A.R.V.I.S.',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 창이 가려져도 마이크 처리와 애니메이션이 멈추지 않게
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  for (const ev of ['move', 'resize', 'minimize', 'restore', 'show', 'hide']) win.on(ev, notifyGecko);
  // 게코가 나중에 켜져도 알 수 있게 주기적으로 보낸다
  setInterval(notifyGecko, 2000);

  // 디버그: JARVIS_CAPTURE=파일경로 로 실행하면 몇 초 간격으로 화면을 저장한다
  if (process.env.JARVIS_CAPTURE) {
    const base = process.env.JARVIS_CAPTURE.replace(/\.png$/i, '');
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    setInterval(() => win.webContents.executeJavaScript(
      `console.log('mic level', mic.level.toFixed(4), 'ctx', mic.ctx && mic.ctx.state, mic.ctx && mic.ctx.sampleRate, 'state', document.body.dataset.state, 'q', speaker.queue.length, 'sp', speechSynthesis.speaking, speaker.voice && speaker.voice.name)`
    ).catch(() => {}), 4000);
    (process.env.JARVIS_CAPTURE_TIMES || '6,14,24').split(',').map(Number).forEach((sec) =>
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(`${base}-${sec}s.png`, img.toPNG());
      }, sec * 1000)
    );
    if (process.env.JARVIS_TEST_CMD) {
      setTimeout(() => win.webContents.executeJavaScript(
        `document.getElementById('cmdInput').value=${JSON.stringify(process.env.JARVIS_TEST_CMD)};` +
        `document.getElementById('cmdForm').requestSubmit();`), 10000);
    }
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'speaker-selection');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  startStt();
  createWindow();

  if (config.hotkey) {
    globalShortcut.register(config.hotkey, () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send('jarvis:wake');
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  claude.cancel();
  if (stt.proc) stt.proc.kill();
});

app.on('window-all-closed', () => app.quit());
