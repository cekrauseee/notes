import { segmentDisplayUnits } from './markdown.js'
import type { Locale, TimedUnit } from './types.js'

export const ALIGNMENT_METHOD = 'elevenlabs-character-timestamps' as const
export const OUTPUT_FORMAT = 'mp3_44100_128'

/** Use original-text alignment, not normalized_alignment (e.g. expanded numbers).
 * API character entries may occupy multiple JavaScript UTF-16 code units.
 */
export function decodeSpeech(
  value: unknown,
  text: string,
  locale: Locale,
): {
  audio: Buffer
  units: TimedUnit[]
  durationMs: number
} {
  if (!value || typeof value !== 'object') throw new Error('Missing ElevenLabs response.')
  const response = value as Record<string, unknown>
  if (
    typeof response.audio_base64 !== 'string' ||
    !response.audio_base64.length ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(response.audio_base64)
  )
    throw new Error('Missing or invalid ElevenLabs audio.')
  const audio = Buffer.from(response.audio_base64, 'base64')
  if (!audio.length) throw new Error('Empty ElevenLabs audio.')
  const alignment = response.alignment as Record<string, unknown> | null
  if (!alignment || typeof alignment !== 'object')
    throw new Error('ElevenLabs did not return original-text alignment.')
  const characters = alignment.characters
  const starts = alignment.character_start_times_seconds
  const ends = alignment.character_end_times_seconds
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    !characters.length ||
    characters.length !== starts.length ||
    characters.length !== ends.length ||
    characters.some((char) => typeof char !== 'string' || !char.length) ||
    characters.join('') !== text
  ) {
    throw new Error('ElevenLabs character alignment does not match the original note.')
  }
  const startByChar: number[] = []
  const endByChar: number[] = []
  let lastEnd = 0
  for (let index = 0; index < characters.length; index += 1) {
    const start: unknown = starts[index]
    const end: unknown = ends[index]
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    )
      throw new Error(`Invalid ElevenLabs timestamp at character ${index}.`)
    for (let offset = 0; offset < (characters[index] as string).length; offset += 1) {
      startByChar.push(Math.round(start * 1000))
      endByChar.push(Math.round(end * 1000))
    }
    lastEnd = Math.max(lastEnd, end)
  }
  const units = segmentDisplayUnits(text, locale).map((unit) => ({
    text: unit.text,
    startChar: unit.start,
    endChar: unit.end,
    startMs: startByChar[unit.start]!,
    endMs: endByChar[unit.end - 1]!,
  }))
  if (!units.length || lastEnd <= 0) throw new Error('ElevenLabs returned no timed words.')
  return { audio, units, durationMs: Math.ceil(lastEnd * 1000) }
}
