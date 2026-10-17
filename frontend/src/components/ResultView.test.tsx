import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import cleanDetails from '../../../docs/frontend/mock_details_clean.json'
import sampleDetails from '../../../docs/frontend/mock_details.json'
import type { DoneDetails, Violation } from '@/api/contracts'
import { ResultView } from './ResultView'

function event(index = 0, overrides: Partial<Violation> = {}): Violation {
  return {
    ...sampleDetails.violations[0],
    type_id: `event-${index}`,
    type: `Событие ${index + 1}`,
    timecode_sec: 8.625 + index,
    confidence_level: 'high',
    observed: `Наблюдение ${index + 1}: кассир вышла из помещения.`,
    why: `Обоснование ${index + 1}: ценности остались без присмотра.`,
    evidence_frames: [
      { ...sampleDetails.violations[0].evidence_frames[0], timestamp_sec: 8.625 + index },
    ],
    ...overrides,
  }
}

function result(violations: Violation[] = [], overrides: Partial<DoneDetails> = {}): DoneDetails {
  return {
    job_id: cleanDetails.job_id,
    status: 'done',
    duration_sec: cleanDetails.duration_sec,
    processing_sec: cleanDetails.processing_sec,
    rules_checked: cleanDetails.rules_checked,
    preview_url: cleanDetails.preview_url,
    verdict: violations.length ? 'violation' : 'no_violation',
    violations,
    degraded: false,
    ...overrides,
  }
}

describe('ResultView', () => {
  it.each([0, 1, 4])('shows all %s events and the corresponding verdict', (count) => {
    const violations = Array.from({ length: count }, (_, index) => event(index))
    render(<ResultView result={result(violations)} onReset={vi.fn()} serviceMode="pipeline" />)

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      count ? `Обнаружены признаки возможных нарушений: ${count}` : 'Нарушение не обнаружено',
    )
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(count)
    for (const violation of violations) {
      expect(screen.getByRole('heading', { name: violation.type })).toBeVisible()
      expect(screen.getByText(violation.observed)).toBeVisible()
      expect(screen.getByText(violation.why)).toBeVisible()
    }
    if (!count) expect(screen.queryByText('Что видно')).not.toBeInTheDocument()
  })

  it('shows an unknown server type, confidence and an exact fractional timecode', () => {
    const violation = event(0, {
      type_id: 'future-risk-type',
      type: 'Новый вид риска, поступивший с сервера',
      confidence_level: 'medium',
    })
    render(<ResultView result={result([violation])} onReset={vi.fn()} serviceMode="pipeline" />)
    expect(screen.getByRole('heading', { name: violation.type })).toBeVisible()
    expect(screen.getAllByText('00:08,6 · 8,6 с')).toHaveLength(2)
    expect(screen.getByText('Уверенность: средняя')).toBeVisible()
    expect(screen.getByText(violation.observed)).toBeVisible()
    expect(screen.getByText(violation.why)).toBeVisible()
  })

  it('lets the user expand a long normative quote and open its actual source', async () => {
    const user = userEvent.setup()
    const quote = 'Подробное положение открытого нормативного источника. '.repeat(30)
    render(
      <ResultView
        result={result([
          event(0, {
            rule: {
              document: 'Открытый норматив РК',
              point: 'п. 20',
              quote,
              url: 'https://adilet.zan.kz/rus/docs/example',
            },
          }),
        ])}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.getByText(quote.trim())).not.toBeVisible()
    await user.click(screen.getByText('Фрагмент документа'))
    expect(screen.getByText(quote.trim())).toBeVisible()
    expect(screen.getByText('п. 20')).toBeVisible()
    const link = screen.getByRole('link', { name: 'Открыть источник' })
    expect(link).toHaveAttribute('href', 'https://adilet.zan.kz/rus/docs/example')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await user.click(screen.getByText('Фрагмент документа'))
    expect(screen.getByText(quote.trim())).not.toBeVisible()
  })

  it.each([
    { document: 'Норматив без точного пункта', url: 'https://adilet.zan.kz/rus/docs/example' },
    {
      document: 'Норматив без точного пункта',
      url: 'https://adilet.zan.kz/rus/docs/example',
      point: null,
      quote: null,
    },
  ])('shows a partial normative source without inventing a point or quote', (rule) => {
    render(
      <ResultView result={result([event(0, { rule })])} onReset={vi.fn()} serviceMode="pipeline" />,
    )
    expect(screen.getByText(rule.document)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Открыть источник' })).toHaveAttribute('href', rule.url)
    expect(screen.queryByText('Фрагмент документа')).not.toBeInTheDocument()
    expect(screen.queryByText('п. 20')).not.toBeInTheDocument()
    expect(screen.queryByText(/Источник не указан/)).not.toBeInTheDocument()
  })

  it.each([undefined, null])('marks a missing normative source explicitly: %s', (rule) => {
    render(
      <ResultView result={result([event(0, { rule })])} onReset={vi.fn()} serviceMode="pipeline" />,
    )
    expect(screen.getByText('Источник не указан, требуется проверка.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Открыть источник' })).not.toBeInTheDocument()
    expect(screen.getByText('Что видно')).toBeVisible()
    expect(screen.getByText('Почему это может быть нарушением')).toBeVisible()
  })

  it('does not invent a zero rule count when the service omits it', () => {
    render(
      <ResultView
        result={result([], { rules_checked: undefined })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.queryByText('Проверено правил')).not.toBeInTheDocument()
    expect(screen.getByText('Время обработки')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Нарушение не обнаружено' })).toBeVisible()
  })

  it('marks missing completeness as unknown instead of a confirmed green clean result', () => {
    render(
      <ResultView
        result={result([], { degraded: undefined })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Полнота анализа не подтверждена')
    expect(screen.getByText(/Сервис не сообщил, выполнены ли все этапы проверки/)).toBeVisible()
    expect(screen.getByRole('status')).not.toHaveClass('clean')
    expect(screen.queryByText('Анализ выполнен не полностью')).not.toBeInTheDocument()
  })

  it.each([
    {
      mode: 'stub' as const,
      degraded: false,
      title: 'Тестовый результат',
      explanation: /Сервис использует заглушку/,
    },
    {
      mode: 'pipeline' as const,
      degraded: true,
      title: 'Анализ выполнен не полностью',
      explanation: /Отсутствие находок не подтверждает отсутствие нарушения/,
    },
    {
      mode: 'unknown' as const,
      degraded: false,
      title: 'Режим сервиса не подтверждён',
      explanation: /Не удалось проверить, подключена ли модель анализа/,
    },
  ])(
    'warns about $mode / degraded=$degraded without presenting a green clean result',
    ({ mode, degraded, title, explanation }) => {
      render(<ResultView result={result([], { degraded })} onReset={vi.fn()} serviceMode={mode} />)
      expect(screen.getByRole('alert')).toHaveTextContent(title)
      expect(screen.getByText(explanation)).toBeVisible()
      expect(screen.getByRole('status')).not.toHaveClass('clean')
    },
  )

  it('keeps explanations and the other cards when a JPEG fails to decode', () => {
    const violations = Array.from({ length: 4 }, (_, index) => event(index))
    render(<ResultView result={result(violations)} onReset={vi.fn()} serviceMode="pipeline" />)
    fireEvent.error(screen.getByAltText('Кадр-доказательство на 8.625 с'))
    expect(screen.getByText('Кадр недоступен. Проверьте исходную запись.')).toBeVisible()
    expect(screen.getAllByRole('img')).toHaveLength(3)
    for (const violation of violations) {
      expect(screen.getByRole('heading', { name: violation.type })).toBeVisible()
      expect(screen.getByText(violation.observed)).toBeVisible()
      expect(screen.getByText(violation.why)).toBeVisible()
    }
  })

  it('opens evidence with Enter, closes with Escape and restores trigger focus', async () => {
    const user = userEvent.setup()
    render(<ResultView result={result([event()])} onReset={vi.fn()} serviceMode="pipeline" />)
    const trigger = screen.getByRole('button', { name: 'Увеличить кадр 1 события 1, 8.625 с' })
    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Кадр-доказательство' })
    expect(within(dialog).getByAltText('Кадр-доказательство на 8.625 с')).toBeVisible()
    expect(within(dialog).getByText('Событие 1, кадр 1 · 8.625 с от начала видео')).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('starts the new-video flow through the reset button', async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(<ResultView result={result()} onReset={onReset} serviceMode="pipeline" />)
    await user.click(screen.getByRole('button', { name: 'Новое видео' }))
    expect(onReset).toHaveBeenCalledOnce()
  })
})


describe('ResultView review fixes', () => {
  it('shows an unconfirmed clean result as neutral review, not as a violation', () => {
    const { container } = render(
      <ResultView result={result([])} onReset={vi.fn()} serviceMode="unknown" />,
    )
    const banner = container.querySelector('.result-banner')
    expect(banner).toHaveClass('needs-review')
    expect(banner).not.toHaveClass('has-findings')
  })
})
