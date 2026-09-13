import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
