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

  it('turns an HTML email into readable text', () => {
    const html = '<html><head><style>p{}</style></head><body><h1>Hi Rahim</h1><p>Total: ৳1,250<br>Thanks</p><a href="https://x.co/t">Track</a></body></html>'
    expect(htmlToText(html)).toBe('Hi Rahim\nTotal: ৳1,250\nThanks\nTrack (https://x.co/t)')
  })
})
