import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { useAnalysis } from './useAnalysis'
import { ApiError, getServiceHealth } from './api/client'
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

describe('F5 accessible upload flow', () => {
  it('opens and focuses a missing key and describes the invalid field', async () => {
    const user = userEvent.setup()
    const state = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    await user.upload(
      screen.getByLabelText('Видео для проверки'),
      new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
    )
    await user.click(screen.getByRole('button', { name: 'Ключ доступа к API' }))
    expect(screen.queryByLabelText('API-ключ')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Начать проверку' }))
    const key = await screen.findByLabelText('API-ключ')
    await waitFor(() => expect(key).toHaveFocus())
    expect(key).toHaveAttribute('aria-invalid', 'true')
    expect(key).toHaveAccessibleDescription(/Укажите API-ключ для доступа к проверке/)
    expect(screen.getByLabelText('Видео для проверки')).not.toHaveAttribute('aria-invalid', 'true')
    expect(state.start).not.toHaveBeenCalled()
  })

  it('returns an invalid file to the visible chooser with its correction message', async () => {
    const user = userEvent.setup()
    renderState({ busy: false, job: null, elapsedSeconds: 0 })
    const fileInput = screen.getByLabelText('Видео для проверки')
    await user.click(screen.getByRole('button', { name: 'Выбрать видео' }))
    // Нативный выбор файла недоступен в jsdom; change приходит после возврата фокуса на input.
    fileInput.focus()
    fireEvent.change(fileInput, {
      target: { files: [new File(['video'], 'camera.avi', { type: 'video/x-msvideo' })] },
    })

    const chooser = screen.getByRole('button', { name: 'Выбрать видео' })
    await waitFor(() => expect(chooser).toHaveFocus())
    expect(chooser).toHaveAttribute('aria-invalid', 'true')
    expect(chooser).toHaveAccessibleDescription(/Выберите видео .mov или .mp4/)
    expect(fileInput).toHaveAttribute('aria-invalid', 'true')
    expect(fileInput).toHaveAccessibleDescription(/Выберите видео .mov или .mp4/)
    expect(screen.getByRole('button', { name: 'Начать проверку' })).toBeDisabled()
  })

  it('preserves a long file name when changing from selection to upload', async () => {
    const user = userEvent.setup()
    localStorage.setItem('cashguard-api-key', 'test-key')
    const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    const name = `${'кассовая_операция_'.repeat(20)}камера_1.mov`
    const file = new File(['video'], name, { type: 'video/quicktime' })
    await user.upload(screen.getByLabelText('Видео для проверки'), file)
    expect(screen.getByText(name, { exact: true })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Начать проверку' }))
    expect(view.start).toHaveBeenCalledExactlyOnceWith(file, 'test-key')
    view.rerenderState({ uploading: true, busy: true })
    expect(screen.getByText(name, { exact: true })).toBeVisible()
  })

  it('moves focus between phases and preserves the current control during progress updates', async () => {
    const user = userEvent.setup()
    localStorage.setItem('cashguard-api-key', 'test-key')
    const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    await user.upload(
      screen.getByLabelText('Видео для проверки'),
      new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
    )
    await user.click(screen.getByRole('button', { name: 'Начать проверку' }))

    view.rerenderState({ uploading: true, busy: true, uploadProgress: 0 })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Отправляем видео' })).toHaveFocus(),
    )
    await user.tab()
    const cancelUpload = screen.getByRole('button', { name: 'Отменить отправку' })
    expect(cancelUpload).toHaveFocus()
    view.rerenderState({ uploadProgress: 70, elapsedSeconds: 20 })
    expect(cancelUpload).toHaveFocus()

    view.rerenderState({
      uploading: false,
      job: { id: 'job-1', key: 'test-key', started: 1 },
      details: {
        job_id: 'job-1',
        status: 'processing',
        progress: { stage: 'detect', value: 0.2 },
        stages: [],
      },
    })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Проверяем запись' })).toHaveFocus(),
    )
    await user.tab()
    const stopWaiting = screen.getByRole('button', { name: 'Остановить ожидание' })
    expect(stopWaiting).toHaveFocus()
    view.rerenderState({
      elapsedSeconds: 21,
      details: {
        job_id: 'job-1',
        status: 'processing',
        progress: { stage: 'scene', value: 0.6 },
        stages: [],
      },
    })
    expect(stopWaiting).toHaveFocus()

    view.rerenderState({ done: true, busy: false, details: cleanResult('job-1') })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Проверка завершена' })).toHaveFocus(),
    )
    await user.tab()
    expect(screen.getByRole('button', { name: 'Обновить доступ к видео' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Новое видео' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(view.reset).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Проверка видео', level: 1 })).toHaveFocus()
  })

  it('focuses a status error once and keeps the retry button focused as elapsed time changes', async () => {
    const user = userEvent.setup()
    localStorage.setItem('cashguard-api-key', 'test-key')
    const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    await user.upload(
      screen.getByLabelText('Видео для проверки'),
      new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
    )
    await user.click(screen.getByRole('button', { name: 'Начать проверку' }))
    view.rerenderState({ busy: true, job: { id: 'job-1', key: 'test-key', started: 1 } })
    screen.getByRole('button', { name: 'Остановить ожидание' }).focus()
    const error = new ApiError('Не удалось связаться с сервисом.', null, 'network')
    view.rerenderState({ busy: false, error, statusError: true })
    const alert = screen.getByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(alert).toHaveTextContent(error.message)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Проверить ключ доступа' })).toHaveFocus()
    await user.tab()
    const retry = screen.getByRole('button', { name: 'Повторить запрос статуса' })
    expect(retry).toHaveFocus()
    view.rerenderState({ elapsedSeconds: 66 })
    expect(retry).toHaveFocus()
  })

  it.each([
    {
      status: 401,
      message: 'API-ключ не принят. Проверьте ключ и попробуйте снова.',
      field: 'key',
    },
    {
      status: 400,
      message: 'Сервис не смог принять видео. Проверьте файл и попробуйте снова.',
      field: 'file',
    },
    {
      status: 413,
      message: 'Видео слишком большое для сервиса. Выберите файл меньшего размера.',
      field: 'file',
    },
  ])(
    'associates HTTP $status with the field that can be corrected',
    async ({ status, message, field }) => {
      const user = userEvent.setup()
      const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
      await user.upload(
        screen.getByLabelText('Видео для проверки'),
        new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
      )
      await user.type(screen.getByLabelText('API-ключ'), 'test-key')
      view.rerenderState({ error: new ApiError(message, status), busy: false })
      const input = screen.getByLabelText(field === 'key' ? 'API-ключ' : 'Видео для проверки')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription(
        new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
      if (field === 'file') {
        const chooser = screen.getByRole('button', { name: 'Выбрать другое видео' })
        expect(chooser).toHaveAttribute('aria-invalid', 'true')
        expect(chooser).toHaveAccessibleDescription(
          new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        )
      }
    },
  )

  it('replaces the HTTP 401 key association when a new file validation error is shown', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    await user.upload(
      screen.getByLabelText('Видео для проверки'),
      new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
    )
    const key = screen.getByLabelText('API-ключ')
    await user.type(key, 'test-key')
    view.rerenderState({
      error: new ApiError('API-ключ не принят. Проверьте ключ и попробуйте снова.', 401),
    })
    expect(key).toHaveAttribute('aria-invalid', 'true')
    expect(key).toHaveAccessibleDescription(/API-ключ не принят/)

    const fileInput = screen.getByLabelText('Видео для проверки')
    await user.upload(fileInput, new File(['video'], 'camera.avi', { type: 'video/x-msvideo' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Неподдерживаемый формат.')
    expect(fileInput).toHaveAttribute('aria-invalid', 'true')
    expect(fileInput).toHaveAccessibleDescription(/Выберите видео .mov или .mp4/)
    const chooser = screen.getByRole('button', { name: 'Выбрать другое видео' })
    expect(chooser).toHaveAttribute('aria-invalid', 'true')
    expect(chooser).toHaveAccessibleDescription(/Выберите видео .mov или .mp4/)
    expect(key).not.toHaveAttribute('aria-invalid', 'true')
    expect(key).not.toHaveAccessibleDescription(/Неподдерживаемый формат|API-ключ не принят/)
  })

  it('replaces the HTTP 400 file association when a missing key error is shown', async () => {
    const user = userEvent.setup()
    const view = renderState({ busy: false, job: null, elapsedSeconds: 0 })
    await user.upload(
      screen.getByLabelText('Видео для проверки'),
      new File(['video'], 'camera.mov', { type: 'video/quicktime' }),
    )
    const key = screen.getByLabelText('API-ключ')
    await user.type(key, 'test-key')
    view.rerenderState({
      error: new ApiError('Сервис не смог принять видео. Проверьте файл и попробуйте снова.', 400),
    })
    const fileInput = screen.getByLabelText('Видео для проверки')
    expect(fileInput).toHaveAttribute('aria-invalid', 'true')
    expect(fileInput).toHaveAccessibleDescription(/Сервис не смог принять видео/)

    await user.clear(key)
    await user.click(screen.getByRole('button', { name: 'Попробовать снова' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Укажите API-ключ для доступа к проверке.')
    expect(key).toHaveFocus()
    expect(key).toHaveAttribute('aria-invalid', 'true')
    expect(key).toHaveAccessibleDescription(/Укажите API-ключ для доступа к проверке/)
    expect(fileInput).not.toHaveAttribute('aria-invalid', 'true')
    expect(fileInput).not.toHaveAccessibleDescription(
      /Укажите API-ключ|Сервис не смог принять видео/,
    )
    const chooser = screen.getByRole('button', { name: 'Выбрать другое видео' })
    expect(chooser).not.toHaveAttribute('aria-invalid', 'true')
    expect(chooser).not.toHaveAccessibleDescription(/Укажите API-ключ|Сервис не смог принять видео/)
    expect(view.start).not.toHaveBeenCalled()
  })
})
