type Can = (permission: string) => boolean

/** What a page needs: one permission, or a rule over several. */
export type Access = string | ((can: Can) => boolean)

export const hasAccess = (can: Can, access?: Access) => !access || (typeof access === 'string' ? can(access) : access(can))

/**
 * Messaging setup (auto replies and the connected pages; read-only without inbox.manage) is for
 * managers and for staff who also work with orders, not for chat-only Moderators.
 */
export const MESSAGING_SETUP: Access = (can) => can('inbox.manage') || (can('inbox.view') && can('orders.view'))
