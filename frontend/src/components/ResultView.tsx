import { useState } from 'react'
import {
  CircleAlert,
  ExternalLink,
  ImageOff,
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

function timecode(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')
  const rest = new Intl.NumberFormat('ru-RU', {
    minimumIntegerDigits: 2,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(seconds % 60)
  return `${minutes}:${rest}`
}

const seconds1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, useGrouping: false })

function sec(value: number) {
  return seconds1.format(value)
}

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
}: {
  frame: EvidenceFrame
  eventIndex: number
  frameIndex: number
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
      <figcaption className="mono" title={`${frame.timestamp_sec} с от начала видео`}>
        {timecode(frame.timestamp_sec)} · {sec(frame.timestamp_sec)} с
      </figcaption>
    </figure>
  )
}

const confidenceLabels = { low: 'низкая', medium: 'средняя', high: 'высокая' }

export function ResultView({
  result,
  onReset,
  serviceMode,
}: {
  result: DoneDetails
  onReset: () => void
  serviceMode: 'stub' | 'pipeline' | 'unknown'
}) {
  const hasFindings = result.verdict === 'violation'
  const needsReview = result.degraded !== false || serviceMode !== 'pipeline'
  return (
    <div className="result-body">
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
      <div
        className={`result-banner ${hasFindings ? 'has-findings' : needsReview ? 'needs-review' : 'clean'}`}
        role="status"
      >
        {hasFindings || needsReview ? <CircleAlert size={28} /> : <ShieldCheck size={28} />}
        <h3>
          {hasFindings
            ? `Обнаружены признаки возможных нарушений: ${result.violations.length}`
            : 'Нарушение не обнаружено'}
        </h3>
      </div>
      <div className="result-facts">
        {result.rules_checked !== undefined && (
          <span>
            Проверено правил<strong className="mono">{result.rules_checked}</strong>
          </span>
        )}
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
      {result.violations.map((violation, index) => (
        <Card
          role="article"
          aria-label={`Событие ${index + 1}: ${violation.type}`}
          key={`${index}:${violation.type_id}:${violation.timecode_sec}`}
          className="event-card gap-5 rounded-2xl shadow-none"
        >
          <CardHeader className="gap-3 px-5">
            <div className="event-heading">
              <span className="event-number mono">{String(index + 1).padStart(2, '0')}</span>
              <CardTitle>
                <h4>{violation.type}</h4>
              </CardTitle>
            </div>
            <div className="event-metadata">
              <span className="mono" title={`${violation.timecode_sec} с от начала видео`}>
                {timecode(violation.timecode_sec)} · {sec(violation.timecode_sec)} с
              </span>
              <Badge variant="secondary" className="rounded-full">
                Уверенность: {confidenceLabels[violation.confidence_level]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 px-5">
            <div className="evidence-grid">
              {violation.evidence_frames.map((frame, frameIndex) => (
                <EvidencePreview
                  key={`${frameIndex}:${frame.timestamp_sec}`}
                  frame={frame}
                  eventIndex={index}
                  frameIndex={frameIndex}
                />
              ))}
            </div>
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
              <h5>Нормативный источник</h5>
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
                <p className="text-[var(--violation)]">Источник не указан, требуется проверка.</p>
              )}
            </div>
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
