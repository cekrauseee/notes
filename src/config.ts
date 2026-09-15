import type { Locale } from './types.js'

export const MODEL_LIMITS = {
  eleven_v3: 5_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_turbo_v2_5: 40_000,
} as const
export type SpeechModel = keyof typeof MODEL_LIMITS
type LegacyVoiceSettings = {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
  speed: number
}
type ElevenV3VoiceSettings = {
  stability: number
}

export interface GenerationConfig {
  model: SpeechModel
  voices: Record<Locale, string>
  voiceSettings: LegacyVoiceSettings | ElevenV3VoiceSettings
  blobPrefix: string
}
export interface EnvironmentConfig extends GenerationConfig {
  elevenLabsApiKey?: string | undefined
  blobToken?: string | undefined
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): EnvironmentConfig {
  const model = env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_v3'
  if (!Object.hasOwn(MODEL_LIMITS, model))
    throw new Error(
      `Unsupported ELEVENLABS_MODEL_ID: ${model}. Use ${Object.keys(MODEL_LIMITS).join(', ')}.`,
    )
  const speed = Number(env.ELEVENLABS_SPEED?.trim() || '0.95')
  if (model !== 'eleven_v3' && (!Number.isFinite(speed) || speed < 0.7 || speed > 1.2))
    throw new Error('ELEVENLABS_SPEED must be between 0.7 and 1.2.')
  return {
    elevenLabsApiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    blobToken: env.BLOB_READ_WRITE_TOKEN?.trim() || undefined,
    model: model as SpeechModel,
    voices: {
      en: env.ELEVENLABS_VOICE_ID_EN?.trim() || '',
      pt: env.ELEVENLABS_VOICE_ID_PT?.trim() || '',
      ja: env.ELEVENLABS_VOICE_ID_JA?.trim() || '',
    },
    voiceSettings:
      model === 'eleven_v3'
        ? { stability: 0.5 }
        : {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: true,
            speed,
          },
    blobPrefix: (env.NOTES_BLOB_PREFIX?.trim() || 'notes').replace(/^\/+|\/+$/gu, ''),
  }
}
