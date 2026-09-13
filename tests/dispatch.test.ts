import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dispatchFromEnvironment } from '../src/dispatch.js'
import type { DispatchFetch } from '../src/dispatch.js'

const commit = 'a'.repeat(40)

test('dispatch is disabled without both optional integration values', async () => {
  let calls = 0
  const fetchImpl: DispatchFetch = async () => {
    calls += 1
    return { ok: true, status: 204, text: async () => '' }
  }
  const result = await dispatchFromEnvironment({ env: {}, fetchImpl })
  assert.deepEqual(result, { enabled: false })
  assert.equal(calls, 0)
})

test('dispatch requires the token and repository as an all-or-none pair', async () => {
  await assert.rejects(
    dispatchFromEnvironment({
      env: { PORTFOLIO_DISPATCH_TOKEN: 'secret' },
      notesCommit: commit,
    }),
    /must be configured together/,
  )
  await assert.rejects(
    dispatchFromEnvironment({
      env: { PORTFOLIO_REPOSITORY: 'cekrauseee\/portfolio' },
      notesCommit: commit,
    }),
    /must be configured together/,
  )
})

test('dispatch sends the exact receiver request with the committed SHA', async () => {
  const requests: Array<{ url: string; init: Parameters<DispatchFetch>[1] }> = []
  const fetchImpl: DispatchFetch = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 204, text: async () => '' }
  }
  const result = await dispatchFromEnvironment({
    env: {
      PORTFOLIO_DISPATCH_TOKEN: 'test-token',
      PORTFOLIO_REPOSITORY: 'cekrauseee/portfolio',
    },
    notesCommit: commit,
    fetchImpl,
  })
  assert.deepEqual(result, { enabled: true, status: 204 })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.url, 'https://api.github.com/repos/cekrauseee/portfolio/dispatches')
  assert.deepEqual(request.init.headers, {
    Authorization: 'Bearer test-token',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  })
  assert.deepEqual(JSON.parse(request.init.body), {
    event_type: 'notes-published',
    client_payload: { notes_commit: commit },
  })
})

test('dispatch validates SHA and leaves a failed notification retryable', async () => {
  let calls = 0
  const fetchImpl: DispatchFetch = async () => {
    calls += 1
    return { ok: false, status: 500, text: async () => 'temporary failure' }
  }
  await assert.rejects(
    dispatchFromEnvironment({
      env: {
        PORTFOLIO_DISPATCH_TOKEN: 'test-token',
        PORTFOLIO_REPOSITORY: 'cekrauseee/portfolio',
      },
      notesCommit: 'A'.repeat(40),
      fetchImpl,
    }),
    /40-character lowercase/,
  )
  assert.equal(calls, 0)
  await assert.rejects(
    dispatchFromEnvironment({
      env: {
        PORTFOLIO_DISPATCH_TOKEN: 'test-token',
        PORTFOLIO_REPOSITORY: 'cekrauseee/portfolio',
      },
      notesCommit: commit,
      fetchImpl,
    }),
    /HTTP 500: temporary failure/,
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
  const dispatchIndex = workflow.indexOf('name: dispatch portfolio notes update')
  assert.ok(pushIndex >= 0 && dispatchIndex > pushIndex)
  assert.match(workflow, /git rev-parse HEAD/)
  assert.match(workflow, /PORTFOLIO_DISPATCH_TOKEN/)
  assert.match(workflow, /PORTFOLIO_REPOSITORY/)
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
      workflow.indexOf('dispatch portfolio notes update'),
  )
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /github.run_attempt/)
})
