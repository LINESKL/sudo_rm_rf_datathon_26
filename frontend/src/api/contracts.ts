export interface Stage {
  id: string
  title: string
}

export const FALLBACK_STAGES: readonly Stage[] = [
  { id: 'decode', title: 'Подготовка видео' },
  { id: 'detect', title: 'Люди и предметы' },
  { id: 'scene', title: 'Анализ сцены' },
  { id: 'verify', title: 'Проверка находок' },
]

export interface Progress {
  stage: string
  value: number
}

export interface EvidenceFrame {
  timestamp_sec: number
  image_base64: string
}

export interface Rule {
  document: string
  point: string
  quote: string
  url: string
}

export interface Violation {
  type: string
  type_id: string
  timecode_sec: number
  timecode_end_sec: number
  confidence: number
  confidence_level: 'low' | 'medium' | 'high'
  observed: string
  why: string
  description: string
  rule: Rule | null
  evidence_frames: EvidenceFrame[]
}

export interface ProcessingDetails {
  job_id: string
  status: 'processing'
  progress: Progress
  stages: Stage[]
}

export interface DoneDetails {
  job_id: string
  status: 'done'
  verdict: 'violation' | 'no_violation'
  violations: Violation[]
  rules_checked: number
  processing_sec: number
  duration_sec: number
  preview_url: string | null
  progress?: Progress
  stages?: Stage[]
  timeline?: Record<string, [number, number][]>
  timeline_labels?: Record<string, string>
}

export interface FailedDetails {
  job_id: string
  status: 'failed'
  error?: string
}

export type JobDetails = ProcessingDetails | DoneDetails | FailedDetails
