/**
 * @module core/media
 * @role Handle voice transcription (Whisper) and image analysis (Vision).
 * @responsibilities
 *   - Transcribe audio buffers via OpenAI Whisper API
 *   - Describe images via OpenAI Vision API
 *   - Manage temp files for audio processing
 * @dependencies shared/config
 * @effects Network calls to OpenAI API, temp file I/O in .tinyclaw/voice_temp/
 * @contract transcribeAudio(base64, filename) => Promise<string>
 * @contract describeImage(base64, caption?) => Promise<string>
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

let openai: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openai) {
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
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

export function isMediaConfigured(): boolean {
  return !!config.openaiApiKey;
}
