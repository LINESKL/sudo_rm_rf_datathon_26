import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoneDetails, JobDetails } from '@/api/contracts'
import { getJobDetails, uploadVideo } from '@/api/client'
import { VideoPreview, type VideoPreviewHandle } from './VideoPreview'

vi.mock('@/api/client', async (importActual) => ({
  ...(await importActual<typeof import('@/api/client')>()),
  getJobDetails: vi.fn(),
  uploadVideo: vi.fn(),
}))

const API_KEY = 'preview-test-key'
const VIDEO_LABEL = 'Плеер загруженного видео'

function result(overrides: Partial<DoneDetails> = {}): DoneDetails {
  return {
    job_id: 'preview-job',
    status: 'done',
    verdict: 'no_violation',
    violations: [],
    duration_sec: 120,
    processing_sec: 8,
    degraded: false,
    preview_url: '/previews/preview-job.mp4',
    ...overrides,
  }
}

function video() {
  return screen.getByLabelText(VIDEO_LABEL) as HTMLVideoElement
}

function loadMetadata(element: HTMLVideoElement, duration = 120) {
  Object.defineProperty(element, 'duration', { configurable: true, value: duration })
  Object.defineProperty(element, 'readyState', { configurable: true, value: 1 })
  fireEvent.loadedMetadata(element)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(getJobDetails).mockReset()
  vi.mocked(uploadVideo).mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VideoPreview', () => {
  it('uses the same-origin preview with native media controls and no automatic refresh', () => {
    render(<VideoPreview result={result()} apiKey={API_KEY} />)
    const element = video()
    expect(element).toHaveAttribute('controls')
    expect(element).toHaveAttribute('playsinline')
    expect(element).toHaveAttribute('preload', 'metadata')
    expect(new URL(element.getAttribute('src')!, location.href).href).toBe(
      `${location.origin}/previews/preview-job.mp4`,
    )
    expect(element.getAttribute('src')).not.toContain(API_KEY)
    expect(getJobDetails).not.toHaveBeenCalled()
    expect(uploadVideo).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    null,
    'https://untrusted.example/previews/preview-job.mp4',
    '//untrusted.example/previews/preview-job.mp4',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    '/api/v1/jobs/preview-job/details',
    '/previews/preview-job.mp4?api_key=preview-test-key',
    '/previews/preview-job.mp4#preview-test-key',
  ])('does not create a media request for an absent or unsafe preview: %s', (previewUrl) => {
    const availability = vi.fn()
    render(
      <VideoPreview
        result={result({ preview_url: previewUrl })}
        apiKey={API_KEY}
        onAvailabilityChange={availability}
      />,
    )
    expect(screen.queryByLabelText(VIDEO_LABEL)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /недоступ|не.*доступ|отсутств|не.*подготов/i,
    )
    expect(availability).not.toHaveBeenCalledWith(true)
    expect(getJobDetails).not.toHaveBeenCalled()
  })

  it('reports a media error without silently requesting new access', () => {
    const availability = vi.fn()
    const position = vi.fn()
    render(
      <VideoPreview
        result={result()}
        apiKey={API_KEY}
        onAvailabilityChange={availability}
        onPositionChange={position}
      />,
    )
    loadMetadata(video())
    fireEvent.error(video())
    expect(screen.getByRole('alert')).toHaveTextContent(/видео|просмотр|воспроизвед/i)
    expect(screen.getByRole('button', { name: 'Обновить доступ к видео' })).toBeEnabled()
    expect(availability).toHaveBeenLastCalledWith(false)
    expect(position).toHaveBeenLastCalledWith(null)
    expect(getJobDetails).not.toHaveBeenCalled()
    expect(uploadVideo).not.toHaveBeenCalled()
  })

  it('queues the supplied context target until metadata and does not subtract another second', async () => {
    const ref = createRef<VideoPreviewHandle>()
    render(<VideoPreview ref={ref} result={result()} apiKey={API_KEY} />)
    const element = video()

    act(() => ref.current!.seek(41.625))
    expect(element.currentTime).toBe(0)
    expect(element.play).not.toHaveBeenCalled()
    loadMetadata(element)
    await waitFor(() => expect(element.currentTime).toBe(41.625))
    expect(element.play).toHaveBeenCalledOnce()
  })

  it('uses the most recent pending seek when several events are selected before metadata', async () => {
    const ref = createRef<VideoPreviewHandle>()
    render(<VideoPreview ref={ref} result={result()} apiKey={API_KEY} />)
    act(() => {
      ref.current!.seek(15)
      ref.current!.seek(65.5)
    })
    loadMetadata(video())
    await waitFor(() => expect(video().currentTime).toBe(65.5))
    expect(video().play).toHaveBeenCalledOnce()
  })

  it.each([
    { target: -10, expected: 0 },
    { target: 70, expected: 30 },
  ])('clamps seek $target to the actual media duration', async ({ target, expected }) => {
    const ref = createRef<VideoPreviewHandle>()
    render(<VideoPreview ref={ref} result={result({ duration_sec: 120 })} apiKey={API_KEY} />)
    loadMetadata(video(), 30)
    act(() => ref.current!.seek(target))
    await waitFor(() => expect(video().currentTime).toBe(expected))
    expect(video().play).toHaveBeenCalledOnce()
  })

  it('makes a rejected play request visible instead of claiming playback started', async () => {
    const ref = createRef<VideoPreviewHandle>()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('Playback blocked', 'NotAllowedError'),
    )
    render(<VideoPreview ref={ref} result={result()} apiKey={API_KEY} />)
    loadMetadata(video())
    await act(async () => ref.current!.seek(20))
    expect(screen.getByRole('status')).toHaveTextContent(/воспроизвед|видео/i)
    expect(
      screen.queryByText(/воспроизведение начато|видео воспроизводится/i),
    ).not.toBeInTheDocument()
    expect(getJobDetails).not.toHaveBeenCalled()
  })

  it('reports actual media positions for synchronizing the result cards', () => {
    const position = vi.fn()
    const availability = vi.fn()
    render(
      <VideoPreview
        result={result()}
        apiKey={API_KEY}
        onPositionChange={position}
        onAvailabilityChange={availability}
      />,
    )
    const element = video()
    loadMetadata(element)
    element.currentTime = 18.625
    fireEvent.timeUpdate(element)
    expect(position).toHaveBeenLastCalledWith(18.625)
    fireEvent.error(element)
    expect(availability).toHaveBeenLastCalledWith(false)
    expect(position).toHaveBeenLastCalledWith(null)
  })

  it.each(['/previews/preview-job.mp4', '/previews/refreshed-preview.mp4'])(
    'refreshes through GET once and restores time only on the new video metadata: %s',
    async (previewUrl) => {
      const user = userEvent.setup()
      const pending = deferred<JobDetails>()
      const availability = vi.fn()
      vi.mocked(getJobDetails).mockReturnValueOnce(pending.promise)
      render(
        <VideoPreview result={result()} apiKey={API_KEY} onAvailabilityChange={availability} />,
      )
      const oldVideo = video()
      const oldLoad = vi.spyOn(oldVideo, 'load')
      loadMetadata(oldVideo)
      oldVideo.currentTime = 42.5
      fireEvent.timeUpdate(oldVideo)
      fireEvent.error(oldVideo)
      expect(availability).toHaveBeenLastCalledWith(false)

      await user.dblClick(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
      const refreshing = screen.getByRole('button', { name: 'Обновляем доступ…' })
      expect(refreshing).toBeDisabled()
      expect(getJobDetails).toHaveBeenCalledExactlyOnceWith(
        'preview-job',
        API_KEY,
        expect.any(AbortSignal),
      )
      expect(uploadVideo).not.toHaveBeenCalled()
      expect(oldLoad).not.toHaveBeenCalled()

      await act(async () => {
        pending.resolve(result({ preview_url: previewUrl }))
        await pending.promise
      })
      const newVideo = video()
      expect(newVideo).not.toBe(oldVideo)
      expect(new URL(newVideo.getAttribute('src')!, location.href).pathname).toBe(previewUrl)
      expect(oldLoad).not.toHaveBeenCalled()
      expect(newVideo.currentTime).toBe(0)
      loadMetadata(newVideo)
      await waitFor(() => expect(newVideo.currentTime).toBe(42.5))
      expect(availability).toHaveBeenLastCalledWith(true)
      expect(screen.getByRole('button', { name: 'Обновить доступ к видео' })).toBeEnabled()
    },
  )

  it('preserves the pending restore position across a second refresh before metadata', async () => {
    const user = userEvent.setup()
    vi.mocked(getJobDetails).mockResolvedValueOnce(result()).mockResolvedValueOnce(result())
    render(<VideoPreview result={result()} apiKey={API_KEY} />)
    const originalVideo = video()
    loadMetadata(originalVideo)
    originalVideo.currentTime = 1.95
    fireEvent.timeUpdate(originalVideo)

    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    const intermediateVideo = video()
    expect(intermediateVideo).not.toBe(originalVideo)
    expect(intermediateVideo.readyState).toBe(0)
    expect(intermediateVideo.currentTime).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    const restoredVideo = video()
    expect(restoredVideo).not.toBe(intermediateVideo)
    expect(getJobDetails).toHaveBeenCalledTimes(2)
    loadMetadata(restoredVideo)
    await waitFor(() => expect(restoredVideo.currentTime).toBe(1.95))
  })

  it('restores the last known position when a media error resets an unloaded video to zero', async () => {
    const user = userEvent.setup()
    vi.mocked(getJobDetails).mockResolvedValueOnce(result())
    render(<VideoPreview result={result()} apiKey={API_KEY} />)
    const originalVideo = video()
    loadMetadata(originalVideo)
    originalVideo.currentTime = 1.95
    fireEvent.timeUpdate(originalVideo)

    Object.defineProperty(originalVideo, 'readyState', { configurable: true, value: 0 })
    originalVideo.currentTime = 0
    fireEvent.error(originalVideo)
    expect(screen.getByRole('alert')).toHaveTextContent(/не загрузилось|доступ истёк/i)
    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    const restoredVideo = video()
    expect(restoredVideo).not.toBe(originalVideo)
    expect(getJobDetails).toHaveBeenCalledOnce()
    loadMetadata(restoredVideo)
    await waitFor(() => expect(restoredVideo.currentTime).toBe(1.95))
  })

  it('preserves the last confirmed position when an unloaded timeupdate precedes a media error', async () => {
    const user = userEvent.setup()
    vi.mocked(getJobDetails).mockResolvedValueOnce(result())
    render(<VideoPreview result={result()} apiKey={API_KEY} />)
    const originalVideo = video()
    loadMetadata(originalVideo)
    originalVideo.currentTime = 1.95
    fireEvent.timeUpdate(originalVideo)

    Object.defineProperty(originalVideo, 'readyState', { configurable: true, value: 0 })
    originalVideo.currentTime = 0
    fireEvent.timeUpdate(originalVideo)
    fireEvent.error(originalVideo)

    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    const restoredVideo = video()
    expect(restoredVideo).not.toBe(originalVideo)
    expect(getJobDetails).toHaveBeenCalledOnce()
    loadMetadata(restoredVideo)
    await waitFor(() => expect(restoredVideo.currentTime).toBe(1.95))
  })

  it.each([
    {
      job_id: 'preview-job',
      status: 'processing',
      progress: { stage: 'scene', value: 0.5 },
      stages: [],
    },
    { job_id: 'preview-job', status: 'failed', error: 'Проверка завершилась ошибкой.' },
    result({ preview_url: null }),
    result({ preview_url: 'https://untrusted.example/previews/preview-job.mp4' }),
  ] satisfies JobDetails[])(
    'keeps an invalid refreshed result unavailable: $status',
    async (response) => {
      const user = userEvent.setup()
      const availability = vi.fn()
      vi.mocked(getJobDetails).mockResolvedValueOnce(response)
      render(
        <VideoPreview result={result()} apiKey={API_KEY} onAvailabilityChange={availability} />,
      )
      fireEvent.error(video())
      await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Обновить доступ к видео' })).toBeEnabled(),
      )
      expect(screen.getByRole('alert')).toHaveTextContent(/не|недоступ|ошиб/i)
      expect(availability).toHaveBeenLastCalledWith(false)
      expect(getJobDetails).toHaveBeenCalledOnce()
      expect(uploadVideo).not.toHaveBeenCalled()
    },
  )

  it('shows a failed manual refresh and allows another explicit retry', async () => {
    const user = userEvent.setup()
    vi.mocked(getJobDetails).mockRejectedValueOnce(new Error('Не удалось связаться с сервисом.'))
    render(<VideoPreview result={result()} apiKey={API_KEY} />)
    fireEvent.error(video())
    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось|недоступ/i)
    expect(screen.getByRole('button', { name: 'Обновить доступ к видео' })).toBeEnabled()
    expect(getJobDetails).toHaveBeenCalledOnce()
  })

  it('cancels queued autoplay while refresh is pending and after refresh fails', async () => {
    const user = userEvent.setup()
    const ref = createRef<VideoPreviewHandle>()
    let rejectRefresh!: (reason: Error) => void
    const pending = new Promise<JobDetails>((_resolve, reject) => {
      rejectRefresh = reject
    })
    vi.mocked(getJobDetails).mockReturnValueOnce(pending)
    render(<VideoPreview ref={ref} result={result()} apiKey={API_KEY} />)
    const oldVideo = video()
    act(() => ref.current!.seek(15))
    expect(oldVideo.play).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    expect(screen.getByRole('button', { name: 'Обновляем доступ…' })).toBeDisabled()
    expect(oldVideo.pause).toHaveBeenCalledOnce()
    try {
      loadMetadata(oldVideo)
      expect(oldVideo.play).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        rejectRefresh(new Error('Не удалось обновить доступ к видео.'))
        await pending.catch(() => {})
      })
    }

    fireEvent.canPlay(oldVideo)
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось обновить доступ к видео.')
    expect(oldVideo.play).not.toHaveBeenCalled()
    expect(oldVideo.pause).toHaveBeenCalledOnce()
    expect(getJobDetails).toHaveBeenCalledOnce()
  })

  it('aborts manual refresh on unmount and ignores a transport completion after cancellation', async () => {
    const user = userEvent.setup()
    const pending = deferred<JobDetails>()
    const position = vi.fn()
    const availability = vi.fn()
    vi.mocked(getJobDetails).mockReturnValueOnce(pending.promise)
    const view = render(
      <VideoPreview
        result={result()}
        apiKey={API_KEY}
        onPositionChange={position}
        onAvailabilityChange={availability}
      />,
    )
    fireEvent.error(video())
    await user.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    const signal = vi.mocked(getJobDetails).mock.calls[0][2]
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    const positionCalls = position.mock.calls.length
    const availabilityCalls = availability.mock.calls.length

    await act(async () => {
      pending.resolve(result({ preview_url: '/previews/late-preview.mp4' }))
      await pending.promise
    })
    expect(position).toHaveBeenCalledTimes(positionCalls)
    expect(availability).toHaveBeenCalledTimes(availabilityCalls)
    expect(screen.queryByLabelText(VIDEO_LABEL)).not.toBeInTheDocument()
  })
})
