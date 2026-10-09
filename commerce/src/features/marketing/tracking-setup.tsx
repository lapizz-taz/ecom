import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** Ad-platform URL parameters that let every order show its campaign, ad set and ad. */
export const TRACKING_TEMPLATES = [
  {
    key: 'meta', name: 'Meta (Facebook / Instagram)', where: 'Ads Manager → ad → Tracking → URL parameters',
    value: 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&site_source_name={{site_source_name}}&placement={{placement}}',
  },
  {
    key: 'tiktok', name: 'TikTok', where: 'Ads Manager → ad → Destination URL → add these after ?',
    value: 'utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&utm_term=__AID_NAME__&utm_content=__CID_NAME__&campaign_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__',
  },
  {
    key: 'google', name: 'Google Ads', where: 'Turn on auto-tagging (adds gclid). Optional final URL suffix:',
    value: 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}',
  },
] as const

export function TrackingSetup({ className }: { className?: string }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (key: string, value: string) => navigator.clipboard.writeText(value).then(() => {
    setCopied(key)
    toast.success('Copied')
    setTimeout(() => setCopied(null), 1500)
  })
  return (
    <Card className={cn('min-w-0 gap-3', className)}>
      <CardHeader>
        <CardTitle className="text-sm">Ad tracking setup</CardTitle>
        <CardDescription>
          Paste these into your ads once. Every order then shows the campaign, ad set and ad it came from. Orders without them are shown as
          Facebook, Google, Direct or Unknown — never guessed as an ad.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 grid-cols-1 gap-3">
        {TRACKING_TEMPLATES.map((t) => (
          <div key={t.key} className="min-w-0 rounded-lg border p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground">{t.where}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => copy(t.key, t.value)} aria-label={`Copy ${t.name} parameters`}>
                {copied === t.key ? <Check /> : <Copy />} {copied === t.key ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <code className="block rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all text-muted-foreground select-all">{t.value}</code>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
