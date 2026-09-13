import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decodeSpeech } from '../src/alignment.js'
import { readConfig } from '../src/config.js'
import { readNotes } from '../src/content.js'
import { generateNotes, generationHash, type SpeechProvider } from '../src/generate.js'
import { sha256 } from '../src/hash.js'
import { normalizeForSpeech } from '../src/markdown.js'
import { validateManifest } from '../src/manifest.js'
import { LOCALES, type Locale, type Note, type NoteLocale } from '../src/types.js'

const config = readConfig({
  ELEVENLABS_VOICE_ID_EN: 'fixture',
  ELEVENLABS_VOICE_ID_PT: 'fixture-pt',
  ELEVENLABS_VOICE_ID_JA: 'fixture-ja',
})
const empty = {
  schemaVersion: 1 as const,
  generatedAt: '2026-09-10T00:00:00.000Z',
  notes: [],
}
function note(root: string): Note {
  const locales = Object.fromEntries(
    LOCALES.map((locale) => {
      const spokenText = {
        en: 'Hello world.',
        pt: 'Olá mundo.',
        ja: '考えを話す。',
      }[locale]
      return [
        locale,
        {
          locale,
          sourcePath: path.join(
            root,
            'content/notes/fixture',
            locale === 'en' ? 'note.md' : `note.${locale}.md`,
          ),
          rawMarkdown: spokenText,
          markdownBody: spokenText,
          spokenText,
          title: 'Fixture',
          summary: 'Summary',
          markdownSha256: sha256(spokenText),
          spokenTextSha256: sha256(spokenText),
        } satisfies NoteLocale,
      ]
    }),
  ) as Record<Locale, NoteLocale>
  return {
    id: 'fixture',
    status: 'published',
    date: '2026-09-10',
    publishedAt: '2026-09-10T00:00:00.000Z',
    locales,
  }
}
function speech(text: string) {
  const characters = Array.from(text)
  return {
    audio_base64: Buffer.from('fixture-mp3').toString('base64'),
    alignment: {
      characters,
      character_start_times_seconds: characters.map((_, i) => i / 10),
      character_end_times_seconds: characters.map((_, i) => (i + 1) / 10),
    },
  }
}

test('Markdown narration preserves rendered text by explicit AST policy', () => {
  assert.equal(
    normalizeForSpeech(
      '# Heading\n\nThis is **strong**, [a link](https://example.com), `code`, and ![alt text](image.png).',
      'en',
    ),
    'Heading\n\nThis is strong, a link, code, and alt text.',
  )
  assert.throws(() => normalizeForSpeech('hello <span>world</span>', 'en'), /raw HTML/)
})

test('content validation rejects missing translations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-invalid-'))
  try {
    await mkdir(path.join(root, 'content/notes/broken'), { recursive: true })
    await writeFile(
      path.join(root, 'content/notes/broken/note.md'),
      '---\nid: broken\nstatus: draft\ndate: 2026-09-10\ntitle: broken\nsummary: broken\nlocale: en\npublishedAt: null\n---\n\nText\n',
    )
    await assert.rejects(readNotes(root), /missing note\.pt\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('character timestamps map words to UTF-16 source spans in all three languages', () => {
  for (const [locale, text] of [
    ['en', 'Hi 😀 world.'],
    ['pt', 'Olá mundo.'],
    ['ja', '考えを話す。'],
  ] as const) {
    const result = decodeSpeech(speech(text), text, locale)
    assert.equal(result.audio.toString(), 'fixture-mp3')
    assert.ok(result.units.length > 0)
    for (const unit of result.units)
      assert.equal(text.slice(unit.startChar, unit.endChar), unit.text)
    if (locale === 'en') assert.equal(result.units[1]?.startChar, 6)
  }
})

test('mapping uses original alignment and rejects missing or mismatched timing data', () => {
  const raw = speech('2026')
  assert.equal(
    decodeSpeech({ ...raw, normalized_alignment: speech('two thousand').alignment }, '2026', 'en')
      .units[0]?.text,
    '2026',
  )
  assert.throws(
    () => decodeSpeech({ audio_base64: raw.audio_base64 }, '2026', 'en'),
    /original-text alignment/,
  )
  assert.throws(() => decodeSpeech(raw, '2027', 'en'), /does not match/)
  assert.throws(
    () =>
      decodeSpeech(
        {
          ...raw,
          alignment: { ...raw.alignment, character_end_times_seconds: [NaN] },
        },
        '2026',
        'en',
      ),
    /does not match/,
  )
})

test('failed locale stops once and subsequent runs reuse completed generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-generate-'))
  const calls = { en: 0, pt: 0, ja: 0 }
  let fail = true
  const provider: SpeechProvider = {
    async generateSpeech(input) {
      calls[input.locale] += 1
      if (input.locale === 'ja' && fail) throw new Error('unavailable')
      return speech(input.text)
    },
  }
  const current = note(root)
  const options = {
    config,
    manifest: empty,
    manifestPath: path.join(root, '.notes/manifest.json'),
    notes: [current],
    provider,
    rootDirectory: root,
    upload: false,
  }
  try {
    await assert.rejects(generateNotes(options), /fixture\/ja.*no automatic retry/)
    assert.deepEqual(calls, { en: 1, pt: 1, ja: 1 })
    fail = false
    const resumed = await generateNotes(options)
    assert.deepEqual(resumed.recovered, ['fixture/en', 'fixture/pt'])
    assert.deepEqual(calls, { en: 1, pt: 1, ja: 2 })
    const directory = path.join(
      root,
      '.notes/generated/fixture/en',
      generationHash('en', config, current, current.locales.en.spokenTextSha256),
    )
    await rm(path.join(directory, 'alignment.json'))
    await generateNotes(options)
    assert.equal(calls.en, 1, 'recover local mapping from the saved API response')
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'alignment.json'), 'utf8')).alignmentMethod,
      'elevenlabs-character-timestamps',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upload failures keep local results and metadata edits reuse published assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-publish-'))
  let calls = 0,
    fail = true
  const objects = new Map<string, { url: string }>()
  const uploader = {
    async find({ pathname }: { pathname: string }) {
      return objects.get(pathname) ?? null
    },
    async upload({ pathname }: { pathname: string }) {
      if (fail && pathname.endsWith('.json')) throw new Error('upload failed')
      const result = { url: `https://blob.test/${pathname}` }
      objects.set(pathname, result)
      return result
    },
  }
  const current = note(root)
  const options = {
    config,
    manifest: empty,
    manifestPath: path.join(root, '.notes/manifest.json'),
    notes: [current],
    provider: {
      async generateSpeech({ text }: { text: string }) {
        calls += 1
        return speech(text)
      },
    },
    uploader,
    rootDirectory: root,
    upload: true,
  }
  try {
    await assert.rejects(generateNotes(options), /upload failed/)
    fail = false
    const result = await generateNotes(options)
    assert.equal(calls, 3)
    validateManifest(result.manifest)
    current.locales.en.title = 'New title'
    const reused = await generateNotes({
      ...options,
      manifest: result.manifest,
    })
    assert.equal(calls, 3)
    assert.equal(reused.reused.length, 3)
    assert.equal(reused.manifest.notes[0]?.locales.en.title, 'New title')
    assert.deepEqual(
      (
        await generateNotes({
          ...options,
          notes: [],
          manifest: result.manifest,
        })
      ).manifest.notes,
      [],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
