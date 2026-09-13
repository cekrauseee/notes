import type { Locale } from './types.js'
import { toString } from 'mdast-util-to-string'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Node, Parent, Root } from 'mdast'
import { logger } from './logger.js'

export const SPOKEN_NORMALIZATION_VERSION = 'markdown-text-v2-remark-plain-text'
export const SEGMENTATION_VERSION = 'intl-segmenter-v1'

/**
 * Markdown narration policy:
 * - headings, paragraphs, lists, quotes, emphasis, links, and inline code keep
 *   their textual children; Markdown markers and link destinations are omitted;
 * - fenced/indented code keeps its literal code text;
 * - images contribute alt text and omit their URL;
 * - raw HTML is rejected because its visual/plain-text behavior depends on the
 *   renderer and cannot be aligned safely from Markdown alone.
 *
 * This is a plain-text projection of the Markdown AST, not a regex cleanup.
 * The source Markdown remains the display authority and is hashed separately.
 */
function children(node: Parent): string {
  return node.children.map((child) => renderNode(child)).join('')
}

function blockChildren(node: Parent): string {
  return node.children.map((child) => renderNode(child)).join('\n\n')
}

function renderNode(node: Node): string {
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
    case 'inlineCode':
    case 'code':
      return (node as Node & { value: string }).value
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'link':
    case 'linkReference':
    case 'footnote':
      return children(node as Parent)
    case 'image':
    case 'imageReference':
      return (node as Node & { alt?: string | null }).alt ?? ''
    case 'break':
      return '\n'
    case 'thematicBreak':
    case 'definition':
      return ''
    case 'html':
      throw new Error(
        'Markdown narration does not support raw HTML; replace it with Markdown text so rendered text and audio stay aligned.',
      )
    default:
      return toString(node)
  }
}

export function normalizeForSpeech(markdown: string, locale: Locale): string {
  const tree = unified().use(remarkParse).parse(markdown) as Root
  const text = renderNode(tree)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  if (text.length === 0) {
    throw new Error('Markdown has no narratable plain text.')
  }
  logger.debug(
    { inputChars: markdown.length, locale, outputChars: text.length },
    'Markdown normalized for speech',
  )
  return text
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
