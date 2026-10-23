import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImageUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/lib/toast'
import { uploadThemeImage } from '@/services/catalog'
import { type EmailSettings, saveEmailSettings } from '@/services/messaging'

const SWATCHES = ['#111827', '#2563eb', '#16a34a', '#dc2626', '#ea580c', '#9333ea', '#db2777', '#0d9488']
const HEX = /^#[0-9a-f]{6}$/i

/** The look every email shares: the logo at the top and the colour of its buttons. */
export function EmailDesign({ settings, canManage }: { settings: EmailSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [design, setDesign] = useState({ logo_url: settings.design.logo_url ?? '', accent_color: settings.design.accent_color })
  useEffect(() => setDesign({ logo_url: settings.design.logo_url ?? '', accent_color: settings.design.accent_color }), [settings.design.logo_url, settings.design.accent_color])
  const file = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: uploadThemeImage,
    onSuccess: (url) => setDesign((d) => ({ ...d, logo_url: url })),
  })
  const save = useMutation({
    mutationFn: () => saveEmailSettings({ design: { logo_url: design.logo_url.trim() || null, accent_color: design.accent_color } }),
    onSuccess: () => { toast.success('Email design saved'); void queryClient.invalidateQueries({ queryKey: ['email-settings'] }) },
  })
  const logo = design.logo_url.trim() || settings.store.logo_url
  const colorOk = HEX.test(design.accent_color)
  const logoOk = !design.logo_url.trim() || /^https:\/\/\S+$/i.test(design.logo_url.trim())

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email design</CardTitle>
          <CardDescription>Used by every email. For more, edit an email's code: it is yours to change.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email_logo">Logo</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="email_logo" className="min-w-0 flex-1" value={design.logo_url} disabled={!canManage}
                placeholder={settings.store.logo_url ? 'Your store logo' : 'https://…/logo.png'} onChange={(e) => setDesign({ ...design, logo_url: e.target.value })} />
              {canManage && (
                <>
                  <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }} />
                  <Button variant="outline" disabled={upload.isPending} onClick={() => file.current?.click()}>
                    {upload.isPending ? <Spinner /> : <ImageUp />} Upload
                  </Button>
                  {design.logo_url && <Button variant="ghost" size="icon" aria-label="Use the store logo" onClick={() => setDesign({ ...design, logo_url: '' })}><X /></Button>}
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {logoOk ? 'Empty: the logo from Settings, or the store name when there is none. PNG or JPG works in every mail app (not SVG).' : <span className="text-red-600">The address must start with https://</span>}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email_accent">Button colour</Label>
            <div className="flex flex-wrap items-center gap-2">
              <input type="color" aria-label="Pick a colour" value={colorOk ? design.accent_color : '#111827'} disabled={!canManage}
                onChange={(e) => setDesign({ ...design, accent_color: e.target.value })} className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1" />
              <Input id="email_accent" className="w-28 font-mono" value={design.accent_color} disabled={!canManage} maxLength={7}
                onChange={(e) => setDesign({ ...design, accent_color: e.target.value.trim() })} />
              <div className="flex flex-wrap gap-1.5">
                {SWATCHES.map((c) => (
                  <button key={c} type="button" disabled={!canManage} aria-label={c} onClick={() => setDesign({ ...design, accent_color: c })}
                    className={`size-6 rounded-full border ring-offset-2 ring-offset-background ${design.accent_color.toLowerCase() === c ? 'ring-2 ring-foreground' : ''}`} style={{ background: c }} />
                ))}
              </div>
            </div>
            {!colorOk && <p className="text-xs text-red-600">Write the colour as # and six letters or digits, like #2563eb.</p>}
          </div>

          {canManage && (
            <div className="flex justify-end">
              <Button disabled={save.isPending || !colorOk || !logoOk} onClick={() => save.mutate()}>{save.isPending && <Spinner />} Save design</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* A small likeness of the email's top and button, in mail-app colours (always light). */}
      <div className="h-fit overflow-hidden rounded-xl border bg-[#f4f4f5] p-4">
        <div className="space-y-4 rounded-lg bg-white p-5 text-[#111827]">
          {logo ? <img src={logo} alt="" className="h-9 max-w-[180px] object-contain" />
            : <span className="text-lg font-bold">{settings.store.name || 'Your store'}</span>}
          <div className="space-y-1.5">
            <p className="text-base font-semibold">Thank you for your order!</p>
            <p className="text-xs text-[#4b5563]">Hi Rahim, we have your order and will call you to confirm it soon.</p>
          </div>
          <span className="inline-block rounded-md px-4 py-2 text-xs font-semibold text-white" style={{ background: colorOk ? design.accent_color : '#111827' }}>View your order</span>
        </div>
      </div>
    </div>
  )
}
