import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { CircleAlert, ShieldCheck, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { DoneDetails, EvidenceFrame } from './api/contracts'
import { getJobDetails, safePreviewUrl } from './api/client'

import { timecode } from './timecode'

function EvidenceImage({ frame, title }: { frame: EvidenceFrame; title: string }) {
  const [broken, setBroken] = useState(false)
  return broken ? (
    <span role="alert" className="evidence-unavailable">
      Кадр {timecode(frame.timestamp_sec)} повреждён или недоступен.
    </span>
  ) : (
    <img
      src={`data:image/jpeg;base64,${frame.image_base64}`}
      alt={title}
      onError={() => setBroken(true)}
    />
  )
}

export function AnalysisResults({ details, apiKey }: { details: DoneDetails; apiKey: string }) {
  const player = useRef<HTMLVideoElement>(null)
  const pendingSeek = useRef<number | null>(null)
  const position = useRef(0)
  const zoomOpener = useRef<HTMLButtonElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const [preview, setPreview] = useState(() => safePreviewUrl(details.preview_url))
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const [zoom, setZoom] = useState<{ frame: EvidenceFrame; title: string } | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  function seek(seconds: number, index: number) {
    const target = Math.max(0, Math.min(seconds - 1, details.duration_sec))
    setActive(index)
    pendingSeek.current = target
    position.current = target
    if (player.current && player.current.readyState >= 1) {
      player.current.currentTime = target
      pendingSeek.current = null
    }
  }

  async function refreshPreview() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setRefreshing(true)
    try {
      // /details renews the per-video HttpOnly cookie. The API key never enters src.
      const updated = await getJobDetails(details.job_id, apiKey, controller.signal)
      if (controller.signal.aborted) return
      const url = updated.status === 'done' ? safePreviewUrl(updated.preview_url) : null
      if (!url) throw new Error('Превью пока недоступно. Кадры и описание остаются ниже.')
      pendingSeek.current = position.current
      setPreview(url)
      setMediaError(null)
      player.current?.load()
    } catch (error) {
      if (!controller.signal.aborted)
        setMediaError(error instanceof Error ? error.message : 'Не удалось открыть видео.')
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }

  const isStub = details.violations.some((item) => item.type_id === 'stub_demo')
  return (
    <>
      <div
        className={`result-banner ${details.verdict === 'violation' ? 'has-findings' : 'clean'}`}
        role="status"
      >
        {details.verdict === 'violation' ? <CircleAlert size={28} /> : <ShieldCheck size={28} />}
        <h3>
          {details.verdict === 'violation'
            ? `Обнаружены признаки возможных нарушений: ${details.violations.length}`
            : 'Нарушение не обнаружено'}
        </h3>
      </div>
      <div className="result-facts">
        <span>
          Проверено правил<strong className="mono">{details.rules_checked}</strong>
        </span>
        <span>
          Время обработки<strong className="mono">{Math.round(details.processing_sec)} с</strong>
        </span>
      </div>
      {(__DEMO__ || isStub) && (
        <Alert role="note" className="mb-5 border-0 bg-muted text-muted-foreground">
          <AlertDescription>
            {isStub
              ? 'Работает заглушка анализа: событие вымышлено, кадр взят из загруженного видео. Это проверка интерфейса и API, а не вывод модели.'
              : 'Это пример результата для проверки интерфейса, а не вывод по загруженной записи.'}
          </AlertDescription>
        </Alert>
      )}
      <section className="preview-section" aria-label="Просмотр видео">
        <h3>Видеозапись</h3>
        {preview && (
          <video
            ref={player}
            src={preview}
            controls
            playsInline
            preload="metadata"
            aria-label="Плеер загруженного видео"
            onError={() =>
              setMediaError(
                'Видео не загрузилось или доступ истёк. Обновите доступ; кадры и описание остаются ниже.',
              )
            }
            onLoadedMetadata={() => {
              if (player.current && pendingSeek.current !== null) {
                player.current.currentTime = Math.min(pendingSeek.current, player.current.duration)
                pendingSeek.current = null
              }
            }}
            onTimeUpdate={() => {
              const time = player.current?.currentTime ?? 0
              position.current = time
              const found = details.violations.findIndex(
                (v) => time >= v.timecode_sec && time <= v.timecode_end_sec,
              )
              setActive(found < 0 ? null : found)
            }}
          />
        )}
        {(!preview || mediaError) && (
          <Alert className="my-3" variant="destructive">
            <AlertDescription>
              {mediaError ?? 'Превью недоступно. Используйте кадры и описания событий ниже.'}
            </AlertDescription>
          </Alert>
        )}
        {preview && details.violations.length > 0 && (
          <div className="event-track" role="group" aria-label="События на шкале видео">
            {details.violations.map((v, index) => (
              <Button
                key={`${v.type_id}-${index}`}
                type="button"
                variant="secondary"
                className={`event-marker ${active === index ? 'selected' : ''}`}
                style={{
                  left: `${Math.min(96, (v.timecode_sec / Math.max(1, details.duration_sec)) * 100)}%`,
                  width: `${Math.max(4, ((v.timecode_end_sec - v.timecode_sec) / Math.max(1, details.duration_sec)) * 100)}%`,
                }}
                aria-label={`Событие ${index + 1}: ${v.type}, ${timecode(v.timecode_sec)}`}
                onClick={() => seek(v.timecode_sec, index)}
              >
                {index + 1}
              </Button>
            ))}
          </div>
        )}
        <div className="preview-actions">
          <p className="small-note">Таймкод открывает фрагмент за секунду до события.</p>
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={() => void refreshPreview()}
          >
            {refreshing ? 'Обновляем доступ…' : 'Обновить доступ к видео'}
          </Button>
        </div>
      </section>
      <div className="evidence-list">
        {details.violations.map((v, index) => (
          <Card
            role="article"
            aria-label={`Событие ${index + 1}: ${v.type}`}
            key={`${v.type_id}-${index}`}
            className={`evidence-card ${active === index ? 'active' : ''}`}
          >
            <CardContent className="p-5">
              <div className="evidence-heading">
                <h3>
                  {index + 1}. {v.type}
                </h3>
                <Badge variant="secondary">
                  Уверенность:{' '}
                  {{ low: 'низкая', medium: 'средняя', high: 'высокая' }[v.confidence_level]}
                </Badge>
              </div>
              <Button
                type="button"
                variant="link"
                className="mono px-0"
                disabled={!preview || !!mediaError}
                onClick={() => seek(v.timecode_sec, index)}
                aria-label={`Перейти к событию ${index + 1} в ${timecode(v.timecode_sec)}`}
              >
                {timecode(v.timecode_sec)} – {timecode(v.timecode_end_sec)}
              </Button>
              <div className="evidence-frames">
                {v.evidence_frames.map((frame, frameIndex) => (
                  <figure key={frameIndex}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="evidence-button"
                      onClick={(event) => {
                        zoomOpener.current = event.currentTarget
                        seek(frame.timestamp_sec, index)
                        setZoom({ frame, title: `${v.type} — ${timecode(frame.timestamp_sec)}` })
                      }}
                      aria-label={`Открыть кадр ${frameIndex + 1} события ${index + 1}, ${timecode(frame.timestamp_sec)}`}
                    >
                      <EvidenceImage
                        frame={frame}
                        title={`Кадр события ${index + 1}, ${timecode(frame.timestamp_sec)}`}
                      />
                    </Button>
                    <figcaption className="mono">{timecode(frame.timestamp_sec)}</figcaption>
                  </figure>
                ))}
              </div>
              <dl className="evidence-text">
                <dt>Что видно</dt>
                <dd>{v.observed}</dd>
                <dt>Почему это может быть нарушением</dt>
                <dd>{v.why}</dd>
                <dt>Норматив</dt>
                <dd>
                  {v.rule ? (
                    <>
                      <a href={v.rule.url} target="_blank" rel="noopener noreferrer">
                        {v.rule.document}
                      </a>
                      {v.rule.point && <p>{v.rule.point}</p>}
                      {v.rule.quote && (
                        <details>
                          <summary>Цитата из источника</summary>
                          <blockquote>{v.rule.quote}</blockquote>
                        </details>
                      )}
                    </>
                  ) : (
                    'Источник не указан, требуется проверка.'
                  )}
                </dd>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      <Dialog.Root
        open={zoom !== null}
        onOpenChange={(open) => {
          if (!open) setZoom(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="evidence-overlay" />
          <Dialog.Content
            className="evidence-dialog"
            aria-describedby="evidence-caption"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              zoomOpener.current?.focus()
            }}
          >
            <Dialog.Title>{zoom?.title}</Dialog.Title>
            <Dialog.Description id="evidence-caption">
              Кадр из ответа сервера. Время доказательства указано без сдвига.
            </Dialog.Description>
            {zoom && <EvidenceImage key={zoom.title} frame={zoom.frame} title={zoom.title} />}
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                <X size={16} /> Закрыть кадр
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
