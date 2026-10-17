import type { DoneDetails } from '@/api/contracts'
import { Button } from '@/components/ui/button'
import { timecode } from '@/lib/timecode'

const FALLBACK_LABELS = new Map([
  ['cashier_present', 'Кассир на месте'],
  ['cash_on_desk', 'Деньги на столе'],
  ['bag_on_desk', 'Сумка инкассации на столе'],
  ['safe_open', 'Сейф открыт'],
  ['screen_unlocked', 'Экран разблокирован'],
  ['outsider_in_cashier_zone', 'Посторонний в зоне кассира'],
])

// Лента времени под плеером: события и состояния сцены на одной шкале с общим курсором.
export function Timeline({
  result,
  activeTime,
  canSeek,
  onSeek,
  onEventSeek,
  isHighlighted,
}: {
  result: DoneDetails
  activeTime: number | null
  canSeek: boolean
  onSeek: (seconds: number) => void
  onEventSeek: (index: number) => void
  isHighlighted: (index: number) => boolean
}) {
  const duration = result.duration_sec
  if (!Number.isFinite(duration) || duration <= 0) return null

  const clamp = (seconds: number) => Math.max(0, Math.min(seconds, duration))
  const percent = (seconds: number) => `${(clamp(seconds) / duration) * 100}%`
  const events = result.violations
  const rows = Object.entries(result.timeline ?? {})
    .map(([key, intervals]) => ({
      key,
      intervals: intervals
        .map(([start, end]) => ({
          start,
          end,
          visibleStart: clamp(start),
          visibleEnd: clamp(end),
          overlap: events.some((event) =>
            event.timecode_sec === event.timecode_end_sec
              ? event.timecode_sec >= start && event.timecode_sec < end
              : event.timecode_sec < end && event.timecode_end_sec > start,
          ),
          hits: events
            .map((event) => [
              Math.max(clamp(start), clamp(event.timecode_sec)),
              Math.min(clamp(end), clamp(event.timecode_end_sec)),
            ])
            .filter(([from, to]) => to > from),
        }))
        .filter(
          ({ start, end, visibleStart, visibleEnd }) =>
            Number.isFinite(start) && Number.isFinite(end) && visibleEnd > visibleStart,
        ),
    }))
    .filter((row) => row.intervals.length > 0)
  if (rows.length === 0 && events.length === 0) return null

  const cursorTime = activeTime !== null && Number.isFinite(activeTime) ? clamp(activeTime) : null
  const cursor = cursorTime !== null && (
    <span className="timeline-cursor" aria-hidden="true" style={{ left: percent(cursorTime) }} />
  )

  return (
    <section className="timeline-section" aria-label="Лента времени">
      <div className="timeline-head">
        <h3>Лента времени</h3>
        <p className="small-note mono" title={activeTime === null ? undefined : `${activeTime} с`}>
          Позиция видео: {cursorTime === null ? 'не выбрана' : timecode(cursorTime)}
        </p>
      </div>
      {!canSeek && (
        <p className="small-note">
          Переход к видео недоступен. Интервалы остаются доступны для просмотра.
        </p>
      )}
      <div className="timeline-scale mono" aria-hidden="true">
        <span>{timecode(0)}</span>
        <span>{timecode(duration)}</span>
      </div>
      {events.map((event, index) => (
        <div
          className="timeline-row timeline-row-event"
          role="group"
          aria-label={`Событие ${index + 1}`}
          key={`${index}:${event.type_id}`}
        >
          <span className="timeline-label" title={event.type}>
            {index + 1}. {event.type}
          </span>
          <div className="timeline-rail timeline-rail-event">
            <Button
              type="button"
              variant="outline"
              className="event-marker h-7 justify-start rounded-md border-[var(--violation)]/45 bg-[var(--violation-bg)] px-2 text-xs text-[var(--violation)] shadow-none hover:bg-accent hover:text-[var(--violation)] disabled:opacity-100 data-[highlighted]:border-[var(--violation)] data-[highlighted]:bg-[var(--violation)] data-[highlighted]:text-white"
              style={{
                left: percent(event.timecode_sec),
                width: `${((clamp(event.timecode_end_sec) - clamp(event.timecode_sec)) / duration) * 100}%`,
              }}
              disabled={!canSeek}
              title={event.type}
              aria-label={`Событие ${index + 1}: ${event.type}, ${timecode(event.timecode_sec)}`}
              data-highlighted={isHighlighted(index) || undefined}
              onClick={() => onEventSeek(index)}
            >
              <span className="mono">{timecode(event.timecode_sec)}</span>
            </Button>
            {cursor}
          </div>
        </div>
      ))}
      {rows.length > 0 && events.length > 0 && <hr className="timeline-divider" />}
      {rows.map(({ key, intervals }, rowIndex) => {
        const labels = result.timeline_labels
        const serverLabel = labels && Object.hasOwn(labels, key) ? labels[key].trim() : ''
        const label = serverLabel || FALLBACK_LABELS.get(key) || `Состояние ${rowIndex + 1}`

        return (
          <div className="timeline-row" role="group" aria-label={label} key={key}>
            <h4 className="timeline-label">{label}</h4>
            <div className="timeline-rail" aria-hidden="true">
              {intervals.map(({ start, end, visibleStart, visibleEnd, overlap, hits }, index) => (
                <span key={`${index}:${start}:${end}`}>
                  <span
                    className={`timeline-interval${overlap ? ' timeline-interval-overlap' : ''}`}
                    title={`${label}: ${start}–${end} с от начала видео`}
                    style={{
                      left: `${(visibleStart / duration) * 100}%`,
                      width: `${((visibleEnd - visibleStart) / duration) * 100}%`,
                    }}
                  />
                  {hits.map(([from, to]) => (
                    <span
                      key={`${from}:${to}`}
                      className="timeline-hit"
                      style={{
                        left: `${(from / duration) * 100}%`,
                        width: `${((to - from) / duration) * 100}%`,
                      }}
                    />
                  ))}
                </span>
              ))}
              {cursor}
            </div>
            <div className="timeline-actions">
              {intervals.map(({ start, end, overlap }, index) => {
                const current =
                  cursorTime !== null &&
                  cursorTime >= start &&
                  (cursorTime < end || (cursorTime === duration && end >= duration))
                const exactInterval = `${label}: ${start}–${end} с от начала видео`
                return (
                  <Button
                    key={`${index}:${start}:${end}`}
                    type="button"
                    variant="ghost"
                    className="timeline-jump mono"
                    disabled={!canSeek}
                    aria-label={`Перейти к состоянию ${exactInterval}${overlap ? '. Совпадает с событием' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    title={exactInterval}
                    data-overlap={overlap || undefined}
                    onClick={() => onSeek(start)}
                  >
                    {timecode(start)}–{timecode(end)}
                    {overlap && <span className="visually-hidden">Совпадает с событием</span>}
                  </Button>
                )
              })}
            </div>
          </div>
        )
      })}
      {rows.length > 0 && (
        <p className="timeline-legend small-note">
          <span>
            <i className="timeline-swatch" /> состояние
          </span>
          <span>
            <i className="timeline-swatch timeline-swatch-hit" /> пересечение с событием
          </span>
          <span>Состояния описывают сцену и сами по себе не означают нарушение.</span>
        </p>
      )}
    </section>
  )
}
