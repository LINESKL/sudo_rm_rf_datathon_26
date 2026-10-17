import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import sampleDetails from '../../../docs/frontend/mock_details.json'
import type { DoneDetails, Violation } from '@/api/contracts'
import { StateTimeline } from './StateTimeline'

function result(overrides: Partial<DoneDetails> = {}): DoneDetails {
  return {
    job_id: 'timeline-job',
    status: 'done',
    verdict: 'no_violation',
    violations: [],
    duration_sec: 10,
    processing_sec: 2,
    degraded: false,
    ...overrides,
  }
}

function event(start: number, end: number): Violation {
  return {
    ...sampleDetails.violations[0],
    confidence_level: 'high',
    timecode_sec: start,
    timecode_end_sec: end,
  }
}

describe('StateTimeline', () => {
  const emptyStates: Partial<DoneDetails>[] = [
    {},
    { timeline: {} },
    { timeline: { cashier_present: [], cash_on_desk: [] } },
    { timeline: { cashier_present: [[2, 2]] } },
    { duration_sec: 0, timeline: { cashier_present: [[0, 1]] } },
    { timeline: { cashier_present: [[10, 10.01]] } },
  ]
  it.each(emptyStates)('hides absent or visually empty scene states: %j', (overrides) => {
    render(<StateTimeline result={result(overrides)} activeTime={null} canSeek onSeek={vi.fn()} />)
    expect(screen.queryByRole('region', { name: 'Состояния сцены' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('uses trimmed server labels, Russian fallbacks and anonymous names without exposing technical keys', () => {
    render(
      <StateTimeline
        result={result({
          timeline: {
            cashier_present: [[0, 3]],
            cash_on_desk: [[1, 4]],
            future_signal: [[2, 5]],
            safe_open: [],
          },
          timeline_labels: { cashier_present: '  Кассир у рабочего места  ', future_signal: '   ' },
        })}
        activeTime={null}
        canSeek
        onSeek={vi.fn()}
      />,
    )
    const section = screen.getByRole('region', { name: 'Состояния сцены' })
    expect(within(section).getByRole('group', { name: 'Кассир у рабочего места' })).toBeVisible()
    expect(within(section).getByRole('group', { name: 'Деньги на столе' })).toBeVisible()
    expect(within(section).getByRole('group', { name: 'Состояние 3' })).toBeVisible()
    expect(within(section).queryByRole('group', { name: 'Сейф открыт' })).not.toBeInTheDocument()
    expect(section).not.toHaveTextContent(/cashier_present|cash_on_desk|future_signal|safe_open/)
  })

  it.each([
    ['bag_on_desk', 'Сумка инкассации на столе'],
    ['safe_open', 'Сейф открыт'],
    ['screen_unlocked', 'Экран разблокирован'],
    ['outsider_in_cashier_zone', 'Посторонний в зоне кассира'],
    ['constructor', 'Состояние 1'],
  ])('provides a readable fallback for %s', (key, label) => {
    render(
      <StateTimeline
        result={result({ timeline: { [key]: [[1, 2]] }, timeline_labels: {} })}
        activeTime={null}
        canSeek
        onSeek={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: label })).toBeVisible()
  })

  it('keeps exact fractional seconds for the jump while showing short common timecodes', async () => {
    const user = userEvent.setup()
    const onSeek = vi.fn()
    render(
      <StateTimeline
        result={result({ timeline: { cash_on_desk: [[1.234, 2.987]] } })}
        activeTime={null}
        canSeek
        onSeek={onSeek}
      />,
    )
    const jump = screen.getByRole('button', { name: /Деньги на столе.*1\.234.*2\.987/ })
    expect(jump).toHaveTextContent('00:01,2')
    expect(jump).toHaveTextContent('00:03,0')
    expect(jump).toHaveAttribute('title', expect.stringMatching(/1\.234.*2\.987/))
    await user.click(jump)
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(1.234)
  })

  it('lets a keyboard user activate an interval with Enter', async () => {
    const user = userEvent.setup()
    const onSeek = vi.fn()
    render(
      <StateTimeline
        result={result({ timeline: { cashier_present: [[3.125, 6]] } })}
        activeTime={null}
        canSeek
        onSeek={onSeek}
      />,
    )
    await user.tab()
    expect(screen.getByRole('button', { name: /3\.125.*6/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(3.125)
  })

  it('preserves static interval information when seeking is unavailable', async () => {
    const user = userEvent.setup()
    const onSeek = vi.fn()
    render(
      <StateTimeline
        result={result({ timeline: { cashier_present: [[1, 4]] } })}
        activeTime={null}
        canSeek={false}
        onSeek={onSeek}
      />,
    )
    const jump = screen.getByRole('button', { name: /Кассир на месте.*1.*4/ })
    expect(jump).toBeDisabled()
    expect(jump).toHaveTextContent('00:01,0')
    expect(screen.getByText(/Переход к видео недоступен/)).toBeVisible()
    await user.click(jump)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('marks current intervals with an exclusive end except at the recording end', () => {
    const details = result({
      timeline: {
        cashier_present: [
          [1, 2],
          [2, 4],
          [4, 10],
        ],
      },
    })
    const view = render(<StateTimeline result={details} activeTime={2} canSeek onSeek={vi.fn()} />)
    const jumps = screen.getAllByRole('button')
    expect(jumps[0]).not.toHaveAttribute('aria-current')
    expect(jumps[1]).toHaveAttribute('aria-current', 'true')
    expect(jumps[2]).not.toHaveAttribute('aria-current')

    view.rerender(<StateTimeline result={details} activeTime={10} canSeek onSeek={vi.fn()} />)
    expect(jumps[1]).not.toHaveAttribute('aria-current')
    expect(jumps[2]).toHaveAttribute('aria-current', 'true')
  })

  it('positions the cursor proportionally and removes it when the position is unknown', () => {
    const details = result({ timeline: { cashier_present: [[0, 10]] } })
    const view = render(
      <StateTimeline result={details} activeTime={2.5} canSeek onSeek={vi.fn()} />,
    )
    const section = screen.getByRole('region', { name: 'Состояния сцены' })
    expect(section.querySelector('.timeline-cursor')).toHaveStyle({ left: '25%' })
    expect(screen.getByText(/Позиция видео:/)).toHaveTextContent('00:02,5')
    expect(section.querySelector('[aria-live]')).not.toBeInTheDocument()

    view.rerender(<StateTimeline result={details} activeTime={null} canSeek onSeek={vi.fn()} />)
    expect(section.querySelector('.timeline-cursor')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current')
  })

  it('clamps the visible rail and cursor while retaining the server interval end', () => {
    render(
      <StateTimeline
        result={result({ timeline: { cash_on_desk: [[8, 10.01]] } })}
        activeTime={11}
        canSeek
        onSeek={vi.fn()}
      />,
    )
    const lane = screen.getByRole('group', { name: 'Деньги на столе' })
    expect(lane.querySelector('.timeline-interval')).toHaveStyle({ left: '80%', width: '20%' })
    expect(lane.querySelector('.timeline-cursor')).toHaveStyle({ left: '100%' })
    expect(screen.getByRole('button')).toHaveAccessibleName(/8.*10\.01/)
  })

  it.each([
    { eventStart: 4, eventEnd: 5, overlap: false },
    { eventStart: 1, eventEnd: 2, overlap: false },
    { eventStart: 3, eventEnd: 5, overlap: true },
    { eventStart: 2, eventEnd: 2, overlap: true },
    { eventStart: 3, eventEnd: 3, overlap: true },
    { eventStart: 4, eventEnd: 4, overlap: false },
  ])(
    'uses strict event overlap, including point events: %j',
    ({ eventStart, eventEnd, overlap }) => {
      render(
        <StateTimeline
          result={result({
            verdict: 'violation',
            violations: [event(eventStart, eventEnd)],
            timeline: { cash_on_desk: [[2, 4]] },
          })}
          activeTime={null}
          canSeek
          onSeek={vi.fn()}
        />,
      )
      const lane = screen.getByRole('group', { name: 'Деньги на столе' })
      const span = lane.querySelector('.timeline-interval')
      if (overlap) {
        expect(span).toHaveClass('timeline-interval-overlap')
        expect(screen.getByRole('button')).toHaveTextContent('Совпадает с событием')
      } else {
        expect(span).not.toHaveClass('timeline-interval-overlap')
        expect(screen.queryByText('Совпадает с событием')).not.toBeInTheDocument()
      }
    },
  )

  it('keeps microscopic and overlapping intervals as separate controls outside the visual rail', async () => {
    const user = userEvent.setup()
    const onSeek = vi.fn()
    const intervals: [number, number][] = [
      [1.001, 1.002],
      [1.0015, 1.003],
      [1.002, 1.004],
    ]
    render(
      <StateTimeline
        result={result({ timeline: { cash_on_desk: intervals } })}
        activeTime={null}
        canSeek
        onSeek={onSeek}
      />,
    )
    const lane = screen.getByRole('group', { name: 'Деньги на столе' })
    const rail = lane.querySelector('.timeline-rail')
    const jumps = within(lane).getAllByRole('button')
    expect(jumps).toHaveLength(3)
    for (const [index, jump] of jumps.entries()) {
      expect(rail).not.toContainElement(jump)
      await user.click(jump)
      expect(onSeek).toHaveBeenLastCalledWith(intervals[index][0])
    }
  })

  it('shows scene states for a clean verdict without treating them as violations', () => {
    render(
      <StateTimeline
        result={result({ timeline: { screen_unlocked: [[1, 9]] } })}
        activeTime={null}
        canSeek
        onSeek={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Экран разблокирован' })).toBeVisible()
    expect(screen.getByText(/сами по себе не означают нарушение/)).toBeVisible()
    expect(screen.queryByText('Совпадает с событием')).not.toBeInTheDocument()
  })
})
