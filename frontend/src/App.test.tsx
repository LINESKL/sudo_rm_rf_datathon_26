import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { useAnalysis } from './useAnalysis'
import { getServiceHealth } from './api/client'
import type { DoneDetails } from './api/contracts'

vi.mock('./useAnalysis', () => ({ useAnalysis: vi.fn() }))
vi.mock('./api/client', async (original) => ({
  ...(await original<typeof import('./api/client')>()),
  getServiceHealth: vi.fn().mockResolvedValue({ mode: 'pipeline', status: 'ok' }),
}))

function renderState(overrides: Partial<ReturnType<typeof useAnalysis>> = {}) {
  let state: ReturnType<typeof useAnalysis> = {
    start: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    retryStatus: vi.fn(),
    uploading: false,
    uploadProgress: 0,
    elapsedSeconds: 65,
    error: null,
    busy: true,
    done: false,
    job: { id: 'job-1', key: 'test-key', started: 1 },
    details: undefined,
    statusError: false,
    ...overrides,
  }
  vi.mocked(useAnalysis).mockReturnValue(state)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const tree = () => (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  )
  const view = render(tree())
  return {
    ...state,
    client,
    rerenderState(next: Partial<ReturnType<typeof useAnalysis>>) {
      state = { ...state, ...next }
      vi.mocked(useAnalysis).mockReturnValue(state)
      view.rerender(tree())
    },
  }
}

beforeEach(() => {
  vi.mocked(useAnalysis).mockReset()
  vi.mocked(getServiceHealth).mockReset().mockResolvedValue({ mode: 'pipeline', status: 'ok' })
  localStorage.clear()
})

function cleanResult(jobId: string): DoneDetails {
  return {
    job_id: jobId,
    status: 'done',
    verdict: 'no_violation',
    violations: [],
    duration_sec: 20,
    processing_sec: 12,
    degraded: false,
  }
}

describe('F1 processing states', () => {
  it('waits for the first server status without inventing a stage or percentage', () => {
    renderState()
    expect(screen.getByText('Обработка продолжается. Ожидаем результат.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Подготовка видео')).not.toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveTextContent('01:05')
    expect(screen.queryByText(/1–2 минуты/)).not.toBeInTheDocument()
  })

  it('keeps an unknown server stage neutral even when it includes a numeric progress value', () => {
    renderState({
      details: {
        job_id: 'job-1',
        status: 'processing',
        progress: { stage: 'future-stage', value: 0.89 },
        stages: [{ id: 'future-stage', title: 'Новый этап' }],
      },
    })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('89%')).not.toBeInTheDocument()
    expect(screen.queryByText('Подготовка видео')).not.toBeInTheDocument()
    expect(screen.getByText('Обработка продолжается. Ожидаем результат.')).toBeInTheDocument()
  })

  it('shows server progress for a known stage and lets the user stop waiting', () => {
    const state = renderState({
      details: {
        job_id: 'job-1',
        status: 'processing',
        progress: { stage: 'scene', value: 0.42 },
        stages: [],
      },
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('Анализ сцены')).toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveAttribute('aria-live', 'off')
    expect(screen.getByText(/не останавливает проверку на сервере/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Остановить ожидание' }))
    expect(state.reset).toHaveBeenCalledOnce()
  })

  it('keeps a fully uploaded file in progress while waiting for the upload response', () => {
    const state = renderState({ uploading: true, uploadProgress: 100, job: null })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText(/Ожидаем подтверждение сервиса/)).toBeInTheDocument()
    expect(screen.queryByText('Проверка завершена')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить отправку' }))
    expect(state.reset).toHaveBeenCalledOnce()
  })

  it('retries the existing job after a status error instead of uploading again', () => {
    const state = renderState({
      busy: false,
      statusError: true,
      elapsedSeconds: 301,
      error: new Error('Не удалось связаться с сервисом.'),
    })
    fireEvent.change(screen.getByLabelText('Видео для проверки'), {
      target: { files: [new File(['video'], 'camera.mov', { type: 'video/quicktime' })] },
    })
    fireEvent.change(screen.getByLabelText('API-ключ'), { target: { value: 'test-key' } })
    expect(screen.getByRole('timer')).toHaveTextContent('05:01')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить запрос статуса' }))
    expect(state.retryStatus).toHaveBeenCalledExactlyOnceWith('test-key')
    expect(state.start).not.toHaveBeenCalled()
  })
})

describe('F2 service-health freshness', () => {
  it('checks a new job instead of reusing the previous pipeline mode', async () => {
    vi.mocked(getServiceHealth)
      .mockResolvedValueOnce({ mode: 'pipeline', status: 'ok' })
      .mockResolvedValueOnce({ mode: 'stub', status: 'ok' })
    const view = renderState({ done: true, busy: false, details: cleanResult('job-1') })
    await waitFor(() =>
      expect(screen.queryByText('Режим сервиса не подтверждён')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText('Тестовый результат')).not.toBeInTheDocument()

    view.rerenderState({
      job: { id: 'job-2', key: 'test-key', started: 2 },
      details: cleanResult('job-2'),
    })
    expect(await screen.findByText('Тестовый результат')).toBeVisible()
    expect(screen.getByText(/События вымышлены и не являются выводом по записи/)).toBeVisible()
    expect(getServiceHealth).toHaveBeenCalledTimes(2)
  })

  it('checks the analyzer again when an existing job completes', async () => {
    vi.mocked(getServiceHealth)
      .mockResolvedValueOnce({ mode: 'pipeline', status: 'ok' })
      .mockResolvedValueOnce({ mode: 'stub', status: 'ok' })
    const view = renderState()
    await waitFor(() => expect(getServiceHealth).toHaveBeenCalledTimes(1))

    view.rerenderState({ done: true, busy: false, details: cleanResult('job-1') })
    expect(await screen.findByText('Тестовый результат')).toBeVisible()
    expect(getServiceHealth).toHaveBeenCalledTimes(2)
  })

  it('does not trust the cached pipeline mode while refetching or after a health error', async () => {
    const view = renderState({ done: true, busy: false, details: cleanResult('job-1') })
    await waitFor(() =>
      expect(screen.queryByText('Режим сервиса не подтверждён')).not.toBeInTheDocument(),
    )
    let rejectHealth!: (error: Error) => void
    vi.mocked(getServiceHealth).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectHealth = reject
      }),
    )
    let refetch!: Promise<void>
    act(() => {
      refetch = view.client.refetchQueries({ queryKey: ['service-health'] })
    })

    expect(await screen.findByText('Режим сервиса не подтверждён')).toBeVisible()
    await act(async () => {
      rejectHealth(new Error('Сервис временно недоступен.'))
      await refetch
    })
    await waitFor(() => expect(screen.getByText('Режим сервиса не подтверждён')).toBeVisible())
    expect(screen.getByText(/Проверьте результат с администратором сервиса/)).toBeVisible()
    expect(screen.getByRole('status')).not.toHaveClass('clean')
    expect(getServiceHealth).toHaveBeenCalledTimes(2)
  })
})
