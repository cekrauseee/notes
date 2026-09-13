import assert from 'node:assert/strict'
import test from 'node:test'
import { createElevenLabsProvider } from '../src/providers.js'
import { readConfig } from '../src/config.js'

// Updated for the ElevenLabs migration; intentionally not executed during migration.
test('one ElevenLabs request includes voice settings and returns audio with timestamps', async () => {
  const config = readConfig({
    ELEVENLABS_VOICE_ID_EN: 'voice-id',
    ELEVENLABS_VOICE_ID_PT: 'voice-id-pt',
    ELEVENLABS_VOICE_ID_JA: 'voice-id-ja',
  })
  let calls = 0
  const result = {
    audio_base64: 'bXAz',
    alignment: {
      characters: ['A'],
      character_start_times_seconds: [0],
      character_end_times_seconds: [1],
    },
  }
  const provider = createElevenLabsProvider('fixture-key', async (url, init) => {
    calls += 1
    assert.equal(
      String(url),
      'https://api.elevenlabs.io/v1/text-to-speech/voice-id/with-timestamps?output_format=mp3_44100_128',
    )
    const request = new Request(url, init)
    assert.equal(request.headers.get('xi-api-key'), 'fixture-key')
    assert.deepEqual(await request.json(), {
      text: 'A',
      model_id: 'eleven_multilingual_v2',
      voice_settings: config.voiceSettings,
    })
    return Response.json(result)
  })
  assert.deepEqual(
    await provider.generateSpeech({
      text: 'A',
      locale: 'en',
      model: config.model,
      voiceId: config.voices.en,
      voiceSettings: config.voiceSettings,
    }),
    result,
  )
  assert.equal(calls, 1)
})

test('retryable ElevenLabs failure is not retried', async () => {
  let calls = 0
  const config = readConfig({
    ELEVENLABS_VOICE_ID_EN: 'voice-id',
    ELEVENLABS_VOICE_ID_PT: 'voice-id-pt',
    ELEVENLABS_VOICE_ID_JA: 'voice-id-ja',
  })
  const provider = createElevenLabsProvider('fixture-key', async () => {
    calls += 1
    return new Response(null, { status: 429 })
  })
  await assert.rejects(
    provider.generateSpeech({
      text: 'A',
      locale: 'en',
      model: config.model,
      voiceId: config.voices.en,
      voiceSettings: config.voiceSettings,
    }),
    /HTTP 429/,
  )
  assert.equal(calls, 1)
})
