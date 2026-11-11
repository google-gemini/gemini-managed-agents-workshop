# Gemini Interactions API — Smart Transcribe & Speech Generation Reference

Reference code patterns for `gemini-3.5-transcribe` (Smart Mode) and `gemini-3.8-flash-lite-tts` using `@google/genai` (TypeScript), `google-genai` (Python), and REST (`POST /v1beta/interactions`).

---

## 1. `gemini-3.5-transcribe` with Smart Mode

### TypeScript (`@google/genai`)
```typescript
import { readFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

const audioBase64 = readFileSync("./voice-note.webm").toString("base64");

const interaction = await ai.interactions.create({
  model: "gemini-3.5-transcribe",
  input: [
    {
      type: "audio",
      data: audioBase64,
      mime_type: "audio/webm",
    },
  ],
  generation_config: {
    transcription_config: {
      mode: "smart",
    },
  },
});

console.log(interaction.output_text);
```

### Python (`google-genai`)
```python
from google import genai

client = genai.Client()
audio_file = client.files.upload(file="voice-note.mp3")

interaction = client.interactions.create(
    model="gemini-3.5-transcribe",
    input=[
        {
            "type": "audio",
            "uri": audio_file.uri,
            "mime_type": audio_file.mime_type,
        }
    ],
    generation_config={
        "transcription_config": {
            "mode": "smart",
        }
    },
)

print(interaction.output_text)
```

### REST (`POST /v1beta/interactions`)
```json
{
  "model": "gemini-3.5-transcribe",
  "input": [
    {
      "type": "audio",
      "data": "<BASE64_AUDIO>",
      "mime_type": "audio/webm"
    }
  ],
  "generation_config": {
    "transcription_config": {
      "mode": "smart"
    }
  }
}
```

> **Note**: Use `mode: { "type": "verbatim" }` only when you require exact filler words, `diarization_mode: "speaker"`, or `timestamp_granularities: ["word"]`. Smart Mode automatically strips disfluencies, resolves inline self-corrections, and normalizes numbers/dates/punctuation.

---

## 2. `gemini-3.8-flash-lite-tts` Speech Generation

### Single-Speaker TypeScript (`@google/genai`)
```typescript
import { writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

const interaction = await ai.interactions.create({
  model: "gemini-3.8-flash-lite-tts",
  input: [
    {
      type: "user_input",
      content: [
        {
          type: "text",
          text: "Pull request 42 looks clean. <short pause> All unit tests pass, so I recommend approving.",
          annotations: [
            {
              type: "speech_metadata",
              style: "warm, clear, and concise",
            },
          ],
        },
      ],
    },
  ],
  response_format: {
    type: "audio",
  },
  generation_config: {
    speech_config: [
      {
        voice: "Kore",
      },
    ],
  },
});

if (interaction.output_audio?.data) {
  writeFileSync("summary.wav", Buffer.from(interaction.output_audio.data, "base64"));
}
```

### Multi-Speaker Python (`google-genai`)
```python
import base64
from pathlib import Path
from google import genai

client = genai.Client()

interaction = client.interactions.create(
    model="gemini-3.8-flash-lite-tts",
    input=[
        {
            "type": "user_input",
            "content": [
                {
                    "type": "text",
                    "text": "Did the new auth middleware tests pass in the sandbox?",
                    "annotations": [{"type": "speech_metadata", "speaker": "Author", "style": "curious"}],
                },
                {
                    "type": "text",
                    "text": "Yes, all 24 tests passed with zero regressions.",
                    "annotations": [{"type": "speech_metadata", "speaker": "Reviewer", "style": "confident"}],
                },
            ],
        }
    ],
    response_format={"type": "audio", "mime_type": "audio/wav"},
    generation_config={
        "speech_config": {
            "speakers": [
                {"speaker": "Author", "voice": "Puck"},
                {"speaker": "Reviewer", "voice": "Kore"},
            ]
        }
    },
)

Path("dialogue.wav").write_bytes(base64.b64decode(interaction.output_audio.data))
```

### Prebuilt Voices & Audio Formats
- **Voices**: `Kore`, `Puck`, `Aoede`, `Charon`, `Fenrir` (plus custom `voice_...` IDs from Voice Design / Voice Replication).
- **Default Unary Output**: `audio/wav` with a 44-byte RIFF header (24 kHz, mono, 16-bit signed little-endian PCM).
- **Raw Headerless PCM**: Pass `response_format: { "type": "audio", "mime_type": "audio/l16", "sample_rate": 24000 }` when streaming raw PCM frames.
