export const MP3_ASSEMBLY_VERSION = 'mp3-frame-assembly-v1'

type Mp3Frame = {
  data: Buffer
  sampleRate: number
  channels: number
  samplesPerFrame: number
  isMetadata: boolean
}

export interface Mp3BlockInfo {
  sampleRate: number
  channels: number
  audioFrames: number
  sampleCount: number
  durationMs: number
}

export interface AssembledMp3 {
  audio: Buffer
  sampleRate: number
  channels: number
  blocks: Mp3BlockInfo[]
  blockStartMs: number[]
  sampleCount: number
  durationMs: number
}

const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
} as const

function syncSafeSize(value: Buffer, offset: number): number {
  return (
    ((value[offset + 6]! & 0x7f) << 21) |
    ((value[offset + 7]! & 0x7f) << 14) |
    ((value[offset + 8]! & 0x7f) << 7) |
    (value[offset + 9]! & 0x7f)
  )
}

function audioStart(value: Buffer): number {
  if (value.length >= 10 && value.subarray(0, 3).toString('ascii') === 'ID3') {
    const footerSize = value[5]! & 0x10 ? 10 : 0
    const end = 10 + syncSafeSize(value, 0) + footerSize
    if (end > value.length) throw new Error('MP3 ID3 metadata extends beyond the audio file.')
    return end
  }
  return 0
}

function parseFrame(value: Buffer, offset: number): Mp3Frame | null {
  if (offset + 4 > value.length) return null
  const first = value[offset]!
  const second = value[offset + 1]!
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null
  const versionBits = (second >> 3) & 0x03
  const layerBits = (second >> 1) & 0x03
  if (versionBits === 1 || layerBits !== 1) return null
  const third = value[offset + 2]!
  const bitrateIndex = (third >> 4) & 0x0f
  const sampleRateIndex = (third >> 2) & 0x03
  const padding = (third >> 1) & 0x01
  const bitrates = versionBits === 3 ? BITRATES_MPEG1 : BITRATES_MPEG2
  const bitrate = bitrates[bitrateIndex]
  const sampleRates = SAMPLE_RATES[versionBits as keyof typeof SAMPLE_RATES]
  const sampleRate = sampleRates?.[sampleRateIndex]
  if (!bitrate || !sampleRate || sampleRateIndex === 3) return null
  const frameLength =
    Math.floor(((versionBits === 3 ? 144_000 : 72_000) * bitrate) / sampleRate) + padding
  if (frameLength < 4 || offset + frameLength > value.length) return null
  const channels = ((value[offset + 3]! >> 6) & 0x03) === 3 ? 1 : 2
  const sideInfoLength = versionBits === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17
  const payloadStart = offset + 4 + sideInfoLength
  const marker = value.subarray(payloadStart, payloadStart + 4).toString('ascii')
  const vbriMarker = value.subarray(offset + 36, offset + 40).toString('ascii')
  return {
    data: value.subarray(offset, offset + frameLength),
    sampleRate,
    channels,
    samplesPerFrame: versionBits === 3 ? 1152 : 576,
    isMetadata: marker === 'Xing' || marker === 'Info' || vbriMarker === 'VBRI',
  }
}

function readBlock(value: Buffer): { frames: Mp3Frame[]; info: Mp3BlockInfo } {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error('MP3 block is empty.')
  const frames: Mp3Frame[] = []
  let offset = audioStart(value)
  while (offset < value.length) {
    if (
      value.length - offset === 128 &&
      value.subarray(offset, offset + 3).toString('ascii') === 'TAG'
    ) {
      offset = value.length
      break
    }
    const frame = parseFrame(value, offset)
    if (!frame) {
      throw new Error(`MP3 block has invalid or unsupported frame data at byte ${offset}.`)
    }
    if (frames.length > 0) frame.isMetadata = false
    frames.push(frame)
    offset += frame.data.length
  }
  const audioFrames = frames.filter((frame) => !frame.isMetadata)
  if (!audioFrames.length) throw new Error('MP3 block has no audio frames.')
  const [first] = audioFrames
  if (!first) throw new Error('MP3 block has no audio frames.')
  if (
    audioFrames.some(
      (frame) => frame.sampleRate !== first.sampleRate || frame.channels !== first.channels,
    )
  ) {
    throw new Error('MP3 block changes sample rate or channel count.')
  }
  const sampleCount = audioFrames.reduce((total, frame) => total + frame.samplesPerFrame, 0)
  return {
    frames,
    info: {
      sampleRate: first.sampleRate,
      channels: first.channels,
      audioFrames: audioFrames.length,
      sampleCount,
      durationMs: (sampleCount * 1000) / first.sampleRate,
    },
  }
}

/**
 * Assemble independently encoded MP3 blocks by validating and joining their
 * MPEG audio frames. ID3/Xing/VBRI wrappers are removed so stale per-block
 * metadata cannot describe the final stream. The block sample counts provide
 * the real timeline used to shift alignment units; no timestamp interpolation
 * or re-encoding is performed.
 */
export function assembleMp3(values: readonly Buffer[]): AssembledMp3 {
  if (!values.length) throw new Error('Cannot assemble an empty MP3 sequence.')
  const parsed = values.map(readBlock)
  const first = parsed[0]!.info
  if (
    parsed.some(
      ({ info }) => info.sampleRate !== first.sampleRate || info.channels !== first.channels,
    )
  ) {
    throw new Error('MP3 blocks must share a sample rate and channel count.')
  }
  const frames = parsed.flatMap(({ frames }) => frames.filter((frame) => !frame.isMetadata))
  const sampleCount = parsed.reduce((total, { info }) => total + info.sampleCount, 0)
  let samplesBefore = 0
  const blockStartMs = parsed.map(({ info }) => {
    const start = Math.round((samplesBefore * 1000) / first.sampleRate)
    samplesBefore += info.sampleCount
    return start
  })
  return {
    audio: Buffer.concat(frames.map((frame) => frame.data)),
    sampleRate: first.sampleRate,
    channels: first.channels,
    blocks: parsed.map(({ info }) => info),
    blockStartMs,
    sampleCount,
    durationMs: Math.ceil((sampleCount * 1000) / first.sampleRate),
  }
}
