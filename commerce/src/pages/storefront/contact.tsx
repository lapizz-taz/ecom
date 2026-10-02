import { useMutation } from '@tanstack/react-query'
import { Mail, MapPin, Phone } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toUserMessage } from '@/lib/errors'
import { submitContact } from '@/services/storefront'

export default function ContactPage() {
  const { data: config } = useStoreConfig()
  const [values, setValues] = useState({ name: '', phone: '', email: '', subject: '', message: '' })
  const send = useMutation({ meta: { silent: true }, mutationFn: () => submitContact(values) })
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value }))
  const store = config?.store
  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-4 py-10 md:grid-cols-[1fr_1.4fr]">
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Contact us</h1>
        <p className="text-muted-foreground">Questions about an order, sizing or delivery? We usually reply within a few hours.</p>
        <ul className="space-y-3 text-sm">
          {store?.phone && <li className="flex items-center gap-2"><Phone className="size-4" /> <a href={`tel:${store.phone}`}>{store.phone}</a></li>}
          {store?.email && <li className="flex items-center gap-2"><Mail className="size-4" /> <a href={`mailto:${store.email}`}>{store.email}</a></li>}
          {store?.address && <li className="flex items-center gap-2"><MapPin className="size-4" /> {store.address}</li>}
        </ul>
      </div>
      <Card>
        <CardContent>
          {send.isSuccess ? (
            <p className="py-8 text-center">Thanks — we've received your message and will get back to you soon.</p>
          ) : (
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
              <Field label="Name" htmlFor="name" required><Input id="name" value={values.name} onChange={set('name')} required /></Field>
              <Field label="Mobile" htmlFor="cphone"><Input id="cphone" value={values.phone} onChange={set('phone')} inputMode="tel" /></Field>
              <Field label="Email" htmlFor="cemail" className="sm:col-span-2"><Input id="cemail" type="email" value={values.email} onChange={set('email')} /></Field>
              <Field label="Subject" htmlFor="subject" className="sm:col-span-2"><Input id="subject" value={values.subject} onChange={set('subject')} /></Field>
              <Field label="Message" htmlFor="message" required className="sm:col-span-2"><Textarea id="message" rows={5} value={values.message} onChange={set('message')} required /></Field>
              {send.error && <p className="text-sm text-destructive sm:col-span-2">{toUserMessage(send.error)}</p>}
              <Button type="submit" className="sm:col-span-2" disabled={send.isPending}>{send.isPending && <Spinner />} Send message</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
