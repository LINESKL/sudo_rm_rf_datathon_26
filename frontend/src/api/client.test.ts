import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import doneDetails from '../../../docs/frontend/mock_details.json'
import cleanDetails from '../../../docs/frontend/mock_details_clean.json'
import processingDetails from '../../../docs/frontend/mock_details_processing.json'
import {
  ApiError,
  getJobDetails,
  getServiceHealth,
  MAX_VIDEO_BYTES,
  uploadVideo,
  validateVideo,
} from './client'

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
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    [
      'without point and quote',
      { document: 'Открытый норматив', url: 'https://adilet.zan.kz/rus/docs/source' },
    ],
    [
      'with null point and quote',
      {
        document: 'Открытый норматив',
        url: 'https://adilet.zan.kz/rus/docs/source',
        point: null,
        quote: null,
      },
    ],
    ['without a rule', undefined],
    ['with a null rule', null],
  ])(
    'accepts backend-shaped details %s without optional statistics or preview',
    async (_name, rule) => {
      const payload = JSON.parse(
        JSON.stringify({
          job_id: 'job-1',
          status: 'done',
          verdict: 'violation',
          duration_sec: 20.9,
          processing_sec: 74.2,
          degraded: true,
          violations: [{ ...doneDetails.violations[0], rule }],
        }),
      )
      vi.mocked(fetch).mockResolvedValue(response(payload))
      await expect(getJobDetails('job-1', 'key', new AbortController().signal)).resolves.toEqual(
        payload,
      )
    },
  )

  it('preserves degraded=false and does not invent it when it is omitted', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ...cleanDetails, degraded: false }))
      .mockResolvedValueOnce(response(cleanDetails))
    const first = await getJobDetails(cleanDetails.job_id, 'key', new AbortController().signal)
    const second = await getJobDetails(cleanDetails.job_id, 'key', new AbortController().signal)
    expect(first).toMatchObject({ degraded: false })
    expect(second).not.toHaveProperty('degraded')
  })

  it.each([
    ['clean verdict with events', { ...doneDetails, verdict: 'no_violation' }],
    ['violation verdict without events', { ...cleanDetails, verdict: 'violation' }],
    ['missing processing duration', { ...cleanDetails, processing_sec: undefined }],
    ['invalid degraded flag', { ...cleanDetails, degraded: 'false' }],
    ['null rule counter', { ...cleanDetails, rules_checked: null }],
    [
      'event outside video',
      { ...doneDetails, violations: [{ ...doneDetails.violations[0], timecode_end_sec: 21 }] },
    ],
    [
      'frame outside video',
      {
        ...doneDetails,
        violations: [
          {
            ...doneDetails.violations[0],
            evidence_frames: [
              { ...doneDetails.violations[0].evidence_frames[0], timestamp_sec: 21 },
            ],
          },
        ],
      },
    ],
    ['timeline outside video', { ...cleanDetails, timeline: { cashier_present: [[0, 21]] } }],
  ])('rejects inconsistent %s instead of presenting a clean result', async (_name, payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload))
    await expect(
      getJobDetails(payload.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
  })

  it.each(['observed', 'why', 'description'] as const)(
    'rejects a blank %s explanation',
    async (field) => {
      vi.mocked(fetch).mockResolvedValue(
        response({ ...doneDetails, violations: [{ ...doneDetails.violations[0], [field]: '  ' }] }),
      )
      await expect(
        getJobDetails(doneDetails.job_id, 'key', new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'contract' })
    },
  )

  it.each([
    ['javascript source', { document: 'Норматив', url: 'javascript:alert(1)' }],
    ['relative source', { document: 'Норматив', url: '/source' }],
    [
      'credentials in source',
      { document: 'Норматив', url: 'https://user:secret@adilet.zan.kz/source' },
    ],
    ['blank document', { document: ' ', url: 'https://adilet.zan.kz/source' }],
    ['blank point', { document: 'Норматив', url: 'https://adilet.zan.kz/source', point: ' ' }],
    ['blank quote', { document: 'Норматив', url: 'https://adilet.zan.kz/source', quote: '' }],
  ])('rejects a malformed rule: %s', async (_name, rule) => {
    vi.mocked(fetch).mockResolvedValue(
      response({ ...doneDetails, violations: [{ ...doneDetails.violations[0], rule }] }),
    )
    await expect(
      getJobDetails(doneDetails.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
  })

  it.each([0, 4])('rejects %s evidence frames', async (count) => {
    const evidence_frames = Array.from(
      { length: count },
      () => doneDetails.violations[0].evidence_frames[0],
    )
    vi.mocked(fetch).mockResolvedValue(
      response({ ...doneDetails, violations: [{ ...doneDetails.violations[0], evidence_frames }] }),
    )
    await expect(
      getJobDetails(doneDetails.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
  })

  it.each([
    ['invalid base64', '!!!!'],
    ['bad padding', '/9j/2Q==='],
    ['non-JPEG bytes', 'SGVsbG8='],
    ['missing end marker', '/9j/4AAQ'],
    [
      'data URL',
      `data:image/jpeg;base64,${doneDetails.violations[0].evidence_frames[0].image_base64}`,
    ],
    ['oversized evidence', 'A'.repeat(14_000_001)],
  ])('rejects %s evidence', async (_name, image_base64) => {
    const evidence_frames = [{ timestamp_sec: 8.6, image_base64 }]
    vi.mocked(fetch).mockResolvedValue(
      response({ ...doneDetails, violations: [{ ...doneDetails.violations[0], evidence_frames }] }),
    )
    await expect(
      getJobDetails(doneDetails.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
  })

  it.each([undefined, null, '/previews/job-1.mp4', `${window.location.origin}/previews/job-1.mp4`])(
    'accepts safe optional preview %s',
    async (preview_url) => {
      vi.mocked(fetch).mockResolvedValue(response({ ...cleanDetails, preview_url }))
      await expect(
        getJobDetails(cleanDetails.job_id, 'key', new AbortController().signal),
      ).resolves.toMatchObject({ status: 'done' })
    },
  )

  it.each([
    'https://other.example/previews/job-1.mp4',
    '//other.example/previews/job-1.mp4',
    '/previews/job-1.mp4?api_key=secret',
    '/previews/job-1.mp4#secret',
    '/api/v1/analyze',
    '/previews/../api/v1/analyze',
    '/previews/%2e%2e/api/v1/analyze',
    'javascript:alert(1)',
    `${window.location.origin.replace('://', '://user:secret@')}/previews/job-1.mp4`,
  ])('rejects an unsafe preview URL: %s', async (preview_url) => {
    vi.mocked(fetch).mockResolvedValue(response({ ...cleanDetails, preview_url }))
    await expect(
      getJobDetails(cleanDetails.job_id, 'key', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'contract' })
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

describe('getServiceHealth', () => {
  it.each([
    { mode: 'stub', status: 'ok' },
    { mode: 'stub', status: 'degraded' },
    { mode: 'pipeline', status: 'ok' },
    { mode: 'pipeline', status: 'degraded' },
  ])('returns the checked mode/status without API credentials: %j', async (health) => {
    vi.mocked(fetch).mockResolvedValue(
      response({ ...health, gpu: { available: false }, queued: 0 }),
    )
    await expect(getServiceHealth(new AbortController().signal)).resolves.toEqual(health)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/health', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    {},
    { mode: 'live', status: 'ok' },
    { mode: 'pipeline', status: 'unknown' },
    { mode: 'stub' },
  ])('rejects unknown health %j', async (health) => {
    vi.mocked(fetch).mockResolvedValue(response(health))
    await expect(getServiceHealth(new AbortController().signal)).rejects.toMatchObject({
      kind: 'contract',
    })
  })

  it('does not expose HTML or server internals on an HTTP failure', async () => {
    const reply = response({ detail: '<html>server traceback</html>' }, 503)
    vi.mocked(fetch).mockResolvedValue(reply)
    await expect(getServiceHealth(new AbortController().signal)).rejects.toMatchObject({
      status: 503,
      kind: 'http',
    })
    expect(reply.json).not.toHaveBeenCalled()
  })

  it('times out an unavailable health endpoint and cleans up its timer', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const request = getServiceHealth(new AbortController().signal)
    const assertion = expect(request).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an in-flight health request', async () => {
    abortableFetch()
    const controller = new AbortController()
    const request = getServiceHealth(controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('does not accept a late response body after cancellation', async () => {
    let resolveBody!: (value: unknown) => void
    const reply = response(null)
    vi.mocked(reply.json).mockReturnValue(
      new Promise((resolve) => {
        resolveBody = resolve
      }),
    )
    vi.mocked(fetch).mockResolvedValue(reply)
    const controller = new AbortController()
    const request = getServiceHealth(controller.signal)
    await Promise.resolve()
    controller.abort()
    resolveBody({ mode: 'pipeline', status: 'ok' })
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
