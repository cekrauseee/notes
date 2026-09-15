import { dispatchFromEnvironment } from './dispatch.js'
import { logger } from './logger.js'

dispatchFromEnvironment()
  .then((result) => {
    logger.info(
      { enabled: result.enabled, status: result.status ?? null },
      'Portfolio deploy hook command completed',
    )
    console.log(
      result.enabled
        ? `portfolio deploy hook sent (${result.status})`
        : 'portfolio deploy hook disabled',
    )
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Portfolio dispatch command failed')
    process.exitCode = 1
  })
