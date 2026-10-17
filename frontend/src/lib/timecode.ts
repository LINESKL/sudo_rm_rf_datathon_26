export function timecode(seconds: number) {
  const tenths = Math.round(seconds * 10)
  const minutes = Math.floor(tenths / 600)
    .toString()
    .padStart(2, '0')
  const rest = new Intl.NumberFormat('ru-RU', {
    minimumIntegerDigits: 2,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format((tenths % 600) / 10)
  return `${minutes}:${rest}`
}
