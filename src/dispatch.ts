import { logger } from './logger.js'

export interface PortfolioDispatchConfig {
  deployHookUrl: string
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
    headers?: Record<string, string>
    body?: string
  },
) => Promise<DispatchFetchResponse>

const DEPLOY_HOOK_PATH_PATTERN = /^\/v1\/integrations\/deploy\/[^/]+\/[^/]+$/u

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

function isVercelDeployHookUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.vercel.com' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      DEPLOY_HOOK_PATH_PATTERN.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function readPortfolioDispatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): PortfolioDispatchConfig | null {
  const deployHookUrl = trimmed(env.VERCEL_DEPLOY_HOOK_URL)
  if (!deployHookUrl) {
    logger.debug('Portfolio deploy hook is disabled')
    return null
  }
  if (!isVercelDeployHookUrl(deployHookUrl)) {
    throw new Error(
      'VERCEL_DEPLOY_HOOK_URL must be an HTTPS Vercel deploy hook URL for api.vercel.com.',
    )
  }
  logger.debug('Portfolio Vercel deploy hook is configured')
  return { deployHookUrl }
}

export async function sendPortfolioDispatch({
  config,
  fetchImpl,
}: {
  config: PortfolioDispatchConfig
  fetchImpl: DispatchFetch
}): Promise<DispatchResult> {
  logger.info('Triggering portfolio Vercel deploy hook')
  const response = await fetchImpl(config.deployHookUrl, {
    method: 'POST',
  })
  if (!response.ok) {
    const details = (await response.text()).trim().slice(0, 500)
    throw new Error(
      `Portfolio Vercel deploy hook failed with HTTP ${response.status}${details ? `: ${details}` : '.'}`,
    )
  }
  logger.info({ status: response.status }, 'Portfolio Vercel deploy hook triggered')
  return { enabled: true, status: response.status }
}

export async function dispatchFromEnvironment({
  env = process.env,
  fetchImpl = fetch as unknown as DispatchFetch,
}: {
  env?: NodeJS.ProcessEnv
  fetchImpl?: DispatchFetch
} = {}): Promise<DispatchResult> {
  const config = readPortfolioDispatchConfig(env)
  if (!config) return { enabled: false }
  return sendPortfolioDispatch({ config, fetchImpl })
}
