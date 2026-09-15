import { segmentDisplayUnits } from './markdown.js'
import type { Locale, TimedUnit } from './types.js'

export const ALIGNMENT_METHOD = 'elevenlabs-character-timestamps' as const
export const OUTPUT_FORMAT = 'mp3_44100_128'

function identityMap(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

/** Use original-text alignment, ignoring normalized_alignment.
 * Audio tags may be present in the input but are not part of spokenText.
 */
export function decodeSpeech(
  value: unknown,
  speechText: string,
  spokenText: string,
  locale: Locale,
  spokenToSpeech: readonly number[] = identityMap(spokenText.length),
): {
  audio: Buffer
  units: TimedUnit[]
  durationMs: number
} {
  if (!value || typeof value !== 'object') throw new Error('Missing ElevenLabs response.')
  if (!speechText.length || !spokenText.length) throw new Error('Missing ElevenLabs source text.')
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
    characters.some((char) => typeof char !== 'string' || !char.length)
  ) {
    throw new Error('ElevenLabs returned invalid character alignment.')
  }

  const alignedText = characters.join('')
  let sourceIndices: readonly number[]
  if (alignedText === spokenText) {
    sourceIndices = identityMap(spokenText.length)
  } else if (alignedText === speechText) {
    if (spokenToSpeech.length !== spokenText.length) {
      throw new Error('ElevenLabs audio tag alignment map does not match spoken text.')
    }
    let previous = -1
    for (const [spokenIndex, sourceIndex] of spokenToSpeech.entries()) {
      if (
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= speechText.length ||
        sourceIndex <= previous ||
        speechText[sourceIndex] !== spokenText[spokenIndex]
      ) {
        throw new Error('ElevenLabs audio tag alignment map does not match spoken text.')
      }
      previous = sourceIndex
    }
    sourceIndices = spokenToSpeech
  } else {
    throw new Error('ElevenLabs character alignment does not match the note text.')
  }

  const startByChar: number[] = []
  const endByChar: number[] = []
  const usedSourceIndices = new Set(sourceIndices)
  let alignedOffset = 0
  let lastEnd = 0
  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index] as string
    const usesSpokenText = Array.from({ length: char.length }, (_, offset) =>
      usedSourceIndices.has(alignedOffset + offset),
    ).some(Boolean)
    const start: unknown = starts[index]
    const end: unknown = ends[index]
    if (
      usesSpokenText &&
      (typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start)
    ) {
      throw new Error('Invalid ElevenLabs timestamp at character ' + index + '.')
    }
    for (let offset = 0; offset < char.length; offset += 1) {
      startByChar.push(usesSpokenText && typeof start === 'number' ? Math.round(start * 1000) : 0)
      endByChar.push(usesSpokenText && typeof end === 'number' ? Math.round(end * 1000) : 0)
    }
    if (usesSpokenText && typeof end === 'number') lastEnd = Math.max(lastEnd, end)
    alignedOffset += char.length
  }

  const startBySpokenChar = sourceIndices.map((sourceIndex) => startByChar[sourceIndex])
  const endBySpokenChar = sourceIndices.map((sourceIndex) => endByChar[sourceIndex])
  if (
    startBySpokenChar.some((value) => value === undefined) ||
    endBySpokenChar.some((value) => value === undefined)
  ) {
    throw new Error('ElevenLabs character alignment omitted spoken text timing.')
  }
  const units = segmentDisplayUnits(spokenText, locale).map((unit) => ({
    text: unit.text,
    startChar: unit.start,
    endChar: unit.end,
    startMs: startBySpokenChar[unit.start]!,
    endMs: endBySpokenChar[unit.end - 1]!,
  }))
  if (!units.length || lastEnd <= 0) throw new Error('ElevenLabs returned no timed words.')
  return { audio, units, durationMs: Math.ceil(lastEnd * 1000) }
}
