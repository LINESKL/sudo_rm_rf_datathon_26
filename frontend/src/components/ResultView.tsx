import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  ImageOff,
  Link2,
  Play,
  Printer,
  ScanSearch,
  ShieldCheck,
  Upload,
  ZoomIn,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { DoneDetails, EvidenceFrame } from '@/api/contracts'
import { safePreviewUrl } from '@/api/client'
import { timecode } from '@/lib/timecode'
import { VideoPreview } from './VideoPreview'
import type { VideoPreviewHandle } from './VideoPreview'
import { Timeline } from './Timeline'
import { ReviewDecision } from './ReviewDecision'
import { useReview } from '@/lib/useReview'

function EvidenceImage({ frame, large = false }: { frame: EvidenceFrame; large?: boolean }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <div className="evidence-unavailable" role="status">
      <ImageOff size={24} aria-hidden="true" />
      Кадр недоступен. Проверьте исходную запись.
    </div>
  ) : (
    <img
      className={large ? 'evidence-large' : 'evidence-image'}
      src={`data:image/jpeg;base64,${frame.image_base64}`}
      alt={`Кадр-доказательство на ${frame.timestamp_sec} с`}
      onError={() => setFailed(true)}
    />
  )
}

function EvidencePreview({
  frame,
  eventIndex,
  frameIndex,
  canSeek,
  onShow,
}: {
  frame: EvidenceFrame
  eventIndex: number
  frameIndex: number
  canSeek: boolean
  onShow: () => void
}) {
  return (
    <figure className="evidence-preview">
      <Dialog>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="evidence-trigger h-auto w-full overflow-hidden rounded-xl p-0"
            aria-label={`Увеличить кадр ${frameIndex + 1} события ${eventIndex + 1}, ${frame.timestamp_sec} с`}
          >
            <EvidenceImage frame={frame} />
            <span className="evidence-zoom">
              <ZoomIn size={16} aria-hidden="true" />
            </span>
          </Button>
        </DialogTrigger>
        <DialogContent className="evidence-dialog max-h-[90dvh] overflow-y-auto rounded-3xl sm:max-w-3xl">
          <DialogHeader className="pr-8">
            <DialogTitle>Кадр-доказательство</DialogTitle>
            <DialogDescription>
              Событие {eventIndex + 1}, кадр {frameIndex + 1} · {frame.timestamp_sec} с от начала
              видео
            </DialogDescription>
          </DialogHeader>
          <EvidenceImage frame={frame} large />
        </DialogContent>
      </Dialog>
      <figcaption>
        <span className="mono" title={`${frame.timestamp_sec} с от начала видео`}>
          {timecode(frame.timestamp_sec)} · {frame.timestamp_sec} с
        </span>
        <Button
          type="button"
          variant="link"
          className="evidence-show h-auto min-h-6 px-0 text-brand has-[>svg]:px-0"
          disabled={!canSeek}
          aria-label={`Показать кадр ${frameIndex + 1} события ${eventIndex + 1} в видео`}
          onClick={onShow}
        >
          <Play aria-hidden="true" /> В видео
        </Button>
      </figcaption>
    </figure>
  )
}

// Один крупный кадр и миниатюры: проверяющий листает доказательства, не теряя деталей.
function EvidenceGallery({
  frames,
  eventIndex,
  canSeek,
  onShow,
}: {
  frames: EvidenceFrame[]
  eventIndex: number
  canSeek: boolean
  onShow: (seconds: number) => void
}) {
  const [current, setCurrent] = useState(0)
  const frame = frames[Math.min(current, frames.length - 1)]
  if (!frame) return null
  return (
    <div className="evidence-gallery">
      <EvidencePreview
        key={current}
        frame={frame}
        eventIndex={eventIndex}
        frameIndex={current}
        canSeek={canSeek}
        onShow={() => onShow(frame.timestamp_sec)}
      />
      {frames.length > 1 && (
        <div className="evidence-thumbs">
          {frames.map((item, index) => (
            <button
              key={`${index}:${item.timestamp_sec}`}
              type="button"
              className="evidence-thumb"
              aria-label={`Показать кадр ${index + 1} из ${frames.length}`}
              aria-pressed={index === current}
              onClick={() => setCurrent(index)}
            >
              <img src={`data:image/jpeg;base64,${item.image_base64}`} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const confidenceLabels = { low: 'низкая', medium: 'средняя', high: 'высокая' }
const confidenceSteps = { low: 1, medium: 2, high: 3 }

export function ResultView({
  result,
  onReset,
  serviceMode,
  apiKey = '',
}: {
  result: DoneDetails
  onReset: () => void
  serviceMode: 'stub' | 'pipeline' | 'unknown'
  apiKey?: string
}) {
  const playerRef = useRef<VideoPreviewHandle>(null)
  const [position, setPosition] = useState<{ jobId: string; time: number | null } | null>(null)
  const [availability, setAvailability] = useState<{ jobId: string; available: boolean } | null>(
    null,
  )
  const [selected, setSelected] = useState<{ jobId: string; index: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const { review, update } = useReview(result.job_id)
  const reviewed = result.violations.filter((_, index) => review[index]).length
  const canSeek =
    availability?.jobId === result.job_id
      ? availability.available
      : safePreviewUrl(result.preview_url) !== null
  const activeTime = canSeek && position?.jobId === result.job_id ? position.time : null
  const isActive = (index: number) => {
    const event = result.violations[index]
    return (
      activeTime !== null &&
      activeTime >= event.timecode_sec &&
      activeTime <= event.timecode_end_sec
    )
  }
  // Выбранная карточка подсвечена сразу после клика и до конца своего интервала.
  const isHighlighted = (index: number) =>
    isActive(index) ||
    (selected?.jobId === result.job_id &&
      selected.index === index &&
      (activeTime === null || activeTime <= result.violations[index].timecode_end_sec))
  function seek(index: number, seconds: number) {
    setSelected({ jobId: result.job_id, index })
    playerRef.current?.seek(Math.max(0, seconds - 1))
  }
  const order = result.violations
    .map((violation, index) => ({ index, time: violation.timecode_sec }))
    .sort((a, b) => a.time - b.time)
    .map(({ index }) => index)
  function step(direction: 1 | -1) {
    if (!canSeek || order.length === 0) return
    const current = selected?.jobId === result.job_id ? order.indexOf(selected.index) : -1
    const next =
      current < 0
        ? direction > 0
          ? 0
          : order.length - 1
        : (current + direction + order.length) % order.length
    seek(order[next], result.violations[order[next]].timecode_sec)
  }
  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  })
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (event.key === ']') stepRef.current(1)
      if (event.key === '[') stepRef.current(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const hasFindings = result.verdict === 'violation'
  const needsReview = result.degraded !== false || serviceMode !== 'pipeline'
  const duration = result.duration_sec
  return (
    <div className="result-body">
      <div
        className={`result-banner ${hasFindings ? 'has-findings' : needsReview ? 'needs-review' : 'clean'}`}
        role="status"
      >
        {hasFindings || needsReview ? (
          <CircleAlert size={28} aria-hidden="true" />
        ) : (
          <ShieldCheck size={28} aria-hidden="true" />
        )}
        <div className="result-banner-text">
          <h3>
            {hasFindings
              ? `Обнаружены признаки возможных нарушений: ${result.violations.length}`
              : needsReview
                ? 'Результат требует проверки'
                : 'Нарушение не обнаружено'}
          </h3>
          {(hasFindings || needsReview) && (
            <p>
              {hasFindings
                ? 'Просмотрите фрагменты видео и кадры-доказательства ниже.'
                : 'Отсутствие находок не подтверждено. Просмотрите запись.'}
            </p>
          )}
          <p className="result-banner-note">
            <ShieldCheck size={16} aria-hidden="true" />
            Результат — подсказка для проверки человеком. Решение принимает специалист.
          </p>
        </div>
      </div>
      <div className="result-facts">
        {result.rules_checked !== undefined && (
          <span>
            Проверено типов нарушений<strong className="mono">{result.rules_checked}</strong>
          </span>
        )}
        <span>
          Длительность записи<strong className="mono">{timecode(duration)}</strong>
        </span>
        <span>
          Время обработки
          <strong className="mono">
            {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(
              result.processing_sec,
            )}{' '}
            с
          </strong>
        </span>
      </div>
      <p className="print-only">
        Отчёт Observer · задача {result.job_id} · {new Date().toLocaleString('ru-RU')}
      </p>
      <div className="result-actions">
        <Button type="button" className="h-10 rounded-xl" onClick={() => window.print()}>
          <Printer aria-hidden="true" /> Отчёт / PDF
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-xl"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(window.location.href)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          <Link2 aria-hidden="true" /> Скопировать ссылку
        </Button>
        {copied && (
          <span className="small-note" role="status">
            Ссылка скопирована
          </span>
        )}
        {result.violations.length > 0 && (
          <span className="review-progress">
            Проверено {reviewed} из {result.violations.length}
            <span className="review-progress-bar" aria-hidden="true">
              <span style={{ width: `${(reviewed / result.violations.length) * 100}%` }} />
            </span>
          </span>
        )}
      </div>
      {serviceMode === 'stub' && (
        <Alert className="mb-5 rounded-xl border-0 bg-muted">
          <ScanSearch />
          <AlertTitle>Тестовый результат</AlertTitle>
          <AlertDescription>
            Сервис использует заглушку. События вымышлены и не являются выводом по записи.
          </AlertDescription>
        </Alert>
      )}
      {serviceMode === 'unknown' && (
        <Alert className="mb-5 rounded-xl">
          <CircleAlert />
          <AlertTitle>Режим сервиса не подтверждён</AlertTitle>
          <AlertDescription>
            Не удалось проверить, подключена ли модель анализа. Проверьте результат с
            администратором сервиса.
          </AlertDescription>
        </Alert>
      )}
      {result.degraded === true && (
        <Alert className="mb-5 rounded-xl border-0 bg-[var(--violation-bg)] text-[var(--violation)]">
          <CircleAlert />
          <AlertTitle>Анализ выполнен не полностью</AlertTitle>
          <AlertDescription>
            Часть проверки недоступна. Отсутствие находок не подтверждает отсутствие нарушения;
            требуется просмотр записи человеком.
          </AlertDescription>
        </Alert>
      )}
      {result.degraded === undefined && serviceMode === 'pipeline' && (
        <Alert className="mb-5 rounded-xl">
          <CircleAlert />
          <AlertTitle>Полнота анализа не подтверждена</AlertTitle>
          <AlertDescription>
            Сервис не сообщил, выполнены ли все этапы проверки. Отсутствие находок требует проверки
            человеком.
          </AlertDescription>
        </Alert>
      )}
      <VideoPreview
        key={result.job_id}
        ref={playerRef}
        result={result}
        apiKey={apiKey}
        onPositionChange={(time) => setPosition({ jobId: result.job_id, time })}
        onAvailabilityChange={(available) => setAvailability({ jobId: result.job_id, available })}
      />
      {order.length > 0 && (
        <div className="event-nav">
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl"
            disabled={!canSeek}
            aria-label="Предыдущее событие"
            onClick={() => step(-1)}
          >
            <ChevronLeft aria-hidden="true" /> Предыдущее
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl"
            disabled={!canSeek}
            aria-label="Следующее событие"
            onClick={() => step(1)}
          >
            Следующее событие <ChevronRight aria-hidden="true" />
          </Button>
          <span className="small-note">
            Клавиши <kbd>[</kbd> и <kbd>]</kbd>
          </span>
        </div>
      )}
      <Timeline
        result={result}
        activeTime={activeTime}
        canSeek={canSeek}
        onSeek={(seconds) => playerRef.current?.seek(seconds)}
        onEventSeek={(index) => seek(index, result.violations[index].timecode_sec)}
        isHighlighted={isHighlighted}
      />
      {result.violations.map((violation, index) => (
        <Card
          role="article"
          aria-label={`Событие ${index + 1}: ${violation.type}`}
          key={`${index}:${violation.type_id}:${violation.timecode_sec}`}
          className={`event-card gap-5 rounded-2xl shadow-none ${isHighlighted(index) ? 'event-current' : ''}`}
          aria-current={isActive(index) ? 'true' : undefined}
        >
          <CardHeader className="gap-3 px-5">
            <div className="event-heading">
              <span className="event-number mono">{String(index + 1).padStart(2, '0')}</span>
              <CardTitle>
                <h4>{violation.type}</h4>
              </CardTitle>
            </div>
            <div className="event-metadata">
              <Button
                type="button"
                variant="link"
                className="mono min-h-11 h-auto whitespace-normal px-0 text-brand has-[>svg]:px-0"
                aria-label={`Перейти к событию ${index + 1}, ${violation.timecode_sec} с`}
                title={`${violation.timecode_sec} с от начала видео`}
                disabled={!canSeek}
                onClick={() => seek(index, violation.timecode_sec)}
              >
                <Play aria-hidden="true" />
                {timecode(violation.timecode_sec)} · {violation.timecode_sec} с
              </Button>
              {isActive(index) && (
                <Badge className="rounded-full bg-accent text-primary">Текущий фрагмент</Badge>
              )}
              <Badge variant="secondary" className="rounded-full">
                <span
                  className="confidence-scale"
                  role="img"
                  aria-label={`Уверенность ${confidenceSteps[violation.confidence_level]} из 3`}
                >
                  {[1, 2, 3].map((step) => (
                    <i
                      key={step}
                      data-filled={step <= confidenceSteps[violation.confidence_level] || undefined}
                    />
                  ))}
                </span>
                Уверенность: {confidenceLabels[violation.confidence_level]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="event-body px-5">
            <EvidenceGallery
              frames={violation.evidence_frames}
              eventIndex={index}
              canSeek={canSeek}
              onShow={(seconds) => seek(index, seconds)}
            />
            <div className="event-text">
              <dl className="event-explanation">
                <div>
                  <dt>Что видно</dt>
                  <dd>{violation.observed}</dd>
                </div>
                <div>
                  <dt>Почему это может быть нарушением</dt>
                  <dd>{violation.why}</dd>
                </div>
              </dl>
              <div className="event-rule">
                <h5>Норматив</h5>
                {violation.rule ? (
                  <>
                    <p>{violation.rule.document}</p>
                    {violation.rule.point && (
                      <p className="text-muted-foreground">{violation.rule.point}</p>
                    )}
                    {violation.rule.quote && (
                      <details className="rule-quote">
                        <summary>Фрагмент документа</summary>
                        <blockquote>{violation.rule.quote}</blockquote>
                      </details>
                    )}
                    <a
                      className="source-link"
                      aria-label={`Открыть источник: ${violation.rule.document}`}
                      href={violation.rule.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Открыть источник <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  </>
                ) : (
                  <p className="rule-missing">
                    <CircleAlert size={16} aria-hidden="true" />
                    Норматив не определён, требуется проверка.
                  </p>
                )}
              </div>
            </div>
            <ReviewDecision
              decision={review[index]}
              onChange={(decision) => update(index, decision)}
            />
          </CardContent>
        </Card>
      ))}
      <Button
        className="mt-6 h-12 rounded-xl px-6 text-base font-normal has-[>svg]:px-6"
        onClick={onReset}
      >
        <Upload size={17} /> Новое видео
      </Button>
    </div>
  )
}
