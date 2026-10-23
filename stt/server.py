"""자비스 음성 인식(STT) 서버.

Electron 메인 프로세스가 실행하며, 16kHz mono float32 PCM 바이트를 POST /transcribe 로 받아
faster-whisper 로 한국어 텍스트를 돌려준다. stdout 첫 줄에 "READY <port> <device>" 를 출력한다.
"""
import json
import os
import sys
import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import numpy as np


def add_cuda_dll_dirs():
    # pip 로 설치한 nvidia-cublas / nvidia-cudnn 의 DLL 경로를 등록
    try:
        import nvidia  # noqa
        for base in nvidia.__path__:
            for d in glob.glob(os.path.join(base, "*", "bin")):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


add_cuda_dll_dirs()

from faster_whisper import WhisperModel  # noqa: E402

MODEL_GPU = os.environ.get("JARVIS_STT_MODEL_GPU", "large-v3-turbo")
MODEL_CPU = os.environ.get("JARVIS_STT_MODEL_CPU", "small")
LANG = os.environ.get("JARVIS_STT_LANG", "ko")
# 호출어 인식률을 높이기 위한 프롬프트
INITIAL_PROMPT = "자비스, 크롬 좀 켜줘. 메모장 열어줘. 자비스야."


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def load_model():
    try:
        m = WhisperModel(MODEL_GPU, device="cuda", compute_type="float16")
        # 실제로 CUDA 라이브러리가 로드되는지 짧은 무음으로 확인
        list(m.transcribe(np.zeros(16000, dtype=np.float32), language=LANG)[0])
        return m, "cuda"
    except Exception as e:
        log("GPU 로드 실패, CPU로 전환:", e)
        return WhisperModel(MODEL_CPU, device="cpu", compute_type="int8"), "cpu"


model, device = load_model()
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "device": device})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        audio = np.frombuffer(self.rfile.read(n), dtype=np.float32)
        if audio.size < 1600:
            return self._json(200, {"text": ""})
        try:
            with lock:
                segments, _ = model.transcribe(
                    audio,
                    language=LANG,
                    beam_size=5,
                    vad_filter=True,
                    initial_prompt=INITIAL_PROMPT,
                    condition_on_previous_text=False,
                )
                segs = [s for s in segments if s.no_speech_prob < 0.6]
                text = " ".join(s.text.strip() for s in segs).strip()
            self._json(200, {"text": text})
        except Exception as e:
            log("transcribe error:", e)
            self._json(500, {"error": str(e)})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"READY {srv.server_address[1]} {device}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
