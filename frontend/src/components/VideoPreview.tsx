import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import type { DoneDetails } from '@/api/contracts'
import { getJobDetails, safePreviewUrl } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export interface VideoPreviewHandle {
  seek: (seconds: number) => void
}

interface Props {
  result: DoneDetails
  apiKey: string
  onPositionChange?: (time: number | null) => void
  onAvailabilityChange?: (available: boolean) => void
}

export const VideoPreview = forwardRef<VideoPreviewHandle, Props>(function VideoPreview(
  { result, apiKey, onPositionChange, onAvailabilityChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const request = useRef<AbortController | null>(null)
  const position = useRef(0)
  const pendingSeek = useRef<{ time: number; play: boolean } | null>(null)
  const playIntent = useRef(0)
  const mediaGeneration = useRef(0)
  const [media, setMedia] = useState(() => ({
    url: safePreviewUrl(result.preview_url),
    revision: 0,
  }))
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [playbackNotice, setPlaybackNotice] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(
    () => () => {
      request.current?.abort()
      playIntent.current += 1
    },
    [],
  )

  function play(video: HTMLVideoElement) {
    const intent = ++playIntent.current
    void video.play().catch(() => {
      if (videoRef.current === video && playIntent.current === intent) {
        setPlaybackNotice('Воспроизведение не началось. Нажмите кнопку запуска в плеере.')
      }
    })
  }

  function applyPending(video: HTMLVideoElement) {
    if (
      video !== videoRef.current ||
      media.revision !== mediaGeneration.current ||
      request.current ||
      mediaError ||
      !pendingSeek.current ||
      video.readyState < 1
    )
      return
    const pending = pendingSeek.current
    const duration = Number.isFinite(video.duration) ? video.duration : result.duration_sec
    const target = Math.max(0, Math.min(pending.time, duration))
    pendingSeek.current = null
    try {
      video.currentTime = target
      position.current = target
      onPositionChange?.(target)
      if (pending.play) play(video)
    } catch {
      setPlaybackNotice('Не удалось перейти к фрагменту. Используйте шкалу плеера.')
    }
  }

  useImperativeHandle(ref, () => ({
    seek(seconds) {
      const video = videoRef.current
      if (
        !video ||
        mediaError ||
        request.current ||
        media.revision !== mediaGeneration.current ||
        !Number.isFinite(seconds)
      )
        return
      pendingSeek.current = {
        time: Math.max(0, Math.min(seconds, result.duration_sec)),
        play: true,
      }
      setPlaybackNotice(null)
      applyPending(video)
      video.focus()
      video.scrollIntoView?.({ block: 'nearest' })
    },
  }))

  async function refreshPreview() {
    if (request.current || !apiKey) return
    const controller = new AbortController()
    request.current = controller
    playIntent.current += 1
    const video = videoRef.current
    const savedPosition =
      pendingSeek.current?.time ??
      (video && video.readyState >= 1 && Number.isFinite(video.currentTime)
        ? video.currentTime
        : position.current)
    const generation = ++mediaGeneration.current
    pendingSeek.current = { time: savedPosition, play: false }
    video?.pause()
    setRefreshing(true)
    setPlaybackNotice(null)
    onAvailabilityChange?.(false)
    try {
      // /details обновляет HttpOnly cookie; основной ключ остаётся только в заголовке.
      const updated = await getJobDetails(result.job_id, apiKey, controller.signal)
      if (controller.signal.aborted) return
      const url = updated.status === 'done' ? safePreviewUrl(updated.preview_url) : null
      if (!url) throw new Error('Превью недоступно. Кадры и описания событий остаются ниже.')
      pendingSeek.current = { time: savedPosition, play: false }
      setMediaError(null)
      // Новый DOM-узел получает новый src до metadata; load() старого видео не вызывается.
      setMedia({ url, revision: generation })
      onAvailabilityChange?.(true)
    } catch (error) {
      if (!controller.signal.aborted) {
        setMediaError(
          error instanceof Error ? error.message : 'Не удалось обновить доступ к видео.',
        )
        onAvailabilityChange?.(false)
        onPositionChange?.(null)
      }
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }

  return (
    <section className="preview-section" aria-label="Просмотр видео">
      <h3>Видеозапись</h3>
      {media.url && (
        <video
          key={media.revision}
          ref={videoRef}
          src={media.url}
          controls
          playsInline
          preload="metadata"
          hidden={Boolean(mediaError)}
          tabIndex={0}
          aria-label="Плеер загруженного видео"
          onLoadedMetadata={(event) => applyPending(event.currentTarget)}
          onCanPlay={(event) => applyPending(event.currentTarget)}
          onTimeUpdate={(event) => {
            if (
              event.currentTarget !== videoRef.current ||
              media.revision !== mediaGeneration.current ||
              event.currentTarget.readyState < 1 ||
              mediaError ||
              refreshing
            )
              return
            position.current = event.currentTarget.currentTime
            onPositionChange?.(position.current)
          }}
          onError={(event) => {
            if (
              event.currentTarget !== videoRef.current ||
              media.revision !== mediaGeneration.current
            )
              return
            playIntent.current += 1
            pendingSeek.current = null
            setMediaError(
              'Видео не загрузилось или доступ истёк. Обновите доступ; кадры и описания остаются ниже.',
            )
            onAvailabilityChange?.(false)
            onPositionChange?.(null)
          }}
        />
      )}
      {(!media.url || mediaError) && (
        <Alert variant="destructive" className="rounded-xl">
          <CircleAlert />
          <AlertTitle>Видеопревью недоступно</AlertTitle>
          <AlertDescription>
            {mediaError ?? 'Превью отсутствует. Используйте кадры и описания событий ниже.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="preview-actions">
        <p className="small-note">
          Таймкод открывает контекст за секунду до события. Время доказательства не меняется.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 whitespace-normal rounded-xl"
          disabled={refreshing || !apiKey}
          onClick={() => void refreshPreview()}
        >
          <RotateCcw aria-hidden="true" />
          {refreshing ? 'Обновляем доступ…' : 'Обновить доступ к видео'}
        </Button>
      </div>
      {playbackNotice && (
        <p className="small-note" role="status">
          {playbackNotice}
        </p>
      )}
    </section>
  )
})
