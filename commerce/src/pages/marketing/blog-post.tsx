import { ArrowLeft, Lightbulb } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { type Block, postBySlug, POSTS } from '@/features/site/blog-posts'
import { SitePage } from '@/features/site/site-chrome'
import MarketingNotFound from '@/pages/marketing/not-found'
import { PostMeta } from '@/pages/marketing/blog'

/** One blog post. */
export default function BlogPostPage() {
  const { slug } = useParams()
  const post = postBySlug(slug)
  if (!post) return <MarketingNotFound />
  const more = POSTS.filter((p) => p.slug !== post.slug).slice(0, 2)
  return (
    <SitePage title={`${post.title} — Fullfilio`}>
      <article className="mx-auto max-w-2xl px-5 pt-16 pb-20 sm:pt-24">
        <Link to="/blog" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8f98] hover:text-white"><ArrowLeft className="size-3.5" /> All posts</Link>
        <div className="mt-8"><PostMeta tag={post.tag} date={post.date} minutes={post.minutes} /></div>
        <h1 className="mt-5 text-[34px] leading-[1.1] font-medium tracking-[-0.03em] sm:text-[44px]">{post.title}</h1>
        <p className="mt-5 text-[17px] leading-relaxed text-[#d0d6e0]">{post.excerpt}</p>
        <div className="mt-10 space-y-5 text-[15px] leading-[1.75] text-[#b4bcc8]">
          {post.body.map((b, i) => <BlockView key={i} b={b} />)}
        </div>
        <div className="mt-14 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/[0.08] bg-[#0f1011] p-6">
          <p className="text-[15px] font-medium">Try it with your own orders</p>
          <div className="flex gap-2">
            <Link to="/start" className="rounded-full bg-[#f7f8f8] px-4 py-2 text-[13px] font-medium text-[#08090a] hover:bg-white">Start for free</Link>
            <Link to="/contact" className="rounded-full border border-white/10 px-4 py-2 text-[13px] text-[#d0d6e0] hover:bg-white/[0.05]">Talk to us</Link>
          </div>
        </div>
      </article>
      <section className="border-t border-white/[0.06]">
        <div className="mx-auto grid max-w-2xl gap-4 px-5 py-14 sm:grid-cols-2">
          {more.map((p) => (
            <Link key={p.slug} to={`/blog/${p.slug}`} className="rounded-xl border border-white/[0.08] p-5 transition-colors hover:border-white/20">
              <p className="text-[12px] text-[#8a8f98]">{p.tag}</p>
              <p className="mt-2 text-[15px] leading-snug font-medium">{p.title}</p>
            </Link>
          ))}
        </div>
      </section>
    </SitePage>
  )
}

function BlockView({ b }: { b: Block }) {
  if ('h' in b) return <h2 className="pt-4 text-[22px] leading-snug font-medium tracking-[-0.02em] text-white">{b.h}</h2>
  if ('list' in b) return <ul className="list-disc space-y-2 pl-5 marker:text-[#62666d]">{b.list.map((t) => <li key={t}>{t}</li>)}</ul>
  if ('tip' in b) return <p className="flex gap-3 rounded-xl border border-[#2142e7]/30 bg-[#2142e7]/[0.07] p-4 text-[14px] text-[#d0d6e0]"><Lightbulb className="mt-0.5 size-4 shrink-0 text-[#7b8fff]" />{b.tip}</p>
  return <p>{b.p}</p>
}
