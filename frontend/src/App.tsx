import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DragEvent, FormEvent } from 'react'
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  FileVideo,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { FALLBACK_STAGES } from './api/contracts'
import { ApiError, getServiceHealth, validateVideo } from './api/client'
import { ResultView } from './components/ResultView'
import { useAnalysis } from './useAnalysis'

function fileSize(bytes: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} МБ`
}

function elapsedTime(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function AnalysisProgress({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className="progress-group">
      <div className="progress-caption">
        <span>{label}</span>
        <span className="mono">{percent}%</span>
      </div>
      <Progress
        value={percent}
        className="h-2 bg-muted [&_[data-slot=progress-indicator]]:bg-brand"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
      />
    </div>
  )
}

export function App() {
  const [file, setFile] = useState<File | null>(null)
  const [validation, setValidation] = useState<{
    field: 'file' | 'key'
    message: string
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const chooserRef = useRef<HTMLButtonElement>(null)
  const panelHeadingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const analysis = useAnalysis()
  const health = useQuery({
    queryKey: ['service-health', analysis.job?.id ?? null, analysis.done],
    queryFn: ({ signal }) => getServiceHealth(signal),
    enabled: !__DEMO__,
    networkMode: 'always',
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const serviceMode = __DEMO__
    ? 'stub'
    : health.isSuccess && !health.isFetching
      ? health.data.mode
      : 'unknown'
  const processing =
    !analysis.uploading && analysis.job !== null && !analysis.done && !analysis.error
  const result = analysis.details?.status === 'done' && analysis.done ? analysis.details : null
  const activeStage =
    analysis.details?.status === 'processing' ? analysis.details.progress.stage : null
  const queued = activeStage === 'queued'
  const stageIndex = FALLBACK_STAGES.findIndex((stage) => stage.id === activeStage)
  const hasKnownStage = stageIndex >= 0
  const progress =
    analysis.details?.status === 'processing' ? analysis.details.progress.value * 100 : 0
  const step = result ? 2 : processing ? 1 : 0
  const phase = analysis.uploading
    ? 'uploading'
    : processing
      ? 'processing'
      : result
        ? 'result'
        : analysis.error
          ? 'error'
          : 'upload'
  const previousPhase = useRef(phase)
  const errorStatus = analysis.error instanceof ApiError ? analysis.error.status : null
  const serverErrorField = errorStatus === 400 || errorStatus === 413 ? 'file' : null
  const errorField = validation?.field ?? serverErrorField
  const fileInvalid = errorField === 'file'

  useEffect(() => {
    if (previousPhase.current === phase) return
    previousPhase.current = phase
    if (phase === 'error') errorRef.current?.focus()
    else if (phase !== 'upload') panelHeadingRef.current?.focus()
  }, [phase])

  useEffect(() => {
    if (validation?.field === 'file') chooserRef.current?.focus()
  }, [validation])

  function selectFile(candidate?: File) {
    if (!candidate || analysis.busy) return
    const message = validateVideo(candidate)
    setValidation(message ? { field: 'file', message } : null)
    if (!message) {
      analysis.reset()
      setFile(candidate)
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length > 1) {
      setValidation({
        field: 'file',
        message: 'Выберите одно видео. Следующую запись можно проверить после этой.',
      })
      return
    }
    selectFile(event.dataTransfer.files[0])
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) {
      setValidation({ field: 'file', message: 'Выберите видео для проверки.' })
      return
    }
    const message = validateVideo(file)
    setValidation(message ? { field: 'file', message } : null)
    if (message) return
    if (analysis.statusError && analysis.job) analysis.retryStatus('')
    else void analysis.start(file, '')
  }

  function newVideo() {
    analysis.reset()
    setFile(null)
    setValidation(null)
    if (inputRef.current) inputRef.current.value = ''
    headingRef.current?.focus()
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="Observer — главная">
            <span className="brand-mark">
              <ScanLine size={23} strokeWidth={1.8} />
            </span>
            <span>Observer</span>
          </a>
          <div className="header-description">AI-проверка кассовой дисциплины по видео</div>
          <span className="private-label">
            <LockKeyhole size={14} /> Закрытый контур
          </span>
        </div>
      </header>

      <main className="main-content">
        {__DEMO__ && (
          <Alert role="note" className="mb-7 rounded-xl border-0 bg-muted text-muted-foreground">
            <CircleAlert size={17} />
            <AlertDescription className="text-xs">
              <p>
                Деморежим · ключ <code className="text-primary">demo-key</code>. Результат из
                примера, видео не анализируется.
              </p>
            </AlertDescription>
          </Alert>
        )}
        {!__DEMO__ && serviceMode === 'stub' && !result && (
          <Alert className="mb-7 rounded-xl border-0 bg-muted">
            <CircleAlert />
            <AlertTitle>Подключён тестовый анализатор</AlertTitle>
            <AlertDescription>
              Сервис возвращает пример для проверки интерфейса. Модель анализа видео не подключена.
            </AlertDescription>
          </Alert>
        )}
        <div className="page-intro">
          <h1 tabIndex={-1} ref={headingRef}>
            Проверка видео
          </h1>
          <p>Загрузите запись кассовой операции для проверки.</p>
        </div>

        <ol className="workflow" aria-label="Этапы проверки">
          {['Загрузка видео', 'Обработка', 'Результат'].map((title, index) => (
            <li
              key={title}
              className={step === index ? 'current' : step > index ? 'complete' : ''}
              aria-current={step === index ? 'step' : undefined}
            >
              <span className="step-number">
                {step > index ? <Check size={15} /> : `0${index + 1}`}
              </span>
              <span>{title}</span>
              {index < 2 && <span className="step-line" />}
            </li>
          ))}
        </ol>

        <div className="workspace">
          <Card
            role="region"
            aria-label="Проверка видео"
            className="work-panel gap-0 rounded-3xl border-0 py-0 shadow-none"
          >
            <CardHeader className="panel-heading flex gap-3 px-5 min-[601px]:px-7">
              <span className="section-number mono">0{step + 1}</span>
              <div>
                <CardTitle>
                  <h2 tabIndex={-1} ref={panelHeadingRef}>
                    {result
                      ? 'Проверка завершена'
                      : processing
                        ? 'Проверяем запись'
                        : analysis.uploading
                          ? 'Отправляем видео'
                          : 'Загрузите запись'}
                  </h2>
                </CardTitle>
                <CardDescription>
                  <p>
                    {result
                      ? 'Результат готов к просмотру.'
                      : processing
                        ? 'Видео обрабатывается. Дождитесь результата.'
                        : 'Одна запись — одна проверка.'}
                  </p>
                </CardDescription>
              </div>
              {processing && <Clock3 className="heading-icon" size={23} />}
            </CardHeader>

            <CardContent className="p-0">
              {result ? (
                <ResultView
                  key={result.job_id}
                  result={result}
                  onReset={newVideo}
                  serviceMode={serviceMode}
                  apiKey={analysis.job?.key ?? ''}
                />
              ) : (
                <form onSubmit={submit} noValidate>
                  {!processing && !analysis.uploading && (
                    <div className="upload-body">
                      <div
                        className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
                        onDragOver={(event) => {
                          event.preventDefault()
                          setDragging(true)
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={drop}
                      >
                        {file ? (
                          <>
                            <span className="upload-icon selected">
                              <FileVideo size={29} strokeWidth={1.6} />
                            </span>
                            <p className="selected-name">{file.name}</p>
                            <p className="drop-hint">{fileSize(file.size)} · Готово к отправке</p>
                            <Button
                              ref={chooserRef}
                              type="button"
                              variant="link"
                              className="mt-3.5 min-h-11 whitespace-normal px-2 text-brand underline"
                              aria-invalid={fileInvalid || undefined}
                              aria-describedby={fileInvalid ? 'form-error-message' : undefined}
                              onClick={() => inputRef.current?.click()}
                            >
                              Выбрать другое видео
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="upload-icon">
                              <Upload size={29} strokeWidth={1.6} />
                            </span>
                            <h3>Перетащите видео сюда</h3>
                            <p className="drop-hint">или выберите файл на устройстве</p>
                            <Button
                              ref={chooserRef}
                              variant="outline"
                              className="mt-4 h-11 rounded-xl px-5 text-primary has-[>svg]:px-5"
                              type="button"
                              aria-invalid={fileInvalid || undefined}
                              aria-describedby={fileInvalid ? 'form-error-message' : 'file-help'}
                              onClick={() => inputRef.current?.click()}
                            >
                              <FileVideo size={17} /> Выбрать видео
                            </Button>
                            <span id="file-help" className="file-requirements">
                              MOV или MP4 <span>·</span> до 200 МБ
                            </span>
                          </>
                        )}
                        <input
                          ref={inputRef}
                          className="visually-hidden"
                          type="file"
                          accept=".mov,.mp4,video/quicktime,video/mp4"
                          aria-label="Видео для проверки"
                          aria-invalid={fileInvalid || undefined}
                          aria-describedby={fileInvalid ? 'form-error-message' : undefined}
                          tabIndex={-1}
                          onChange={(event) => {
                            selectFile(event.target.files?.[0])
                            event.target.value = ''
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {(processing || analysis.uploading) && (
                    <div className="processing-body" aria-live="polite">
                      <div className="file-summary">
                        <span className="file-summary-icon">
                          <FileVideo size={23} />
                        </span>
                        <div>
                          <strong>{file?.name}</strong>
                          <span>{file && fileSize(file.size)}</span>
                        </div>
                        {analysis.uploading ? (
                          <Badge
                            variant="secondary"
                            className="ml-auto rounded-full px-2.5 py-1 text-brand"
                          >
                            Отправка
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="ml-auto rounded-full px-2.5 py-1 text-brand"
                          >
                            {queued ? 'В очереди' : 'В работе'}
                          </Badge>
                        )}
                      </div>
                      {analysis.uploading || hasKnownStage ? (
                        <AnalysisProgress
                          value={analysis.uploading ? analysis.uploadProgress : progress}
                          label={analysis.uploading ? 'Отправка файла' : 'Обработка видео'}
                        />
                      ) : queued ? (
                        <p role="status">
                          Задача в очереди. Анализ начнётся, когда освободится обработчик.
                        </p>
                      ) : (
                        <p role="status">Обработка продолжается. Ожидаем результат.</p>
                      )}
                      <p className="small-note mono" role="timer" aria-live="off">
                        Прошло с начала отправки: {elapsedTime(analysis.elapsedSeconds)}
                      </p>
                      {analysis.uploading && (
                        <p className="helper">
                          {analysis.uploadProgress >= 100
                            ? 'Файл отправлен. Ожидаем подтверждение сервиса…'
                            : 'Дождитесь окончания отправки. Не закрывайте страницу.'}
                        </p>
                      )}
                      {processing && (hasKnownStage || queued) && (
                        <ol className="processing-stages">
                          {FALLBACK_STAGES.map((stage, index) => (
                            <li
                              key={stage.id}
                              className={
                                index === stageIndex
                                  ? 'active'
                                  : index < stageIndex
                                    ? 'finished'
                                    : ''
                              }
                            >
                              <span className="stage-icon">
                                {index < stageIndex ? <Check size={15} /> : <span />}
                              </span>
                              <span>{stage.title}</span>
                              <span className="stage-status">
                                {index < stageIndex
                                  ? 'Готово'
                                  : index === stageIndex
                                    ? 'В процессе'
                                    : 'Ожидание'}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                      <Button
                        type="button"
                        variant="link"
                        className="min-h-11 whitespace-normal px-2 text-muted-foreground underline has-[>svg]:px-2"
                        onClick={newVideo}
                      >
                        <X size={15} />{' '}
                        {analysis.uploading ? 'Отменить отправку' : 'Остановить ожидание'}
                      </Button>
                      {processing && (
                        <p className="small-note">
                          Возврат к загрузке не останавливает проверку на сервере.
                        </p>
                      )}
                    </div>
                  )}

                  {!analysis.busy && (
                    <div className="settings-body">
                      {(validation || analysis.error) && (
                        <Alert
                          ref={errorRef}
                          tabIndex={-1}
                          aria-labelledby="form-error-title"
                          aria-describedby="form-error-message"
                          variant="destructive"
                          className="mb-5 rounded-xl bg-[var(--violation-bg)]"
                        >
                          <CircleAlert size={19} />
                          <AlertTitle id="form-error-title">Не удалось продолжить</AlertTitle>
                          <AlertDescription>
                            <p id="form-error-message">
                              {validation?.message ?? analysis.error?.message}
                            </p>
                            {analysis.error && analysis.job && (
                              <p className="mono" role="timer" aria-live="off">
                                Прошло с начала отправки: {elapsedTime(analysis.elapsedSeconds)}
                              </p>
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                      <div className="submit-row">
                        <span>
                          <LockKeyhole size={14} /> Данные остаются в контуре сервиса
                        </span>
                        <Button
                          className="h-12 rounded-xl px-6 text-base font-normal has-[>svg]:px-6"
                          type="submit"
                          disabled={!file}
                        >
                          {analysis.error ? (
                            <>
                              <RotateCcw size={17} />
                              {analysis.statusError && analysis.job
                                ? 'Повторить запрос статуса'
                                : 'Попробовать снова'}
                            </>
                          ) : (
                            <>
                              Начать проверку
                              <ArrowRight size={17} />
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </form>
              )}
            </CardContent>
          </Card>
        </div>
        {!result && (
          <Alert role="note" className="human-note flex border-0 bg-transparent p-0">
            <ShieldCheck size={18} />
            <AlertDescription className="text-xs max-[600px]:text-[11px]">
              Результат — подсказка для проверки человеком. Решение принимает специалист.
            </AlertDescription>
          </Alert>
        )}
      </main>
    </div>
  )
}
