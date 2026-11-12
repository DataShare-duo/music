import { describe, expect, it } from 'vitest'
import { sourceNames, time } from './api'

describe('player helpers', () => {
  it('formats durations without padding minutes', () => {
    expect(time(0)).toBe('0:00')
    expect(time(65.9)).toBe('1:05')
    expect(time(-1)).toBe('0:00')
  })
  it('exposes actual source names', () => {
    expect(sourceNames.soda).toBe('汽水音乐')
    expect(sourceNames.netease).toBe('网易云音乐')
  })
})
