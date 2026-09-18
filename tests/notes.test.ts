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
import {
  normalizeForSpeech,
  normalizeForSpeechProjection,
  segmentSpeechProjection,
  stripAudioTagsFromMarkdown,
} from '../src/markdown.js'
import { validateManifest } from '../src/manifest.js'
import { LOCALES, type Locale, type Note, type NoteLocale } from '../src/types.js'

const config = readConfig({
  ELEVENLABS_VOICE_ID_EN: 'fixture',
  ELEVENLABS_VOICE_ID_FR: 'fixture-fr',
  ELEVENLABS_VOICE_ID_ES: 'fixture-es',
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
        fr: 'Bonjour le monde.',
        es: 'Hola mundo.',
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
function fixtureMp3(durationMs: number): Buffer {
  const frameDurationMs = (1152 * 1000) / 44_100
  const frameCount = Math.max(2, Math.ceil(durationMs / frameDurationMs) + 1)
  return Buffer.concat(
    Array.from({ length: frameCount }, () => {
      const frame = Buffer.alloc(417)
      frame[0] = 0xff
      frame[1] = 0xfb
      frame[2] = 0x90
      frame[3] = 0x40
      return frame
    }),
  )
}

function speech(text: string, millisecondsPerCharacter = 100) {
  const characters = Array.from(text)
  return {
    audio_base64: fixtureMp3(characters.length * millisecondsPerCharacter + 1).toString('base64'),
    alignment: {
      characters,
      character_start_times_seconds: characters.map(
        (_, i) => (i * millisecondsPerCharacter) / 1000,
      ),
      character_end_times_seconds: characters.map(
        (_, i) => ((i + 1) * millisecondsPerCharacter) / 1000,
      ),
    },
  }
}

async function writePublishedNote(root: string, body: string): Promise<void> {
  const directory = path.join(root, 'content/notes/limit-note')
  await mkdir(directory, { recursive: true })
  for (const locale of LOCALES) {
    await writeFile(
      path.join(directory, locale === 'en' ? 'note.md' : `note.${locale}.md`),
      `---\nid: limit-note\nstatus: published\ndate: 2026-09-10\ntitle: Fixture\nsummary: Summary\nlocale: ${locale}\npublishedAt: 2026-09-10T00:00:00.000Z\n---\n\n${body}\n`,
    )
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

test('audio tags stay in the speech projection while literal brackets and code stay intact', () => {
  const code = String.fromCharCode(96)
  const markdown = '[calm, measured] Hello [not-a-tag].\n\n' + code + '[thoughtful] literal' + code
  const projection = normalizeForSpeechProjection(markdown, 'en')
  assert.equal(projection.speechText, '[calm, measured] Hello [not-a-tag].\n\n[thoughtful] literal')
  assert.equal(projection.spokenText, 'Hello [not-a-tag].\n\n[thoughtful] literal')
  assert.equal(
    stripAudioTagsFromMarkdown(markdown),
    'Hello [not-a-tag].\n\n' + code + '[thoughtful] literal' + code,
  )
})

test('semantic speech blocks preserve exact order, tags, and UTF-16 mappings', () => {
  const markdown =
    '[thoughtful][short pause] First sentence. [measured] Second sentence.\n\n' +
    'A separate paragraph with 😀 Unicode and a final sentence.'
  const projection = normalizeForSpeechProjection(markdown, 'en')
  for (const limit of [
    Array.from(projection.speechText).length,
    Array.from(projection.speechText).length + 1,
  ]) {
    assert.equal(segmentSpeechProjection(projection, 'en', limit).length, 1)
  }
  const blocks = segmentSpeechProjection(projection, 'en', 32)
  assert.ok(blocks.length > 1)
  assert.equal(blocks.map((block) => block.speechText).join(''), projection.speechText)
  assert.equal(blocks.map((block) => block.spokenText).join(''), projection.spokenText)
  assert.ok(blocks.every((block) => Array.from(block.speechText).length <= 32))
  for (const tag of ['[thoughtful]', '[short pause]', '[measured]']) {
    assert.equal(blocks.filter((block) => block.speechText.includes(tag)).length, 1)
  }
  assert.match(
    blocks.find((block) => block.speechText.includes('[measured]'))!.speechText,
    /\[measured\] Second/,
  )
  for (const block of blocks) {
    for (const [index, sourceIndex] of block.spokenToSpeech.entries()) {
      assert.equal(block.speechText[sourceIndex], block.spokenText[index])
    }
  }
  const japanese = normalizeForSpeechProjection('😀'.repeat(40), 'ja')
  const japaneseBlocks = segmentSpeechProjection(japanese, 'ja', 15)
  assert.ok(japaneseBlocks.every((block) => Array.from(block.speechText).length <= 15))
  assert.equal(japaneseBlocks.map((block) => block.speechText).join(''), japanese.speechText)
  assert.ok(japaneseBlocks.every((block) => !/[\uD800-\uDBFF]$/u.test(block.speechText)))
  assert.ok(japaneseBlocks.every((block) => !/^\uDC00/gu.test(block.speechText)))
})

test('content validation rejects missing translations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-invalid-'))
  try {
    await mkdir(path.join(root, 'content/notes/broken'), { recursive: true })
    await writeFile(
      path.join(root, 'content/notes/broken/note.md'),
      '---\nid: broken\nstatus: draft\ndate: 2026-09-10\ntitle: broken\nsummary: broken\nlocale: en\npublishedAt: null\n---\n\nText\n',
    )
    await assert.rejects(readNotes(root), /missing note\.fr\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('character timestamps map words to UTF-16 source spans in all five languages', () => {
  for (const [locale, text] of [
    ['en', 'Hi 😀 world.'],
    ['fr', 'Bonjour le monde.'],
    ['es', 'Hola mundo.'],
    ['pt', 'Olá mundo.'],
    ['ja', '考えを話す。'],
  ] as const) {
    const result = decodeSpeech(speech(text), text, text, locale)
    assert.ok(result.audio.length > 0)
    assert.ok(result.units.length > 0)
    for (const unit of result.units)
      assert.equal(text.slice(unit.startChar, unit.endChar), unit.text)
    if (locale === 'en') assert.equal(result.units[1]?.startChar, 6)
  }
})

test('mapping uses original alignment and rejects missing or mismatched timing data', () => {
  const raw = speech('2026')
  assert.equal(
    decodeSpeech(
      { ...raw, normalized_alignment: speech('two thousand').alignment },
      '2026',
      '2026',
      'en',
    ).units[0]?.text,
    '2026',
  )
  assert.throws(
    () => decodeSpeech({ audio_base64: raw.audio_base64 }, '2026', '2026', 'en'),
    /original-text alignment/,
  )
  assert.throws(() => decodeSpeech(raw, '2027', '2027', 'en'), /does not match/)
  assert.throws(
    () =>
      decodeSpeech(
        {
          ...raw,
          alignment: { ...raw.alignment, character_end_times_seconds: [NaN] },
        },
        '2026',
        '2026',
        'en',
      ),
    /invalid character alignment/,
  )
})

test('tagged alignment maps timestamps to clean spoken-text offsets', () => {
  const projection = normalizeForSpeechProjection('[calm, measured] Hello world.', 'en')
  const result = decodeSpeech(
    speech(projection.speechText),
    projection.speechText,
    projection.spokenText,
    'en',
    projection.spokenToSpeech,
  )
  assert.equal(result.units.map((unit) => unit.text).join(' '), 'Hello world')
  assert.equal(result.units[0]?.startChar, 0)
  assert.equal(result.units[0]?.startMs, projection.spokenToSpeech[0]! * 100)
  assert.equal(result.units[1]?.startChar, 6)
})

test('tagged Japanese alignment keeps UTF-16 offsets for both response shapes', () => {
  const projection = normalizeForSpeechProjection('考えです。[calm, reflective]次です。', 'ja')
  const tagged = decodeSpeech(
    speech(projection.speechText),
    projection.speechText,
    projection.spokenText,
    'ja',
    projection.spokenToSpeech,
  )
  const clean = decodeSpeech(
    speech(projection.spokenText),
    projection.speechText,
    projection.spokenText,
    'ja',
    projection.spokenToSpeech,
  )
  assert.equal(
    tagged.units.map((unit) => unit.text).join(''),
    clean.units.map((unit) => unit.text).join(''),
  )
  assert.equal(tagged.units[0]?.startChar, 0)
  for (const unit of tagged.units) {
    assert.equal(projection.spokenText.slice(unit.startChar, unit.endChar), unit.text)
    assert.equal(unit.startMs, projection.spokenToSpeech[unit.startChar]! * 100)
  }
})

test('generation identity changes when only an audio tag changes', () => {
  const current = note('/tmp/notes-fixture')
  const changed = {
    ...current,
    locales: {
      ...current.locales,
      en: {
        ...current.locales.en,
        markdownBody: '[thoughtful] Hello world.',
        rawMarkdown: '[thoughtful] Hello world.',
        markdownSha256: sha256('[thoughtful] Hello world.'),
      },
    },
  }
  assert.equal(current.locales.en.spokenTextSha256, changed.locales.en.spokenTextSha256)
  assert.notEqual(
    generationHash('en', config, current, current.locales.en.spokenTextSha256),
    generationHash('en', config, changed, changed.locales.en.spokenTextSha256),
  )
  const modelChanged = {
    ...config,
    model: 'eleven_multilingual_v2' as const,
  }
  const voiceChanged = {
    ...config,
    voices: { ...config.voices, en: 'different-voice' },
  }
  assert.notEqual(
    generationHash('en', config, current, current.locales.en.spokenTextSha256),
    generationHash('en', modelChanged, current, current.locales.en.spokenTextSha256),
  )
  assert.notEqual(
    generationHash('en', config, current, current.locales.en.spokenTextSha256),
    generationHash('en', voiceChanged, current, current.locales.en.spokenTextSha256),
  )
})

test('v3 segmentation includes audio tags and keeps each request within the limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-v3-limit-'))
  const requests = { en: [], fr: [], es: [], pt: [], ja: [] } as Record<Locale, string[]>
  const v3Config = readConfig({
    ELEVENLABS_MODEL_ID: 'eleven_v3',
    ELEVENLABS_VOICE_ID_EN: 'fixture',
    ELEVENLABS_VOICE_ID_FR: 'fixture-fr',
    ELEVENLABS_VOICE_ID_ES: 'fixture-es',
    ELEVENLABS_VOICE_ID_PT: 'fixture-pt',
    ELEVENLABS_VOICE_ID_JA: 'fixture-ja',
  })
  try {
    await writePublishedNote(root, '[calm, measured] ' + 'a'.repeat(4_990))
    const [current] = await readNotes(root)
    const result = await generateNotes({
      config: v3Config,
      manifest: empty,
      manifestPath: path.join(root, '.notes/manifest.json'),
      notes: [current!],
      provider: {
        async generateSpeech({ locale, text }) {
          requests[locale].push(text)
          return speech(text, 1)
        },
      },
      rootDirectory: root,
      upload: false,
    })
    for (const locale of LOCALES) {
      const projection = normalizeForSpeechProjection(current!.locales[locale].markdownBody, locale)
      assert.equal(requests[locale].length, 2)
      assert.equal(requests[locale].join(''), projection.speechText)
      assert.ok(requests[locale].every((text) => Array.from(text).length <= 5_000))
      const manifestLocale = result.manifest.notes[0]?.locales[locale]
      assert.ok(manifestLocale)
      assert.ok(manifestLocale.durationMs > 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('segmented generation resumes completed blocks without repeating paid calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-segment-recovery-'))
  const requests: Array<{ locale: Locale; text: string }> = []
  let failOnce = true
  const body = Array.from(
    { length: 150 },
    (_, index) => `Sentence ${index} remains in this published note.`,
  ).join(' ')
  const current = await (async () => {
    await writePublishedNote(root, '[thoughtful] ' + body)
    return (await readNotes(root))[0]
  })()
  const options = {
    config,
    manifest: empty,
    manifestPath: path.join(root, '.notes/manifest.json'),
    notes: [current!],
    provider: {
      async generateSpeech({ locale, text }: { locale: Locale; text: string }) {
        requests.push({ locale, text })
        if (
          locale === 'en' &&
          requests.filter((request) => request.locale === 'en').length === 2 &&
          failOnce
        ) {
          failOnce = false
          throw new Error('block failure')
        }
        return speech(text, 1)
      },
    },
    rootDirectory: root,
    upload: false,
  }
  try {
    await assert.rejects(generateNotes(options), /block failure/)
    const firstEnglish = requests.find((request) => request.locale === 'en')!.text
    const hash = generationHash('en', config, current!, current!.locales.en.spokenTextSha256)
    const directory = path.join(root, '.notes/generated', current!.id, 'en', hash)
    assert.ok((await readFile(path.join(directory, 'blocks/0000/response.json'))).length > 0)
    await assert.rejects(readFile(path.join(directory, 'blocks/0001/response.json')), /ENOENT/)
    await assert.rejects(readFile(path.join(directory, 'audio.mp3')), /ENOENT/)

    const result = await generateNotes(options)
    assert.equal(requests.filter((request) => request.locale === 'en').length, 3)
    assert.equal(
      requests.filter((request) => request.locale === 'en' && request.text === firstEnglish).length,
      1,
    )
    const manifestLocale = result.manifest.notes[0]?.locales.en
    assert.ok(manifestLocale)
    assert.ok(manifestLocale.durationMs > 0)
    assert.ok((await readFile(path.join(directory, 'audio.mp3'))).length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed locale stops once and subsequent runs reuse completed generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-generate-'))
  const calls = { en: 0, fr: 0, es: 0, pt: 0, ja: 0 }
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
    assert.deepEqual(calls, { en: 1, fr: 1, es: 1, pt: 1, ja: 1 })
    fail = false
    const resumed = await generateNotes(options)
    assert.deepEqual(resumed.recovered, ['fixture/en', 'fixture/fr', 'fixture/es', 'fixture/pt'])
    assert.deepEqual(calls, { en: 1, fr: 1, es: 1, pt: 1, ja: 2 })
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
    assert.equal(calls, 5)
    validateManifest(result.manifest)
    current.locales.en.title = 'New title'
    const reused = await generateNotes({
      ...options,
      manifest: result.manifest,
    })
    assert.equal(calls, 5)
    assert.equal(reused.reused.length, 5)
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
