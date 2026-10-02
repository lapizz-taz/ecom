import { describe, expect, it } from 'vitest'
import { stageOf } from './status'

describe('order stages', () => {
  it('keeps unapproved orders in Web Orders and maps approved ones to their stage', () => {
    expect(stageOf('CONFIRMATION_REQUIRED', null)).toBe('WEB')
    expect(stageOf('CANCELLED', null)).toBe('WEB')
    expect(stageOf('PACKING', '2026-10-01')).toBe('PENDING')
    expect(stageOf('FAILED_DELIVERY', '2026-10-01')).toBe('PENDING_RETURN')
    expect(stageOf('RETURNING', '2026-10-01')).toBe('RETURN_PENDING')
    expect(stageOf('PARTIALLY_DELIVERED', '2026-10-01')).toBe('PARTIAL')
    expect(stageOf('CANCELLED', '2026-10-01')).toBe('CANCELLED')
  })
})
