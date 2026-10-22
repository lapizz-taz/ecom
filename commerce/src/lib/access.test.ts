import { describe, expect, it } from 'vitest'
import { hasAccess, MESSAGING_SETUP } from './access'

const as = (...perms: string[]) => (p: string) => perms.includes(p)

describe('page access', () => {
  it('a page without a rule is open; a permission is checked as it is', () => {
    expect(hasAccess(as())).toBe(true)
    expect(hasAccess(as('orders.view'), 'orders.view')).toBe(true)
    expect(hasAccess(as('orders.view'), 'orders.create')).toBe(false)
  })

  it('messaging setup: managers and order staff, not chat-only Moderators', () => {
    expect(hasAccess(as('inbox.view', 'inbox.reply', 'inbox.manage'), MESSAGING_SETUP)).toBe(true) // Admin
    expect(hasAccess(as('inbox.view', 'inbox.reply', 'orders.view', 'orders.update'), MESSAGING_SETUP)).toBe(true) // Call
    expect(hasAccess(as('inbox.view', 'inbox.reply', 'orders.create'), MESSAGING_SETUP)).toBe(false) // Moderator
    expect(hasAccess(as('orders.view'), MESSAGING_SETUP)).toBe(false) // no messaging at all
  })
})
