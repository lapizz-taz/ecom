import { MessageSquareText } from 'lucide-react'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { InboxPlatform } from '@/services/inbox'

export const PLATFORM: Record<InboxPlatform, { label: string; short: string; color: string }> = {
  FACEBOOK: { label: 'Messenger', short: 'Facebook', color: '#0866FF' },
  INSTAGRAM: { label: 'Instagram', short: 'Instagram', color: '#E1306C' },
  WHATSAPP: { label: 'WhatsApp', short: 'WhatsApp', color: '#25D366' },
}

/** The platform's mark in a small coloured circle (drawn here, no brand assets loaded). */
export function PlatformIcon({ platform, className }: { platform: InboxPlatform; className?: string }) {
  const p = PLATFORM[platform]
  return (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-white', className)}
      style={{ background: platform === 'INSTAGRAM' ? 'linear-gradient(45deg,#F58529,#DD2A7B,#8134AF)' : p.color }}
      title={p.label} aria-label={p.label}>
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="currentColor" aria-hidden>
        {platform === 'FACEBOOK' && <path d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.44 3.14 7.17.16.15.26.35.27.57l.05 1.78c.02.57.6.94 1.12.71l1.98-.87c.17-.08.36-.09.53-.04.91.25 1.88.38 2.91.38 5.64 0 10-4.13 10-9.7S17.64 2 12 2Zm6 7.46-2.94 4.66a1.5 1.5 0 0 1-2.17.4l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66a1.5 1.5 0 0 1 2.17-.4l2.34 1.75c.21.16.51.16.72 0l3.16-2.4c.42-.32.97.18.69.63Z" />}
        {platform === 'INSTAGRAM' && <path d="M12 7.3a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4Zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0ZM16.4 2H7.6A5.6 5.6 0 0 0 2 7.6v8.8A5.6 5.6 0 0 0 7.6 22h8.8a5.6 5.6 0 0 0 5.6-5.6V7.6A5.6 5.6 0 0 0 16.4 2Zm3.9 14.4a3.9 3.9 0 0 1-3.9 3.9H7.6a3.9 3.9 0 0 1-3.9-3.9V7.6a3.9 3.9 0 0 1 3.9-3.9h8.8a3.9 3.9 0 0 1 3.9 3.9v8.8Z" />}
        {platform === 'WHATSAPP' && <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.8 14.1c-.2.7-1.4 1.3-2 1.4-.5.1-1.2.1-1.9-.1a17 17 0 0 1-1.7-.6 13.4 13.4 0 0 1-5.2-4.6c-.4-.5-1.2-1.6-1.2-3s.8-2.2 1-2.5c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.7-.1l1-1.2c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.8-.1 1.5Z" />}
      </svg>
    </span>
  )
}

/** Customer picture, or their initials, with the platform in the corner. */
export function ChatAvatar({ name, src, platform, size = 'md', className }: {
  name: string | null; src?: string | null; platform?: InboxPlatform; size?: 'sm' | 'md' | 'lg'; className?: string
}) {
  const box = size === 'lg' ? 'size-16 text-lg' : size === 'sm' ? 'size-7 text-[10px]' : 'size-9 text-xs'
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {src
        ? <img src={src} alt="" className={cn(box, 'rounded-full bg-muted object-cover')} referrerPolicy="no-referrer" />
        : <span className={cn(box, 'inline-flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground')}>
          {name ? initials(name) : <MessageSquareText className="size-1/2" />}
        </span>}
      {platform && <PlatformIcon platform={platform} className={cn('absolute -right-0.5 -bottom-0.5 ring-2 ring-background', size === 'lg' && 'size-5')} />}
    </span>
  )
}

/** "10:42", "Yesterday", "Mon", "12 Oct" — like a chat app. */
export function chatTime(value: string | null | undefined, now = new Date()): string {
  if (!value) return ''
  const d = new Date(value)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** Day separator text inside a conversation. */
export function dayLabel(value: string, now = new Date()): string {
  const d = new Date(value)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, now)) return 'Today'
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export const EMOJI = ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😉', '😎', '🤗', '🤔', '😅', '😢', '😭', '😡', '🙏', '👍', '👎', '👌', '✌️', '👏', '🙌', '💪', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '🔥', '✨', '🎉', '🎁', '🛍️', '📦', '🚚', '✅', '❌', '⏰', '📞', '💬', '💰', '🏷️', '⭐', '🌸']
