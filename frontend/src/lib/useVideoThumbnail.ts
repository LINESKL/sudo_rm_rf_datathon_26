import { useEffect, useState } from 'react'

interface VideoThumbnail {
  file: File
  thumb: string
  duration: number
}

// Кадр и длительность выбранного файла снимаются в браузере, без сервера.
// Если браузер не декодирует запись (например, HEVC в Chrome), возвращается null и остаётся иконка.
export function useVideoThumbnail(file: File | null) {
  const [info, setInfo] = useState<VideoThumbnail | null>(null)

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let cancelled = false
    video.muted = true
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, video.duration / 2 || 0)
    }
    video.onseeked = () => {
      if (cancelled || !video.videoWidth) return
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth)
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      setInfo({ file, thumb: canvas.toDataURL('image/jpeg', 0.75), duration: video.duration })
    }
    video.src = url
    return () => {
      cancelled = true
      video.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }, [file])

  return info?.file === file ? info : null
}
