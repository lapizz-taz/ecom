import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FONT_GROUPS, FONTS, fontsHref, type ThemeFont } from '@/features/storefront/theme'
import { cn } from '@/lib/utils'

// Picks one of the store fonts. Each name is shown in its own font: the list loads only the letters
// of the names (Google Fonts "text="), so opening it stays light.

const ALL = Object.keys(FONTS) as ThemeFont[]
const LETTERS = [...new Set(ALL.map((f) => FONTS[f].label + FONTS[f].sample).join(''))].join('')

function usePreviewFonts(on: boolean) {
  useEffect(() => {
    if (!on || document.querySelector('link[data-font-preview]')) return
    const href = fontsHref(ALL, LETTERS)
    if (!href) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.fontPreview = ''
    document.head.appendChild(link)
  }, [on])
}

export function FontPicker({ value, onChange, label }: { value: ThemeFont; onChange: (f: ThemeFont) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  usePreviewFonts(open)
  const query = q.trim().toLowerCase()
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQ('') }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${label}: ${FONTS[value].label}`}
          className="flex h-10 w-full items-center gap-3 rounded-lg border border-zinc-300 bg-white px-3 text-left hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
          <span className="w-7 text-lg leading-none" style={{ fontFamily: FONTS[value].family }}>{FONTS[value].sample}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{FONTS[value].label}</span>
          <ChevronDown className="size-4 text-zinc-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[70] w-[var(--radix-popover-trigger-width)] min-w-64 overflow-hidden p-0">
        <label className="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
          <Search className="size-3.5 text-zinc-500" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fonts" className="h-9 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <div role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
          {FONT_GROUPS.map((g) => {
            const fonts = ALL.filter((f) => FONTS[f].group === g && FONTS[f].label.toLowerCase().includes(query))
            if (!fonts.length) return null
            return (
              <div key={g}>
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">{g}</p>
                {fonts.map((f) => (
                  <button key={f} type="button" role="option" aria-selected={f === value} onClick={() => { onChange(f); setOpen(false) }}
                    className={cn('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800', f === value && 'bg-zinc-100 dark:bg-zinc-800')}>
                    <span className="w-7 text-lg leading-none" style={{ fontFamily: FONTS[f].family }}>{FONTS[f].sample}</span>
                    <span className="min-w-0 flex-1 truncate text-[15px]" style={{ fontFamily: FONTS[f].family }}>{FONTS[f].label}</span>
                    {f === value && <Check className="size-3.5" />}
                  </button>
                ))}
              </div>
            )
          })}
          {!ALL.some((f) => FONTS[f].label.toLowerCase().includes(query)) && <p className="px-2 py-6 text-center text-xs text-zinc-500">No font matches “{q}”.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
