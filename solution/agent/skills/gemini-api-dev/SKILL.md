---
name: gemini-api-dev
description: Build and execute Gemini API workflows using the Interactions API (POST /v1beta/interactions), @google/genai (TypeScript), and google-genai (Python), including Gemini 3.5 Smart Audio Transcription (gemini-3.5-transcribe with mode "smart") and Gemini 3.8 Text-to-Speech generation (gemini-3.8-flash-lite-tts and gemini-3.8-flash-tts).
---

# Gemini API Developer Skill (`gemini-api-dev`)

> [!IMPORTANT]
> 1. Always use the **Interactions API** (`client.interactions.create` / `POST /v1beta/interactions`) and current SDKs (`@google/genai` for TypeScript/Bun, `google-genai` for Python).
> 2. Never use deprecated `@google/generative-ai`, `google-generativeai`, legacy `models.generateContent`, or retired `gemini-1.5-*` / `gemini-2.0-*` / `gemini-2.5-*` models.
> 3. In `@google/genai`, pass `apiVersion: "v1beta"` when instantiating `new GoogleGenAI({ apiKey, apiVersion: "v1beta" })`.

## Current Recommended Models

| Capability | Model ID | Notes |
| --- | --- | --- |
| Fast coding, reasoning & multimodal | `gemini-3.8-flash` | Default workhorse for agentic tool use and multimodal turns |
| Deep multi-step engineering | `gemini-4-argon` | Complex architecture, planning, and deep code reasoning |
| Smart speech-to-text transcription | `gemini-3.5-transcribe` | Supports `mode: "smart"` and `mode: { type: "verbatim" }` |
| Low-latency / high-throughput TTS | `gemini-3.8-flash-lite-tts` | Fast voice notes, conversational read-aloud, and spoken summaries |
| Studio-fidelity expressive TTS | `gemini-3.8-flash-tts` | Long-form narration and rich character acting |

For complete SDK and REST code templates, read `/.agents/skills/gemini-api-dev/references/audio-and-tts.md`.

---

## 1. Smart Audio Transcription (`gemini-3.5-transcribe`)

`gemini-3.5-transcribe` provides a dedicated **Smart Mode** (`transcription_config: { mode: "smart" }`) that removes conversational disfluencies (*"um"*, *"uh"*), resolves inline spoken self-corrections (*"review PR 12—no, PR 14"* -> *"review PR 14"*), and applies clean punctuation and formatting.

- **Constraint**: `mode: "smart"` cannot be combined in the same call with `timestamp_granularities` or `diarization_mode` (which require `mode: { type: "verbatim", ... }`).
- **Inputs**: Inline base64 audio (`{ type: "audio", data: "<base64>", mime_type: "audio/webm" }`, up to ~20 MB) or an uploaded Files API URI (`{ type: "audio", uri, mime_type }`).
- **Output**: Read `interaction.output_text` (Python / REST) or `interaction.outputText` (TypeScript), falling back to `steps[].content[].text`.

---

## 2. Speech Generation (`gemini-3.8-flash-lite-tts`)

`gemini-3.8-flash-lite-tts` synthesizes natural speech via `POST /v1beta/interactions` and returns complete RIFF WAV audio (`audio/wav`, 24 kHz, 16-bit mono PCM) on unary requests:

- Pass `response_format: { type: "audio" }`.
- Configure single-speaker output with `generation_config: { speech_config: [{ voice: "Kore" }] }` (prebuilt voices include `Kore`, `Puck`, `Aoede`, `Charon`, and `Fenrir`).
- Guide delivery tone using `annotations: [{ type: "speech_metadata", style: "warm, concise engineering summary" }]` on the input text block and optional inline pacing tags such as `<short pause>`.
- Decode base64 WAV bytes from `interaction.output_audio.data` (or `steps[].content[].data`).

---

## 3. Running Voice Notes Inside the Managed Agent Sandbox

Inside this Managed Agent sandbox (`antigravity-preview-09-2026`), outbound HTTPS traffic to `generativelanguage.googleapis.com` is authenticated transparently on the wire by the **Gemini Credential Vault egress proxy** (`x-goog-api-key` is injected outside the VM; zero API keys exist in `os.environ` or `/proc`).

Use the pre-mounted zero-dependency helper CLI `/.agents/skills/gemini-api-dev/scripts/voice_notes.py`:

### Transcribe a Staged Voice Note (Smart Mode)
```bash
python3 /.agents/skills/gemini-api-dev/scripts/voice_notes.py transcribe \
  --input /workspace/voice/in-<turn_id>.webm \
  --mime-type audio/webm \
  --output-json /workspace/voice/transcript-<turn_id>.json
```
Prints JSON containing `ok`, `model` (`"gemini-3.5-transcribe"`), `mode` (`"smart"`), and `transcript`, and writes the same object to `--output-json`.

### Generate a Spoken Voice Summary (`gemini-3.8-flash-lite-tts`)
```bash
python3 /.agents/skills/gemini-api-dev/scripts/voice_notes.py speak \
  --text "Here is the summary of PR 42: all 18 unit tests pass in the sandbox, and the change is ready to approve." \
  --voice Kore \
  --style "warm, clear, concise engineering briefing" \
  --output /workspace/voice/out-<turn_id>.wav \
  --meta-json /workspace/voice/out-<turn_id>.json
```
Writes a RIFF WAV file to `--output` and metadata (`summary`, `voice`, `model`, `bytes`) to `--meta-json`.

### Guidelines for Spoken Summaries
- Keep spoken summaries to **2–4 natural sentences (~40–90 words)** summarizing the core finding, risks, and verdict of your full written response.
- Write plain conversational prose suitable for speech synthesis: avoid markdown headings, code blocks, backticks, file hashes, or raw URLs in the `--text` argument passed to `speak`.
