import { useMutation } from '@tanstack/react-query'
import { CheckCircle2, Loader2, MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { SitePage } from '@/features/site/site-chrome'
import { toUserMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { type ContactInput, submitContact } from '@/services/onboarding'

const TOPICS: Array<[ContactInput['topic'], string]> = [['SALES', 'Getting started'], ['SUPPORT', 'Help with my account'], ['PARTNERSHIP', 'Partnership'], ['GENERAL', 'Something else']]
const EMPTY: ContactInput = { name: '', email: '', phone: '', business: '', topic: 'SALES', message: '' }

const field = 'mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[14px] text-white outline-none transition-colors placeholder:text-[#62666d] focus:border-[#2142e7] focus:bg-white/[0.05]'

/** The website contact form; messages go to the Super Admin support inbox. */
export default function ContactPage() {
  const [form, setForm] = useState<ContactInput>(EMPTY)
  const [touched, setTouched] = useState(false)
  const set = <K extends keyof ContactInput>(k: K, v: ContactInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const send = useMutation({ meta: { silent: true }, mutationFn: () => submitContact(form) })

  const problems = {
    name: form.name.trim().length < 2 ? 'Enter your name' : null,
    reach: !form.email?.trim() && !form.phone?.trim() ? 'Add an e-mail address or a phone number so we can reply' : null,
    message: form.message.trim().length < 10 ? 'Tell us a little more (at least 10 characters)' : null,
  }
  const invalid = Object.values(problems).some(Boolean)

  return (
    <SitePage title="Contact — Fullfilio">
      <section className="mx-auto grid max-w-6xl gap-12 px-5 pt-20 pb-24 md:grid-cols-[1fr_1.2fr] md:pt-28">
        <div>
          <p className="font-mono text-[12px] text-[#8a8f98]">Contact</p>
          <h1 className="mt-4 text-[40px] leading-[1.05] font-medium tracking-[-0.035em] sm:text-[52px]">Talk to us</h1>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-[#8a8f98]">
            Questions about plans, moving from another tool, or connecting Shopify or WooCommerce? Send a message and a person from the team replies by e-mail or phone.
          </p>
          <ul className="mt-8 space-y-3 text-[14px] text-[#d0d6e0]">
            {['Free trial on every paid plan', 'Help moving your products and orders', 'Setup help for Shopify and WooCommerce'].map((t) => (
              <li key={t} className="flex items-center gap-2.5"><CheckCircle2 className="size-4 text-[#7b8fff]" />{t}</li>
            ))}
          </ul>
          <p className="mt-8 text-[13px] text-[#8a8f98]">Already a customer? Sign in and use <span className="text-[#d0d6e0]">Support</span> in the admin for the fastest answer.</p>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#0f1011] p-5 sm:p-7">
          {send.isSuccess ? (
            <div className="grid min-h-[420px] place-items-center text-center">
              <div>
                <span className="mx-auto grid size-12 place-items-center rounded-full bg-[#2142e7]/15"><MessageSquareText className="size-5 text-[#7b8fff]" /></span>
                <p className="mt-5 text-[22px] font-medium tracking-[-0.02em]">Thanks, {form.name.trim().split(' ')[0]}</p>
                <p className="mt-2 text-[14px] text-[#8a8f98]">We have your message and will reply to {form.email?.trim() || form.phone?.trim()}.</p>
                <div className="mt-6 flex justify-center gap-3">
                  <Link to="/" className="rounded-full border border-white/10 px-4 py-2 text-[13px] text-[#d0d6e0] hover:bg-white/[0.05]">Back to the website</Link>
                  <Link to="/start" className="rounded-full bg-[#f7f8f8] px-4 py-2 text-[13px] font-medium text-[#08090a] hover:bg-white">Start for free</Link>
                </div>
              </div>
            </div>
          ) : (
            <form noValidate className="grid gap-4" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!invalid) send.mutate() }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-[13px] text-[#d0d6e0]">Your name
                  <input className={field} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={100} />
                  {touched && problems.name && <span className="mt-1 block text-[12px] text-[#eb5757]">{problems.name}</span>}
                </label>
                <label className="text-[13px] text-[#d0d6e0]">Business <span className="text-[#62666d]">(optional)</span>
                  <input className={field} value={form.business} onChange={(e) => set('business', e.target.value)} autoComplete="organization" maxLength={120} />
                </label>
                <label className="text-[13px] text-[#d0d6e0]">E-mail
                  <input className={field} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" maxLength={160} />
                </label>
                <label className="text-[13px] text-[#d0d6e0]">Phone
                  <input className={field} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" placeholder="01XXXXXXXXX" maxLength={20} />
                </label>
              </div>
              {touched && problems.reach && <p className="-mt-2 text-[12px] text-[#eb5757]">{problems.reach}</p>}
              <div className="text-[13px] text-[#d0d6e0]">What is it about?
                <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Topic">
                  {TOPICS.map(([v, l]) => (
                    <button key={v} type="button" role="radio" aria-checked={form.topic === v} onClick={() => set('topic', v)}
                      className={cn('rounded-full border px-3 py-1.5 text-[13px] transition-colors', form.topic === v ? 'border-[#2142e7] bg-[#2142e7]/15 text-white' : 'border-white/10 text-[#8a8f98] hover:text-white')}>{l}</button>
                  ))}
                </div>
              </div>
              <label className="text-[13px] text-[#d0d6e0]">Message
                <textarea className={cn(field, 'min-h-32 resize-y')} value={form.message} onChange={(e) => set('message', e.target.value)} maxLength={4000}
                  placeholder="How many orders a month, where you sell today, and what you would like help with." />
                {touched && problems.message && <span className="mt-1 block text-[12px] text-[#eb5757]">{problems.message}</span>}
              </label>
              {send.error && <p className="rounded-lg border border-[#eb5757]/30 bg-[#eb5757]/10 px-3 py-2 text-[13px] text-white">{toUserMessage(send.error)}</p>}
              <button type="submit" disabled={send.isPending}
                className="flex items-center justify-center gap-2 rounded-full bg-[#f7f8f8] px-5 py-2.5 text-sm font-medium text-[#08090a] transition-colors hover:bg-white disabled:opacity-60">
                {send.isPending && <Loader2 className="size-4 animate-spin" />} Send message
              </button>
            </form>
          )}
        </div>
      </section>
    </SitePage>
  )
}
