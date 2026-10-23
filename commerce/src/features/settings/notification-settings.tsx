import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Mail, MessageSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { PlatformIcon } from '@/features/inbox/ui'
import { CustomerMessageSettings } from '@/features/messaging/customer-message-settings'
import { emailSettings, whatsappSettings } from '@/services/messaging'

/**
 * Customer messages live in their own modules (SMS, Email, WhatsApp); this tab points to them and
 * holds what they share: language, confirm, cart reminders, review requests and the daily summary.
 */
export function NotificationSettings() {
  const { can } = useAuth()
  const messages = can('notifications.view')
  const email = useQuery({ queryKey: ['email-settings'], queryFn: emailSettings, enabled: messages })
  const whatsapp = useQuery({ queryKey: ['whatsapp-settings'], queryFn: whatsappSettings, enabled: messages })
  const state = (on?: boolean, ready?: boolean) => (on === undefined ? null : on ? <Badge variant="success">On</Badge> : <Badge variant="neutral">{ready ? 'Off' : 'Not set up'}</Badge>)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer messages</CardTitle>
          <CardDescription>Order updates by SMS, email and WhatsApp each have their own page: the texts, how they are sent, on and off, and what went out.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y rounded-lg border p-0">
          {can('sms.view') && <Row to="/admin/sms?tab=automations" icon={<MessageSquare className="size-4" />} title="SMS" text="Texts sent from Fullfilio's SMS service; each costs SMS balance." />}
          {messages && (
            <>
              <Row to="/admin/email" icon={<Mail className="size-4" />} title="Email" state={state(email.data?.enabled, email.data?.ready)}
                text="Order confirmations, shipping and payment emails, from your own mailbox or Fullfilio's email service. Edit their code like Shopify's." />
              <Row to="/admin/whatsapp" icon={<PlatformIcon platform="WHATSAPP" className="size-4" />} title="WhatsApp" state={state(whatsapp.data?.enabled, whatsapp.data?.ready)}
                text="Order updates over WhatsApp from your business number, with texts Meta approved." />
            </>
          )}
        </CardContent>
      </Card>
      {messages && <CustomerMessageSettings canManage={can('notifications.manage')} />}
    </div>
  )
}

function Row({ to, icon, title, text, state }: { to: string; icon: ReactNode; title: string; text: string; state?: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{text}</span>
      </span>
      {state}
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  )
}
