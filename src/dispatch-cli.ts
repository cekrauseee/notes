import { dispatchFromEnvironment } from './dispatch.js'
import { logger } from './logger.js'

const dispatchOptions = process.env.NOTES_COMMIT ? { notesCommit: process.env.NOTES_COMMIT } : {}

dispatchFromEnvironment(dispatchOptions)
  .then((result) => {
    logger.info(
      { enabled: result.enabled, status: result.status ?? null },
      'Portfolio dispatch command completed',
    )
    console.log(
      result.enabled ? `portfolio dispatch sent (${result.status})` : 'portfolio dispatch disabled',
    )
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Portfolio dispatch command failed')
    process.exitCode = 1
  })
