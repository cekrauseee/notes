import { logger } from './logger.js'

export interface PortfolioDispatchConfig {
  token: string
  repository: string
}

export interface DispatchResult {
  enabled: boolean
  status?: number
}

export interface DispatchFetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type DispatchFetch = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  },
) => Promise<DispatchFetchResponse>

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

export function readPortfolioDispatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): PortfolioDispatchConfig | null {
  const token = trimmed(env.PORTFOLIO_DISPATCH_TOKEN)
  const repository = trimmed(env.PORTFOLIO_REPOSITORY)
  if (!token && !repository) {
    logger.debug('Portfolio dispatch is disabled')
    return null
  }
  if (!token || !repository) {
    throw new Error(
      'PORTFOLIO_DISPATCH_TOKEN and PORTFOLIO_REPOSITORY must be configured together.',
    )
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      'PORTFOLIO_REPOSITORY must be an owner/repository value such as cekrauseee/portfolio.',
    )
  }
  logger.debug({ repository }, 'Portfolio dispatch is configured')
  return { token, repository }
}

function validateCommit(notesCommit: string): void {
  if (!COMMIT_PATTERN.test(notesCommit)) {
    throw new Error('notes_commit must be a 40-character lowercase Git commit SHA.')
  }
}

export async function sendPortfolioDispatch({
  config,
  notesCommit,
  fetchImpl,
}: {
  config: PortfolioDispatchConfig
  notesCommit: string
  fetchImpl: DispatchFetch
}): Promise<DispatchResult> {
  validateCommit(notesCommit)
  logger.info({ notesCommit, repository: config.repository }, 'Sending portfolio notes update')
  const response = await fetchImpl(`https://api.github.com/repos/${config.repository}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'notes-published',
      client_payload: { notes_commit: notesCommit },
    }),
  })
  if (!response.ok) {
    const details = (await response.text()).trim().slice(0, 500)
    throw new Error(
      `Portfolio repository dispatch failed with HTTP ${response.status}${details ? `: ${details}` : '.'}`,
    )
  }
  logger.info(
    { repository: config.repository, status: response.status },
    'Portfolio notes update sent',
  )
  return { enabled: true, status: response.status }
}

export async function dispatchFromEnvironment({
  env = process.env,
  notesCommit,
  fetchImpl = fetch as unknown as DispatchFetch,
}: {
  env?: NodeJS.ProcessEnv
  notesCommit?: string
  fetchImpl?: DispatchFetch
} = {}): Promise<DispatchResult> {
  const config = readPortfolioDispatchConfig(env)
  if (!config) return { enabled: false }
  if (!notesCommit)
    throw new Error('A committed notes revision is required when portfolio dispatch is configured.')
  return sendPortfolioDispatch({ config, notesCommit, fetchImpl })
}
