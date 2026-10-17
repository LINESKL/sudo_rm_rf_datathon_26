import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import doneDetails from '../../../docs/frontend/mock_details.json'
import cleanDetails from '../../../docs/frontend/mock_details_clean.json'
import processingDetails from '../../../docs/frontend/mock_details_processing.json'
import { ApiError, getJobDetails, MAX_VIDEO_BYTES, uploadVideo, validateVideo } from './client'

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []
  status = 0
  responseText = ''
  timeout = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => this.onabort?.())

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  respond(body: unknown, status = 200) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

function lastUpload() {
  return FakeXMLHttpRequest.instances.at(-1)!
}

function video(name = 'camera.mp4', size = 1) {
  const file = new File(['v'], name, { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response
}

function abortableFetch() {
  vi.mocked(fetch).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      }),
  )
}

beforeEach(() => {
  FakeXMLHttpRequest.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('validateVideo', () => {
  it.each(['camera.mp4', 'camera.MP4', 'camera.mov', 'camera.MoV'])('accepts %s', (name) => {
    expect(validateVideo(video(name))).toBeNull()
  })

  it('accepts the size limit and rejects the next byte', () => {
    expect(validateVideo(video('camera.mp4', MAX_VIDEO_BYTES))).toBeNull()
    expect(validateVideo(video('camera.mp4', MAX_VIDEO_BYTES + 1))).toContain('200 МБ')
  })

  it('rejects empty files and unsupported extensions', () => {
    expect(validateVideo(video('camera.mp4', 0))).toContain('пустой')
    expect(validateVideo(video('camera.mp4.exe'))).toContain('.mov или .mp4')
    expect(validateVideo(video('camera'))).not.toBeNull()
  })
})

describe('uploadVideo', () => {
  it('sends multipart video and key, reports progress, and returns the job ID', async () => {
    const file = video()
    const onProgress = vi.fn()
    const controller = new AbortController()
    const request = uploadVideo(file, 'bank-key', onProgress, controller.signal)
    const xhr = lastUpload()

    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/v1/analyze')
    expect(xhr.setRequestHeader).toHaveBeenCalledExactlyOnceWith('X-API-Key', 'bank-key')
    expect(xhr.timeout).toBe(120_000)
    expect(xhr.send.mock.calls[0][0]).toBeInstanceOf(FormData)
    expect((xhr.send.mock.calls[0][0] as FormData).get('file')).toBe(file)
    xhr.upload.onprogress?.(
      new ProgressEvent('progress', { lengthComputable: true, loaded: 25, total: 100 }),
    )
    xhr.upload.onprogress?.(new ProgressEvent('progress', { lengthComputable: false, loaded: 30 }))
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(25)

    xhr.respond({ job_id: 'job-1' }, 202)
    await expect(request).resolves.toEqual({ job_id: 'job-1' })
    expect(xhr.upload.onprogress).toBeNull()
    controller.abort()
    expect(xhr.abort).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'Проверьте файл'],
    [401, 'API-ключ'],
    [413, 'слишком большое'],
    [500, 'временно недоступен'],
  ])('reports HTTP %s without exposing the server response', async (status, message) => {
    const request = uploadVideo(video(), 'key', vi.fn(), new AbortController().signal)
    lastUpload().respond({ detail: '<html>private server traceback</html>' }, status)
    await expect(request).rejects.toMatchObject({
      status,
      kind: 'http',
      message: expect.stringContaining(message),
    })
    await expect(request).rejects.not.toThrow('traceback')
  })

  it.each([
    ['onerror', 'network'],
    ['ontimeout', 'timeout'],
  ] as const)('reports %s and clears event handlers', async (handler, kind) => {
    const request = uploadVideo(video(), 'key', vi.fn(), new AbortController().signal)
    const xhr = lastUpload()
    xhr[handler]?.()
    await expect(request).rejects.toMatchObject({ status: null, kind })
    expect(xhr.onload).toBeNull()
    expect(xhr.upload.onprogress).toBeNull()
  })

  it.each([{}, { job_id: '' }, { job_id: 4 }, { job_id: '   ' }])(
    'rejects malformed upload response %j',
    async (payload) => {
      const request = uploadVideo(video(), 'key', vi.fn(), new AbortController().signal)
      lastUpload().respond(payload)
      await expect(request).rejects.toMatchObject({ kind: 'contract' })
    },
  )

  it('rejects invalid JSON', async () => {
    const request = uploadVideo(video(), 'key', vi.fn(), new AbortController().signal)
    const xhr = lastUpload()
    xhr.status = 200
    xhr.responseText = '<html>Not JSON</html>'
    xhr.onload?.()
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({ kind: 'contract' })
  })

  it('aborts an active upload and cleans up listeners', async () => {
    const controller = new AbortController()
    const request = uploadVideo(video(), 'key', vi.fn(), controller.signal)
    const xhr = lastUpload()
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(xhr.abort).toHaveBeenCalledOnce()
    expect(xhr.onload).toBeNull()
  })

  it('does not start a request after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(uploadVideo(video(), 'key', vi.fn(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })
})

describe('getJobDetails', () => {
  it('uses the details endpoint with an encoded job ID and API key', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ...processingDetails, job_id: 'job/with space' }))
    await getJobDetails('job/with space', 'bank-key', new AbortController().signal)
    expect(fetch).toHaveBeenCalledWith('/api/v1/jobs/job%2Fwith%20space/details', {
      headers: { 'X-API-Key': 'bank-key' },
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    ['processing', processingDetails],
    ['violation result', doneDetails],
    ['clean result', cleanDetails],
    ['failed', { job_id: 'job-1', status: 'failed', error: 'Видео не декодируется' }],
  ])('accepts canonical %s response', async (_name, payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload))
    await expect(
      getJobDetails(payload.job_id, 'key', new AbortController().signal),
    ).resolves.toEqual(payload)
  })

  it('rejects a valid result belonging to a different job', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ...cleanDetails, job_id: 'another-job' }))
    await expect(
      getJobDetails('requested-job', 'key', new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'contract',
    })
  })

  it.each([
    { ...processingDetails, status: 'queued' },
    { ...processingDetails, progress: { stage: 'scene', value: 55 } },
    { ...processingDetails, progress: { stage: 'scene', value: Number.NaN } },
    { ...processingDetails, stages: [{ id: 'decode' }] },
    { ...cleanDetails, verdict: 'unknown' },
    { ...cleanDetails, rules_checked: -1 },
    { ...cleanDetails, duration_sec: undefined },
    { ...doneDetails, violations: [{ type: 'Incomplete result' }] },
    { ...doneDetails, violations: [{ ...doneDetails.violations[0], confidence_level: ['high'] }] },
    { ...cleanDetails, timeline: { cashier_present: [[3, 1]] } },
  ])('rejects malformed details %j', async (payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload))
    await expect(
      getJobDetails(payload.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
  })

  it.each([400, 401])(
    'reports HTTP %s without reading arbitrary server details',
    async (status) => {
      const reply = response({ detail: '<html>traceback</html>' }, status)
      vi.mocked(fetch).mockResolvedValue(reply)
      await expect(
        getJobDetails('job-1', 'key', new AbortController().signal),
      ).rejects.toMatchObject({ status, kind: 'http' })
      expect(reply.json).not.toHaveBeenCalled()
    },
  )

  it('reports an unreadable JSON body as a contract error', async () => {
    const reply = response(null)
    vi.mocked(reply.json).mockRejectedValue(new SyntaxError('Unexpected HTML'))
    vi.mocked(fetch).mockResolvedValue(reply)
    await expect(getJobDetails('job-1', 'key', new AbortController().signal)).rejects.toMatchObject(
      { kind: 'contract' },
    )
  })

  it('reports a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getJobDetails('job-1', 'key', new AbortController().signal)).rejects.toMatchObject(
      { kind: 'network' },
    )
  })

  it('times out an unanswered status request', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const request = getJobDetails('job-1', 'key', new AbortController().signal)
    const assertion = expect(request).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forwards cancellation and clears its timeout', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const controller = new AbortController()
    const request = getJobDetails('job-1', 'key', controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const options = vi.mocked(fetch).mock.calls[0][1]
    expect(options?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fetch after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(getJobDetails('job-1', 'key', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
