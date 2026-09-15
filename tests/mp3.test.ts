import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleMp3 } from '../src/mp3.js'

function frame(sampleRate = 44_100, marker = ''): Buffer {
  const frameLength = Math.floor((144_000 * 128) / sampleRate)
  const value = Buffer.alloc(frameLength)
  value[0] = 0xff
  value[1] = 0xfb
  value[2] = sampleRate === 48_000 ? 0x94 : 0x90
  value[3] = 0x40
  if (marker) value.write(marker, 36, 'ascii')
  return value
}

function id3(size: number): Buffer {
  const value = Buffer.alloc(10 + size)
  value.write('ID3', 0, 'ascii')
  value[3] = 4
  value[6] = (size >> 21) & 0x7f
  value[7] = (size >> 14) & 0x7f
  value[8] = (size >> 7) & 0x7f
  value[9] = size & 0x7f
  return value
}

test('MP3 assembly removes per-block metadata and uses real frame timeline', () => {
  const first = Buffer.concat([id3(3), frame(44_100, 'Info'), frame(), frame()])
  const second = Buffer.concat([frame(), frame(), frame()])
  const assembled = assembleMp3([first, second])
  const frameLength = 417
  assert.equal(assembled.audio.length, frameLength * 5)
  assert.equal(assembled.blocks[0]?.audioFrames, 2)
  assert.equal(assembled.blocks[1]?.audioFrames, 3)
  assert.deepEqual(assembled.blockStartMs, [0, Math.round((2 * 1152 * 1000) / 44_100)])
  assert.equal(assembled.durationMs, Math.ceil((5 * 1152 * 1000) / 44_100))
})

test('MP3 assembly rejects incompatible block streams and malformed frames', () => {
  assert.throws(() => assembleMp3([frame(44_100), frame(48_000)]), /sample rate and channel count/)
  assert.throws(() => assembleMp3([Buffer.from('not-mp3')]), /invalid or unsupported frame/)
})
