import { useState } from 'react'

export type Verdict = 'confirmed' | 'rejected' | 'unsure'
export type Decision = { verdict: Verdict; comment: string }
export type Review = Record<number, Decision>

// Решения живут только в этом браузере, по номеру задачи: удобство проверяющего, не данные сервиса.
const storageKey = (jobId: string) => `observer-review:${jobId}`

function load(jobId: string): Review {
  try {
    return JSON.parse(localStorage.getItem(storageKey(jobId)) ?? '{}') as Review
  } catch {
    return {}
  }
}

export function useReview(jobId: string) {
  const [state, setState] = useState(() => ({ jobId, review: load(jobId) }))
  const review = state.jobId === jobId ? state.review : load(jobId)

  function update(index: number, decision: Decision | null) {
    const next = { ...review }
    if (decision) next[index] = decision
    else delete next[index]
    setState({ jobId, review: next })
    try {
      localStorage.setItem(storageKey(jobId), JSON.stringify(next))
    } catch {
      // Без хранилища решение остаётся до закрытия страницы.
    }
  }

  return { review, update }
}
