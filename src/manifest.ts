import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson } from './hash.js'
import {
  LOCALES,
  type AlignmentArtifact,
  type Manifest,
  type NoteManifestEntry,
  type LocaleManifestEntry,
} from './types.js'
import { logger } from './logger.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`Manifest field ${field} must be a non-empty string.`)
  return value
}

function validateLocaleEntry(value: unknown, context: string): LocaleManifestEntry {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`)
  const durationMs = value.durationMs
  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0)
    throw new Error(`${context}.durationMs must be a positive integer.`)
  for (const field of [
    'markdownSha256',
    'spokenTextSha256',
    'generationConfigHash',
    'markdownPath',
    'title',
    'summary',
    'audioUrl',
    'alignmentUrl',
  ]) {
    requireString(value[field], `${context}.${field}`)
  }
  if (
    !String(value.audioUrl).startsWith('https://') ||
    !String(value.alignmentUrl).startsWith('https://')
  )
    throw new Error(`${context} asset URLs must use https.`)
  return {
    markdownSha256: String(value.markdownSha256),
    spokenTextSha256: String(value.spokenTextSha256),
    generationConfigHash: String(value.generationConfigHash),
    markdownPath: String(value.markdownPath),
    title: String(value.title),
    summary: String(value.summary),
    audioUrl: String(value.audioUrl),
    alignmentUrl: String(value.alignmentUrl),
    durationMs,
  }
}

function validateEntry(value: unknown, index: number): NoteManifestEntry {
  const context = `Manifest note ${index}`
  if (!isRecord(value)) throw new Error(`${context} must be an object.`)
  const id = requireString(value.id, `${context}.id`)
  const slug = requireString(value.slug, `${context}.slug`)
  const date = requireString(value.date, `${context}.date`)
  const publishedAt = requireString(value.publishedAt, `${context}.publishedAt`)
  if (value.status !== 'published')
    throw new Error(`${context} must be published; drafts are excluded.`)
  if (!isRecord(value.locales)) throw new Error(`${context}.locales must be an object.`)
  const locales = {} as NoteManifestEntry['locales']
  for (const locale of LOCALES) {
    locales[locale] = validateLocaleEntry(value.locales[locale], `${context}.locales.${locale}`)
  }
  return { id, slug, status: 'published', date, publishedAt, locales }
}

export function validateManifest(value: unknown): Manifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.notes) ||
    typeof value.generatedAt !== 'string'
  ) {
    throw new Error('Manifest must have schemaVersion 1, generatedAt, and notes.')
  }
  const notes = value.notes.map((entry, index) => validateEntry(entry, index))
  const ids = new Set<string>()
  for (const note of notes) {
    if (ids.has(note.id)) throw new Error(`Manifest contains duplicate note id ${note.id}.`)
    ids.add(note.id)
  }
  return { schemaVersion: 1, generatedAt: value.generatedAt, notes }
}

export function emptyManifest(now = new Date().toISOString()): Manifest {
  return { schemaVersion: 1, generatedAt: now, notes: [] }
}

export async function loadManifest(filePath: string): Promise<Manifest> {
  logger.debug({ filePath }, 'Loading note manifest')
  try {
    await access(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.info({ filePath }, 'No note manifest found; starting from an empty catalog')
    } else {
      logger.warn(
        { err: error, filePath },
        'Note manifest is inaccessible; starting from an empty catalog',
      )
    }
    return emptyManifest()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to parse manifest ${filePath}.`, { cause: error })
  }
  const manifest = validateManifest(parsed)
  logger.info({ filePath, noteCount: manifest.notes.length }, 'Note manifest loaded')
  return manifest
}

export async function writeManifestAtomic(filePath: string, manifest: Manifest): Promise<void> {
  logger.info({ filePath, noteCount: manifest.notes.length }, 'Writing note manifest')
  validateManifest(manifest)
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
  logger.info({ filePath }, 'Note manifest written')
}

export function manifestContentEquals(left: Manifest, right: Manifest): boolean {
  return (
    canonicalJson({ schemaVersion: left.schemaVersion, notes: left.notes }) ===
    canonicalJson({ schemaVersion: right.schemaVersion, notes: right.notes })
  )
}

export function validateAlignmentArtifact(value: unknown): AlignmentArtifact {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.offsetConvention !== 'utf-16-code-units' ||
    value.alignmentMethod !== 'elevenlabs-character-timestamps'
  ) {
    throw new Error('Alignment artifact has an unsupported schema, offset convention, or method.')
  }
  if (
    typeof value.noteId !== 'string' ||
    typeof value.locale !== 'string' ||
    typeof value.spokenText !== 'string' ||
    typeof value.durationMs !== 'number' ||
    value.durationMs <= 0 ||
    !Array.isArray(value.units) ||
    !Array.isArray(value.chunks)
  ) {
    throw new Error('Alignment artifact is missing required fields.')
  }
  let previousEnd = 0
  let previousStart = 0
  let previousEndChar = 0
  for (const [index, unit] of value.units.entries()) {
    if (
      !isRecord(unit) ||
      typeof unit.text !== 'string' ||
      typeof unit.startChar !== 'number' ||
      typeof unit.endChar !== 'number' ||
      typeof unit.startMs !== 'number' ||
      typeof unit.endMs !== 'number' ||
      !Number.isInteger(unit.startChar) ||
      !Number.isInteger(unit.endChar) ||
      !Number.isInteger(unit.startMs) ||
      !Number.isInteger(unit.endMs)
    ) {
      throw new Error(`Alignment unit ${index} is invalid.`)
    }
    const { startChar, endChar, startMs, endMs } = unit
    const sharesPreviousSpan = index > 0 && startMs === previousStart && endMs === previousEnd
    if (
      startChar < previousEndChar ||
      endChar <= startChar ||
      endChar > value.spokenText.length ||
      startMs < 0 ||
      endMs <= startMs ||
      endMs > value.durationMs + 50 ||
      (startMs + 1 < previousEnd && !sharesPreviousSpan)
    ) {
      throw new Error(`Alignment unit ${index} is outside source or timing bounds.`)
    }
    if (value.spokenText.slice(startChar, endChar) !== unit.text) {
      throw new Error(`Alignment unit ${index} does not match its UTF-16 source span.`)
    }
    previousStart = startMs
    previousEnd = unit.endMs
    previousEndChar = endChar
  }
  logger.debug(
    {
      durationMs: value.durationMs,
      locale: value.locale,
      noteId: value.noteId,
      unitCount: value.units.length,
    },
    'Alignment artifact validated',
  )
  return value as unknown as AlignmentArtifact
}
