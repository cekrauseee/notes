import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { sha256 } from './hash.js'
import { normalizeForSpeechProjection } from './markdown.js'
import { LOCALES, NOTE_STATUSES, type Locale, type Note, type NoteStatus } from './types.js'
import { logger } from './logger.js'

const FILES: Record<Locale, string> = {
  en: 'note.md',
  pt: 'note.pt.md',
  ja: 'note.ja.md',
}
const REQUIRED_KEYS = ['date', 'id', 'locale', 'publishedAt', 'status', 'summary', 'title']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} has an invalid ${field}.`)
  }
  return value.trim()
}

function ensureStatus(value: unknown, context: string): NoteStatus {
  if (typeof value !== 'string' || !NOTE_STATUSES.includes(value as NoteStatus)) {
    throw new Error(`${context} has an invalid status.`)
  }
  return value as NoteStatus
}

function ensureDate(value: unknown, context: string): string {
  const date =
    value instanceof Date ? value.toISOString().slice(0, 10) : ensureString(value, 'date', context)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${context} has an invalid date.`)
  }
  return date
}

function ensurePublishedAt(value: unknown, status: NoteStatus, context: string): string | null {
  if (status === 'draft') {
    if (value !== null)
      throw new Error(`${context} must have publishedAt: null while it is a draft.`)
    return null
  }
  if (value === null) throw new Error(`${context} must have publishedAt when published.`)
  const publishedAt =
    value instanceof Date ? value.toISOString() : ensureString(value, 'publishedAt', context)
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error(`${context} has an invalid publishedAt.`)
  }
  return publishedAt
}

function ensureId(value: unknown, context: string): string {
  const id = ensureString(value, 'id', context)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new Error(`${context} has an invalid stable id.`)
  }
  return id
}

function assertFrontMatterKeys(data: Record<string, unknown>, context: string): void {
  const actual = Object.keys(data).sort()
  const expected = [...REQUIRED_KEYS].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} must have exactly: ${REQUIRED_KEYS.join(', ')}.`)
  }
}

function parseLocaleFile(source: string, locale: Locale, sourcePath: string) {
  const context = `${sourcePath} (${locale})`
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(source)
  } catch (error) {
    throw new Error(`${context} has invalid front matter.`, { cause: error })
  }
  if (!isRecord(parsed.data)) throw new Error(`${context} has invalid front matter.`)
  assertFrontMatterKeys(parsed.data, context)
  const id = ensureId(parsed.data.id, context)
  const status = ensureStatus(parsed.data.status, context)
  const date = ensureDate(parsed.data.date, context)
  const publishedAt = ensurePublishedAt(parsed.data.publishedAt, status, context)
  const title = ensureString(parsed.data.title, 'title', context)
  const summary = ensureString(parsed.data.summary, 'summary', context)
  if (parsed.data.locale !== locale)
    throw new Error(`${context} has a locale that does not match its filename.`)
  const markdownBody = parsed.content.trim()
  if (markdownBody.length === 0) throw new Error(`${context} has empty markdown content.`)
  return { id, status, date, publishedAt, title, summary, markdownBody }
}

export async function readNotes(rootDirectory: string): Promise<Note[]> {
  const notesDirectory = path.join(rootDirectory, 'content', 'notes')
  logger.debug({ notesDirectory, rootDirectory }, 'Reading note sources')
  const entries = await readdir(notesDirectory, { withFileTypes: true })
  const noteDirectories = entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  logger.debug({ noteDirectoryCount: noteDirectories.length }, 'Note source directories discovered')
  const notes: Note[] = []
  for (const entry of noteDirectories) {
    logger.debug({ noteId: entry.name }, 'Reading note translations')
    const localeData = {} as Record<
      Locale,
      ReturnType<typeof parseLocaleFile> & {
        locale: Locale
        sourcePath: string
        rawMarkdown: string
      }
    >
    for (const locale of LOCALES) {
      const sourcePath = path.join(notesDirectory, entry.name, FILES[locale])
      let rawMarkdown: string
      try {
        rawMarkdown = await readFile(sourcePath, 'utf8')
      } catch (error) {
        throw new Error(`Note ${entry.name} is missing ${FILES[locale]}.`, { cause: error })
      }
      localeData[locale] = {
        ...parseLocaleFile(rawMarkdown, locale, sourcePath),
        locale,
        sourcePath,
        rawMarkdown,
      }
    }
    const english = localeData.en
    if (english.id !== entry.name)
      throw new Error(`Note directory ${entry.name} must match its stable id ${english.id}.`)
    for (const locale of LOCALES) {
      const current = localeData[locale]
      if (
        current.id !== english.id ||
        current.status !== english.status ||
        current.date !== english.date ||
        current.publishedAt !== english.publishedAt
      ) {
        throw new Error(
          `Note ${english.id} has inconsistent identity or publication metadata in ${locale}.`,
        )
      }
    }
    notes.push({
      id: english.id,
      status: english.status,
      date: english.date,
      publishedAt: english.publishedAt,
      locales: Object.fromEntries(
        LOCALES.map((locale) => {
          const current = localeData[locale]
          const spokenText = normalizeForSpeechProjection(current.markdownBody, locale).spokenText
          logger.debug(
            {
              locale,
              markdownChars: current.markdownBody.length,
              noteId: english.id,
              sourcePath: current.sourcePath,
              spokenChars: spokenText.length,
            },
            'Note translation normalized',
          )
          return [
            locale,
            {
              locale,
              sourcePath: current.sourcePath,
              rawMarkdown: current.rawMarkdown,
              markdownBody: current.markdownBody,
              spokenText,
              title: current.title,
              summary: current.summary,
              markdownSha256: sha256(current.rawMarkdown),
              spokenTextSha256: sha256(spokenText),
            },
          ]
        }),
      ) as Note['locales'],
    })
    logger.info({ noteId: english.id, status: english.status }, 'Note source loaded')
  }
  logger.info(
    {
      noteCount: notes.length,
      publishedCount: notes.filter((note) => note.status === 'published').length,
    },
    'Note sources loaded',
  )
  return notes
}
