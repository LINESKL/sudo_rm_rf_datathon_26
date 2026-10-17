import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoneDetails } from './api/contracts'
import { AnalysisResults } from './AnalysisResults'
import { timecode } from './timecode'
import { getJobDetails } from './api/client'
import mock from '../../docs/frontend/mock_details.json'

vi.mock('./api/client', async (original) => ({
  ...(await original<typeof import('./api/client')>()),
  getJobDetails: vi.fn(),
}))
const details = mock as unknown as DoneDetails

beforeEach(() => {
  vi.mocked(getJobDetails).mockReset()
})

describe('results and private preview', () => {
  it.each([0, 1, 4])('shows all %i events without depending on preview', (count) => {
    const violations = Array.from({ length: count }, (_, i) => ({
      ...details.violations[0],
      type: `Тип ${i}`,
      rule: null,
    }))
    render(
      <AnalysisResults
        apiKey="test-only"
        details={{
          ...details,
          violations,
          verdict: count ? 'violation' : 'no_violation',
          preview_url: null,
        }}
      />,
    )
    expect(screen.queryAllByRole('article')).toHaveLength(count)
    expect(
      screen.getByText('Превью недоступно. Используйте кадры и описания событий ниже.'),
    ).toBeInTheDocument()
    if (count)
      expect(screen.getAllByText('Источник не указан, требуется проверка.')).toHaveLength(count)
    else expect(screen.getByText('Нарушение не обнаружено')).toBeInTheDocument()
  })

  it('seeks with context, opens evidence and closes it with focus restored', async () => {
    render(<AnalysisResults apiKey="test-only" details={details} />)
    const video = screen.getByLabelText('Плеер загруженного видео') as HTMLVideoElement
    Object.defineProperty(video, 'readyState', { value: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Перейти к событию 1/ }))
    expect(video.currentTime).toBe(Math.max(0, details.violations[0].timecode_sec - 1))
    const frame = screen.getByRole('button', { name: /Открыть кадр 1 события 1/ })
    fireEvent.click(frame)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть кадр' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(frame).toHaveFocus())
  })

  it('renews media access through details without putting the key in the video URL', async () => {
    render(<AnalysisResults apiKey="test-only" details={details} />)
    const video = screen.getByLabelText('Плеер загруженного видео') as HTMLVideoElement
    const load = vi.spyOn(video, 'load').mockImplementation(() => {})
    fireEvent.error(video)
    expect(screen.getAllByRole('article')).toHaveLength(details.violations.length)
    vi.mocked(getJobDetails).mockResolvedValue(details)
    fireEvent.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(getJobDetails).toHaveBeenCalledWith(details.job_id, 'test-only', expect.any(AbortSignal))
    expect(video.getAttribute('src')).toBe(details.preview_url)
    expect(video.getAttribute('src')).not.toContain('test-only')
    expect(screen.queryByText(/Видео не загрузилось/)).not.toBeInTheDocument()
  })

  it('keeps evidence visible when refreshing authorization fails', async () => {
    render(<AnalysisResults apiKey="test-only" details={details} />)
    vi.mocked(getJobDetails).mockRejectedValue(new Error('API-ключ не принят.'))
    fireEvent.click(screen.getByRole('button', { name: 'Обновить доступ к видео' }))
    expect(await screen.findByText('API-ключ не принят.')).toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(details.violations.length)
  })

  it('does not request external preview URLs', () => {
    render(
      <AnalysisResults
        apiKey="test-only"
        details={{ ...details, preview_url: 'https://external.example/video.mp4' }}
      />,
    )
    expect(screen.queryByLabelText('Плеер загруженного видео')).not.toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(details.violations.length)
  })

  it('shows source without point and reports damaged images', () => {
    render(
      <AnalysisResults
        apiKey="test-only"
        details={{
          ...details,
          violations: [
            {
              ...details.violations[0],
              rule: {
                document: 'Источник',
                url: 'https://example.org/norm',
                point: null,
                quote: null,
              },
            },
          ],
        }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Источник' })).toHaveAttribute(
      'href',
      'https://example.org/norm',
    )
    fireEvent.error(screen.getAllByRole('img')[0])
    expect(screen.getByText(/повреждён или недоступен/)).toBeInTheDocument()
  })

  it('formats exact tenths including the minute boundary', () => {
    expect(timecode(8.6)).toBe('00:08,6')
    expect(timecode(59.99)).toBe('01:00,0')
  })
})
