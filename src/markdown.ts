import type { Locale } from './types.js'
import { toString } from 'mdast-util-to-string'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Node, Parent, Root } from 'mdast'
import { logger } from './logger.js'

export const SPOKEN_NORMALIZATION_VERSION = 'markdown-text-v3-audio-tags-v1-remark-plain-text'
export const SEGMENTATION_VERSION = 'intl-segmenter-v1'
export const SPEECH_BLOCKS_VERSION = 'semantic-markdown-blocks-v1'
export const AUDIO_TAGS_VERSION = 'audio-tags-v1'

export const AUDIO_TAGS = [
  'calm, conversational',
  'calm, measured',
  'calm, reflective',
  'thoughtful',
  'hopeful',
  'short pause',
  'reflective',
  'explaining',
  'slight emphasis',
  'slightly faster',
  'measured',
  'warmly',
  'slightly weary',
  'subdued',
  'gently',
  'slightly relieved',
  'gently hopeful',
] as const

const escapeRegex = (value: string) => value.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&')
const AUDIO_TAG_PATTERN = new RegExp(
  `\\[(?:${AUDIO_TAGS.map((tag) => escapeRegex(tag)).join('|')})\\](?:[ \\t])?`,
  'gu',
)

export interface SpeechProjection {
  speechText: string
  spokenText: string
  spokenToSpeech: number[]
}

export interface SpeechBlock {
  index: number
  speechText: string
  spokenText: string
  speechStart: number
  speechEnd: number
  spokenStart: number
  spokenEnd: number
  spokenToSpeech: number[]
}

type IndexedText = {
  text: string
  sourceIndices: number[]
}

type TextProjection = SpeechProjection

/**
 * Markdown narration policy:
 * - headings, paragraphs, lists, quotes, emphasis, links, and inline code keep
 *   their textual children; Markdown markers and link destinations are omitted;
 * - fenced/indented code keeps its literal code text;
 * - images contribute alt text and omit their URL;
 * - recognized audio tags are kept in speechText and removed only from spokenText;
 * - raw HTML is rejected because its visual/plain-text behavior depends on the
 *   renderer and cannot be aligned safely from Markdown alone.
 *
 * The Markdown source remains the only editorial source. spokenText and the
 * offset map are derived projections used transiently for alignment.
 */
function identityProjection(text: string): TextProjection {
  return {
    speechText: text,
    spokenText: text,
    spokenToSpeech: text.split('').map((_, index) => index),
  }
}

function taggedProjection(text: string): TextProjection {
  const removed = new Uint8Array(text.length)
  for (const match of text.matchAll(AUDIO_TAG_PATTERN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    for (let index = start; index < end; index += 1) removed[index] = 1
  }

  const spokenChars: string[] = []
  const spokenToSpeech: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (removed[index]) continue
    spokenChars.push(text[index]!)
    spokenToSpeech.push(index)
  }
  return {
    speechText: text,
    spokenText: spokenChars.join(''),
    spokenToSpeech,
  }
}

function joinProjections(values: TextProjection[], separator = ''): TextProjection {
  let speechText = ''
  let spokenText = ''
  const spokenToSpeech: number[] = []
  values.forEach((value, index) => {
    if (index > 0 && separator) {
      const speechOffset = speechText.length
      speechText += separator
      spokenText += separator
      for (let offset = 0; offset < separator.length; offset += 1) {
        spokenToSpeech.push(speechOffset + offset)
      }
    }
    const speechOffset = speechText.length
    speechText += value.speechText
    spokenText += value.spokenText
    for (const sourceIndex of value.spokenToSpeech) {
      spokenToSpeech.push(speechOffset + sourceIndex)
    }
  })
  return { speechText, spokenText, spokenToSpeech }
}

function children(node: Parent): TextProjection {
  return joinProjections(node.children.map((child) => renderNode(child)))
}

function blockChildren(node: Parent): TextProjection {
  return joinProjections(
    node.children.map((child) => renderNode(child)),
    '\n\n',
  )
}

function renderNode(node: Node): TextProjection {
  switch (node.type) {
    case 'root':
      return blockChildren(node as Parent)
    case 'paragraph':
    case 'heading':
      return children(node as Parent)
    case 'blockquote':
    case 'list':
    case 'listItem':
    case 'footnoteDefinition':
      return blockChildren(node as Parent)
    case 'text':
      return taggedProjection((node as Node & { value: string }).value)
    case 'inlineCode':
    case 'code':
      return identityProjection((node as Node & { value: string }).value)
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'link':
    case 'linkReference':
    case 'footnote':
      return children(node as Parent)
    case 'image':
    case 'imageReference':
      return identityProjection((node as Node & { alt?: string | null }).alt ?? '')
    case 'break':
      return identityProjection('\n')
    case 'thematicBreak':
    case 'definition':
      return identityProjection('')
    case 'html':
      throw new Error(
        'Markdown narration does not support raw HTML; replace it with Markdown text so rendered text and audio stay aligned.',
      )
    default:
      return identityProjection(toString(node))
  }
}

function normalizeIndexed(value: IndexedText): IndexedText {
  const chars = value.text.split('')
  const sourceIndices = value.sourceIndices
  const normalizedChars: string[] = []
  const normalizedIndices: number[] = []

  for (let index = 0; index < chars.length; index += 1) {
    let char = chars[index]!
    if (char === '\r') {
      if (chars[index + 1] === '\n') continue
      char = '\n'
    }
    if (
      (char === ' ' || char === '\t') &&
      (chars[index + 1] === '\n' || chars[index + 1] === '\r')
    ) {
      continue
    }
    if (char === '\n' && normalizedChars.at(-1) === '\n' && normalizedChars.at(-2) === '\n') {
      continue
    }
    normalizedChars.push(char)
    normalizedIndices.push(sourceIndices[index]!)
  }

  while (normalizedChars.length > 0 && /\s/u.test(normalizedChars[0]!)) {
    normalizedChars.shift()
    normalizedIndices.shift()
  }
  while (normalizedChars.length > 0 && /\s/u.test(normalizedChars.at(-1)!)) {
    normalizedChars.pop()
    normalizedIndices.pop()
  }
  return { text: normalizedChars.join(''), sourceIndices: normalizedIndices }
}

function normalizeProjection(projection: TextProjection): SpeechProjection {
  const normalizedSpeech = normalizeIndexed({
    text: projection.speechText,
    sourceIndices: projection.speechText.split('').map((_, index) => index),
  })
  const normalizedSpoken = normalizeIndexed({
    text: projection.spokenText,
    sourceIndices: projection.spokenToSpeech,
  })
  const speechIndices = new Map(
    normalizedSpeech.sourceIndices.map((sourceIndex, index) => [sourceIndex, index]),
  )
  const spokenToSpeech = normalizedSpoken.sourceIndices.map((sourceIndex) => {
    const normalizedIndex = speechIndices.get(sourceIndex)
    if (normalizedIndex === undefined) {
      throw new Error('Markdown audio tag projection lost a source character.')
    }
    return normalizedIndex
  })
  return {
    speechText: normalizedSpeech.text,
    spokenText: normalizedSpoken.text,
    spokenToSpeech,
  }
}

function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).parse(markdown) as Root
}

export function normalizeForSpeechProjection(markdown: string, locale: Locale): SpeechProjection {
  const projection = normalizeProjection(renderNode(parseMarkdown(markdown)))
  if (projection.speechText.length === 0 || projection.spokenText.length === 0) {
    throw new Error('Markdown has no narratable plain text.')
  }
  logger.debug(
    {
      inputChars: markdown.length,
      locale,
      spokenChars: projection.spokenText.length,
      speechChars: projection.speechText.length,
    },
    'Markdown normalized for ElevenLabs v3',
  )
  return projection
}

export function normalizeForSpeech(markdown: string, locale: Locale): string {
  return normalizeForSpeechProjection(markdown, locale).speechText
}

export function normalizeForDisplay(markdown: string, locale: Locale): string {
  return normalizeForSpeechProjection(markdown, locale).spokenText
}

export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG_PATTERN, '')
}

type SourceRange = { start: number; end: number }

function codePointLength(value: string): number {
  return Array.from(value).length
}

function hasSpokenCharacters(value: string): boolean {
  return stripAudioTags(value).trim().length > 0
}

function codePointOffset(value: string, start: number, count: number): number {
  let offset = start
  let used = 0
  for (const char of value.slice(start)) {
    if (used >= count) break
    offset += char.length
    used += 1
  }
  return offset
}

function audioTagRanges(text: string): SourceRange[] {
  return Array.from(text.matchAll(AUDIO_TAG_PATTERN)).map((match) => {
    const start = match.index ?? 0
    return { start, end: start + match[0].length }
  })
}

function isInsideAudioTag(index: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => range.start < index && index < range.end)
}

function paragraphRanges(text: string): SourceRange[] {
  const ranges: SourceRange[] = []
  let start = 0
  for (const match of text.matchAll(/\n\n/gu)) {
    const end = (match.index ?? 0) + match[0].length
    ranges.push({ start, end })
    start = end
  }
  if (start < text.length || ranges.length === 0) ranges.push({ start, end: text.length })
  return ranges
}

function segmentEnds(text: string, locale: Locale, granularity: 'sentence' | 'word'): number[] {
  return Array.from(
    new Intl.Segmenter(locale, { granularity }).segment(text),
    (part) => part.index + part.segment.length,
  )
}

function largestSafeCodePointEnd(
  text: string,
  start: number,
  end: number,
  maxCharacters: number,
  protectedRanges: readonly SourceRange[],
): number {
  let candidate = Math.min(end, codePointOffset(text, start, maxCharacters))
  while (candidate > start && isInsideAudioTag(candidate, protectedRanges)) {
    const previous = text.slice(start, candidate)
    candidate = start + Array.from(previous).slice(0, -1).join('').length
  }
  if (candidate > start) return candidate
  const tag = protectedRanges.find((range) => range.start === start)
  if (tag) {
    if (codePointLength(text.slice(tag.start, tag.end)) > maxCharacters) {
      throw new Error('An ElevenLabs audio tag is longer than the configured block limit.')
    }
    return tag.end
  }
  throw new Error('Unable to split Markdown narration without breaking a Unicode character.')
}

function splitOversizedRange(
  text: string,
  range: SourceRange,
  locale: Locale,
  maxCharacters: number,
  protectedRanges: readonly SourceRange[],
): SourceRange[] {
  const result: SourceRange[] = []
  const wordEnds = segmentEnds(text.slice(range.start, range.end), locale, 'word').map(
    (end) => range.start + end,
  )
  let start = range.start
  while (start < range.end) {
    if (codePointLength(text.slice(start, range.end)) <= maxCharacters) {
      result.push({ start, end: range.end })
      break
    }
    const target = codePointOffset(text, start, maxCharacters)
    const semanticEnd = wordEnds
      .filter(
        (end) =>
          end > start &&
          end <= target &&
          !isInsideAudioTag(end, protectedRanges) &&
          hasSpokenCharacters(text.slice(start, end)),
      )
      .at(-1)
    const end =
      semanticEnd ?? largestSafeCodePointEnd(text, start, range.end, maxCharacters, protectedRanges)
    if (end <= start || end > range.end) {
      throw new Error('Unable to split Markdown narration into valid blocks.')
    }
    result.push({ start, end })
    start = end
  }
  return result
}

function semanticSpeechRanges(text: string, locale: Locale, maxCharacters: number): SourceRange[] {
  const protectedRanges = audioTagRanges(text)
  const ranges: SourceRange[] = []
  for (const paragraph of paragraphRanges(text)) {
    if (codePointLength(text.slice(paragraph.start, paragraph.end)) <= maxCharacters) {
      ranges.push(paragraph)
      continue
    }
    const sentenceEnds: number[] = []
    for (const rawEnd of segmentEnds(
      text.slice(paragraph.start, paragraph.end),
      locale,
      'sentence',
    ).map((end) => paragraph.start + end)) {
      const containingTag = protectedRanges.find((tag) => tag.start < rawEnd && rawEnd < tag.end)
      const end = containingTag?.end ?? rawEnd
      if (end > (sentenceEnds.at(-1) ?? paragraph.start) && end <= paragraph.end) {
        sentenceEnds.push(end)
      }
    }
    let sentenceStart = paragraph.start
    for (const sentenceEnd of sentenceEnds) {
      const sentence = { start: sentenceStart, end: sentenceEnd }
      if (codePointLength(text.slice(sentence.start, sentence.end)) <= maxCharacters) {
        ranges.push(sentence)
      } else {
        ranges.push(...splitOversizedRange(text, sentence, locale, maxCharacters, protectedRanges))
      }
      sentenceStart = sentenceEnd
    }
    if (sentenceStart < paragraph.end) {
      const remainder = { start: sentenceStart, end: paragraph.end }
      ranges.push(
        ...(codePointLength(text.slice(remainder.start, remainder.end)) <= maxCharacters
          ? [remainder]
          : splitOversizedRange(text, remainder, locale, maxCharacters, protectedRanges)),
      )
    }
  }

  const grouped: SourceRange[] = []
  for (const range of ranges) {
    const previous = grouped.at(-1)
    if (previous && codePointLength(text.slice(previous.start, range.end)) <= maxCharacters) {
      previous.end = range.end
    } else {
      grouped.push({ ...range })
    }
  }
  return grouped
}

function firstMappedIndex(mapping: readonly number[], start: number): number {
  let low = 0
  let high = mapping.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (mapping[middle]! < start) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Split one normalized Markdown speech projection at paragraph and sentence
 * boundaries. Ranges are contiguous and preserve the original tagged speech
 * text; the clean text and offset maps are transient block projections.
 */
export function segmentSpeechProjection(
  projection: SpeechProjection,
  locale: Locale,
  maxCharacters: number,
): SpeechBlock[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error('Speech block limit must be a positive integer.')
  }
  const ranges = semanticSpeechRanges(projection.speechText, locale, maxCharacters)
  const blocks: SpeechBlock[] = []
  for (const [index, range] of ranges.entries()) {
    const spokenStart = firstMappedIndex(projection.spokenToSpeech, range.start)
    const spokenEnd = firstMappedIndex(projection.spokenToSpeech, range.end)
    blocks.push({
      index,
      speechText: projection.speechText.slice(range.start, range.end),
      spokenText: projection.spokenText.slice(spokenStart, spokenEnd),
      speechStart: range.start,
      speechEnd: range.end,
      spokenStart,
      spokenEnd,
      spokenToSpeech: projection.spokenToSpeech
        .slice(spokenStart, spokenEnd)
        .map((sourceIndex) => sourceIndex - range.start),
    })
  }

  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]!.spokenText.length > 0) continue
    const next = blocks[index + 1]
    if (next && codePointLength(blocks[index]!.speechText + next.speechText) <= maxCharacters) {
      next.speechStart = blocks[index]!.speechStart
      next.spokenStart = blocks[index]!.spokenStart
      next.speechText = blocks[index]!.speechText + next.speechText
      next.spokenText = blocks[index]!.spokenText + next.spokenText
      next.speechEnd = next.speechStart + next.speechText.length
      next.spokenEnd = next.spokenStart + next.spokenText.length
      next.spokenToSpeech = next.spokenToSpeech.map(
        (sourceIndex) => sourceIndex + blocks[index]!.speechText.length,
      )
      blocks.splice(index, 1)
      index -= 1
      continue
    }
    const previous = blocks[index - 1]
    if (
      previous &&
      codePointLength(previous.speechText + blocks[index]!.speechText) <= maxCharacters
    ) {
      previous.speechText += blocks[index]!.speechText
      previous.speechEnd = blocks[index]!.speechEnd
      blocks.splice(index, 1)
      index -= 1
      continue
    }
    throw new Error('Markdown audio tags could not be attached to a narratable speech block.')
  }

  let speechOffset = 0
  let spokenOffset = 0
  for (const [index, block] of blocks.entries()) {
    block.index = index
    if (block.speechStart !== speechOffset || block.spokenStart !== spokenOffset) {
      throw new Error('Speech block segmentation lost source coverage.')
    }
    if (codePointLength(block.speechText) > maxCharacters) {
      throw new Error('Speech block exceeds the configured character limit.')
    }
    speechOffset += block.speechText.length
    spokenOffset += block.spokenText.length
  }
  if (
    speechOffset !== projection.speechText.length ||
    spokenOffset !== projection.spokenText.length
  ) {
    throw new Error('Speech block segmentation did not preserve the complete source text.')
  }
  if (!blocks.length) throw new Error('Markdown has no narratable speech blocks.')
  return blocks
}

function collectAudioTagRanges(node: Node, ranges: SourceRange[]): void {
  if (node.type === 'text') {
    const value = (node as Node & { value: string }).value
    const baseOffset = node.position?.start.offset
    if (baseOffset !== undefined) {
      for (const match of value.matchAll(AUDIO_TAG_PATTERN)) {
        const start = baseOffset + (match.index ?? 0)
        ranges.push({ start, end: start + match[0].length })
      }
    }
  }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) collectAudioTagRanges(child, ranges)
  }
}

export function stripAudioTagsFromMarkdown(markdown: string): string {
  const ranges: SourceRange[] = []
  collectAudioTagRanges(parseMarkdown(markdown), ranges)
  let result = markdown
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + result.slice(range.end)
  }
  return result
}

export function segmentDisplayUnits(
  text: string,
  locale: Locale,
): Array<{ text: string; start: number; end: number }> {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  const units = Array.from(segmenter.segment(text))
    .filter((part) => part.isWordLike)
    .map((part) => ({
      text: part.segment,
      start: part.index,
      end: part.index + part.segment.length,
    }))
  logger.debug(
    { locale, textChars: text.length, unitCount: units.length },
    'Display text segmented into word units',
  )
  return units
}
