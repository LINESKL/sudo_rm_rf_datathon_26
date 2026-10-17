export function timecode(seconds: number) {
  const ticks = Math.round(seconds * 10)
  return `${Math.floor(ticks / 600)
    .toString()
    .padStart(2, '0')}:${Math.floor((ticks % 600) / 10)
    .toString()
    .padStart(2, '0')},${ticks % 10}`
}
