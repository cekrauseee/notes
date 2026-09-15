import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ALIGNMENT_METHOD, OUTPUT_FORMAT, decodeSpeech } from './alignment.js'
import { MODEL_LIMITS, type GenerationConfig } from './config.js'
import { canonicalJson, sha256 } from './hash.js'
import { MP3_ASSEMBLY_VERSION, assembleMp3 } from './mp3.js'
import {
  AUDIO_TAGS_VERSION,
  SEGMENTATION_VERSION,
  SPEECH_BLOCKS_VERSION,
  SPOKEN_NORMALIZATION_VERSION,
  normalizeForSpeech,
  normalizeForSpeechProjection,
  segmentSpeechProjection,
  type SpeechBlock,
} from './markdown.js'
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
  type TimedUnit,
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
      speechTextSha256: sha256(normalizeForSpeech(note.locales[locale].markdownBody, locale)),
      spokenTextSha256,
      model: config.model,
      voice: config.voices[locale],
      voiceSettings: config.voiceSettings,
      outputFormat: OUTPUT_FORMAT,
      alignmentMethod: ALIGNMENT_METHOD,
      normalization: SPOKEN_NORMALIZATION_VERSION,
      segmentation: SEGMENTATION_VERSION,
      speechBlocks: SPEECH_BLOCKS_VERSION,
      mp3Assembly: MP3_ASSEMBLY_VERSION,
      audioTags: AUDIO_TAGS_VERSION,
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

type DecodedSpeechBlock = {
  block: SpeechBlock
  audio: Buffer
  units: TimedUnit[]
  generated: boolean
}

function blockResponseFile(directory: string, blockCount: number, index: number): string {
  if (blockCount === 1) return path.join(directory, 'response.json')
  return path.join(directory, 'blocks', String(index).padStart(4, '0'), 'response.json')
}

async function readResponse(file: string): Promise<unknown | undefined> {
  const cached = await readOptional(file)
  if (!cached) return undefined
  try {
    return JSON.parse(cached.toString())
  } catch {
    await rm(file, { force: true })
    return undefined
  }
}

async function writeGenerationPointer(
  directory: string,
  note: Note,
  locale: Locale,
  blockCount?: number,
): Promise<void> {
  const pointer = {
    version: 1,
    generationConfigHash: path.basename(directory),
    markdownSha256: note.locales[locale].markdownSha256,
    spokenTextSha256: note.locales[locale].spokenTextSha256,
    ...(blockCount === undefined ? {} : { blockCount }),
  }
  await writeAtomic(
    path.join(path.dirname(directory), 'current.json'),
    `${JSON.stringify(pointer)}\n`,
  )
}

function shiftBlockUnits(
  units: readonly TimedUnit[],
  block: SpeechBlock,
  blockStartMs: number,
  blockDurationMs: number,
): TimedUnit[] {
  return units.map((unit) => {
    const endMs = Math.min(unit.endMs, blockDurationMs)
    if (unit.startMs < 0 || unit.startMs >= blockDurationMs || endMs <= unit.startMs) {
      throw new Error('ElevenLabs block timestamps exceed the real MP3 block duration.')
    }
    if (
      unit.startChar < 0 ||
      unit.endChar > block.spokenText.length ||
      unit.endChar <= unit.startChar
    ) {
      throw new Error('ElevenLabs block alignment is outside its spoken text.')
    }
    return {
      text: unit.text,
      startChar: block.spokenStart + unit.startChar,
      endChar: block.spokenStart + unit.endChar,
      startMs: blockStartMs + unit.startMs,
      endMs: blockStartMs + endMs,
    }
  })
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
  const existingAudio = await readOptional(audioFile)
  const existingAlignment = await readOptional(alignmentFile)
  if (existingAudio?.length && existingAlignment) {
    try {
      const artifact = matchingArtifact(JSON.parse(existingAlignment.toString()), note, locale)
      await writeGenerationPointer(directory, note, locale)
      return {
        audio: existingAudio,
        artifact,
        generated: false,
      }
    } catch {
      await rm(alignmentFile, { force: true })
    }
  }

  const projection = normalizeForSpeechProjection(note.locales[locale].markdownBody, locale)
  const limit = MODEL_LIMITS[config.model]
  const blocks = segmentSpeechProjection(projection, locale, limit)
  const decodedBlocks: DecodedSpeechBlock[] = []
  for (const block of blocks) {
    const responseFile = blockResponseFile(directory, blocks.length, block.index)
    let response = await readResponse(responseFile)
    const generated = response === undefined
    if (generated) {
      if (!allowNewGeneration)
        throw new Error(
          'Partial remote publication found. Restore the local generation before publishing; do not pair a new recording with old timestamps.',
        )
      if (!config.voices[locale])
        throw new Error(`Set ELEVENLABS_VOICE_ID_${locale.toUpperCase()}.`)
      if (Array.from(block.speechText).length > limit)
        throw new Error(
          `Speech block exceeds ${limit} characters for ${config.model}. Shorten the source or choose a model with a larger limit.`,
        )
      logger.info(
        {
          noteId: note.id,
          locale,
          block: block.index + 1,
          blockCount: blocks.length,
          model: config.model,
        },
        'Requesting ElevenLabs narration block with timestamps',
      )
      response = await provider.generateSpeech({
        text: block.speechText,
        locale,
        model: config.model,
        voiceId: config.voices[locale],
        voiceSettings: config.voiceSettings,
      })
      // Save each completed provider response before local decoding or assembly.
      await writeAtomic(responseFile, JSON.stringify(response) ?? 'null')
    }
    try {
      const decoded = decodeSpeech(
        response,
        block.speechText,
        block.spokenText,
        locale,
        block.spokenToSpeech,
      )
      decodedBlocks.push({ block, audio: decoded.audio, units: decoded.units, generated })
    } catch (error) {
      await rm(responseFile, { force: true })
      throw error
    }
  }

  const assembled = assembleMp3(decodedBlocks.map((decoded) => decoded.audio))
  const units = decodedBlocks.flatMap((decoded, index) => {
    const blockStartMs = assembled.blockStartMs[index]!
    const blockEndMs = assembled.blockStartMs[index + 1] ?? assembled.durationMs
    return shiftBlockUnits(decoded.units, decoded.block, blockStartMs, blockEndMs - blockStartMs)
  })
  const artifact = matchingArtifact(
    {
      schemaVersion: 1,
      offsetConvention: 'utf-16-code-units',
      alignmentMethod: ALIGNMENT_METHOD,
      noteId: note.id,
      locale,
      spokenText: projection.spokenText,
      durationMs: assembled.durationMs,
      units,
      chunks: [],
    },
    note,
    locale,
  )
  await writeAtomic(audioFile, assembled.audio)
  await writeAtomic(alignmentFile, `${JSON.stringify(artifact, null, 2)}\n`)
  await writeGenerationPointer(directory, note, locale, blocks.length)
  return {
    audio: assembled.audio,
    artifact,
    generated: decodedBlocks.some((decoded) => decoded.generated),
  }
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
