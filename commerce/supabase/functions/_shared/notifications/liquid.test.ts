import { describe, expect, it } from 'vitest'
import { htmlToText, liquidError, renderLiquid } from './liquid.ts'

const data = {
  shop: { name: 'Isolation', currency_symbol: '৳' },
  customer: { first_name: 'Rahim', name: 'Rahim <b>Uddin</b>' },
  order: {
    name: '#1001', total_price: 1250, note: null, created_at: '2026-10-23T05:00:00Z',
    line_items: [{ title: 'Shirt', quantity: 2, line_price: 1000 }, { title: 'Cap', quantity: 1, line_price: 250 }],
  },
}

describe('liquid', () => {
  it('fills values, escapes HTML in emails and leaves texts as they are', () => {
    expect(renderLiquid('Hi {{ customer.first_name }}, order {{ order.name }}', data)).toBe('Hi Rahim, order #1001')
    expect(renderLiquid('{{ customer.name }}', data)).toBe('Rahim &lt;b&gt;Uddin&lt;/b&gt;')
    expect(renderLiquid('{{ customer.name }}', data, { mode: 'text' })).toBe('Rahim <b>Uddin</b>')
    expect(renderLiquid('{{ missing.value }}|{{ order.nothing.deeper }}', data)).toBe('|')
  })

  it('money, default, size, date and maths filters', () => {
    expect(renderLiquid('{{ order.total_price | money }}', data)).toBe('৳1,250')
    expect(renderLiquid('{{ 1250.5 | money }}', data)).toBe('৳1,250.50')
    expect(renderLiquid('{{ order.note | default: "No note" }}', data)).toBe('No note')
    expect(renderLiquid('{{ order.line_items | size }} items, {{ order.line_items.size }}', data)).toBe('2 items, 2')
    expect(renderLiquid('{{ order.created_at | date: "%d %B %Y, %I:%M %p" }}', data)).toBe('23 October 2026, 11:00 AM')
    expect(renderLiquid('{{ order.total_price | minus: 250 | times: 2 }}', data)).toBe('2000')
    expect(renderLiquid('{{ "a\nb" | newline_to_br }}', data)).toBe('a<br>b')
  })

  it('if / elsif / else / unless, and / or, comparisons and blank', () => {
    const t = '{% if order.total_price > 2000 %}big{% elsif order.total_price >= 1250 and shop.name == "Isolation" %}mid{% else %}small{% endif %}'
    expect(renderLiquid(t, data)).toBe('mid')
    expect(renderLiquid('{% unless order.note %}none{% endunless %}', data)).toBe('none')
    expect(renderLiquid('{% if order.note == blank %}blank{% endif %}', data)).toBe('blank')
    expect(renderLiquid('{% if customer.name contains "Rahim" %}yes{% endif %}', data)).toBe('yes')
    expect(renderLiquid('{% if false or order.name %}x{% endif %}', data)).toBe('x')
  })

  it('for loops with forloop, limit, reversed and else; assign and capture', () => {
    const t = '{% for item in order.line_items %}{{ forloop.index }}.{{ item.title }}x{{ item.quantity }}{% unless forloop.last %}, {% endunless %}{% endfor %}'
    expect(renderLiquid(t, data)).toBe('1.Shirtx2, 2.Capx1')
    expect(renderLiquid('{% for i in order.line_items limit: 1 %}{{ i.title }}{% endfor %}', data)).toBe('Shirt')
    expect(renderLiquid('{% for i in order.line_items reversed %}{{ i.title }}{% endfor %}', data)).toBe('CapShirt')
    expect(renderLiquid('{% for i in order.none %}x{% else %}empty{% endfor %}', data)).toBe('empty')
    expect(renderLiquid('{% assign n = order.line_items | size %}{{ n | plus: 1 }}', data)).toBe('3')
    expect(renderLiquid('{% capture g %}<b>{{ customer.first_name }}</b>{% endcapture %}{{ g }}', data)).toBe('<b>Rahim</b>')
    expect(renderLiquid('{% for i in (1..3) %}{{ i }}{% endfor %}', data)).toBe('123')
  })

  it('comments, raw and whitespace control', () => {
    expect(renderLiquid('a{% comment %} hidden {{ x }} {% endcomment %}b', data)).toBe('ab')
    expect(renderLiquid('{% raw %}{{ order.name }}{% endraw %}', data)).toBe('{{ order.name }}')
    expect(renderLiquid('x  {{- order.name -}}  y', data)).toBe('x#1001y')
  })

  it('reports mistakes with their line and refuses runaway templates', () => {
    expect(liquidError('ok {{ order.name }}')).toBeNull()
    expect(liquidError('line one\n{% if x %}never closed')?.message).toMatch(/endif/)
    expect(liquidError('a\nb\n{{ x | nope }}')?.message).toBe('Line 3: there is no filter called "nope"')
    expect(liquidError('{% include "x" %}')?.message).toMatch(/no \{% include %\} tag/)
    expect(liquidError('{{ x ')?.message).toMatch(/not closed/)
    expect(liquidError('{% assign __proto__ = 1 %}')).not.toBeNull()
    const loop = '{% for a in (1..1000) %}{% for b in (1..1000) %}x{% endfor %}{% endfor %}'
    expect(() => renderLiquid(loop, data)).toThrow(/too much work/)
  })

  it('caps values that are kept, not only what is shown (audit run 6)', () => {
    const doubling = `{% assign x = "aaaaaaaaaa" %}${'{% assign x = x | append: x %}'.repeat(17)}{{ x | size }}`
    expect(() => renderLiquid(doubling, data)).toThrow(/too long/)
    const fromCapture = `{% capture c %}${'a'.repeat(1000)}{% endcapture %}${'{% assign c = c | append: c %}'.repeat(10)}{{ c | size }}`
    expect(() => renderLiquid(fromCapture, data)).toThrow(/too long/)
    expect(() => renderLiquid(`{% assign y = "${'b'.repeat(5000)}" %}{% assign z = y | replace: "", y %}{{ z | size }}`, data)).toThrow(/too long/)
    expect(() => renderLiquid(`{% assign s = "${'c'.repeat(1000)}" %}{{ (1..1000) | join: s | size }}`, data)).toThrow(/too long/)
    // many values, each under the limit, still stop
    const wide = `{% assign s = "${'d'.repeat(5000)}" %}{% assign s = s | append: s | append: s | append: s %}${
      Array.from({ length: 200 }, (_, i) => `{% assign v${i} = s | replace: "d", "ee" %}`).join('')}ok`
    expect(() => renderLiquid(wide, data)).toThrow(/too much work/)
    // ordinary use is unchanged
    expect(renderLiquid('{{ "a-b-c" | replace: "-", "+" }} {{ "x" | append: "y" | prepend: "w" }} {{ (1..3) | join: ", " }}', data)).toBe('a+b+c wxy 1, 2, 3')
    expect(renderLiquid('{{ "<i>a</i> < b" | strip_html }}', data, { mode: 'text' })).toBe('a < b')
  })

  it('reads long runs of spaces, tabs and unclosed tags in linear time (audit run 6)', () => {
    const n = 100_000
    const started = performance.now()
    expect(() => renderLiquid(`x${' '.repeat(n)}y{{- order.name }}`, data)).not.toThrow()
    expect(() => renderLiquid(`{{ order.name }}${' '.repeat(n)}y{%- if true %}{% endif %}`, data)).not.toThrow()
    expect(liquidError(`{% if a${'\t'.repeat(n)}b %}{% endif %}`)).not.toBeNull()
    expect(liquidError(`{{ (a${' '.repeat(n)}b) }}`)).not.toBeNull()
    expect(liquidError(`{% for x in a${'a'.repeat(n)}\nb %}{% endfor %}`)).toBeNull()
    expect(liquidError(`{% if ${Array.from({ length: 150 }, () => 'a').join(' and ')} %}{% endif %}`)?.message).toMatch(/and\/or/)
    expect(htmlToText('<'.repeat(n))).toBe('<'.repeat(n))
    expect(htmlToText('<a x '.repeat(n / 5) + '>t')).toBe('t')
    expect(htmlToText('<style '.repeat(n / 7))).toBe('<style '.repeat(n / 7).trim().replace(/<[^>]*>/g, ''))
    expect(htmlToText(`a${' \t'.repeat(n / 2)}b\n`)).toBe(`a${' \t'.repeat(n / 2)}b`)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('turns links, blocks and entities into text like before', () => {
    expect(htmlToText('<a data-href="https://wrong" href="https://right">Go</a> <A HREF="https://up">UP</A> <a href="https://same">https://same</a>'))
      .toBe('Go (https://right) UP (https://up) https://same')
    expect(htmlToText('<head><title>t</title></head><SCRIPT>x()</SCRIPT>a <unclosed and <style> never closed <a href="x">no close'))
      .toBe('a  never closed no close')
    expect(htmlToText('<p>one</p>\n\n\n\n<p>two</p>\t \n x &amp; &lt;y&gt;')).toBe('one\n\ntwo\n\n x & <y>')
  })

  it('turns an HTML email into readable text', () => {
    const html = '<html><head><style>p{}</style></head><body><h1>Hi Rahim</h1><p>Total: ৳1,250<br>Thanks</p><a href="https://x.co/t">Track</a></body></html>'
    expect(htmlToText(html)).toBe('Hi Rahim\nTotal: ৳1,250\nThanks\nTrack (https://x.co/t)')
  })
})
