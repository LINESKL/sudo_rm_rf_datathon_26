import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVideoThumbnail } from './useVideoThumbnail'

afterEach(() => vi.restoreAllMocks())

describe('useVideoThumbnail', () => {
  it('captures a frame and the duration of the chosen file, then releases the object URL', () => {
    URL.createObjectURL = vi.fn(() => 'blob:video')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA')
    const create = document.createElement.bind(document)
    let video: HTMLVideoElement | undefined
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = create(tag)
      if (tag === 'video') video = element as HTMLVideoElement
      return element
    })
    const file = new File(['x'], 'kassa.mov', { type: 'video/quicktime' })
    const { result, unmount } = renderHook(() => useVideoThumbnail(file))
    expect(result.current).toBeNull()

    Object.defineProperty(video, 'duration', { value: 20.9 })
    Object.defineProperty(video, 'videoWidth', { value: 1920 })
    Object.defineProperty(video, 'videoHeight', { value: 1080 })
    act(() => {
      video!.dispatchEvent(new Event('loadedmetadata'))
      video!.dispatchEvent(new Event('seeked'))
    })
    expect(result.current).toEqual({ file, thumb: 'data:image/jpeg;base64,AA', duration: 20.9 })
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video')
  })

  it('stays empty when the browser cannot read the file', () => {
    const { result } = renderHook(() => useVideoThumbnail(null))
    expect(result.current).toBeNull()
  })
})
