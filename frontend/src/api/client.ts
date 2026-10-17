import type { JobDetails } from './contracts'

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024

const UPLOAD_TIMEOUT_MS = 120_000
const DETAILS_TIMEOUT_MS = 15_000

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly kind: 'http' | 'network' | 'timeout' | 'contract' = 'http',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function validateVideo(file: File): string | null {
  if (file.size === 0) return 'Файл пустой. Выберите видео с записью.'
  if (!/\.(mov|mp4)$/i.test(file.name)) {
    return 'Неподдерживаемый формат. Выберите видео .mov или .mp4.'
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return 'Файл больше 200 МБ. Выберите видео меньшего размера.'
  }
  return null
}

function aborted(): DOMException {
  return new DOMException('Операция отменена.', 'AbortError')
}

function httpError(status: number): ApiError {
  if (status === 401) {
    return new ApiError('API-ключ не принят. Проверьте ключ и попробуйте снова.', status)
  }
  if (status === 400) {
    return new ApiError('Сервис не смог принять видео. Проверьте файл и попробуйте снова.', status)
  }
  if (status === 413) {
    return new ApiError(
      'Видео слишком большое для сервиса. Выберите файл меньшего размера.',
      status,
    )
  }
  return new ApiError('Сервис временно недоступен. Попробуйте ещё раз.', status)
}

function networkError(): ApiError {
  return new ApiError(
    'Не удалось связаться с сервисом. Проверьте соединение и попробуйте снова.',
    null,
    'network',
  )
}

function timeoutError(): ApiError {
  return new ApiError('Сервис не ответил вовремя. Попробуйте ещё раз.', null, 'timeout')
}

function contractError(): ApiError {
  return new ApiError('Сервис вернул непонятный ответ. Попробуйте ещё раз.', null, 'contract')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isFraction(value: unknown): value is number {
  return isNonnegative(value) && value <= 1
}

function isProgress(value: unknown): boolean {
  return isRecord(value) && isText(value.stage) && isFraction(value.value)
}

function isStages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((stage: unknown) => isRecord(stage) && isText(stage.id) && isText(stage.title))
  )
}

function isRule(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isText(value.document) &&
      isText(value.point) &&
      typeof value.quote === 'string' &&
      typeof value.url === 'string')
  )
}

function isViolation(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isText(value.type) &&
    isText(value.type_id) &&
    isNonnegative(value.timecode_sec) &&
    isNonnegative(value.timecode_end_sec) &&
    value.timecode_end_sec >= value.timecode_sec &&
    isFraction(value.confidence) &&
    (value.confidence_level === 'low' ||
      value.confidence_level === 'medium' ||
      value.confidence_level === 'high') &&
    typeof value.observed === 'string' &&
    typeof value.why === 'string' &&
    typeof value.description === 'string' &&
    isRule(value.rule) &&
    Array.isArray(value.evidence_frames) &&
    value.evidence_frames.every(
      (frame: unknown) =>
        isRecord(frame) && isNonnegative(frame.timestamp_sec) && isText(frame.image_base64),
    )
  )
}

function isTimeline(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (intervals) =>
        Array.isArray(intervals) &&
        intervals.every(
          (interval: unknown) =>
            Array.isArray(interval) &&
            interval.length === 2 &&
            isNonnegative(interval[0]) &&
            isNonnegative(interval[1]) &&
            interval[1] >= interval[0],
        ),
    )
  )
}

function parseJobDetails(value: unknown): JobDetails {
  if (!isRecord(value) || !isText(value.job_id)) throw contractError()
  if (value.status === 'processing' && isProgress(value.progress) && isStages(value.stages)) {
    return value as unknown as JobDetails
  }
  if (value.status === 'failed' && (value.error === undefined || typeof value.error === 'string')) {
    return value as unknown as JobDetails
  }
  if (
    value.status === 'done' &&
    (value.verdict === 'violation' || value.verdict === 'no_violation') &&
    Array.isArray(value.violations) &&
    value.violations.every(isViolation) &&
    isNonnegative(value.rules_checked) &&
    Number.isInteger(value.rules_checked) &&
    isNonnegative(value.processing_sec) &&
    isNonnegative(value.duration_sec) &&
    (value.preview_url === null || isText(value.preview_url)) &&
    (value.progress === undefined || isProgress(value.progress)) &&
    (value.stages === undefined || isStages(value.stages)) &&
    (value.timeline === undefined || isTimeline(value.timeline)) &&
    (value.timeline_labels === undefined ||
      (isRecord(value.timeline_labels) &&
        Object.values(value.timeline_labels).every((label) => typeof label === 'string')))
  ) {
    return value as unknown as JobDetails
  }
  throw contractError()
}

export function uploadVideo(
  file: File,
  apiKey: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<{ job_id: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted())
      return
    }

    const xhr = new XMLHttpRequest()
    let settled = false

    const cleanup = () => {
      signal.removeEventListener('abort', cancel)
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null
      xhr.upload.onprogress = null
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancel = () => {
      xhr.abort()
      fail(aborted())
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(xhr.status === 0 ? networkError() : httpError(xhr.status))
        return
      }
      let response: unknown
      try {
        response = JSON.parse(xhr.responseText)
      } catch {
        fail(contractError())
        return
      }
      if (!isRecord(response) || !isText(response.job_id)) {
        fail(contractError())
        return
      }
      settled = true
      cleanup()
      resolve({ job_id: response.job_id })
    }
    xhr.onerror = () => fail(networkError())
    xhr.ontimeout = () => fail(timeoutError())
    xhr.onabort = () => fail(aborted())
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))))
      }
    }
    signal.addEventListener('abort', cancel, { once: true })

    try {
      xhr.open('POST', '/api/v1/analyze')
      xhr.setRequestHeader('X-API-Key', apiKey)
      xhr.timeout = UPLOAD_TIMEOUT_MS
      const body = new FormData()
      body.append('file', file)
      xhr.send(body)
    } catch {
      fail(networkError())
    }
  })
}

export async function getJobDetails(
  jobId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<JobDetails> {
  if (signal.aborted) throw aborted()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, DETAILS_TIMEOUT_MS)

  try {
    const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/details`, {
      headers: { 'X-API-Key': apiKey },
      signal: controller.signal,
    })
    if (!response.ok) throw httpError(response.status)
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (signal.aborted || timedOut) throw error
      throw contractError()
    }
    const details = parseJobDetails(payload)
    if (details.job_id !== jobId) throw contractError()
    return details
  } catch (error) {
    if (signal.aborted) throw aborted()
    if (timedOut) throw timeoutError()
    if (error instanceof ApiError) throw error
    throw networkError()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}
