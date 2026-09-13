import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ALIGNMENT_METHOD, OUTPUT_FORMAT, decodeSpeech } from './alignment.js'
import { MODEL_LIMITS, type GenerationConfig } from './config.js'
import { canonicalJson, sha256 } from './hash.js'
import { SEGMENTATION_VERSION, SPOKEN_NORMALIZATION_VERSION } from './markdown.js'
import {
  manifestContentEquals,
  validateAlignmentArtifact,
  writeManifestAtomic,
} from './manifest.js'
import {
  LOCALES,
  type AlignmentArtifact,
  type Locale,
  type LocaleManifestEntry,
  type Manifest,
  type Note,
  type NoteManifestEntry,
} from './types.js'
import { logger } from './logger.js'

export interface SpeechProvider {
  generateSpeech(input: {
    text: string
    locale: Locale
    model: GenerationConfig['model']
    voiceId: string
    voiceSettings: GenerationConfig['voiceSettings']
  }): Promise<unknown>
}
export interface BlobUploader {
  find?(input: { pathname: string }): Promise<{ url: string } | null>
  upload(input: { pathname: string; body: Buffer; contentType: string }): Promise<{ url: string }>
}

export function generationHash(
  locale: Locale,
  config: GenerationConfig,
  note: Note,
  spokenTextSha256: string,
): string {
  return sha256(
    canonicalJson({
      noteId: note.id,
      locale,
      spokenTextSha256,
      model: config.model,
      voice: config.voices[locale],
      voiceSettings: config.voiceSettings,
      outputFormat: OUTPUT_FORMAT,
      alignmentMethod: ALIGNMENT_METHOD,
      normalization: SPOKEN_NORMALIZATION_VERSION,
      segmentation: SEGMENTATION_VERSION,
    }),
  )
}
const markdownPath = (root: string, note: Note, locale: Locale) =>
  path.relative(root, note.locales[locale].sourcePath).split(path.sep).join('/')

export function noteNeedsGeneration(
  note: Note,
  manifest: Manifest,
  config: GenerationConfig,
  root: string,
): boolean {
  if (note.status === 'draft') return false
  const previous = manifest.notes.find((entry) => entry.id === note.id)
  return LOCALES.some(
    (locale) =>
      previous?.locales[locale].generationConfigHash !==
        generationHash(locale, config, note, note.locales[locale].spokenTextSha256) ||
      previous?.locales[locale].markdownPath !== markdownPath(root, note, locale),
  )
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function writeAtomic(file: string, body: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  try {
    await writeFile(temporary, body)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
function matchingArtifact(value: unknown, note: Note, locale: Locale): AlignmentArtifact {
  const artifact = validateAlignmentArtifact(value)
  if (
    artifact.noteId !== note.id ||
    artifact.locale !== locale ||
    artifact.spokenText !== note.locales[locale].spokenText
  )
    throw new Error('Audio alignment does not match the current note.')
  return artifact
}
function localeEntry(
  note: Note,
  locale: Locale,
  root: string,
  hash: string,
  durationMs: number,
  audioUrl = '',
  alignmentUrl = '',
): LocaleManifestEntry {
  const source = note.locales[locale]
  return {
    markdownSha256: source.markdownSha256,
    spokenTextSha256: source.spokenTextSha256,
    generationConfigHash: hash,
    markdownPath: markdownPath(root, note, locale),
    title: source.title,
    summary: source.summary,
    audioUrl,
    alignmentUrl,
    durationMs,
  }
}

async function localGeneration(
  directory: string,
  note: Note,
  locale: Locale,
  config: GenerationConfig,
  provider: SpeechProvider,
  allowNewGeneration: boolean,
): Promise<{ audio: Buffer; artifact: AlignmentArtifact; generated: boolean }> {
  const audioFile = path.join(directory, 'audio.mp3')
  const alignmentFile = path.join(directory, 'alignment.json')
  const responseFile = path.join(directory, 'response.json')
  const audio = await readOptional(audioFile)
  const alignment = await readOptional(alignmentFile)
  if (audio?.length && alignment) {
    try {
      return {
        audio,
        artifact: matchingArtifact(JSON.parse(alignment.toString()), note, locale),
        generated: false,
      }
    } catch {
      await rm(alignmentFile, { force: true })
    }
  }
  const cached = await readOptional(responseFile)
  let response: unknown
  if (cached) {
    try {
      response = JSON.parse(cached.toString())
    } catch {
      await rm(responseFile, { force: true })
    }
  }
  const generated = response === undefined
  const text = note.locales[locale].spokenText
  if (generated) {
    if (!allowNewGeneration)
      throw new Error(
        'Partial remote publication found. Restore the local generation before publishing; do not pair a new recording with old timestamps.',
      )
    if (!config.voices[locale]) throw new Error(`Set ELEVENLABS_VOICE_ID_${locale.toUpperCase()}.`)
    const limit = MODEL_LIMITS[config.model]
    if (Array.from(text).length > limit)
      throw new Error(
        `Note exceeds ${limit} characters for ${config.model}. Shorten it or choose a supported 40,000-character model.`,
      )
    logger.info(
      { noteId: note.id, locale, model: config.model },
      'Requesting ElevenLabs narration with timestamps',
    )
    response = await provider.generateSpeech({
      text,
      locale,
      model: config.model,
      voiceId: config.voices[locale],
      voiceSettings: config.voiceSettings,
    })
    // One recovery file, saved before local mapping or publication.
    await writeAtomic(responseFile, JSON.stringify(response) ?? 'null')
  }
  let decoded: ReturnType<typeof decodeSpeech>
  let artifact: AlignmentArtifact
  try {
    decoded = decodeSpeech(response, text, locale)
    artifact = matchingArtifact(
      {
        schemaVersion: 1,
        offsetConvention: 'utf-16-code-units',
        alignmentMethod: ALIGNMENT_METHOD,
        noteId: note.id,
        locale,
        spokenText: text,
        durationMs: decoded.durationMs,
        units: decoded.units,
        chunks: [],
      },
      note,
      locale,
    )
  } catch (error) {
    // Invalid responses are not successful work and must not poison future runs.
    await rm(responseFile, { force: true })
    throw error
  }
  await writeAtomic(audioFile, decoded.audio)
  await writeAtomic(alignmentFile, `${JSON.stringify(artifact, null, 2)}\n`)
  return { audio: decoded.audio, artifact, generated }
}

export async function generateNotes({
  config,
  manifest,
  manifestPath,
  notes,
  provider,
  uploader,
  rootDirectory,
  upload,
  reconcileAll = true,
  fetchImpl = fetch,
  now = new Date().toISOString(),
}: {
  config: GenerationConfig
  manifest: Manifest
  manifestPath: string
  notes: Note[]
  provider: SpeechProvider
  uploader?: BlobUploader
  rootDirectory: string
  upload: boolean
  reconcileAll?: boolean
  fetchImpl?: typeof fetch
  now?: string
}): Promise<{
  manifest: Manifest
  changed: boolean
  generated: string[]
  reused: string[]
  recovered: string[]
}> {
  const byId = new Map(manifest.notes.map((note) => [note.id, note]))
  const generated: string[] = [],
    reused: string[] = [],
    recovered: string[] = []
  for (const note of notes) {
    if (note.status === 'draft') {
      byId.delete(note.id)
      continue
    }
    if (!note.publishedAt) throw new Error(`Published note ${note.id} must have publishedAt.`)
    const locales = {} as NoteManifestEntry['locales']
    for (const locale of LOCALES) {
      const label = `${note.id}/${locale}`
      try {
        const hash = generationHash(locale, config, note, note.locales[locale].spokenTextSha256)
        const existing = byId.get(note.id)?.locales[locale]
        if (existing?.generationConfigHash === hash) {
          locales[locale] = localeEntry(
            note,
            locale,
            rootDirectory,
            hash,
            existing.durationMs,
            existing.audioUrl,
            existing.alignmentUrl,
          )
          reused.push(label)
          continue
        }
        const directory = path.join(rootDirectory, '.notes/generated', note.id, locale, hash)
        const base = `${config.blobPrefix}/${note.id}/${locale}/${hash}`
        if (upload && !uploader)
          throw new Error('BLOB_READ_WRITE_TOKEN is required for publication.')
        // A remote partial pair may only be completed from the original local result.
        let allowNewGeneration = true
        if (upload && uploader?.find) {
          const remoteAudio = await uploader.find({ pathname: `${base}.mp3` })
          const remoteAlignment = await uploader.find({
            pathname: `${base}.json`,
          })
          if (remoteAudio && remoteAlignment) {
            const response = await fetchImpl(remoteAlignment.url)
            if (!response.ok)
              throw new Error(`Unable to recover published alignment: HTTP ${response.status}.`)
            const artifact = matchingArtifact(await response.json(), note, locale)
            locales[locale] = localeEntry(
              note,
              locale,
              rootDirectory,
              hash,
              artifact.durationMs,
              remoteAudio.url,
              remoteAlignment.url,
            )
            recovered.push(label)
            continue
          }
          allowNewGeneration = !remoteAudio && !remoteAlignment
        }
        const result = await localGeneration(
          directory,
          note,
          locale,
          config,
          provider,
          allowNewGeneration,
        )
        let audioUrl = '',
          alignmentUrl = ''
        if (upload && uploader) {
          audioUrl = (
            await uploader.upload({
              pathname: `${base}.mp3`,
              body: result.audio,
              contentType: 'audio/mpeg',
            })
          ).url
          alignmentUrl = (
            await uploader.upload({
              pathname: `${base}.json`,
              body: Buffer.from(JSON.stringify(result.artifact)),
              contentType: 'application/json',
            })
          ).url
        }
        locales[locale] = localeEntry(
          note,
          locale,
          rootDirectory,
          hash,
          result.artifact.durationMs,
          audioUrl,
          alignmentUrl,
        )
        ;(result.generated ? generated : recovered).push(label)
      } catch (error) {
        throw new Error(
          `Note ${label} failed. Completed generations were preserved; no automatic retry. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    byId.set(note.id, {
      id: note.id,
      slug: note.id,
      status: 'published',
      date: note.date,
      publishedAt: note.publishedAt,
      locales,
    })
  }
  if (reconcileAll) {
    const ids = new Set(notes.map((note) => note.id))
    for (const id of byId.keys()) if (!ids.has(id)) byId.delete(id)
  }
  const candidate: Manifest = {
    schemaVersion: 1,
    generatedAt: now,
    notes: [...byId.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ),
  }
  const changed = !manifestContentEquals(manifest, candidate)
  if (changed && upload) await writeManifestAtomic(manifestPath, candidate)
  return {
    manifest: changed ? candidate : manifest,
    changed,
    generated,
    reused,
    recovered,
  }
}
