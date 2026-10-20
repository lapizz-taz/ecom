import { cn } from '@/lib/utils'

/** Fullfilio's own pages on social networks (website footer, Contact, Help Center). */
export const FULLFILIO_SOCIAL = [
  { name: 'Facebook', handle: '@fullfilio', href: 'https://www.facebook.com/fullfilio/' },
  { name: 'Instagram', handle: '@fullfiliohq', href: 'https://www.instagram.com/fullfiliohq/' },
] as const

export type SocialName = (typeof FULLFILIO_SOCIAL)[number]['name']

/** The network's mark in the current text colour (drawn here, no brand assets loaded). */
export function SocialIcon({ name, className }: { name: SocialName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} fill="currentColor" aria-hidden>
      {name === 'Facebook' && <path d="M9.1 23.7v-8H6.6V12h2.5v-1.6c0-4.1 1.8-6 5.9-6 .8 0 2.1.2 2.6.3v3.3l-1.4-.1c-2 0-2.7.7-2.7 2.7V12h3.9l-.7 3.7h-3.2v8.2A12 12 0 1 0 9.1 23.7Z" />}
      {name === 'Instagram' && <path d="M12 7.3a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4Zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0ZM16.4 2H7.6A5.6 5.6 0 0 0 2 7.6v8.8A5.6 5.6 0 0 0 7.6 22h8.8a5.6 5.6 0 0 0 5.6-5.6V7.6A5.6 5.6 0 0 0 16.4 2Zm3.9 14.4a3.9 3.9 0 0 1-3.9 3.9H7.6a3.9 3.9 0 0 1-3.9-3.9V7.6a3.9 3.9 0 0 1 3.9-3.9h8.8a3.9 3.9 0 0 1 3.9 3.9v8.8Z" />}
    </svg>
  )
}

/** Links to Fullfilio's social pages: icons only, or icons with the handle. */
export function SocialLinks({ className, linkClassName, withHandles }: { className?: string; linkClassName?: string; withHandles?: boolean }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-2', className)}>
      {FULLFILIO_SOCIAL.map((s) => (
        <li key={s.name}>
          <a href={s.href} target="_blank" rel="noopener noreferrer me" aria-label={`Fullfilio on ${s.name}`} title={`Fullfilio on ${s.name}`}
            className={cn('inline-flex items-center gap-2 transition-colors', linkClassName)}>
            <SocialIcon name={s.name} />
            {withHandles && <span>{s.handle}</span>}
          </a>
        </li>
      ))}
    </ul>
  )
}
