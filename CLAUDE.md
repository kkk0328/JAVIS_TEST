# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 개요

Windows 전용 음성 비서 데스크탑 앱. 호출어("자비스")를 듣고 명령을 로컬 Claude Code CLI(`claude -p`)에 넘긴 뒤, Claude의 텍스트 응답을 한국어 TTS로 읽어준다. 빌드 단계, 린터, 테스트 스위트는 없다.

## 명령어

```bash
npm.cmd start          # 앱 실행 (start.bat 더블클릭과 같음)
python -u stt/server.py  # STT 서버만 단독 실행 — stdout에 "READY <port> <device>" 출력
```

- 이 PC의 PowerShell은 스크립트 실행 정책 때문에 `npm`(npm.ps1)이 막힌다. 항상 `npm.cmd`를 쓴다.
- Python 의존성: `faster-whisper msvc-runtime nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*`. 시스템에 VC++ 런타임이 없어서 `msvc-runtime`이 Python 폴더에 DLL을 넣어 준다. 이게 없으면 ctranslate2가 로드되지 않는다.

### 자동 검증 (디버그 훅, `src/main.js`)

환경변수를 주면 창을 캡처하고 텍스트 명령을 자동으로 넣는다. 수동 마이크 입력 없이 전체 흐름을 확인할 때 쓴다.

```bash
JARVIS_CAPTURE="<scratch>/shot.png" JARVIS_CAPTURE_TIMES="13,20,35" JARVIS_TEST_CMD="자비스 크롬 좀 켜줘" timeout 60 npx electron .
```

- 지정한 초마다 `shot-<n>s.png`를 저장하고, 10초 뒤 입력창에 `JARVIS_TEST_CMD`를 제출한다.
- 텍스트 입력은 `handleUtterance`의 잡음 필터와 호출어 판정을 **거치지 않는다**. 음성 경로를 고쳤다면 `jarvis.log`로 실제 발화를 확인해야 한다.

### 로그

`jarvis.log`(프로젝트 루트, 앱 시작 때 초기화)에 VAD 시작/종료, STT 결과, 호출어 판정(`heard ... wake ... awake ...`), Claude 이벤트, TTS 상태, 5초마다 마이크 레벨이 남는다. 사용자가 "안 된다"고 하면 먼저 이 파일을 본다.

## 아키텍처

세 프로세스가 있다. 이 흐름을 이해하려면 여러 파일을 함께 봐야 한다.

1. **렌더러** (`src/renderer/`, 클래식 스크립트, 모듈 아님): 마이크 → `capture-worklet.js`(장치 샘플레이트를 16kHz로 다운샘플링) → `audio.js`의 에너지 기반 VAD가 발화 하나를 Float32 PCM으로 잘라낸다 → IPC로 메인에 보낸다.
2. **메인** (`src/main.js`): 시작할 때 `stt/server.py`를 실행하고 stdout의 `READY` 줄에서 포트를 얻는다. PCM을 `POST /transcribe`로 넘겨 텍스트를 받는다.
3. **STT 서버** (`stt/server.py`): faster-whisper. GPU `large-v3-turbo` float16을 먼저 시도하고, 실패하면 CPU `small` int8로 내려간다. pip nvidia 패키지의 DLL 경로를 직접 등록한다.

명령 처리:

- 상태 머신은 `src/renderer/app.js`에 있다. 상태는 idle → (호출어) awake → processing → speaking → (후속 대기) awake → idle 순서다. 작업 중에는 호출어+"그만"으로 취소하고, 호출어+새 명령이 오면 기존 작업을 교체한다.
- `src/claude.js`의 `ClaudeRunner`는 `claude -p ... --output-format stream-json --verbose --append-system-prompt <자비스 페르소나>`를 실행한다. `assistant` 메시지의 텍스트 블록을 **나오는 즉시** 이벤트로 보내고, 렌더러가 그대로 TTS로 읽는다. 따라서 "네 알겠습니다…" 같은 첫 확인 응답은 시스템 프롬프트 규칙으로 만들어진다. 응답 말투나 행동을 바꾸려면 `SYSTEM_PROMPT`를 고친다.
- 대화 연속성: `session_id`를 저장해 두고 `--resume`으로 이어 붙인다. `sessionIdleMinutes`가 지나면 새 세션을 시작한다.
- `claude` 실행 파일 탐색 순서: `config.claudePath` → PATH → `~/.local/bin/claude.exe` → `%LOCALAPPDATA%\Claude-Data\*\claude-code\<ver>\*\claude.exe`(데스크톱 앱 번들, 최신 버전). 자식 프로세스 환경에서는 `CLAUDECODE`, `CLAUDE_CODE_*`를 지운다. Claude Code 세션 안에서 앱을 띄워도 영향이 없게 하기 위해서다.
- TTS(`tts.js`)는 Windows 내장 음성 "Microsoft Heami"를 `speechSynthesis`로 쓴다. 말하는 동안 `mic.setGated(true)`로 VAD를 막아 자기 목소리를 다시 인식하지 않게 한다. Chromium에서 `onend`가 누락될 때를 대비해 문장 단위로 나누고 watchdog 타이머를 둔다.
- 비주얼라이저(`visualizer.js`)는 대기/청취 상태에서는 `AnalyserNode` 주파수를, speaking 상태에서는 TTS 단어 경계(`speaker.pulse`)로 합성한 스펙트럼을 쓴다. 상태별 색상은 `STATE_STYLE`에 있다.

설정은 전부 `config.json`(호출어 목록, Claude 권한/모델/작업 폴더, 단축키)에서 한다. 기본 권한은 Bash/PowerShell을 확인 없이 허용한다.

## 주의할 점

- JS 정규식의 `\W`, `\w`, `\b`는 한글을 단어 문자로 보지 않는다. 한국어 텍스트를 다룰 때는 `\p{L}`, `\p{P}` 같은 유니코드 속성 이스케이프에 `u` 플래그를 함께 쓴다. 이 버그 때문에 모든 음성 명령이 잡음으로 걸러진 적이 있다.
- Git Bash heredoc으로 JS 파일을 만들면 `\\` 같은 백슬래시가 깨질 수 있다. 정규식이 들어 있는 파일은 Write 도구로 쓴다.
- 번들 `claude.exe`는 데스크톱 앱과 로그인 상태를 공유하지 않는다. 처음 한 번은 `claude.exe /login`이 필요하다. 로그인이 안 돼 있으면 `result.is_error`에 "Not logged in"이 오고, 자비스가 이를 음성으로 안내한다.
- Electron을 강제로 종료하면 렌더러 로그에 "AudioContext encountered an error"가 찍힌다. 종료할 때 생기는 것이라 무시해도 된다.
