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
const stages = ['decode', 'detect', 'scene', 'verify']

export function demoApi(): Plugin {
  const jobs = new Map<string, number>()
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/health' && !req.url?.startsWith('/api/')) return next()
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health')
      return reply(200, { mode: 'stub', status: 'ok' })
    if (req.headers['x-api-key'] !== 'demo-key') return reply(401, { detail: 'Неверный API-ключ.' })
    if (req.method === 'POST' && req.url === '/api/v1/analyze') {
      let bytes = 0
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
      })
      req.on('end', () => {
        if (!bytes || !req.headers['content-type']?.startsWith('multipart/form-data')) {
          return reply(400, { detail: 'Выберите видео для проверки.' })
        }
        const jobId = crypto.randomUUID()
        jobs.set(jobId, Date.now())
        reply(200, { job_id: jobId })
      })
      return
    }
    const match = /^\/api\/v1\/jobs\/([^/]+)\/details$/.exec(req.url)
    if (req.method === 'GET' && match) {
      const started = jobs.get(match[1])
      if (!started) return reply(404, { detail: 'Проверка не найдена.' })
      const index = Math.floor((Date.now() - started) / 1500)
      return reply(
        200,
        index >= stages.length
          ? { ...result, job_id: match[1] }
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
