import { Button } from '@/components/ui/button'
import type { Decision, Verdict } from '@/lib/useReview'

const OPTIONS: { verdict: Verdict; label: string; pressed: string }[] = [
  {
    verdict: 'confirmed',
    label: 'Нарушение подтверждаю',
    pressed:
      'border-[var(--violation)] bg-[var(--violation)] text-white hover:bg-[var(--violation)]',
  },
  {
    verdict: 'rejected',
    label: 'Не нарушение',
    pressed: 'border-[var(--ok)] bg-[var(--ok)] text-white hover:bg-[var(--ok)]',
  },
  {
    verdict: 'unsure',
    label: 'Не уверен',
    pressed:
      'border-[var(--review)] bg-[var(--review-bg)] text-[var(--review)] hover:bg-[var(--review-bg)]',
  },
]

export function ReviewDecision({
  decision,
  onChange,
}: {
  decision: Decision | undefined
  onChange: (decision: Decision | null) => void
}) {
  return (
    <div className="review-decision" role="group" aria-label="Решение проверяющего">
      <span className="review-caption">Ваше решение</span>
      <div className="review-options">
        {OPTIONS.map(({ verdict, label, pressed }) => (
          <Button
            key={verdict}
            type="button"
            variant="outline"
            className={`review-option h-9 rounded-lg ${decision?.verdict === verdict ? pressed : ''}`}
            aria-pressed={decision?.verdict === verdict}
            onClick={() =>
              onChange(
                decision?.verdict === verdict
                  ? null
                  : { verdict, comment: decision?.comment ?? '' },
              )
            }
          >
            {label}
          </Button>
        ))}
      </div>
      {decision && (
        <textarea
          className="review-comment"
          aria-label="Комментарий проверяющего"
          placeholder="Комментарий для отчёта (необязательно)"
          value={decision.comment}
          onChange={(event) => onChange({ ...decision, comment: event.target.value })}
        />
      )}
    </div>
  )
}
