import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readNotes } from '../src/content.js'
import { readConfig } from '../src/config.js'
import { generationHash } from '../src/generate.js'

const repository = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'))

function command(root: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const parts: string[] = packageJson.scripts[script].split(' ').slice(1)
  parts[parts.indexOf('tsx')] = import.meta.resolve('tsx')
  const sourceIndex = parts.findIndex((part) => part.startsWith('src/'))
  parts[sourceIndex] = path.join(repository, parts[sourceIndex]!)
  return spawnSync(process.execPath, [...parts, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
}

async function source(root: string, published = false) {
  await mkdir(path.join(root, 'content/notes/test-note'), { recursive: true })
  for (const locale of ['en', 'fr', 'es', 'pt', 'ja']) {
    const filename = locale === 'en' ? 'note.md' : `note.${locale}.md`
    await writeFile(
      path.join(root, 'content/notes/test-note', filename),
      `---\nid: test-note\nstatus: ${published ? 'published' : 'draft'}\ndate: "2026-09-10"\ntitle: test\nsummary: test\nlocale: ${locale}\npublishedAt: ${published ? '"2026-09-10T00:00:00.000Z"' : 'null'}\n---\n\nhello world.\n`,
    )
  }
}

test('local commands load .env, respect exported values and tolerate a missing file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-env-'))
  try {
    await source(root)
    assert.equal(command(root, 'notes:validate').status, 0)
    await writeFile(
      path.join(root, '.env'),
      'VERCEL_DEPLOY_HOOK_URL=https://example.com/not-a-vercel-hook\n',
    )
    const loaded = command(root, 'notes:dispatch')
    assert.equal(loaded.status, 1)
    assert.match(loaded.stderr, /Vercel deploy hook URL/)
    const overridden = command(root, 'notes:dispatch', [], {
      VERCEL_DEPLOY_HOOK_URL: '',
    })
    assert.equal(overridden.status, 0)
    assert.match(overridden.stdout, /disabled/)
    await writeFile(path.join(root, '.env'), await readFile(path.join(repository, '.env.example')))
    assert.equal(command(root, 'notes:validate').status, 0)
    assert.equal(command(root, 'notes:dispatch').status, 0)
    assert.equal(command(root, 'notes:generate', ['--no-upload']).status, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation config defaults to v3 Natural narration and preserves legacy controls', () => {
  const defaults = readConfig({
    ELEVENLABS_VOICE_ID_EN: 'english',
    ELEVENLABS_VOICE_ID_FR: 'french',
    ELEVENLABS_VOICE_ID_ES: 'spanish',
    ELEVENLABS_VOICE_ID_PT: 'brazilian',
    ELEVENLABS_VOICE_ID_JA: 'japanese',
  })
  assert.equal(defaults.model, 'eleven_v3')
  assert.deepEqual(defaults.voiceSettings, { stability: 0.5 })
  assert.deepEqual(defaults.voices, {
    en: 'english',
    fr: 'french',
    es: 'spanish',
    pt: 'brazilian',
    ja: 'japanese',
  })
  assert.deepEqual(
    readConfig({
      ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
      ELEVENLABS_SPEED: '0.95',
    }).voiceSettings,
    {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 0.95,
    },
  )
  assert.deepEqual(
    readConfig({
      ELEVENLABS_MODEL_ID: 'eleven_v3',
      ELEVENLABS_SPEED: '2',
    }).voiceSettings,
    { stability: 0.5 },
  )
  assert.deepEqual(
    readConfig({
      ELEVENLABS_VOICE_ID: 'obsolete-default',
      ELEVENLABS_VOICE_ID_PT: 'brazilian',
    }).voices,
    { en: '', fr: '', es: 'brazilian', pt: 'brazilian', ja: '' },
  )
  assert.deepEqual(
    readConfig({
      ELEVENLABS_VOICE_ID_EN: 'english',
      ELEVENLABS_VOICE_ID_PT: 'brazilian',
    }).voices,
    { en: 'english', fr: 'english', es: 'brazilian', pt: 'brazilian', ja: '' },
  )
  assert.throws(
    () => readConfig({ ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2', ELEVENLABS_SPEED: '2' }),
    /between 0.7 and 1.2/,
  )
})

test('published manifest reuse does not require ElevenLabs credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notes-reuse-cli-'))
  try {
    await source(root, true)
    const [note] = await readNotes(root)
    assert.ok(note)
    const config = readConfig({})
    const locales = Object.fromEntries(
      Object.entries(note.locales).map(([locale, data]) => [
        locale,
        {
          markdownSha256: data.markdownSha256,
          spokenTextSha256: data.spokenTextSha256,
          generationConfigHash: generationHash(data.locale, config, note, data.spokenTextSha256),
          markdownPath: path.relative(root, data.sourcePath),
          title: data.title,
          summary: data.summary,
          audioUrl: `https://fixture.public.blob.vercel-storage.com/${locale}.mp3`,
          alignmentUrl: `https://fixture.public.blob.vercel-storage.com/${locale}.json`,
          durationMs: 1000,
        },
      ]),
    )
    await mkdir(path.join(root, '.notes'))
    await writeFile(
      path.join(root, '.notes/manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-10T00:00:00.000Z',
        notes: [
          {
            id: note.id,
            slug: note.id,
            status: note.status,
            date: note.date,
            publishedAt: note.publishedAt,
            locales,
          },
        ],
      }),
    )
    for (const mode of ['--no-upload', '--upload']) {
      const result = command(root, 'notes:generate', [mode])
      assert.equal(result.status, 0, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.equal(report.generated.length, 0)
      assert.equal(report.reused.length, 5)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
