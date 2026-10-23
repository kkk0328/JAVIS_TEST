// 로컬 Claude Code CLI 실행기: -p 모드 + stream-json 출력을 파싱해서 이벤트로 넘긴다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_PROMPT = `당신은 "자비스"입니다. 이 Windows 컴퓨터에서 동작하는 음성 비서이며, 사용자의 말은 음성 인식으로 들어오고 당신의 텍스트 응답은 모두 TTS로 소리 내어 읽힙니다.

규칙:
1. 작업(도구 사용)이 필요한 요청이면, 도구를 호출하기 전에 먼저 짧은 확인 문장을 텍스트로 말하세요. 예: "네 알겠습니다. 크롬을 켜겠습니다."
2. 작업이 끝나면 결과를 한두 문장으로 짧게 보고하세요. 단순 질문이면 바로 짧게 답하세요.
3. 마크다운, 코드 블록, 목록 기호, 이모지, URL, 파일 경로를 응답 텍스트에 넣지 마세요. 소리 내어 읽기 좋은 자연스러운 한국어 존댓말만 쓰세요.
4. 음성 인식 오류로 단어가 조금 틀릴 수 있습니다. 문맥상 가장 그럴듯한 뜻으로 해석하고, 정말 모호할 때만 짧게 되물으세요.
5. 프로그램 실행은 PowerShell의 Start-Process를 사용하세요(예: Start-Process chrome, Start-Process notepad, Start-Process "https://..."). 실행 후 기다리지 마세요.
6. 파일 삭제, 시스템 설정 변경처럼 되돌리기 어려운 작업은 실행 전에 한 번 확인을 받으세요.`;

function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  // 1) PATH 에 설치된 claude
  try {
    const out = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find((l) => /\.(exe|cmd)$/i.test(l.trim()));
    if (first) return first.trim();
  } catch {}
  // 2) 표준 설치 위치
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  // 3) Claude 데스크톱 앱에 번들된 claude.exe (가장 최신 버전)
  const dataRoot = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
  const found = [];
  try {
    for (const app of fs.readdirSync(dataRoot)) {
      const ccRoot = path.join(dataRoot, app, 'claude-code');
      if (!fs.existsSync(ccRoot)) continue;
      for (const ver of fs.readdirSync(ccRoot)) {
        const verDir = path.join(ccRoot, ver);
        for (const h of fs.readdirSync(verDir)) {
          const exe = path.join(verDir, h, 'claude.exe');
          if (fs.existsSync(exe)) found.push({ ver, exe });
        }
      }
    }
  } catch {}
  const cmp = (a, b) => {
    const pa = a.ver.split('.').map(Number), pb = b.ver.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  };
  found.sort(cmp);
  return found.length ? found[found.length - 1].exe : null;
}

class ClaudeRunner {
  constructor(config) {
    this.config = config;
    this.exe = findClaude(config.claudePath);
    this.sessionId = null;
    this.lastUsed = 0;
    this.child = null;
  }

  get busy() {
    return !!this.child;
  }

  cancel() {
    if (!this.child) return;
    try {
      // Windows 에서는 자식 프로세스 트리까지 종료
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    } catch {}
  }

  // onEvent({type:'text'|'tool'|'done'|'error', ...})
  run(prompt, onEvent) {
    if (!this.exe) {
      onEvent({ type: 'error', message: 'Claude Code를 찾지 못했습니다. config.json의 claudePath를 설정해 주세요.' });
      return;
    }
    const c = this.config;
    const idleMs = (c.sessionIdleMinutes || 10) * 60 * 1000;
    if (Date.now() - this.lastUsed > idleMs) this.sessionId = null;

    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', SYSTEM_PROMPT];
    if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
    if (c.allowedTools && c.allowedTools.length) args.push('--allowedTools', c.allowedTools.join(','));
    if (c.claudeModel) args.push('--model', c.claudeModel);
    if (this.sessionId) args.push('--resume', this.sessionId);

    // Claude Code 세션 안에서 실행된 경우의 환경변수가 넘어가지 않게 정리
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    }

    const cwd = c.workDir && fs.existsSync(c.workDir) ? c.workDir : os.homedir();
    const child = spawn(this.exe, args, { cwd, env, windowsHide: true });
    this.child = child;
    child.stdin.end();

    let buf = '';
    let stderr = '';
    let finished = false;
    const finish = (ev) => {
      if (finished) return;
      finished = true;
      onEvent(ev);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this._handle(msg, onEvent, finish);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      this.child = null;
      finish({ type: 'error', message: `Claude Code 실행 실패: ${err.message}` });
    });
    child.on('close', (code) => {
      this.child = null;
      this.lastUsed = Date.now();
      if (code !== 0 && !finished) {
        finish({ type: 'error', message: stderr.trim() || `Claude Code가 종료되었습니다 (코드 ${code}).` });
      } else {
        finish({ type: 'done', cancelled: code !== 0 });
      }
    });
  }

  _handle(msg, onEvent, finish) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionId = msg.session_id;
    } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          onEvent({ type: 'text', text: block.text.trim() });
        } else if (block.type === 'tool_use') {
          onEvent({ type: 'tool', name: block.name, input: summarizeInput(block.input) });
        }
      }
    } else if (msg.type === 'result') {
      if (msg.session_id) this.sessionId = msg.session_id;
      if (msg.is_error) {
        const text = String(msg.result || '');
        const message = /not logged in|\/login/i.test(text)
          ? 'Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude를 실행해 로그인해 주세요.'
          : text || '작업 중 오류가 발생했습니다.';
        finish({ type: 'error', message });
      } else {
        finish({ type: 'done' });
      }
    }
  }
}

function summarizeInput(input) {
  if (!input) return '';
  const v = input.command || input.url || input.query || input.file_path || input.pattern || input.prompt || input.description;
  const s = typeof v === 'string' ? v : JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

module.exports = { ClaudeRunner, findClaude };
