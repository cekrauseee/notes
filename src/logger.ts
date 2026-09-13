import pino from 'pino'

const development = process.env.NODE_ENV !== 'production' && process.stderr.isTTY === true
const logLevel = process.env.NOTES_LOG_LEVEL?.trim() || (development ? 'debug' : 'info')

const destination = development
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        colorizeObjects: true,
        destination: 2,
        errorProps: 'name,code',
        levelFirst: true,
        singleLine: false,
        sync: true,
        translateTime: 'SYS:standard',
      },
    })
  : pino.destination({ dest: 2, sync: true })

export const logger = pino(
  {
    level: logLevel,
    name: 'notes-audio',
    redact: {
      censor: '[redacted]',
      paths: [
        'apiKey',
        'blobToken',
        'openAiApiKey',
        'token',
        'authorization',
        '*.apiKey',
        '*.blobToken',
        '*.openAiApiKey',
        '*.token',
        '*.authorization',
      ],
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
)

export function previewText(value: string, limit = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}
