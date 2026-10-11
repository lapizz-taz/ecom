import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { formatPostDate, POSTS } from '@/features/site/blog-posts'
import { SitePage } from '@/features/site/site-chrome'

/** The Fullfilio blog: guides for COD sellers. */
export default function BlogPage() {
  const [first, ...rest] = POSTS
  return (
    <SitePage title="Blog — Fullfilio">
      <section className="mx-auto max-w-6xl px-5 pt-20 pb-24 sm:pt-28">
        <p className="font-mono text-[12px] text-[#8a8f98]">Blog</p>
        <h1 className="mt-4 max-w-2xl text-[40px] leading-[1.05] font-medium tracking-[-0.035em] sm:text-[52px]">Notes on selling with cash on delivery</h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[#8a8f98]">Guides on fewer returns, faster shipping and running a store with Shopify or WooCommerce, from the team behind Fullfilio.</p>

        <Link to={`/blog/${first.slug}`} className="group mt-14 grid gap-6 rounded-2xl border border-white/[0.08] bg-[#0f1011] p-6 transition-colors hover:border-white/20 sm:p-8 md:grid-cols-[1.2fr_1fr] md:items-end">
          <div>
            <PostMeta tag={first.tag} date={first.date} minutes={first.minutes} />
            <h2 className="mt-4 text-[26px] leading-tight font-medium tracking-[-0.025em] sm:text-[32px]">{first.title}</h2>
          </div>
          <div>
            <p className="text-[14px] leading-relaxed text-[#8a8f98]">{first.excerpt}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-white">Read the guide <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
          </div>
        </Link>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {rest.map((p) => (
            <Link key={p.slug} to={`/blog/${p.slug}`} className="group flex flex-col rounded-2xl border border-white/[0.08] p-6 transition-colors hover:border-white/20 hover:bg-white/[0.02]">
              <PostMeta tag={p.tag} date={p.date} minutes={p.minutes} />
              <h2 className="mt-4 text-[18px] leading-snug font-medium tracking-[-0.015em]">{p.title}</h2>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed text-[#8a8f98]">{p.excerpt}</p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-[13px] text-[#d0d6e0] group-hover:text-white">Read <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
          ))}
        </div>
      </section>
    </SitePage>
  )
}

export function PostMeta({ tag, date, minutes }: { tag: string; date: string; minutes: number }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-[#8a8f98]">
      <span className="rounded-full border border-white/10 px-2 py-0.5 text-[#d0d6e0]">{tag}</span>
      <span>{formatPostDate(date)}</span><span aria-hidden>·</span><span>{minutes} min read</span>
    </p>
  )
}
