import { Link, useLocation } from 'react-router'
import { SitePage } from '@/features/site/site-chrome'

// Privacy policy, terms of service and data deletion instructions for the
// Fullfilio website. Meta links to these from the "Continue with Facebook"
// login, so they describe exactly what the inbox does with Meta data.

const UPDATED = '17 October 2026'

type Doc = { title: string; intro: string; sections: Array<{ heading: string; body: Array<string | string[]> }> }

const contact = 'Use the contact form at fullfilio.com/contact, or Support inside your Fullfilio admin.'

const DOCS: Record<'privacy' | 'terms' | 'data-deletion', Doc> = {
  privacy: {
    title: 'Privacy policy',
    intro: 'Fullfilio is order-management software for online stores in Bangladesh. This policy explains what information Fullfilio handles, why, and the choices stores and their customers have.',
    sections: [
      { heading: 'Who we are', body: ['Fullfilio ("we") provides the Fullfilio platform at fullfilio.com to businesses ("stores"). Each store decides what it does with its own customers’ information; we process that information on the store’s behalf.'] },
      { heading: 'Information we handle', body: [[
        'Store accounts: names, e-mail addresses, phone numbers and sign-in details of the people who use Fullfilio.',
        'Orders and customers: the names, phone numbers, addresses and order history that stores record or import from their website, Shopify or WooCommerce.',
        'Messages: when a store connects Facebook, Instagram or WhatsApp, the messages and comments its customers send to that store, the sender’s public name and profile picture, and the replies the store sends.',
        'Technical data: IP address, browser and device information, used to keep accounts secure and to detect fraud.',
      ]] },
      { heading: 'Facebook, Instagram and WhatsApp', body: [
        'A store connects its Facebook Page, Instagram professional account or WhatsApp Business number by signing in with Facebook ("Continue with Facebook") and choosing which accounts to connect. We receive access only to the accounts the store chooses and only the permissions it approves.',
        [
          'We use this access to show the store’s messages and comments in its Fullfilio inbox, to send the replies its staff write, and to show the customer’s name and picture next to the conversation.',
          'Access tokens are stored encrypted and are never shown to anyone, including the store’s own staff.',
          'We do not use Meta data for advertising, do not sell it, and do not share it with anyone other than the store that owns the conversation.',
          'A store can disconnect an account at any time under Inbox → Channels, or remove Fullfilio from its Facebook settings (Settings → Business integrations).',
        ],
      ] },
      { heading: 'How we use information', body: [[
        'To run the service: orders, deliveries, courier bookings, payments, messages and reports for each store.',
        'To protect stores from fraud and abuse, and to keep the service secure.',
        'To provide support and tell store owners about changes to the service.',
      ]] },
      { heading: 'Sharing', body: [
        'We share information only to run the service: with the couriers, payment providers, SMS providers and Meta services a store chooses to use, and with our hosting providers. We do not sell personal information.',
      ] },
      { heading: 'Keeping and deleting information', body: [
        'We keep a store’s information for as long as its account is open. When a store disconnects a messaging account, we delete that account’s access token immediately. See the data deletion instructions at fullfilio.com/data-deletion for how to have messages and other data removed.',
      ] },
      { heading: 'Security', body: ['Data is encrypted in transit, secrets are kept in an encrypted vault, and every store’s data is separated from every other store’s at the database level.'] },
      { heading: 'Your choices', body: ['Store customers who want their information corrected or removed can ask the store they bought from, or contact us. Store owners can export or delete their data from the admin or by contacting us.'] },
      { heading: 'Contact', body: [contact] },
    ],
  },
  terms: {
    title: 'Terms of service',
    intro: 'These terms apply to every business that uses Fullfilio. By creating an account you agree to them.',
    sections: [
      { heading: 'The service', body: ['Fullfilio provides software to manage orders, inventory, couriers, payments, messaging and an online store. Features depend on your plan.'] },
      { heading: 'Your account', body: [[
        'You are responsible for the people you give access to and for keeping sign-in details safe.',
        'You must give accurate information and use Fullfilio only for lawful business.',
      ]] },
      { heading: 'Your data', body: ['You own the data you put into Fullfilio, including your customers’ information and messages. You are responsible for having the right to collect it and for answering your customers’ requests about it. We process it only to provide the service, as described in our privacy policy.'] },
      { heading: 'Connected services', body: ['When you connect Facebook, Instagram, WhatsApp, Shopify, WooCommerce, couriers or payment providers, you must also follow their terms and policies, including Meta’s Platform Terms and messaging policies. We may disconnect an account that breaks them.'] },
      { heading: 'Payment', body: ['Paid plans and usage charges are billed in advance as shown in the admin. Unpaid accounts may be limited after the grace period.'] },
      { heading: 'Acceptable use', body: [['No spam, fraud, harassment or illegal goods.', 'No attempts to break into, overload or copy the service.', 'Messages to customers must follow the rules of the platform they are sent on.']] },
      { heading: 'Availability and liability', body: ['We work to keep Fullfilio available and your data safe, but the service is provided "as is". To the extent the law allows, our liability is limited to the fees you paid in the three months before a claim.'] },
      { heading: 'Ending', body: ['You can close your account at any time. We may suspend accounts that break these terms. After closing, you can ask for your data to be deleted as described at fullfilio.com/data-deletion.'] },
      { heading: 'Changes', body: ['We may update these terms and will tell store owners about important changes before they take effect.'] },
      { heading: 'Contact', body: [contact] },
    ],
  },
  'data-deletion': {
    title: 'Data deletion instructions',
    intro: 'How to remove the information Fullfilio holds, including data from Facebook, Instagram and WhatsApp.',
    sections: [
      { heading: 'Remove Fullfilio from Facebook', body: [[
        'Open Facebook and go to Settings & privacy → Settings → Business integrations.',
        'Find Fullfilio and choose Remove.',
        'Fullfilio can no longer read or send messages for your Pages, Instagram accounts or WhatsApp numbers. Their access tokens stop working right away.',
      ]] },
      { heading: 'Disconnect inside Fullfilio', body: ['Store owners can go to Inbox → Channels and choose Disconnect on any connected account. Its access token is deleted immediately.'] },
      { heading: 'Delete messages and other data', body: [[
        'Send a deletion request through the contact form at fullfilio.com/contact, from the e-mail address on your Fullfilio account, saying which store and which data (for example: all Facebook and Instagram messages, or the whole account).',
        'We confirm the request and delete the data within 30 days. Records the law requires us to keep (such as invoices) are kept only for as long as required.',
      ]] },
      { heading: 'If you are a store’s customer', body: ['Ask the store you messaged to delete your conversation, or contact us with the store’s name and the Facebook, Instagram or WhatsApp account you used, and we will pass the request on and make sure it is completed.'] },
      { heading: 'Contact', body: [contact] },
    ],
  },
}

/** /privacy, /terms and /data-deletion on the Fullfilio website. */
export default function LegalPage() {
  const { pathname } = useLocation()
  const key = (pathname.replace(/^\/+|\/+$/g, '') || 'privacy') as keyof typeof DOCS
  const doc = DOCS[key] ?? DOCS.privacy
  return (
    <SitePage title={`${doc.title} — Fullfilio`}>
      <article className="mx-auto max-w-3xl px-5 pt-20 pb-24 md:pt-28">
        <p className="font-mono text-[12px] text-(--s-muted)">Legal · Last updated {UPDATED}</p>
        <h1 className="mt-4 text-[36px] leading-[1.1] font-medium tracking-[-0.03em] text-balance sm:text-[44px]">{doc.title}</h1>
        <p className="mt-5 text-[15px] leading-relaxed text-(--s-fg2)">{doc.intro}</p>
        <div className="mt-10 space-y-9">
          {doc.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-[17px] font-medium tracking-[-0.01em]">{s.heading}</h2>
              <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-(--s-muted)">
                {s.body.map((b, i) => Array.isArray(b)
                  ? <ul key={i} className="list-disc space-y-2 pl-5">{b.map((li) => <li key={li}>{li}</li>)}</ul>
                  : <p key={i}>{b}</p>)}
              </div>
            </section>
          ))}
        </div>
        <nav className="mt-14 flex flex-wrap gap-4 border-t border-(--s-line) pt-6 text-[13px] text-(--s-muted)">
          <Link to="/privacy" className="hover:text-(--s-fg)">Privacy policy</Link>
          <Link to="/terms" className="hover:text-(--s-fg)">Terms of service</Link>
          <Link to="/data-deletion" className="hover:text-(--s-fg)">Data deletion</Link>
          <Link to="/contact" className="hover:text-(--s-fg)">Contact</Link>
        </nav>
      </article>
    </SitePage>
  )
}
