"""Local Supertonic 3 server. One process, shared by every bot."""

import io
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = "127.0.0.1"
TTS = None
STYLES = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        if TTS is None:
            self.send_error(503)
            return
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/speak":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text", "")).strip()
            voice = str(payload.get("voice") or "M1")
            lang = str(payload.get("lang") or "ko")
            if not text:
                raise ValueError("empty text")
            if TTS is None:
                raise RuntimeError("model is still loading")
            wav = synthesize(text, voice, lang)
        except Exception as exc:
            body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, fmt, *args):
        return


def synthesize(text, voice, lang):
    import soundfile as sf

    style = STYLES.get(voice)
    if style is None:
        style = TTS.get_voice_style(voice)
        STYLES[voice] = style
    wav, _duration = TTS.synthesize(text, voice_style=style, lang=lang, verbose=False)
    buf = io.BytesIO()
    sf.write(buf, wav.squeeze(), TTS.sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def main():
    global TTS
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 47821
    try:
        server = HTTPServer((HOST, port), Handler)
    except OSError:
        return

    from supertonic import TTS as Supertonic

    print("Supertonic TTS loading...", flush=True)
    TTS = Supertonic(auto_download=True)
    print(f"Supertonic TTS ready on {HOST}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
