/**
 * @module core/media
 * @role Handle voice transcription (Whisper), image analysis (Vision), and speech synthesis (ElevenLabs).
 * @responsibilities
 *   - Transcribe audio buffers via OpenAI Whisper API
 *   - Describe images via OpenAI Vision API
 *   - Generate speech from text via ElevenLabs API
 *   - Manage temp files for audio processing
 * @dependencies shared/config
 * @effects Network calls to OpenAI API and ElevenLabs API, temp file I/O in .tinyclaw/voice_temp/
 * @contract transcribeAudio(base64, filename) => Promise<string>
 * @contract describeImage(base64, caption?) => Promise<string>
 * @contract generateSpeech(text, voice?) => Promise<string>
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

let openai: OpenAI | null = null;
let elevenlabs: ElevenLabsClient | null = null;

function getClient(): OpenAI {
  if (!openai) {
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
}

function getElevenLabsClient(): ElevenLabsClient {
  if (!elevenlabs) {
    if (!config.elevenlabsApiKey) {
      throw new Error("ELEVENLABS_API_KEY not configured");
    }
    elevenlabs = new ElevenLabsClient({ apiKey: config.elevenlabsApiKey });
  }
  return elevenlabs;
}

export async function transcribeAudio(base64: string, filename: string): Promise<string> {
  const client = getClient();

  if (!existsSync(config.voiceTempDir)) {
    mkdirSync(config.voiceTempDir, { recursive: true });
  }

  const tempPath = join(config.voiceTempDir, filename);
  const buffer = Buffer.from(base64, "base64");
  writeFileSync(tempPath, buffer);

  try {
    const file = Bun.file(tempPath);
    const transcription = await client.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
    });
    log.info(`Transcribed audio: "${transcription.text.substring(0, 80)}..."`);
    return transcription.text;
  } finally {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

export async function describeImage(base64: string, caption?: string): Promise<string> {
  const client = getClient();

  const prompt = caption
    ? `The user sent this image with the text: "${caption}". Describe in detail what you see and respond considering the attached text.`
    : "Describe in detail what you see in this image.";

  const response = await client.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
    response_format: { type: "text" },
    verbosity: "low",
    reasoning_effort: "none",
    store: false,
  });

  const description = response.choices[0]?.message?.content || "";
  log.info(`Image described (gpt-5.2): "${description.substring(0, 80)}..."`);
  return description;
}

export async function generateSpeech(text: string, voiceId: string = config.elevenlabsVoiceId): Promise<string> {
  const client = getElevenLabsClient();

  if (!existsSync(config.voiceTempDir)) {
    mkdirSync(config.voiceTempDir, { recursive: true });
  }

  const outputPath = join(config.voiceTempDir, `speech_${Date.now()}.mp3`);

  try {
    const audio = await client.textToSpeech.convert(voiceId, {
      text,
      model_id: "eleven_turbo_v2_5",
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    writeFileSync(outputPath, buffer);

    log.info(`Generated speech: ${text.substring(0, 80)}... (voice: ${voiceId})`);
    return outputPath;
  } catch (error) {
    // Invalidate cached client on auth errors so a new key takes effect without restart
    const errStr = String(error);
    if (errStr.includes("401") || errStr.includes("403") || errStr.includes("Unauthorized")) {
      elevenlabs = null;
      log.warn("ElevenLabs client invalidated due to auth error — update ELEVENLABS_API_KEY in .env");
    }
    log.error(`Failed to generate speech: ${error}`);
    throw error;
  }
}

export function isMediaConfigured(): boolean {
  return !!config.openaiApiKey;
}

export function isSpeechConfigured(): boolean {
  return !!config.elevenlabsApiKey;
}
