import { useMutation } from '@tanstack/react-query'
import { Globe, Loader2, Lock, MessagesSquare, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { sendInboxMessage } from '@/services/inbox'
import { SavedReplies } from './composer'

export type ReplyMode = 'public' | 'private' | 'both'

const MODES: Array<{ value: ReplyMode; label: string; icon: React.ReactNode }> = [
  { value: 'public', label: 'Public reply', icon: <Globe className="size-3.5" /> },
  { value: 'private', label: 'Private message', icon: <Lock className="size-3.5" /> },
  { value: 'both', label: 'Both', icon: <MessagesSquare className="size-3.5" /> },
]

/** Answers a comment under the post, in the commenter's inbox, or both at once. */
export function CommentReply({ conversationId, name, mode: initial = 'public', onSent, onCancel, autoFocus = true }: {
  conversationId: string
  name: string
  mode?: ReplyMode
  onSent: () => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [mode, setMode] = useState<ReplyMode>(initial)
  const [text, setText] = useState('')
  const [privateText, setPrivateText] = useState('')
  const first = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setMode(initial), [initial])
  useEffect(() => { if (autoFocus) first.current?.focus() }, [autoFocus, mode])

  const send = useMutation({
    mutationFn: () => sendInboxMessage(
      mode === 'public' ? { conversation_id: conversationId, text }
        : mode === 'private' ? { conversation_id: conversationId, text: privateText, private_reply: true }
          : { conversation_id: conversationId, text, private_text: privateText }),
    onSuccess: () => {
      toast.success(mode === 'both' ? 'Replied in public and in private' : mode === 'private' ? 'Private message sent' : 'Reply posted')
      setText('')
      setPrivateText('')
      onSent()
    },
    onError: (e) => { toast.error(toUserMessage(e)); onSent() },
  })
  const ready = mode === 'public' ? !!text.trim() : mode === 'private' ? !!privateText.trim() : !!text.trim() && !!privateText.trim()
  const used = (mode === 'private' ? privateText : text).length
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (ready && !send.isPending) send.mutate() }
    if (e.key === 'Escape') onCancel?.()
  }

  return (
    <div className="rounded-xl border bg-background shadow-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-1 border-b p-1" role="tablist">
        {MODES.map((m) => (
          <button key={m.value} type="button" role="tab" aria-selected={mode === m.value} onClick={() => setMode(m.value)}
            className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
              mode === m.value && 'bg-muted text-foreground')}>
            {m.icon} {m.label}
          </button>
        ))}
      </div>
      {mode !== 'private' && (
        <div className="px-3 pt-2">
          {mode === 'both' && <p className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"><Globe className="size-3" /> Public reply</p>}
          <Textarea ref={first} value={text} onChange={(e) => setText(e.target.value.slice(0, 2000))} onKeyDown={keys} rows={2}
            placeholder={`Write a public reply to ${name}, or insert a saved comment…`}
            className="min-h-[52px] resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
        </div>
      )}
      {mode !== 'public' && (
        <div className={cn('px-3 pt-2', mode === 'both' && 'border-t')}>
          {mode === 'both' && <p className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"><Lock className="size-3" /> Private message</p>}
          <Textarea ref={mode === 'private' ? first : undefined} value={privateText} onChange={(e) => setPrivateText(e.target.value.slice(0, 2000))} onKeyDown={keys} rows={2}
            placeholder={`Write or paste the private message to ${name}, or insert a saved reply…`}
            className="min-h-[52px] resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
        </div>
      )}
      <div className="flex items-center gap-1 px-2 pb-2">
        <SavedReplies disabled={false} onPick={(body) => (mode === 'private' ? setPrivateText((t) => t + body) : setText((t) => t + body))} />
        {mode === 'both' && <SavedReplies disabled={false} onPick={(body) => setPrivateText((t) => t + body)} />}
        <Button size="sm" className="gap-1.5" disabled={!ready || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? <Loader2 className="animate-spin" /> : <Send />}
          {mode === 'both' ? 'Send both' : mode === 'private' ? 'Send private' : 'Send public reply'}
        </Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{used}/2000 · Enter to send</span>
      </div>
    </div>
  )
}
