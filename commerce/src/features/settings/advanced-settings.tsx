import { useQueryClient } from '@tanstack/react-query'
import { Activity, FileClock, RefreshCw, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { deviceLabel } from '@/lib/device'
import { NumberSetting, SettingCard, TextSetting, useSettingDraft } from './setting-form'

export function AdvancedSettings() {
  const store = useSettingDraft('store')
  const advanced = useSettingDraft('advanced')
  const queryClient = useQueryClient()
  const idle = Number(advanced.get(['idle_logout_minutes']) ?? 0)

  return (
    <div className="grid gap-4">
      <SettingCard setting={store} title="Region & numbering" description="Money, dates and order numbers everywhere in the system."
        validate={() => (/^[A-Z0-9]{1,8}$/.test(String(store.get(['order_prefix']) ?? '')) ? null : 'Order prefix must be 1–8 uppercase letters or digits')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextSetting s={store} path={['currency']} label="Currency code" mono />
          <TextSetting s={store} path={['currency_symbol']} label="Currency symbol" />
          <TextSetting s={store} path={['locale']} label="Number format (locale)" mono hint="e.g. en-BD" />
          <TextSetting s={store} path={['timezone']} label="Time zone" mono hint="Reports, attendance and day boundaries use this" />
          <TextSetting s={store} path={['order_prefix']} label="Order number prefix" mono hint="ISO → ISO-10001" />
          <TextSetting s={store} path={['phone_country_code']} label="Phone country code" mono />
        </div>
        <TextSetting s={store} path={['phone_pattern']} label="Local phone pattern" mono hint="Regular expression for valid local numbers; checkout rejects anything else" />
      </SettingCard>

      <SettingCard setting={advanced} title="Session security" description="Applies to every staff member. Owners can also require approval for new devices."
        validate={() => (idle < 0 || idle > 1440 ? 'Between 0 (off) and 1440 minutes' : null)}>
        <NumberSetting s={advanced} path={['idle_logout_minutes']} label="Sign out after inactivity (minutes)" min={0} max={1440}
          hint={idle > 0 ? `Staff are signed out after ${idle} minutes without using the admin.` : '0 = stay signed in'} className="max-w-xs" />
        <p className="text-sm text-muted-foreground">New sign-in devices: <Link to="/admin/settings/devices" className="underline">Device approvals</Link></p>
      </SettingCard>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">This browser</CardTitle>
          <CardDescription>{deviceLabel()} — tools for when something looks out of date.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => { void queryClient.invalidateQueries(); toast.success('Reloading all data') }}><RefreshCw /> Refresh all data</Button>
          <Button variant="outline" size="sm" onClick={() => {
            try {
              for (const k of Object.keys(localStorage)) if (k !== 'admin-device-token' && !k.startsWith('sb-')) localStorage.removeItem(k)
              sessionStorage.clear()
            } catch { /* storage blocked */ }
            location.reload()
          }}><Trash2 /> Clear saved views & reload</Button>
          <Button variant="ghost" size="sm" asChild><Link to="/admin/status"><Activity /> System status</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/admin/audit-logs"><FileClock /> Audit log</Link></Button>
        </CardContent>
      </Card>
    </div>
  )
}
