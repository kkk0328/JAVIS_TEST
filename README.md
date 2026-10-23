# J.A.R.V.I.S.

음성으로 로컬 Claude Code를 실행하는 Windows 데스크탑 비서입니다.

- "자비스" → "네, 부르셨나요?" → 명령
- "자비스, 크롬 좀 켜줘" 처럼 호출어와 명령을 한 번에 말해도 됩니다.
- 응답 후 6초 동안은 호출어 없이 이어서 말할 수 있습니다.
- 작업 중 "자비스 그만" 또는 `Esc` 로 중단, `Ctrl+Shift+J` 로 창 호출 + 대기 상태 진입.
- 하단 입력창에 직접 명령을 입력할 수도 있습니다.

## 구성

| 부분 | 기술 |
| --- | --- |
| 앱 | Electron (`src/main.js`, `src/renderer/*`) |
| 음성 인식 | faster-whisper `large-v3-turbo` (GPU, 실패 시 CPU `small`) — `stt/server.py` |
| 음성 구간 검출 | 렌더러에서 에너지 기반 VAD (`src/renderer/audio.js`) |
| 음성 응답 | Windows 내장 TTS (Microsoft Heami) via `speechSynthesis` |
| 명령 실행 | `claude -p --output-format stream-json` (`src/claude.js`) |
| 비주얼라이저 | Canvas 주파수 링 + 파동 + 입자 (`src/renderer/visualizer.js`) |

## 처음 한 번 설정

1. Python 패키지

   ```bash
   pip install faster-whisper msvc-runtime nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
   ```

   `msvc-runtime` 은 Visual C++ 런타임이 없는 PC용입니다. GPU가 없으면 nvidia 패키지는 빼도 됩니다(CPU로 동작).

2. Claude Code 로그인 — 자비스는 로그인된 `claude` CLI가 필요합니다.

   ```bash
   claude
   ```

   `claude` 명령이 없다면 공식 설치 스크립트(PowerShell: `irm https://claude.ai/install.ps1 | iex`)로 설치한 뒤 실행해 로그인하세요.
   설치하지 않으면 Claude 데스크톱 앱에 번들된 `claude.exe` 를 자동으로 찾아 쓰며, 이 경우에도 그 exe로 한 번 로그인해야 합니다.

3. 실행

   ```bash
   npm install
   npm.cmd start
   ```

   또는 `start.bat` 을 더블클릭하세요. (PowerShell 실행 정책 때문에 `npm start` 가 막히는 PC에서는 `npm.cmd` 를 씁니다.)

   첫 실행 때 음성 인식 모델(약 1.6GB)을 내려받습니다.

## 설정 (`config.json`)

| 키 | 설명 |
| --- | --- |
| `wakeWords` | 호출어 목록 (인식 오차를 고려해 여러 표기 포함) |
| `pythonPath` | Python 실행 파일 |
| `claudePath` | 비워두면 자동 탐색 |
| `claudeModel` | 비워두면 Claude Code 기본 모델 |
| `workDir` | Claude Code 작업 폴더 (기본: 사용자 홈) |
| `permissionMode`, `allowedTools` | Claude Code 권한. 기본값은 Bash/PowerShell 실행을 확인 없이 허용합니다 |
| `sessionIdleMinutes` | 이 시간 안의 명령은 같은 대화로 이어집니다 |
| `ttsRate` | 말하기 속도 |
| `hotkey` | 전역 단축키 |
| `geckoUrl` | 데스크탑 펫 게코(`../javis2`) 주소. 자비스 상태를 알려 주고 "자비스, 도마뱀 재워줘" 같은 명령을 보냅니다. 비우면 연동하지 않습니다 |

> 기본 설정은 음성 명령으로 셸 명령이 바로 실행됩니다. 불안하면 `allowedTools` 에서 `Bash`, `PowerShell` 을 빼세요(대신 프로그램 실행 같은 작업은 거절됩니다).
