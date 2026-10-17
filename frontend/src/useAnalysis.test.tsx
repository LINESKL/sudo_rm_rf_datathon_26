import type { PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getJobDetails, uploadVideo } from './api/client'
import type { DoneDetails, JobDetails, ProcessingDetails } from './api/contracts'
import { useAnalysis } from './useAnalysis'

vi.mock('./api/client', () => ({
  getJobDetails: vi.fn(),
  uploadVideo: vi.fn(),
}))

const clients: QueryClient[] = []
const file = new File(['video'], 'camera.mp4', { type: 'video/mp4' })

function processing(jobId = 'job-1'): ProcessingDetails {
  return {
    job_id: jobId,
    status: 'processing',
    progress: { stage: 'scene', value: 0.55 },
    stages: [{ id: 'scene', title: 'Анализ сцены' }],
  }
}

function done(jobId = 'job-1'): DoneDetails {
  return {
    job_id: jobId,
    status: 'done',
    verdict: 'no_violation',
    violations: [],
    rules_checked: 13,
    processing_sec: 74.2,
    duration_sec: 20.9,
    preview_url: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function renderAnalysis() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  clients.push(client)
  return renderHook(useAnalysis, {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

async function advance(milliseconds = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
  vi.mocked(uploadVideo).mockReset().mockResolvedValue({ job_id: 'job-1' })
  vi.mocked(getJobDetails).mockReset().mockResolvedValue(processing())
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  clients.forEach((client) => client.clear())
  clients.length = 0
  onlineManager.setOnline(true)
  vi.useRealTimers()
})

describe('useAnalysis', () => {
  it('polls every 1500 ms while processing and stops when the result is ready', async () => {
    vi.mocked(getJobDetails).mockResolvedValueOnce(processing()).mockResolvedValue(done())
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()

    expect(result.current.details?.status).toBe('processing')
    expect(result.current.busy).toBe(true)
    expect(getJobDetails).toHaveBeenCalledExactlyOnceWith(
      'job-1',
      'bank-key',
      expect.any(AbortSignal),
    )
    await advance(1498)
    expect(getJobDetails).toHaveBeenCalledTimes(1)
    await advance(2)
    expect(getJobDetails).toHaveBeenCalledTimes(2)
    expect(result.current.done).toBe(true)
    expect(result.current.busy).toBe(false)
    expect(result.current.details).toEqual(done())
    expect(result.current.elapsedSeconds).toBe(1)

    await advance(6000)
    expect(getJobDetails).toHaveBeenCalledTimes(2)
    expect(result.current.elapsedSeconds).toBe(1)
  })

  it('counts a slow upload in the full duration and job start timestamp', async () => {
    const upload = deferred<{ job_id: string }>()
    vi.mocked(uploadVideo).mockReturnValue(upload.promise)
    const { result } = renderAnalysis()
    const started = Date.now()
    let start!: Promise<void>
    act(() => {
      start = result.current.start(file, 'bank-key')
    })
    await advance(10_500)
    expect(result.current.uploading).toBe(true)
    expect(result.current.elapsedSeconds).toBe(10)

    await act(async () => {
      upload.resolve({ job_id: 'job-1' })
      await start
    })
    await advance()
    expect(result.current.job?.started).toBe(started)
    expect(result.current.elapsedSeconds).toBe(10)
    await advance(2000)
    expect(result.current.elapsedSeconds).toBe(12)
  })

  it('recovers from an upload error when the user starts again', async () => {
    vi.mocked(uploadVideo).mockRejectedValueOnce(new Error('Не удалось отправить видео.'))
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    expect(result.current.error?.message).toBe('Не удалось отправить видео.')
    expect(result.current.busy).toBe(false)
    expect(getJobDetails).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()
    expect(uploadVideo).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.details?.status).toBe('processing')
    expect(result.current.busy).toBe(true)
  })

  it('retries a failed status request for the same job without uploading again', async () => {
    vi.mocked(getJobDetails)
      .mockRejectedValueOnce(new Error('Проверьте соединение.'))
      .mockResolvedValue(done())
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    const started = result.current.job?.started
    await advance()
    expect(result.current.statusError).toBe(true)
    expect(result.current.error?.message).toBe('Проверьте соединение.')
    await advance(6000)
    expect(getJobDetails).toHaveBeenCalledTimes(1)
    expect(result.current.elapsedSeconds).toBe(6)

    act(() => {
      result.current.retryStatus('bank-key')
    })
    await advance()
    expect(uploadVideo).toHaveBeenCalledTimes(1)
    expect(getJobDetails).toHaveBeenCalledTimes(2)
    expect(getJobDetails).toHaveBeenLastCalledWith('job-1', 'bank-key', expect.any(AbortSignal))
    expect(result.current.job?.id).toBe('job-1')
    expect(result.current.job?.started).toBe(started)
    expect(result.current.elapsedSeconds).toBe(6)
    expect(result.current.done).toBe(true)
    expect(result.current.error).toBeNull()
    await advance(6000)
    expect(result.current.elapsedSeconds).toBe(6)
  })

  it('keeps the job timestamp and elapsed time when retrying with a corrected key', async () => {
    vi.mocked(getJobDetails)
      .mockRejectedValueOnce(new Error('API-ключ не принят.'))
      .mockResolvedValue(processing())
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'old-key')
    })
    const started = result.current.job?.started
    await advance(12_345)
    expect(result.current.statusError).toBe(true)
    expect(result.current.elapsedSeconds).toBe(12)

    act(() => {
      result.current.retryStatus('corrected-key')
    })
    await advance()
    expect(result.current.job).toEqual({ id: 'job-1', key: 'corrected-key', started })
    expect(result.current.elapsedSeconds).toBe(12)
    expect(uploadVideo).toHaveBeenCalledTimes(1)
    expect(getJobDetails).toHaveBeenLastCalledWith(
      'job-1',
      'corrected-key',
      expect.any(AbortSignal),
    )
    await advance(2000)
    expect(result.current.elapsedSeconds).toBe(14)
  })

  it('starts a new upload after the service reports a failed analysis', async () => {
    vi.mocked(uploadVideo)
      .mockResolvedValueOnce({ job_id: 'failed-job' })
      .mockResolvedValue({ job_id: 'new-job' })
    vi.mocked(getJobDetails)
      .mockResolvedValueOnce({
        job_id: 'failed-job',
        status: 'failed',
        error: 'Видео не декодируется.',
      })
      .mockResolvedValue(processing('new-job'))
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()
    expect(result.current.error?.message).toBe('Видео не декодируется.')
    expect(result.current.statusError).toBe(false)
    expect(result.current.busy).toBe(false)
    expect(result.current.elapsedSeconds).toBe(0)
    await advance(6000)
    expect(getJobDetails).toHaveBeenCalledTimes(1)
    expect(result.current.elapsedSeconds).toBe(0)

    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()
    expect(uploadVideo).toHaveBeenCalledTimes(2)
    expect(result.current.job?.id).toBe('new-job')
    expect(result.current.details).toEqual(processing('new-job'))
    expect(result.current.error).toBeNull()
    expect(result.current.elapsedSeconds).toBe(0)
  })

  it('cancels a reset upload and prevents its late completion from replacing a new job', async () => {
    const oldUpload = deferred<{ job_id: string }>()
    vi.mocked(uploadVideo)
      .mockReturnValueOnce(oldUpload.promise)
      .mockResolvedValue({ job_id: 'new-job' })
    vi.mocked(getJobDetails).mockResolvedValue(processing('new-job'))
    const { result } = renderAnalysis()
    let firstStart!: Promise<void>
    act(() => {
      firstStart = result.current.start(file, 'bank-key')
    })
    const oldSignal = vi.mocked(uploadVideo).mock.calls[0][3]
    expect(result.current.uploading).toBe(true)
    await advance(11_000)
    expect(result.current.elapsedSeconds).toBe(11)

    act(() => {
      result.current.reset()
    })
    expect(oldSignal.aborted).toBe(true)
    expect(result.current.uploading).toBe(false)
    expect(result.current.job).toBeNull()
    expect(result.current.elapsedSeconds).toBe(0)
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()
    await act(async () => {
      oldUpload.resolve({ job_id: 'old-job' })
      await firstStart
    })
    await advance()
    expect(result.current.job?.id).toBe('new-job')
    expect(result.current.details).toEqual(processing('new-job'))
    expect(getJobDetails).toHaveBeenCalledExactlyOnceWith(
      'new-job',
      'bank-key',
      expect.any(AbortSignal),
    )
    await advance(2000)
    expect(result.current.elapsedSeconds).toBe(2)
  })

  it('cancels a reset status request and ignores its stale result', async () => {
    const oldDetails = deferred<JobDetails>()
    vi.mocked(uploadVideo)
      .mockResolvedValueOnce({ job_id: 'old-job' })
      .mockResolvedValue({ job_id: 'new-job' })
    vi.mocked(getJobDetails)
      .mockReturnValueOnce(oldDetails.promise)
      .mockResolvedValue(processing('new-job'))
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    const oldSignal = vi.mocked(getJobDetails).mock.calls[0][2]
    await advance(5000)
    expect(result.current.elapsedSeconds).toBe(5)

    act(() => {
      result.current.reset()
    })
    expect(oldSignal.aborted).toBe(true)
    expect(result.current.details).toBeUndefined()
    expect(result.current.elapsedSeconds).toBe(0)
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance()
    await act(async () => {
      oldDetails.resolve(done('old-job'))
    })
    await advance()
    expect(result.current.job?.id).toBe('new-job')
    expect(result.current.details).toEqual(processing('new-job'))
    expect(result.current.done).toBe(false)
    await advance(2000)
    expect(result.current.elapsedSeconds).toBe(2)
  })

  it('lets the user resume status requests after the five-minute limit', async () => {
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    const started = result.current.job?.started
    await advance()
    await advance(301_500)
    expect(result.current.statusError).toBe(true)
    expect(result.current.error?.message).toContain('пяти минут')
    expect(result.current.busy).toBe(false)
    expect(result.current.elapsedSeconds).toBe(301)
    const callsAtTimeout = vi.mocked(getJobDetails).mock.calls.length
    await advance(6000)
    expect(getJobDetails).toHaveBeenCalledTimes(callsAtTimeout)
    expect(result.current.elapsedSeconds).toBe(307)

    vi.mocked(getJobDetails).mockResolvedValue(done())
    act(() => {
      result.current.retryStatus('bank-key')
    })
    await advance()
    expect(uploadVideo).toHaveBeenCalledTimes(1)
    expect(result.current.job?.id).toBe('job-1')
    expect(result.current.job?.started).toBe(started)
    expect(result.current.elapsedSeconds).toBe(307)
    expect(result.current.done).toBe(true)
    expect(result.current.error).toBeNull()
    await advance(6000)
    expect(result.current.elapsedSeconds).toBe(307)
  })

  it('includes upload time in the first timeout, then grants a fresh status budget', async () => {
    const upload = deferred<{ job_id: string }>()
    vi.mocked(uploadVideo).mockReturnValue(upload.promise)
    const { result } = renderAnalysis()
    const started = Date.now()
    let start!: Promise<void>
    act(() => {
      start = result.current.start(file, 'bank-key')
    })
    await advance(60_000)
    await act(async () => {
      upload.resolve({ job_id: 'job-1' })
      await start
    })
    await advance(241_501)
    expect(result.current.statusError).toBe(true)
    expect(result.current.job?.started).toBe(started)
    expect(result.current.elapsedSeconds).toBe(301)
    const callsAtTimeout = vi.mocked(getJobDetails).mock.calls.length

    act(() => {
      result.current.retryStatus('bank-key')
    })
    await advance()
    expect(result.current.statusError).toBe(false)
    expect(result.current.details?.status).toBe('processing')
    expect(result.current.elapsedSeconds).toBe(301)
    await advance(1500)
    expect(getJobDetails).toHaveBeenCalledTimes(callsAtTimeout + 2)
    expect(result.current.job?.started).toBe(started)
    expect(result.current.elapsedSeconds).toBe(303)
    expect(uploadVideo).toHaveBeenCalledTimes(1)
  })

  it('freezes the elapsed time when the service completes a delayed failed analysis', async () => {
    const details = deferred<JobDetails>()
    vi.mocked(getJobDetails).mockReturnValue(details.promise)
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, 'bank-key')
    })
    await advance(5500)
    expect(result.current.elapsedSeconds).toBe(5)
    await act(async () => {
      details.resolve({ job_id: 'job-1', status: 'failed', error: 'Видео не декодируется.' })
    })
    await advance()
    await advance(6000)
    expect(result.current.error?.message).toBe('Видео не декодируется.')
    expect(result.current.elapsedSeconds).toBe(5)
  })

  it.each(['done', 'error'] as const)(
    'requests the local service while the browser is offline: %s',
    async (outcome) => {
      onlineManager.setOnline(false)
      if (outcome === 'done') vi.mocked(getJobDetails).mockResolvedValue(done())
      else vi.mocked(getJobDetails).mockRejectedValue(new Error('Сервис недоступен.'))
      const { result } = renderAnalysis()
      await act(async () => {
        await result.current.start(file, 'bank-key')
      })
      await advance()
      expect(getJobDetails).toHaveBeenCalledExactlyOnceWith(
        'job-1',
        'bank-key',
        expect.any(AbortSignal),
      )
      expect(result.current.busy).toBe(false)
      if (outcome === 'done') expect(result.current.done).toBe(true)
      else expect(result.current.error?.message).toBe('Сервис недоступен.')
    },
  )
})

describe('useAnalysis job link', () => {
  it('puts the job into the address after upload and clears it on reset', async () => {
    const { result } = renderAnalysis()
    await act(async () => {
      await result.current.start(file, '')
    })
    expect(window.location.search).toBe('?job=job-1')
    act(() => result.current.reset())
    expect(window.location.search).toBe('')
  })

  it('resumes polling for the job named in the address after a reload', async () => {
    window.history.replaceState(null, '', '/?job=abc-123')
    vi.mocked(getJobDetails).mockResolvedValue(done('abc-123'))
    const { result } = renderAnalysis()
    await advance()
    expect(getJobDetails).toHaveBeenCalledWith('abc-123', '', expect.any(AbortSignal))
    expect(result.current.done).toBe(true)
    expect(uploadVideo).not.toHaveBeenCalled()
  })

  it('ignores a malformed job id in the address', async () => {
    window.history.replaceState(null, '', '/?job=../../etc')
    const { result } = renderAnalysis()
    await advance()
    expect(result.current.job).toBeNull()
    expect(getJobDetails).not.toHaveBeenCalled()
  })
})
