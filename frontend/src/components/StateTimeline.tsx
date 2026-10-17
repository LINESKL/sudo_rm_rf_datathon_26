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

export function StateTimeline({
  result,
  activeTime,
  canSeek,
  onSeek,
}: {
  result: DoneDetails
  activeTime: number | null
  canSeek: boolean
  onSeek: (seconds: number) => void
}) {
  const duration = result.duration_sec
  if (!Number.isFinite(duration) || duration <= 0) return null

  const clamp = (seconds: number) => Math.max(0, Math.min(seconds, duration))
  const rows = Object.entries(result.timeline ?? {})
    .map(([key, intervals]) => ({
      key,
      intervals: intervals
        .map(([start, end]) => ({
          start,
          end,
          visibleStart: clamp(start),
          visibleEnd: clamp(end),
          overlap: result.violations.some((event) =>
            event.timecode_sec === event.timecode_end_sec
              ? event.timecode_sec >= start && event.timecode_sec < end
              : event.timecode_sec < end && event.timecode_end_sec > start,
          ),
        }))
        .filter(
          ({ start, end, visibleStart, visibleEnd }) =>
            Number.isFinite(start) && Number.isFinite(end) && visibleEnd > visibleStart,
        ),
    }))
    .filter((row) => row.intervals.length > 0)
  if (rows.length === 0) return null

  const cursorTime = activeTime !== null && Number.isFinite(activeTime) ? clamp(activeTime) : null

  return (
    <section className="timeline-section" aria-label="Состояния сцены">
      <h3>Состояния сцены</h3>
      <p className="small-note">Состояния описывают сцену и сами по себе не означают нарушение.</p>
      <p className="small-note mono" title={activeTime === null ? undefined : `${activeTime} с`}>
        Позиция видео: {cursorTime === null ? 'не выбрана' : timecode(cursorTime)}
      </p>
      {!canSeek && (
        <p className="small-note">
          Переход к видео недоступен. Интервалы остаются доступны для просмотра.
        </p>
      )}
      <div className="timeline-scale mono" aria-hidden="true">
        <span>{timecode(0)}</span>
        <span>{timecode(duration)}</span>
      </div>
      {rows.map(({ key, intervals }, rowIndex) => {
        const labels = result.timeline_labels
        const serverLabel = labels && Object.hasOwn(labels, key) ? labels[key].trim() : ''
        const label = serverLabel || FALLBACK_LABELS.get(key) || `Состояние ${rowIndex + 1}`

        return (
          <div className="timeline-row" role="group" aria-label={label} key={key}>
            <div className="timeline-row-heading">
              <h4 className="timeline-label">{label}</h4>
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
                      variant="outline"
                      className="timeline-jump min-h-11 h-auto whitespace-normal rounded-xl"
                      disabled={!canSeek}
                      aria-label={`Перейти к состоянию ${exactInterval}${overlap ? '. Совпадает с событием' : ''}`}
                      aria-current={current ? 'true' : undefined}
                      title={exactInterval}
                      data-overlap={overlap || undefined}
                      onClick={() => onSeek(start)}
                    >
                      <span>
                        <span className="mono">
                          {timecode(start)}–{timecode(end)}
                        </span>
                        {overlap && <span className="block text-xs">Совпадает с событием</span>}
                        {current && <span className="block text-xs">Текущий интервал</span>}
                      </span>
                    </Button>
                  )
                })}
              </div>
            </div>
            <div className="timeline-rail" aria-hidden="true">
              {intervals.map(({ start, end, visibleStart, visibleEnd, overlap }, index) => {
                return (
                  <span
                    key={`${index}:${start}:${end}`}
                    className={`timeline-interval${overlap ? ' timeline-interval-overlap' : ''}`}
                    title={`${label}: ${start}–${end} с от начала видео`}
                    style={{
                      left: `${(visibleStart / duration) * 100}%`,
                      width: `${((visibleEnd - visibleStart) / duration) * 100}%`,
                    }}
                  />
                )
              })}
              {cursorTime !== null && (
                <span
                  className="timeline-cursor"
                  style={{ left: `${(cursorTime / duration) * 100}%` }}
                />
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}
