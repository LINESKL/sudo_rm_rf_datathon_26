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

    expect(
      screen.getByRole('heading', {
        level: 3,
        name: count
          ? `Обнаружены признаки возможных нарушений: ${count}`
          : 'Нарушение не обнаружено',
      }),
    ).toBeVisible()
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(count)
    expect(screen.queryAllByRole('article')).toHaveLength(count)
    for (const [index, violation] of violations.entries()) {
      const article = screen.getByRole('article', {
        name: `Событие ${index + 1}: ${violation.type}`,
      })
      expect(within(article).getByRole('heading', { name: violation.type })).toBeVisible()
      expect(within(article).getByText(violation.observed)).toBeVisible()
      expect(within(article).getByText(violation.why)).toBeVisible()
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
    expect(screen.getAllByText('00:08,6 · 8.625 с')).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Увеличить кадр 1 события 1, 8.625 с' }),
    ).toBeVisible()
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
    const link = screen.getByRole('link', { name: 'Открыть источник: Открытый норматив РК' })
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
    expect(
      screen.getByRole('link', { name: `Открыть источник: ${rule.document}` }),
    ).toHaveAttribute('href', rule.url)
    expect(screen.queryByText('Фрагмент документа')).not.toBeInTheDocument()
    expect(screen.queryByText('п. 20')).not.toBeInTheDocument()
    expect(screen.queryByText(/Норматив не определён/)).not.toBeInTheDocument()
  })

  it.each([undefined, null])('marks a missing normative source explicitly: %s', (rule) => {
    render(
      <ResultView result={result([event(0, { rule })])} onReset={vi.fn()} serviceMode="pipeline" />,
    )
    expect(screen.getByText('Норматив не определён, требуется проверка.')).toBeVisible()
    expect(screen.queryByRole('link', { name: /^Открыть источник/ })).not.toBeInTheDocument()
    expect(screen.getByText('Что видно')).toBeVisible()
    expect(screen.getByText('Почему это может быть нарушением')).toBeVisible()
  })

  it('distinguishes repeated event types and source links by their accessible names', () => {
    const violations = [
      event(0, {
        type: 'Кассир покинул рабочее место',
        rule: {
          document: 'Правила кассовых операций РК',
          url: 'https://adilet.zan.kz/rus/docs/first',
        },
      }),
      event(1, {
        type: 'Кассир покинул рабочее место',
        rule: {
          document: 'Инструкция по хранению ценностей',
          url: 'https://adilet.zan.kz/rus/docs/second',
        },
      }),
    ]
    render(<ResultView result={result(violations)} onReset={vi.fn()} serviceMode="pipeline" />)

    for (const [index, violation] of violations.entries()) {
      const article = screen.getByRole('article', {
        name: `Событие ${index + 1}: ${violation.type}`,
      })
      const link = within(article).getByRole('link', {
        name: `Открыть источник: ${violation.rule!.document}`,
      })
      expect(link).toHaveAttribute('href', violation.rule!.url)
    }
  })

  it('does not invent a zero rule count when the service omits it', () => {
    render(
      <ResultView
        result={result([], { rules_checked: undefined })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.queryByText('Проверено типов нарушений')).not.toBeInTheDocument()
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
    expect(screen.getAllByAltText(/^Кадр-доказательство/)).toHaveLength(3)
    for (const violation of violations) {
      expect(screen.getByRole('heading', { name: violation.type })).toBeVisible()
      expect(screen.getByText(violation.observed)).toBeVisible()
      expect(screen.getByText(violation.why)).toBeVisible()
    }
  })

  it('opens evidence with Enter, closes with Escape and restores trigger focus', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const user = userEvent.setup()
    render(<ResultView result={result([event()])} onReset={vi.fn()} serviceMode="pipeline" />)
    const trigger = screen.getByRole('button', { name: 'Увеличить кадр 1 события 1, 8.625 с' })
    await user.tab()
    expect(screen.getByRole('button', { name: 'Отчёт / PDF' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Скопировать ссылку' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Плеер загруженного видео')).toHaveFocus()
    await user.tab()
    // Preview access refresh no longer needs a key, so it is a real tab stop now.
    expect(screen.getByRole('button', { name: /Обновить доступ к видео/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Предыдущее событие' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Следующее событие' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Событие 1: Событие 1, 00:08,6' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Перейти к событию 1, 8.625 с' })).toHaveFocus()
    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Кадр-доказательство' })
    expect(within(dialog).getByAltText('Кадр-доказательство на 8.625 с')).toBeVisible()
    expect(within(dialog).getByText('Событие 1, кадр 1 · 8.625 с от начала видео')).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('starts the new-video flow through the reset button', async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(<ResultView result={result()} onReset={onReset} serviceMode="pipeline" />)
    await user.click(screen.getByRole('button', { name: 'Новое видео' }))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('opens the context before the first and last events without changing evidence timestamps', async () => {
    const user = userEvent.setup()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const violations = [
      event(0, { timecode_sec: 0.25, timecode_end_sec: 0.5 }),
      event(1, { timecode_sec: 19.875, timecode_end_sec: 20 }),
    ]
    render(
      <ResultView
        result={result(violations, { duration_sec: 20 })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 })
    await user.click(screen.getByRole('button', { name: 'Перейти к событию 1, 0.25 с' }))
    expect(video.currentTime).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Событие 2: Событие 2, 00:19,9' }))
    expect(video.currentTime).toBe(18.875)
    expect(screen.getByText('00:19,9 · 19.875 с')).toBeVisible()
    expect(screen.getAllByAltText('Кадр-доказательство на 9.625 с')).toHaveLength(1)
    expect(play).toHaveBeenCalledTimes(2)
    play.mockRestore()
  })

  it('marks all overlapping events at the current position and clears selection for another job', () => {
    const violations = [
      event(0, { timecode_sec: 1, timecode_end_sec: 3 }),
      event(1, { timecode_sec: 2, timecode_end_sec: 4 }),
    ]
    const details = result(violations)
    const view = render(<ResultView result={details} onReset={vi.fn()} serviceMode="pipeline" />)
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    video.currentTime = 2.5
    fireEvent.timeUpdate(video)
    expect(screen.getAllByText('Текущий фрагмент')).toHaveLength(2)
    expect(
      screen.getAllByRole('article').every((card) => card.getAttribute('aria-current') === 'true'),
    ).toBe(true)
    view.rerender(
      <ResultView
        result={{ ...details, job_id: 'another-job' }}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.queryByText('Текущий фрагмент')).not.toBeInTheDocument()
    expect(screen.getAllByRole('article').every((card) => !card.hasAttribute('aria-current'))).toBe(
      true,
    )
  })

  it('keeps evidence and the keyboard dialog available after a media error', async () => {
    const user = userEvent.setup()
    render(
      <ResultView
        result={result([event()])}
        onReset={vi.fn()}
        serviceMode="pipeline"
        apiKey="private-test-key"
      />,
    )
    fireEvent.error(screen.getByLabelText('Плеер загруженного видео'))
    expect(screen.getByRole('alert')).toHaveTextContent('Видеопревью недоступно')
    expect(screen.getByRole('button', { name: 'Перейти к событию 1, 8.625 с' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: 'Событие 1' })).toBeVisible()
    const trigger = screen.getByRole('button', { name: 'Увеличить кадр 1 события 1, 8.625 с' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: 'Кадр-доказательство' })).toBeVisible()
    expect(document.body.innerHTML).not.toContain('private-test-key')
  })
})

describe('ResultView review fixes', () => {
  it('seeks a scene interval exactly and synchronizes its cursor with the player', async () => {
    const user = userEvent.setup()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const details = result([event()], {
      timeline: { cash_on_desk: [[2.625, 10]] },
      timeline_labels: { cash_on_desk: 'Деньги на столе' },
    })
    const view = render(<ResultView result={details} onReset={vi.fn()} serviceMode="pipeline" />)
    expect(screen.getByRole('region', { name: 'Лента времени' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^Состояния сцены/ }))
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: details.duration_sec })
    await user.click(
      within(screen.getByRole('group', { name: 'Деньги на столе' })).getByRole('button'),
    )
    expect(video.currentTime).toBe(2.625)
    expect(
      within(screen.getByRole('group', { name: 'Деньги на столе' })).getByRole('button'),
    ).toHaveAttribute('aria-current', 'true')
    video.currentTime = 12
    fireEvent.timeUpdate(video)
    expect(
      within(screen.getByRole('group', { name: 'Деньги на столе' })).getByRole('button'),
    ).not.toHaveAttribute('aria-current', 'true')
    view.rerender(
      <ResultView
        result={{ ...details, job_id: 'next-scene-job' }}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(view.container.querySelector('.timeline-cursor')).not.toBeInTheDocument()
    play.mockRestore()
  })

  it('disables scene navigation on media error without hiding timeline or evidence', () => {
    render(
      <ResultView
        result={result([event()], { timeline: { cash_on_desk: [[2, 10]] } })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const section = screen.getByRole('region', { name: 'Лента времени' })
    fireEvent.click(screen.getByRole('button', { name: /^Состояния сцены/ }))
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    video.currentTime = 3
    fireEvent.timeUpdate(video)
    expect(
      within(screen.getByRole('group', { name: 'Деньги на столе' })).getByRole('button'),
    ).toHaveAttribute('aria-current', 'true')
    fireEvent.error(video)
    expect(
      within(screen.getByRole('group', { name: 'Деньги на столе' })).getByRole('button'),
    ).toBeDisabled()
    expect(section.querySelector('.timeline-cursor')).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Событие 1: Событие 1' })).toBeVisible()
    expect(screen.getByAltText('Кадр-доказательство на 8.625 с')).toBeVisible()
  })

  it.each([
    { serviceMode: 'unknown' as const, degraded: false },
    { serviceMode: 'pipeline' as const, degraded: true },
  ])(
    'shows an unconfirmed clean result as neutral review: $serviceMode, degraded=$degraded',
    ({ serviceMode, degraded }) => {
      const { container } = render(
        <ResultView
          result={result([], { degraded })}
          onReset={vi.fn()}
          serviceMode={serviceMode}
        />,
      )
      const banner = container.querySelector('.result-banner')
      expect(banner).toHaveClass('needs-review')
      expect(banner).not.toHaveClass('has-findings')
      expect(screen.getByRole('heading', { name: 'Результат требует проверки' })).toBeVisible()
      expect(
        screen.queryByRole('heading', { name: 'Нарушение не обнаружено' }),
      ).not.toBeInTheDocument()
    },
  )

  it('keeps findings explicit when the analysis is incomplete', () => {
    const { container } = render(
      <ResultView
        result={result([event()], { degraded: true })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(container.querySelector('.result-banner')).toHaveClass('has-findings')
    expect(
      screen.getByRole('heading', { name: 'Обнаружены признаки возможных нарушений: 1' }),
    ).toBeVisible()
    expect(screen.getByText('Анализ выполнен не полностью')).toBeVisible()
    expect(screen.getByRole('article', { name: 'Событие 1: Событие 1' })).toBeVisible()
  })

  it.each([
    { seconds: 59.999, formatted: '01:00,0' },
    { seconds: 3599.999, formatted: '60:00,0' },
  ])(
    'carries a rounded timecode across the minute boundary at $seconds',
    ({ seconds, formatted }) => {
      const violation = event(0, {
        timecode_sec: seconds,
        evidence_frames: [
          { ...sampleDetails.violations[0].evidence_frames[0], timestamp_sec: seconds },
        ],
      })
      render(
        <ResultView
          result={result([violation], { duration_sec: 3601 })}
          onReset={vi.fn()}
          serviceMode="pipeline"
        />,
      )
      const timestamps = screen.getAllByTitle(`${seconds} с от начала видео`)
      expect(timestamps).toHaveLength(2)
      for (const timestamp of timestamps) expect(timestamp).toHaveTextContent(formatted)
      expect(
        screen.getByRole('button', { name: `Увеличить кадр 1 события 1, ${seconds} с` }),
      ).toBeVisible()
    },
  )
})

describe('ResultView polish', () => {
  function mountWithPlayer(violations: Violation[], overrides: Partial<DoneDetails> = {}) {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const view = render(
      <ResultView
        result={result(violations, overrides)}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 })
    return { ...view, video }
  }

  it('puts the verdict first and keeps the human-review note next to it', () => {
    render(
      <ResultView
        result={result([], { degraded: true })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const banner = screen.getByRole('heading', { level: 3, name: 'Результат требует проверки' })
    const caveat = screen.getByText('Анализ выполнен не полностью')
    expect(banner.compareDocumentPosition(caveat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      screen.getByText(
        'Результат — подсказка для проверки человеком. Решение принимает специалист.',
      ),
    ).toBeVisible()
  })

  it('shows the recording length among the result facts', () => {
    render(
      <ResultView
        result={result([], { duration_sec: 20.9 })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.getByText('Длительность записи').closest('span')).toHaveTextContent('00:20,9')
  })

  it('places each event marker on the video scale by its interval', () => {
    mountWithPlayer([event(0, { timecode_sec: 5, timecode_end_sec: 10 })], { duration_sec: 20 })
    const marker = screen.getByRole('button', { name: 'Событие 1: Событие 1, 00:05,0' })
    expect(marker).toHaveStyle({ left: '25%', width: '25%' })
  })

  it('highlights the event card as soon as its timecode is clicked', async () => {
    const user = userEvent.setup()
    mountWithPlayer([
      event(0, { timecode_end_sec: 9 }),
      event(1, { timecode_sec: 15, timecode_end_sec: 16 }),
    ])
    await user.click(screen.getByRole('button', { name: 'Событие 2: Событие 2, 00:15,0' }))
    expect(screen.getByRole('article', { name: 'Событие 2: Событие 2' })).toHaveClass(
      'event-current',
    )
    expect(screen.getByRole('article', { name: 'Событие 1: Событие 1' })).not.toHaveClass(
      'event-current',
    )
  })

  it('opens the video a second before an evidence frame', async () => {
    const user = userEvent.setup()
    const { video } = mountWithPlayer([
      event(0, {
        evidence_frames: [
          { ...sampleDetails.violations[0].evidence_frames[0], timestamp_sec: 12.5 },
        ],
      }),
    ])
    await user.click(screen.getByRole('button', { name: 'Показать кадр 1 события 1 в видео' }))
    expect(video.currentTime).toBe(11.5)
    expect(screen.getByRole('article', { name: 'Событие 1: Событие 1' })).toHaveClass(
      'event-current',
    )
  })
})

describe('ResultView event navigation', () => {
  it('steps through events in time order with buttons and wraps around', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    render(
      <ResultView
        result={result([
          event(0, { timecode_sec: 12, timecode_end_sec: 13 }),
          event(1, { timecode_sec: 4, timecode_end_sec: 5 }),
        ])}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    const next = screen.getByRole('button', { name: 'Следующее событие' })
    await user.click(next)
    expect(video.currentTime).toBe(3)
    expect(screen.getByRole('article', { name: 'Событие 2: Событие 2' })).toHaveClass(
      'event-current',
    )
    await user.click(next)
    expect(video.currentTime).toBe(11)
    await user.click(next)
    expect(video.currentTime).toBe(3)
    await user.click(screen.getByRole('button', { name: 'Предыдущее событие' }))
    expect(video.currentTime).toBe(11)
  })
})

describe('ResultView evidence gallery', () => {
  it('shows one large frame and switches it from thumbnails', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const jpeg = sampleDetails.violations[0].evidence_frames[0].image_base64
    render(
      <ResultView
        result={result([
          event(0, {
            evidence_frames: [
              { timestamp_sec: 8.6, image_base64: jpeg },
              { timestamp_sec: 12, image_base64: jpeg },
              { timestamp_sec: 18, image_base64: jpeg },
            ],
          }),
        ])}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    const video = screen.getByLabelText<HTMLVideoElement>('Плеер загруженного видео')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    expect(screen.getAllByAltText(/^Кадр-доказательство на/)).toHaveLength(1)
    const second = screen.getByRole('button', { name: 'Показать кадр 2 из 3' })
    expect(second).toHaveAttribute('aria-pressed', 'false')
    await user.click(second)
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByAltText('Кадр-доказательство на 12 с')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Увеличить кадр 2 события 1, 12 с' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Показать кадр 2 события 1 в видео' }))
    expect(video.currentTime).toBe(11)
  })

  it('names the normative block plainly and shows confidence as a three-step scale', () => {
    render(<ResultView result={result([event()])} onReset={vi.fn()} serviceMode="pipeline" />)
    expect(screen.getByRole('heading', { name: 'Норматив' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Уверенность 3 из 3' })).toBeVisible()
  })
})

describe('ResultView reviewer workflow', () => {
  it('records a decision per finding, counts progress and restores it after a reload', async () => {
    localStorage.clear()
    const user = userEvent.setup()
    const details = result([event(0), event(1)])
    const view = render(<ResultView result={details} onReset={vi.fn()} serviceMode="pipeline" />)
    expect(screen.getByText('Проверено 0 из 2')).toBeVisible()
    const card = screen.getByRole('article', { name: 'Событие 1: Событие 1' })
    const confirm = within(card).getByRole('button', { name: 'Нарушение подтверждаю' })
    await user.click(confirm)
    expect(confirm).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Проверено 1 из 2')).toBeVisible()
    await user.type(within(card).getByRole('textbox', { name: 'Комментарий проверяющего' }), 'ок')
    view.unmount()

    render(<ResultView result={details} onReset={vi.fn()} serviceMode="pipeline" />)
    const restored = screen.getByRole('article', { name: 'Событие 1: Событие 1' })
    expect(within(restored).getByRole('button', { name: 'Нарушение подтверждаю' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(restored).getByRole('textbox', { name: 'Комментарий проверяющего' })).toHaveValue(
      'ок',
    )
    await user.click(within(restored).getByRole('button', { name: 'Нарушение подтверждаю' }))
    expect(screen.getByText('Проверено 0 из 2')).toBeVisible()
  })

  it('prints the report and copies the link to this check', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ResultView result={result([event()])} onReset={vi.fn()} serviceMode="pipeline" />)
    await user.click(screen.getByRole('button', { name: 'Отчёт / PDF' }))
    expect(print).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Скопировать ссылку' }))
    expect(writeText).toHaveBeenCalledWith(window.location.href)
    expect(await screen.findByText('Ссылка скопирована')).toBeVisible()
  })
})

describe('ResultView facts wording', () => {
  it('reports how many violation types were checked', () => {
    render(
      <ResultView
        result={result([], { rules_checked: 8 })}
        onReset={vi.fn()}
        serviceMode="pipeline"
      />,
    )
    expect(screen.getByText('Проверено типов нарушений').closest('span')).toHaveTextContent('8')
  })
})
