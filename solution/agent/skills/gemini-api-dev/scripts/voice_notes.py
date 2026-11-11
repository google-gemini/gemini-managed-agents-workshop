#!/usr/bin/env python3
"""Sandbox CLI for Gemini 3.5 Smart Transcription and Gemini 3.8 Flash-Lite TTS via Interactions API."""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
TRANSCRIBE_MODEL = "gemini-3.5-transcribe"
TTS_MODEL = "gemini-3.8-flash-lite-tts"
ALLOWED_VOICES = {"Kore", "Puck", "Aoede", "Charon", "Fenrir"}
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_SUMMARY_CHARS = 2000

EXT_MIME_MAP = {
    ".webm": "audio/webm",
    ".wav": "audio/wav",
    ".mp3": "audio/mp3",
    ".mpeg": "audio/mp3",
    ".mp4": "audio/m4a",
    ".m4a": "audio/m4a",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
}


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, indent=2))
    sys.exit(exit_code)


def resolve_sandbox_path(raw_path: str) -> Path:
    target = Path(raw_path).resolve()
    allowed_roots = [Path("/workspace").resolve(), (Path.cwd() / "tmp").resolve()]
    for root in allowed_roots:
        if target == root or str(target).startswith(str(root) + os.sep):
            return target
    emit(
        {
            "ok": False,
            "error": f"Path {str(target)!r} must stay inside /workspace (or ./tmp when testing locally).",
        },
        2,
    )
    raise AssertionError("unreachable")


def locate_input_audio(raw_path: str) -> Path:
    primary = resolve_sandbox_path(raw_path)
    if primary.is_file():
        return primary
    # Handle Environments Files API paths that mount relative to /workspace vs container root.
    workspace_root = Path("/workspace").resolve()
    if str(primary).startswith(str(workspace_root) + os.sep):
        rel = primary.relative_to(workspace_root)
        nested = (workspace_root / "workspace" / rel).resolve()
        if nested.is_file():
            return nested
    emit({"ok": False, "error": f"Input audio file not found: {primary}"}, 1)
    raise AssertionError("unreachable")


def normalize_mime(raw_mime: str | None, file_path: Path) -> str:
    if raw_mime:
        base = raw_mime.split(";", 1)[0].strip().lower()
        if base == "audio/mpeg":
            return "audio/mp3"
        if base in ("audio/mp4", "audio/x-m4a"):
            return "audio/m4a"
        if base.startswith("audio/"):
            return base
    return EXT_MIME_MAP.get(file_path.suffix.lower(), "audio/webm")


def post_interaction(api_base: str, body: dict[str, Any], timeout_sec: int = 90) -> dict[str, Any]:
    url = f"{api_base.rstrip('/')}/interactions"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # Inside the Managed Agent sandbox, the Gemini Credential Vault egress proxy injects x-goog-api-key
    # on outbound requests to generativelanguage.googleapis.com. Only attach an env header during local tests.
    local_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if local_key:
        headers["x-goog-api-key"] = local_key

    encoded = json.dumps(body).encode("utf-8")
    last_err: Exception | None = None
    for attempt in range(2):
        req = urllib.request.Request(url, data=encoded, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                raw = resp.read().decode("utf-8", "replace")
                parsed = json.loads(raw) if raw else {}
                return parsed if isinstance(parsed, dict) else {}
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", "replace")
            if exc.code in (502, 503, 504) and attempt == 0:
                time.sleep(0.6)
                last_err = RuntimeError(f"HTTP {exc.code}: {err_body[:300]}")
                continue
            raise RuntimeError(f"HTTP {exc.code}: {err_body[:400]}") from exc
        except Exception as exc:
            last_err = exc
            if attempt == 0:
                time.sleep(0.5)
                continue
            raise RuntimeError(f"Interactions API request failed: {exc}") from exc
    raise RuntimeError(f"Interactions API request failed: {last_err}")


def extract_transcript(data: dict[str, Any]) -> str:
    for key in ("output_text", "outputText"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    chunks: list[str] = []
    for collection_key in ("steps", "outputs"):
        items = data.get(collection_key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "thought":
                continue
            direct_text = item.get("text")
            if isinstance(direct_text, str) and direct_text:
                chunks.append(direct_text)
            content = item.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                        chunks.append(block["text"])
    return "\n".join(part.strip() for part in chunks if part.strip()).strip()


def extract_audio_bytes(data: dict[str, Any]) -> bytes | None:
    for key in ("output_audio", "outputAudio"):
        audio_obj = data.get(key)
        if isinstance(audio_obj, dict) and isinstance(audio_obj.get("data"), str) and audio_obj["data"]:
            return base64.b64decode(audio_obj["data"])

    for collection_key in ("steps", "outputs"):
        items = data.get(collection_key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "audio" and isinstance(item.get("data"), str):
                return base64.b64decode(item["data"])
            content = item.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "audio" and isinstance(block.get("data"), str):
                        return base64.b64decode(block["data"])
                    inline = block.get("inline_data") or block.get("inlineData")
                    if isinstance(inline, dict) and isinstance(inline.get("data"), str):
                        return base64.b64decode(inline["data"])
    return None


def ensure_riff_wav(raw_audio: bytes, sample_rate: int = 24000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    if len(raw_audio) >= 12 and raw_audio[:4] == b"RIFF" and raw_audio[8:12] == b"WAVE":
        return raw_audio
    byte_rate = sample_rate * channels * (bits_per_sample // 8)
    block_align = channels * (bits_per_sample // 8)
    data_size = len(raw_audio)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + raw_audio


def cmd_transcribe(args: argparse.Namespace) -> None:
    audio_path = locate_input_audio(args.input)
    raw_bytes = audio_path.read_bytes()
    if len(raw_bytes) == 0:
        emit({"ok": False, "error": "Input audio file is empty."}, 1)
    if len(raw_bytes) > MAX_AUDIO_BYTES:
        emit({"ok": False, "error": f"Input audio exceeds {MAX_AUDIO_BYTES} byte inline limit."}, 1)

    mime_type = normalize_mime(args.mime_type, audio_path)
    audio_b64 = base64.b64encode(raw_bytes).decode("ascii")

    body: dict[str, Any] = {
        "model": TRANSCRIBE_MODEL,
        "input": [
            {
                "type": "audio",
                "data": audio_b64,
                "mime_type": mime_type,
            }
        ],
        "generation_config": {
            "transcription_config": {
                "mode": "smart",
            }
        },
    }

    try:
        try:
            response = post_interaction(args.api_base, body, timeout_sec=args.timeout)
        except RuntimeError as first_err:
            # Defensive fallback if an endpoint revision expects object form `{"type": "smart"}`.
            if "HTTP 400" in str(first_err) and "mode" in str(first_err):
                body["generation_config"] = {"transcription_config": {"mode": {"type": "smart"}}}
                response = post_interaction(args.api_base, body, timeout_sec=args.timeout)
            else:
                raise
    except RuntimeError as exc:
        emit({"ok": False, "model": TRANSCRIBE_MODEL, "error": str(exc)}, 1)

    transcript = extract_transcript(response)
    result = {
        "ok": True,
        "model": TRANSCRIBE_MODEL,
        "mode": "smart",
        "mime_type": mime_type,
        "transcript": transcript,
    }

    if args.output_json:
        out_json = resolve_sandbox_path(args.output_json)
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(result, indent=2), encoding="utf-8")

    emit(result, 0)


def cmd_speak(args: argparse.Namespace) -> None:
    if args.text_file:
        text_path = resolve_sandbox_path(args.text_file)
        if not text_path.is_file():
            emit({"ok": False, "error": f"Summary text file does not exist: {text_path}"}, 1)
        summary = text_path.read_text(encoding="utf-8").strip()
    else:
        summary = (args.text or "").strip()

    if not summary:
        emit({"ok": False, "error": "Spoken summary text must not be empty."}, 2)
    if len(summary) > MAX_SUMMARY_CHARS:
        summary = summary[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"

    voice = args.voice.strip() if args.voice else "Kore"
    if voice not in ALLOWED_VOICES:
        voice = "Kore"

    out_wav = resolve_sandbox_path(args.output)
    out_wav.parent.mkdir(parents=True, exist_ok=True)

    style = (args.style or "warm, clear, concise engineering summary").strip()[:200]
    body: dict[str, Any] = {
        "model": TTS_MODEL,
        "input": [
            {
                "type": "user_input",
                "content": [
                    {
                        "type": "text",
                        "text": summary,
                        "annotations": [
                            {
                                "type": "speech_metadata",
                                "style": style,
                            }
                        ],
                    }
                ],
            }
        ],
        "response_format": {
            "type": "audio",
        },
        "generation_config": {
            "speech_config": [
                {
                    "voice": voice,
                }
            ]
        },
    }

    try:
        response = post_interaction(args.api_base, body, timeout_sec=args.timeout)
    except RuntimeError as exc:
        emit({"ok": False, "model": TTS_MODEL, "error": str(exc)}, 1)

    raw_audio = extract_audio_bytes(response)
    if not raw_audio:
        emit({"ok": False, "model": TTS_MODEL, "error": "No audio data returned by Interactions API."}, 1)

    wav_bytes = ensure_riff_wav(raw_audio)
    out_wav.write_bytes(wav_bytes)

    meta = {
        "ok": True,
        "model": TTS_MODEL,
        "voice": voice,
        "summary": summary,
        "output": str(out_wav),
        "bytes": len(wav_bytes),
    }

    if args.meta_json:
        meta_path = resolve_sandbox_path(args.meta_json)
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    emit(meta, 0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Gemini 3.5 Smart Transcribe & Gemini 3.8 Flash-Lite TTS helper")
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_trans = sub.add_parser("transcribe", help="Transcribe an audio file in /workspace with gemini-3.5-transcribe (smart mode)")
    p_trans.add_argument("--input", required=True, help="Input audio path inside /workspace")
    p_trans.add_argument("--mime-type", default="", help="Optional audio MIME type (e.g. audio/webm, audio/wav)")
    p_trans.add_argument("--output-json", default="", help="Optional JSON path inside /workspace to persist transcript")
    p_trans.add_argument("--api-base", default=DEFAULT_API_BASE, help="Gemini v1beta base URL")
    p_trans.add_argument("--timeout", type=int, default=90, help="HTTP timeout in seconds")
    p_trans.set_defaults(func=cmd_transcribe)

    p_speak = sub.add_parser("speak", help="Synthesize a spoken summary WAV with gemini-3.8-flash-lite-tts")
    group = p_speak.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", help="Spoken summary prose")
    group.add_argument("--text-file", help="Path to text file inside /workspace")
    p_speak.add_argument("--output", required=True, help="Destination .wav path inside /workspace")
    p_speak.add_argument("--meta-json", default="", help="Optional JSON path inside /workspace to persist summary metadata")
    p_speak.add_argument("--voice", default="Kore", help="Prebuilt voice name (Kore, Puck, Aoede, Charon, Fenrir)")
    p_speak.add_argument("--style", default="warm, clear, concise engineering summary", help="Speech delivery style")
    p_speak.add_argument("--api-base", default=DEFAULT_API_BASE, help="Gemini v1beta base URL")
    p_speak.add_argument("--timeout", type=int, default=90, help="HTTP timeout in seconds")
    p_speak.set_defaults(func=cmd_speak)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
