import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dispatchFromEnvironment } from '../src/dispatch.js'
import type { DispatchFetch } from '../src/dispatch.js'

const deployHookUrl = 'https://api.vercel.com/v1/integrations/deploy/prj_test/hook_test'

test('dispatch is disabled without a deploy hook', async () => {
  let calls = 0
  const fetchImpl: DispatchFetch = async () => {
    calls += 1
    return { ok: true, status: 204, text: async () => '' }
  }
  const result = await dispatchFromEnvironment({ env: {}, fetchImpl })
  assert.deepEqual(result, { enabled: false })
  assert.equal(calls, 0)
})

test('dispatch rejects non-Vercel deploy hook URLs', async () => {
  await assert.rejects(
    dispatchFromEnvironment({
      env: { VERCEL_DEPLOY_HOOK_URL: 'https://example.com/hook' },
    }),
    /HTTPS Vercel deploy hook URL/,
  )
})

test('dispatch sends a POST to the configured Vercel deploy hook', async () => {
  const requests: Array<{ url: string; init: Parameters<DispatchFetch>[1] }> = []
  const fetchImpl: DispatchFetch = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 204, text: async () => '' }
  }
  const result = await dispatchFromEnvironment({
    env: { VERCEL_DEPLOY_HOOK_URL: deployHookUrl },
    fetchImpl,
  })
  assert.deepEqual(result, { enabled: true, status: 204 })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.url, deployHookUrl)
  assert.deepEqual(request.init, { method: 'POST' })
})

test('dispatch leaves a failed deploy hook retryable', async () => {
  let calls = 0
  const fetchImpl: DispatchFetch = async () => {
    calls += 1
    return { ok: false, status: 500, text: async () => 'temporary failure' }
  }
  await assert.rejects(
    dispatchFromEnvironment({
      env: { VERCEL_DEPLOY_HOOK_URL: deployHookUrl },
      fetchImpl,
    }),
    /Vercel deploy hook failed with HTTP 500: temporary failure/,
  )
  assert.equal(calls, 1)
})

test('workflow dispatches only after push and keeps repository write permission explicit', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/generate-audio.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /permissions:\n  contents: write/)
  const pushIndex = workflow.indexOf('git push origin "HEAD:${GITHUB_REF_NAME}"')
  const dispatchIndex = workflow.indexOf('name: trigger portfolio Vercel deploy hook')
  assert.ok(pushIndex >= 0 && dispatchIndex > pushIndex)
  assert.match(workflow, /VERCEL_DEPLOY_HOOK_URL/)
  assert.match(workflow, /ELEVENLABS_VOICE_ID_FR/)
  assert.match(workflow, /ELEVENLABS_VOICE_ID_ES/)
  assert.doesNotMatch(workflow, /PORTFOLIO_DISPATCH_TOKEN|PORTFOLIO_REPOSITORY|NOTES_COMMIT/)
  assert.match(workflow, /actions\/cache\/restore@v5/)
  assert.match(workflow, /actions\/cache\/save@v5/)
  assert.match(workflow, /restore-keys:/)
})

test('publication stays on main and never rebases generated output onto newer content', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/generate-audio.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /ref: main/)
  assert.doesNotMatch(workflow, /git pull --rebase|--force/)
  assert.ok(
    workflow.indexOf('preserve completed generation stages') >
      workflow.indexOf('trigger portfolio Vercel deploy hook'),
  )
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /github.run_attempt/)
})
