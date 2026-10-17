import { useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Eye,
  EyeOff,
  FileVideo,
  KeyRound,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { FALLBACK_STAGES } from './api/contracts'
import { validateVideo } from './api/client'
import { useAnalysis } from './useAnalysis'
import { AnalysisResults } from './AnalysisResults'

const STORAGE_KEY = 'cashguard-api-key'

function readKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

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
  const [validation, setValidation] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState(readKey)
  const [keyOpen, setKeyOpen] = useState(() => !readKey())
  const [keyVisible, setKeyVisible] = useState(false)
  const [storageNotice, setStorageNotice] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const analysis = useAnalysis()
  const processing =
    !analysis.uploading && analysis.job !== null && !analysis.done && !analysis.error
  const result = analysis.details?.status === 'done' && analysis.done ? analysis.details : null
  const activeStage =
    analysis.details?.status === 'processing' ? analysis.details.progress.stage : null
  const stageIndex = FALLBACK_STAGES.findIndex((stage) => stage.id === activeStage)
  const hasKnownStage = stageIndex >= 0
  const progress =
    analysis.details?.status === 'processing' ? analysis.details.progress.value * 100 : 0
  const step = result ? 2 : processing ? 1 : 0

  function selectFile(candidate?: File) {
    if (!candidate || analysis.busy) return
    const message = validateVideo(candidate)
    setValidation(message)
    if (!message) {
      analysis.reset()
      setFile(candidate)
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length > 1) {
      setValidation('Выберите одно видео. Следующую запись можно проверить после этой.')
      return
    }
    selectFile(event.dataTransfer.files[0])
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) {
      setValidation('Выберите видео для проверки.')
      return
    }
    if (!apiKey.trim()) {
      setValidation('Укажите API-ключ для доступа к проверке.')
      setKeyOpen(true)
      return
    }
    const message = validateVideo(file)
    setValidation(message)
    if (message) return
    try {
      localStorage.setItem(STORAGE_KEY, apiKey.trim())
      setStorageNotice(false)
    } catch {
      setStorageNotice(true)
    }
    setKeyOpen(false)
    if (analysis.statusError && analysis.job) analysis.retryStatus(apiKey.trim())
    else void analysis.start(file, apiKey.trim())
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
          <a className="brand" href="/" aria-label="GuardTusk — главная">
            <span className="brand-mark">
              <ScanLine size={23} strokeWidth={1.8} />
            </span>
            <span>GuardTusk</span>
          </a>
          <div className="header-description">Видеопроверка кассовых операций</div>
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
                  <h2>
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
                <div className="result-body">
                  <AnalysisResults
                    key={result.job_id}
                    details={result}
                    apiKey={analysis.job?.key ?? apiKey.trim()}
                  />
                  <Button
                    className="mt-6 h-12 rounded-xl px-6 text-base font-normal has-[>svg]:px-6"
                    onClick={newVideo}
                  >
                    <Upload size={17} /> Новое видео
                  </Button>
                </div>
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
                              type="button"
                              variant="link"
                              className="mt-3.5 h-auto p-0 text-brand underline"
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
                              variant="outline"
                              className="mt-4 h-11 rounded-xl px-5 text-primary has-[>svg]:px-5"
                              type="button"
                              onClick={() => inputRef.current?.click()}
                            >
                              <FileVideo size={17} /> Выбрать видео
                            </Button>
                            <span className="file-requirements">
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
                            В работе
                          </Badge>
                        )}
                      </div>
                      {analysis.uploading || hasKnownStage ? (
                        <AnalysisProgress
                          value={analysis.uploading ? analysis.uploadProgress : progress}
                          label={analysis.uploading ? 'Отправка файла' : 'Обработка видео'}
                        />
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
                      {processing && hasKnownStage && (
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
                        className="h-auto p-0 text-muted-foreground underline has-[>svg]:px-0"
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
                      <Collapsible open={keyOpen} onOpenChange={setKeyOpen}>
                        <CollapsibleTrigger asChild>
                          <Button
                            variant="ghost"
                            className="key-toggle h-auto justify-start rounded-xl px-0 py-[18px] has-[>svg]:px-0"
                            type="button"
                            aria-expanded={keyOpen}
                            aria-controls="api-key-panel"
                          >
                            <KeyRound size={17} />
                            <span>Ключ доступа к API</span>
                            {apiKey.trim() && !keyOpen && (
                              <span className="key-saved">
                                <Check size={13} /> Указан
                              </span>
                            )}
                            <ChevronDown size={17} className={keyOpen ? 'rotated' : ''} />
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent id="api-key-panel" className="key-panel">
                          <Label htmlFor="api-key" className="mb-2 font-semibold">
                            API-ключ
                          </Label>
                          <div className="key-input-wrap">
                            <Input
                              className="h-12 rounded-xl pr-12"
                              id="api-key"
                              name="apiKey"
                              type={keyVisible ? 'text' : 'password'}
                              autoComplete="off"
                              spellCheck={false}
                              value={apiKey}
                              onChange={(event) => setApiKey(event.target.value)}
                              placeholder="Введите ключ доступа"
                              aria-describedby="key-help"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="absolute right-1 top-1 size-10 rounded-xl text-muted-foreground"
                              type="button"
                              aria-label={keyVisible ? 'Скрыть ключ' : 'Показать ключ'}
                              onClick={() => setKeyVisible(!keyVisible)}
                            >
                              {keyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                            </Button>
                          </div>
                          <p id="key-help" className="helper">
                            Ключ предоставит администратор сервиса. Сохраняется в этом браузере
                            после отправки.
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                      {storageNotice && (
                        <Alert role="note" className="mb-5 border-0 bg-muted text-muted-foreground">
                          <AlertDescription className="text-xs">
                            Браузер не разрешил сохранить ключ. Введите его снова при следующем
                            открытии.
                          </AlertDescription>
                        </Alert>
                      )}
                      {(validation || analysis.error) && (
                        <Alert
                          variant="destructive"
                          className="mb-5 rounded-xl bg-[var(--violation-bg)]"
                        >
                          <CircleAlert size={19} />
                          <AlertTitle>Не удалось продолжить</AlertTitle>
                          <AlertDescription>
                            <p>{validation ?? analysis.error?.message}</p>
                            {analysis.error && analysis.job && (
                              <p className="mono" role="timer" aria-live="off">
                                Прошло с начала отправки: {elapsedTime(analysis.elapsedSeconds)}
                              </p>
                            )}
                            {analysis.error && !keyOpen && (
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto p-0 text-brand underline"
                                onClick={() => setKeyOpen(true)}
                              >
                                Проверить ключ доступа
                              </Button>
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
        <Alert role="note" className="human-note flex border-0 bg-transparent p-0">
          <ShieldCheck size={18} />
          <AlertDescription className="text-xs max-[600px]:text-[11px]">
            Результат — подсказка для проверки человеком. Решение принимает специалист.
          </AlertDescription>
        </Alert>
      </main>
    </div>
  )
}
