import { describe, expect, it } from 'vitest'
import { timecode } from './timecode'

describe('timecode', () => {
  it.each([
    [0, '00:00,0'],
    [7, '00:07,0'],
    [0.25, '00:00,3'],
    [8.625, '00:08,6'],
    [19.875, '00:19,9'],
    [59.94, '00:59,9'],
    [59.95, '01:00,0'],
    [59.999, '01:00,0'],
    [60, '01:00,0'],
    [3599.999, '60:00,0'],
    [3600, '60:00,0'],
    [3600.125, '60:00,1'],
  ])('formats %s seconds as %s with one decimal and rounding carry', (seconds, expected) => {
    expect(timecode(seconds)).toBe(expected)
  })
})
