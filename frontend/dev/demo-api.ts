import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// Моки остаются у владельца контракта и не входят в production-бандл.
const processing = JSON.parse(
  readFileSync(
    new URL('../../docs/frontend/mock_details_processing.json', import.meta.url),
    'utf8',
  ),
)
const result = JSON.parse(
  readFileSync(new URL('../../docs/frontend/mock_details.json', import.meta.url), 'utf8'),
)
const clean = JSON.parse(
  readFileSync(new URL('../../docs/frontend/mock_details_clean.json', import.meta.url), 'utf8'),
)
const stepMs = Number(process.env.DEMO_STEP_MS) || 1500
const preview = readFileSync(new URL('./demo-preview.mp4', import.meta.url))
const stages = ['queued', 'decode', 'detect', 'scene', 'verify']

// Однотонное демо-видео с полосой времени: плеер и метки без реальной записи.
function sendPreview(req: IncomingMessage, res: ServerResponse) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : preview.length - 1
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${preview.length}` }),
  })
  res.end(preview.subarray(start, end + 1))
}

export function demoApi(): Plugin {
  const jobs = new Map<string, { started: number; result: unknown }>()
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.startsWith('/previews/')) return sendPreview(req, res)
    if (req.url !== '/health' && !req.url?.startsWith('/api/')) return next()
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health')
      return reply(200, { mode: process.env.DEMO_HEALTH_MODE ?? 'stub', status: 'ok' })
    if (req.headers['x-api-key'] !== 'demo-key') return reply(401, { detail: 'Неверный API-ключ.' })
    if (req.method === 'POST' && req.url === '/api/v1/analyze') {
      let bytes = 0
      let isClean = false
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        // Файл с «clean» в имени показывает пример без нарушений.
        isClean ||= /filename="[^"]*clean/i.test(chunk.toString('latin1'))
      })
      req.on('end', () => {
        if (!bytes || !req.headers['content-type']?.startsWith('multipart/form-data')) {
          return reply(400, { detail: 'Выберите видео для проверки.' })
        }
        const jobId = crypto.randomUUID()
        jobs.set(jobId, { started: Date.now(), result: isClean ? clean : result })
        reply(200, { job_id: jobId })
      })
      return
    }
    const match = /^\/api\/v1\/jobs\/([^/]+)\/details$/.exec(req.url)
    if (req.method === 'GET' && match) {
      const job = jobs.get(match[1])
      if (!job) return reply(404, { detail: 'Проверка не найдена.' })
      const index = Math.floor((Date.now() - job.started) / stepMs)
      return reply(
        200,
        index >= stages.length
          ? { ...(job.result as object), job_id: match[1] }
          : {
              ...processing,
              job_id: match[1],
              progress: { stage: stages[index], value: index / stages.length },
            },
      )
    }
    reply(404, { detail: 'Адрес не найден.' })
  }
  return {
    name: 'guardtusk-demo-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
