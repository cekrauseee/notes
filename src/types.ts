export const LOCALES = ['en', 'pt', 'ja'] as const
export type Locale = (typeof LOCALES)[number]

export const NOTE_STATUSES = ['draft', 'published'] as const
export type NoteStatus = (typeof NOTE_STATUSES)[number]

export interface NoteLocale {
  locale: Locale
  sourcePath: string
  rawMarkdown: string
  markdownBody: string
  spokenText: string
  title: string
  summary: string
  markdownSha256: string
  spokenTextSha256: string
}

export interface Note {
  id: string
  status: NoteStatus
  date: string
  publishedAt: string | null
  locales: Record<Locale, NoteLocale>
}

export interface TimedUnit {
  text: string
  startMs: number
  endMs: number
  startChar: number
  endChar: number
}

export interface AlignmentChunk {
  index: number
  sourceStart: number
  sourceEnd: number
  text: string
  audioOffsetMs: number
  durationMs: number
  transcript: string
}

export interface AlignmentArtifact {
  schemaVersion: 1
  offsetConvention: 'utf-16-code-units'
  alignmentMethod: 'elevenlabs-character-timestamps'
  noteId: string
  locale: Locale
  spokenText: string
  durationMs: number
  units: TimedUnit[]
  chunks: AlignmentChunk[]
}

export interface LocaleManifestEntry {
  markdownSha256: string
  spokenTextSha256: string
  generationConfigHash: string
  markdownPath: string
  title: string
  summary: string
  audioUrl: string
  alignmentUrl: string
  durationMs: number
}

export interface NoteManifestEntry {
  id: string
  slug: string
  status: 'published'
  date: string
  publishedAt: string
  locales: Record<Locale, LocaleManifestEntry>
}

export interface Manifest {
  schemaVersion: 1
  generatedAt: string
  notes: NoteManifestEntry[]
}
