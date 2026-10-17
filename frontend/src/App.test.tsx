import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { useAnalysis } from './useAnalysis'

vi.mock('./useAnalysis', () => ({ useAnalysis: vi.fn() }))

function renderState(overrides: Partial<ReturnType<typeof useAnalysis>> = {}) {
  const state = {
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
  render(<App />)
  return state
}

beforeEach(() => {
  vi.mocked(useAnalysis).mockReset()
  localStorage.clear()
})

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
