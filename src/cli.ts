import path from 'node:path'
import { readNotes } from './content.js'
import { readConfig } from './config.js'
import { generateNotes, noteNeedsGeneration, type SpeechProvider } from './generate.js'
import { loadManifest } from './manifest.js'
import { createElevenLabsProvider, createVercelBlobUploader } from './providers.js'
import { logger } from './logger.js'

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

async function validate(rootDirectory: string): Promise<void> {
  logger.info({ rootDirectory }, 'Validating note content')
  const notes = await readNotes(rootDirectory)
  logger.info({ noteCount: notes.length }, 'Note content validated')
  console.log(`validated ${notes.length} note${notes.length === 1 ? '' : 's'}`)
  for (const note of notes) console.log(`${note.id}: ${note.status}`)
}

async function generate(rootDirectory: string, args: string[]): Promise<void> {
  const requestedNote = argumentValue(args, '--note')
  const upload = hasFlag(args, '--upload')
  logger.info(
    { rootDirectory, requestedNote: requestedNote ?? null, upload, args },
    'Starting note audio generation',
  )
  const config = readConfig()
  if (hasFlag(args, '--no-upload')) {
    if (upload) throw new Error('Choose either --upload or --no-upload.')
  }
  const notes = await readNotes(rootDirectory)
  const selected = requestedNote ? notes.filter((note) => note.id === requestedNote) : notes
  if (requestedNote && selected.length === 0) throw new Error(`Unknown note id: ${requestedNote}.`)
  const manifestPath = path.resolve(
    rootDirectory,
    argumentValue(args, '--manifest') ?? '.notes/manifest.json',
  )
  const manifest = await loadManifest(manifestPath)
  logger.info(
    {
      noteCount: notes.length,
      selectedCount: selected.length,
      manifestPath,
      manifestNoteCount: manifest.notes.length,
    },
    'Generation inputs loaded',
  )
  if (
    upload &&
    !config.blobToken &&
    selected.some((note) => noteNeedsGeneration(note, manifest, config, rootDirectory))
  ) {
    throw new Error('BLOB_READ_WRITE_TOKEN is required when uploading published note assets.')
  }
  // Resolve credentials only if recovery/reuse actually needs a paid call.
  let provider: SpeechProvider | undefined
  function getProvider(): SpeechProvider {
    if (!config.elevenLabsApiKey)
      throw new Error('ELEVENLABS_API_KEY is required for new audio generation.')
    logger.debug({ model: config.model }, 'Creating ElevenLabs speech provider')
    return (provider ??= createElevenLabsProvider(config.elevenLabsApiKey))
  }
  const generationOptions = {
    config,
    manifest,
    manifestPath,
    notes: selected,
    provider: {
      generateSpeech: (input: Parameters<SpeechProvider['generateSpeech']>[0]) =>
        getProvider().generateSpeech(input),
    },
    rootDirectory,
    upload,
    reconcileAll: !requestedNote,
    ...(upload && config.blobToken ? { uploader: createVercelBlobUploader(config.blobToken) } : {}),
  }
  const result = await generateNotes(generationOptions)
  logger.info(
    {
      changed: result.changed,
      generatedCount: result.generated.length,
      recoveredCount: result.recovered.length,
      reusedCount: result.reused.length,
      manifestWritten: upload && result.changed,
    },
    'Note audio generation completed',
  )
  console.log(
    JSON.stringify(
      {
        manifestPath,
        upload,
        changed: result.changed,
        generated: result.generated,
        reused: result.reused,
        recovered: result.recovered,
        manifestWritten: upload && result.changed,
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const [command = 'validate', ...args] = process.argv.slice(2)
  const rootDirectory = process.cwd()
  logger.debug({ command, args, rootDirectory }, 'Notes command received')
  if (command === 'validate') return validate(rootDirectory)
  if (command === 'generate') return generate(rootDirectory, args)
  throw new Error(`Unknown command ${command}. Use validate or generate.`)
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Notes command failed')
  process.exitCode = 1
})
