import { BlobNotFoundError, head, put } from '@vercel/blob'
import type { BlobUploader, SpeechProvider } from './generate.js'
import { OUTPUT_FORMAT } from './alignment.js'
import { logger } from './logger.js'

/** One HTTP request supplies both MP3 and character timestamps. No SDK/retries. */
export function createElevenLabsProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SpeechProvider {
  return {
    async generateSpeech({ text, locale, model, voiceId, voiceSettings }) {
      if (!apiKey.trim()) throw new Error('ELEVENLABS_API_KEY is required for new narration.')
      if (!voiceId) throw new Error(`Set ELEVENLABS_VOICE_ID_${locale.toUpperCase()}.`)
      const response = await fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: model,
            voice_settings: voiceSettings,
            ...(model === 'eleven_multilingual_v2' ? {} : { language_code: locale }),
          }),
          signal: AbortSignal.timeout(300_000),
        },
      )
      if (!response.ok)
        throw new Error(
          `ElevenLabs returned HTTP ${response.status} for ${locale}. Check API key, voice access and available credits.`,
        )
      return response.json()
    },
  }
}

type BlobApi = {
  head: typeof head
  put: typeof put
}

export function createVercelBlobUploader(
  token: string,
  api: BlobApi = { head, put },
): BlobUploader {
  if (!token.trim()) throw new Error('BLOB_READ_WRITE_TOKEN is required for Blob upload.')
  const find = async (input: { pathname: string }): Promise<{ url: string } | null> => {
    logger.debug({ pathname: input.pathname }, 'Looking up Blob asset')
    try {
      const existing = await api.head(input.pathname, { token })
      logger.debug({ pathname: input.pathname, url: existing.url }, 'Blob asset found')
      return { url: existing.url }
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        logger.debug({ pathname: input.pathname }, 'Blob asset not found')
        return null
      }
      throw error
    }
  }
  return {
    find,
    async upload(input) {
      const startedAt = Date.now()
      logger.info(
        {
          bytes: input.body.length,
          contentType: input.contentType,
          pathname: input.pathname,
        },
        'Publishing Blob asset',
      )
      const existing = await find(input)
      if (existing) {
        logger.info(
          {
            elapsedMs: Date.now() - startedAt,
            pathname: input.pathname,
            url: existing.url,
          },
          'Blob asset already exists',
        )
        return existing
      }
      const blob = await api.put(input.pathname, input.body, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: input.contentType,
        token,
      })
      logger.info(
        {
          elapsedMs: Date.now() - startedAt,
          pathname: input.pathname,
          url: blob.url,
        },
        'Blob asset published',
      )
      return { url: blob.url }
    },
  }
}
