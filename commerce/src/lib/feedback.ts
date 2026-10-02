// Audible + haptic feedback for the packing desk scanner, so staff don't
// have to look at the screen after every scan.
let ctx: AudioContext | null = null

function tone(freq: number, start: number, duration: number, volume = 0.12) {
  ctx ??= new AudioContext()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(volume, ctx.currentTime + start)
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(ctx.currentTime + start)
  osc.stop(ctx.currentTime + start + duration + 0.02)
}

export type FeedbackKind = 'ok' | 'warn' | 'error'

export function scanFeedback(kind: FeedbackKind, sound = true) {
  try {
    if (sound) {
      if (kind === 'ok') tone(1320, 0, 0.09)
      else if (kind === 'warn') { tone(880, 0, 0.08); tone(880, 0.12, 0.08) }
      else { tone(220, 0, 0.18, 0.18); tone(180, 0.22, 0.25, 0.18) }
    }
    navigator.vibrate?.(kind === 'ok' ? 40 : kind === 'warn' ? [40, 60, 40] : [120, 80, 160])
  } catch {
    /* audio not available — visual feedback is still shown */
  }
}
