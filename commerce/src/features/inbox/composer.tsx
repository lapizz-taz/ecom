import { useMutation, useQuery } from '@tanstack/react-query'
import { Bookmark, FileText, Loader2, Mic, Package, Paperclip, Send, Smile, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreAddress } from '@/hooks/use-store-address'
import { toUserMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { type ChatProduct, chatProducts, fileForSending, type InboxMessage, savedReplies, sendInboxMessage } from '@/services/inbox'
import { EMOJI } from './ui'

/** Best recording format each platform accepts, in the order browsers support them. */
function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
}

export function Composer({ conversationId, kind, disabled, replyTo, onClearReply, onSent, draft, onDraft }: {
  conversationId: string
  kind: 'MESSAGE' | 'COMMENT'
  disabled?: string | null
  replyTo: InboxMessage | null
  onClearReply: () => void
  onSent: () => void
  /** Text put into the box from outside (an order summary from the customer panel). */
  draft: string | null
  onDraft: () => void
}) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [privateReply, setPrivateReply] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const store = useStoreAddress()

  useEffect(() => {
    if (draft) {
      setText((t) => (t ? `${t}\n${draft}` : draft))
      onDraft()
      box.current?.focus()
    }
  }, [draft, onDraft])
  // A different conversation starts with an empty box.
  useEffect(() => {
    setText('')
    setFile(null)
    setPrivateReply(false)
  }, [conversationId])

  const send = useMutation({
    mutationFn: async (extra: { image_url?: string; text?: string; file?: File } = {}) => {
      const f = extra.file ?? file
      return sendInboxMessage({
        conversation_id: conversationId, text: (extra.text ?? text).trim() || undefined,
        file: f ? await fileForSending(f, f.name) : undefined, image_url: extra.image_url,
        reply_to_id: replyTo?.id, private_reply: kind === 'COMMENT' ? privateReply : undefined,
      })
    },
    onSuccess: (_r, extra) => {
      if (extra?.text === undefined) setText('')
      setFile(null)
      onClearReply()
      onSent()
    },
    onError: (e) => {
      toast.error(toUserMessage(e))
      onSent()
    },
  })

  const canSend = !disabled && !send.isPending && (!!text.trim() || !!file)
  const submit = () => canSend && send.mutate({})
  const insert = (s: string) => {
    const el = box.current
    if (!el) return setText((t) => t + s)
    const start = el.selectionStart ?? text.length
    const next = text.slice(0, start) + s + text.slice(el.selectionEnd ?? start)
    setText(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + s.length, start + s.length) })
  }

  const sendProduct = (p: ChatProduct) => {
    const link = store.url ? `${store.url}/product/${p.slug}` : ''
    const caption = [p.name, p.price != null ? `Price: ${formatMoney(p.price)}` : null, link].filter(Boolean).join('\n')
    // Meta fetches the photo itself, so it needs the full address.
    if (p.image) send.mutate({ image_url: new URL(p.image, window.location.origin).toString(), text: caption })
    else send.mutate({ text: caption })
  }

  return (
    <div className="border-t bg-background p-3">
      {disabled && <p className="mb-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{disabled}</p>}
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Replying to {replyTo.direction === 'IN' ? 'customer' : 'you'}</span>
            <span className="line-clamp-1 text-muted-foreground">{replyTo.body || 'Attachment'}</span>
          </span>
          <button type="button" onClick={onClearReply} aria-label="Cancel reply"><X className="size-3.5" /></button>
        </div>
      )}
      {file && (
        <div className="mb-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          {file.type.startsWith('image/')
            ? <img src={URL.createObjectURL(file)} alt="" className="size-9 rounded object-cover" />
            : file.type.startsWith('audio/') ? <Mic className="size-4" /> : <FileText className="size-4" />}
          <span className="min-w-0 flex-1 truncate">{file.name} · {(file.size / 1024).toFixed(0)} KB</span>
          <button type="button" onClick={() => setFile(null)} aria-label="Remove attachment"><X className="size-3.5" /></button>
        </div>
      )}
      <div className="rounded-xl border bg-background focus-within:ring-2 focus-within:ring-ring/30">
        <Textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={!!disabled}
          placeholder={kind === 'COMMENT' && !privateReply ? 'Reply under the comment…' : 'Type a message…'}
          className="max-h-48 min-h-[56px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <div className="flex flex-wrap items-center gap-0.5 px-2 pb-2">
          <Popover>
            <PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Emoji" disabled={!!disabled}><Smile /></Button></PopoverTrigger>
            <PopoverContent className="w-64 p-2" align="start">
              <div className="grid grid-cols-8 gap-1">
                {EMOJI.map((e) => <button key={e} type="button" className="rounded p-1 text-lg hover:bg-muted" onClick={() => insert(e)}>{e}</button>)}
              </div>
            </PopoverContent>
          </Popover>
          {(kind === 'MESSAGE' || privateReply) && <>
            <Button size="icon-sm" variant="ghost" aria-label="Attach a file" disabled={!!disabled} onClick={() => fileInput.current?.click()}><Paperclip /></Button>
            <input ref={fileInput} type="file" hidden accept="image/*,video/mp4,audio/*,application/pdf"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = '' }} />
            <VoiceButton disabled={!!disabled || send.isPending} onDone={(f) => send.mutate({ file: f, text: '' })} />
            <ProductPicker disabled={!!disabled || send.isPending} onPick={sendProduct} />
          </>}
          <SavedReplies onPick={(body) => insert(body)} disabled={!!disabled} />
          {kind === 'COMMENT' && (
            <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={privateReply} onCheckedChange={setPrivateReply} className="scale-75" /> Reply in inbox
            </label>
          )}
          <Button size="sm" className="ml-auto gap-1.5" onClick={submit} disabled={!canSend}>
            {send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function VoiceButton({ disabled, onDone }: { disabled: boolean; onDone: (file: File) => void }) {
  const [state, setState] = useState<'idle' | 'recording'>('idle')
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cancelled = useRef(false)

  useEffect(() => {
    if (state !== 'recording') return
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [state])

  const start = async () => {
    const type = recorderType()
    if (!type || !navigator.mediaDevices?.getUserMedia) return toast.error('This browser cannot record voice messages')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const r = new MediaRecorder(stream, { mimeType: type })
      chunks.current = []
      cancelled.current = false
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        if (cancelled.current || !chunks.current.length) return
        const base = type.split(';')[0]
        const ext = base === 'audio/mp4' ? 'm4a' : base === 'audio/ogg' ? 'ogg' : 'webm'
        onDone(new File(chunks.current, `voice-${Date.now()}.${ext}`, { type: base }))
      }
      r.start()
      rec.current = r
      setSeconds(0)
      setState('recording')
    } catch {
      toast.error('Allow the microphone to record a voice message')
    }
  }
  const stop = (cancel = false) => {
    cancelled.current = cancel
    rec.current?.stop()
    setState('idle')
  }

  if (state === 'recording') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600">
        <span className="size-2 animate-pulse rounded-full bg-red-500" /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        <button type="button" onClick={() => stop(true)} aria-label="Discard recording" className="ml-1"><Trash2 className="size-3.5" /></button>
        <button type="button" onClick={() => stop(false)} aria-label="Send voice message"><Square className="size-3.5 fill-current" /></button>
      </span>
    )
  }
  return <Button size="icon-sm" variant="ghost" aria-label="Record a voice message" disabled={disabled} onClick={start}><Mic /></Button>
}

function ProductPicker({ disabled, onPick }: { disabled: boolean; onPick: (p: ChatProduct) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const term = useDebounce(q, 250)
  const products = useQuery({ queryKey: ['chat-products', term], queryFn: () => chatProducts(term), enabled: open })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={disabled}><Package className="size-3.5" /> Send a product</Button></PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product" className="mb-2 h-8" autoFocus />
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {products.data?.map((p) => (
            <button key={p.id} type="button" onClick={() => { onPick(p); setOpen(false) }} className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-muted">
              {p.image ? <img src={imageUrl(p.image, 80)} alt="" className="size-10 rounded object-cover" /> : <span className="size-10 rounded bg-muted" />}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 text-sm">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.price != null ? formatMoney(p.price) : 'No price'}</span>
              </span>
            </button>
          ))}
          {products.data?.length === 0 && <p className="p-3 text-center text-xs text-muted-foreground">No active products match.</p>}
        </div>
        <p className="mt-2 border-t px-1 pt-2 text-[11px] text-muted-foreground">Sends the photo, name, price and the store link.</p>
      </PopoverContent>
    </Popover>
  )
}

export function SavedReplies({ onPick, disabled }: { onPick: (body: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const replies = useQuery({ queryKey: ['inbox-saved-replies'], queryFn: savedReplies, enabled: open, staleTime: 60_000 })
  const shown = (replies.data ?? []).filter((r) => !q || `${r.title} ${r.body}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={disabled}><Bookmark className="size-3.5" /> Replies</Button></PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved replies" className="mb-2 h-8" autoFocus />
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {shown.map((r) => (
            <button key={r.id} type="button" onClick={() => { onPick(r.body); setOpen(false) }} className="block w-full rounded-md p-2 text-left hover:bg-muted">
              <span className="block text-sm font-medium">{r.title}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{r.body}</span>
            </button>
          ))}
          {replies.data && !shown.length && (
            <p className={cn('p-3 text-center text-xs text-muted-foreground')}>No saved replies yet. Add them under Inbox → Channels → Saved replies.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
