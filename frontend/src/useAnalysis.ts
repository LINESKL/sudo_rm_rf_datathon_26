import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getJobDetails, uploadVideo } from './api/client'

const WAIT_TIMEOUT_MS = 300_000

function elapsedSince(started: number, now: number) {
  return Math.max(0, Math.floor((now - started) / 1000))
}

export function useAnalysis() {
  const queryClient = useQueryClient()
  const controller = useRef<AbortController | null>(null)
  const waitingStarted = useRef<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<Error | null>(null)
  const [job, setJob] = useState<{ id: string; key: string; started: number } | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(
    () => () => {
      controller.current?.abort()
    },
    [],
  )

  const details = useQuery({
    queryKey: ['job-details', job?.id, job?.key, job?.started],
    enabled: job !== null,
    queryFn: ({ signal }) => {
      if (!job) throw new Error('Сначала загрузите видео.')
      if (Date.now() - (waitingStarted.current ?? job.started) >= WAIT_TIMEOUT_MS) {
        throw new Error(
          'Проверка занимает больше пяти минут. Повторите запрос статуса или попробуйте позже.',
        )
      }
      return getJobDetails(job.id, job.key, signal)
    },
    retry: false,
    // Локальный API доступен и без внешнего интернет-соединения.
    networkMode: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      query.state.status === 'error' || query.state.data?.status !== 'processing' ? false : 1500,
    refetchIntervalInBackground: true,
  })

  const finished = details.data?.status === 'done' || details.data?.status === 'failed'
  const clockRunning = uploading || (job !== null && !finished)

  useEffect(() => {
    if (!clockRunning || startedAt === null) return
    const interval = setInterval(() => {
      setElapsedSeconds(elapsedSince(startedAt, Date.now()))
    }, 1000)
    return () => clearInterval(interval)
  }, [clockRunning, startedAt])

  async function start(file: File, key: string) {
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    const started = Date.now()
    waitingStarted.current = started
    setStartedAt(started)
    setElapsedSeconds(0)
    setJob(null)
    setUploadError(null)
    setUploadProgress(0)
    setUploading(true)
    try {
      const response = await uploadVideo(file, key, setUploadProgress, active.signal)
      if (!active.signal.aborted) setJob({ id: response.job_id, key, started })
    } catch (error) {
      if (!active.signal.aborted) {
        setElapsedSeconds(elapsedSince(started, Date.now()))
        setUploadError(
          error instanceof Error
            ? error
            : new Error('Не удалось отправить видео. Попробуйте снова.'),
        )
      }
    } finally {
      if (controller.current === active) setUploading(false)
    }
  }

  function retryStatus(key: string) {
    if (!job) return
    // Новый бюджет опроса не меняет начало и полное время проверки.
    waitingStarted.current = Date.now()
    if (job.key !== key) {
      setJob({ ...job, key })
    } else void details.refetch()
  }

  function reset() {
    controller.current?.abort()
    void queryClient.cancelQueries({ queryKey: ['job-details'] })
    queryClient.removeQueries({ queryKey: ['job-details'] })
    setJob(null)
    setUploading(false)
    setUploadProgress(0)
    setUploadError(null)
    waitingStarted.current = null
    setStartedAt(null)
    setElapsedSeconds(0)
  }

  const failed = details.data?.status === 'failed' ? details.data : null
  const error =
    uploadError ??
    details.error ??
    (failed
      ? new Error(
          failed.error ||
            'Не удалось обработать видео. Попробуйте другую запись или повторите проверку.',
        )
      : null)
  const done = details.data?.status === 'done' && !error
  const busy = uploading || (job !== null && !done && !error)

  return {
    start,
    reset,
    retryStatus,
    uploading,
    uploadProgress,
    error,
    busy,
    done,
    job,
    elapsedSeconds:
      finished && startedAt !== null
        ? elapsedSince(startedAt, details.dataUpdatedAt)
        : elapsedSeconds,
    details: details.data,
    statusError: details.isError,
  }
}
