import { beforeEach, describe, expect, it, vi } from 'vitest'

const custom = vi.fn((..._args: unknown[]) => 'toast-id')
vi.mock('sonner', () => ({ toast: { custom: (...args: unknown[]) => custom(...args), dismiss: vi.fn() } }))

const { toast } = await import('./toast')
const optionsOf = (call: number) => custom.mock.calls[call]?.[1] as { id?: string; duration?: number }

describe('popups', () => {
  beforeEach(() => custom.mockClear())

  it('shows the same error once: a page and the app-wide handler reporting one failure share an id', () => {
    toast.error('Meta: Unsupported post request.')
    toast.error(new Error('Meta: Unsupported post request.'))
    expect(optionsOf(0).id).toBe('error:Meta: Unsupported post request.')
    expect(optionsOf(1).id).toBe(optionsOf(0).id)
  })

  it('keeps different errors apart, and an explicit id wins', () => {
    toast.error('One thing failed')
    toast.error('Another thing failed')
    toast.error('Same words', { id: 'comment-action:1' })
    expect(optionsOf(0).id).not.toBe(optionsOf(1).id)
    expect(optionsOf(2).id).toBe('comment-action:1')
  })

  it('a loading popup stays until the same id shows the outcome', () => {
    toast.loading('Deleting…', { id: 'comment-action:1' })
    toast.success('Deleted', { id: 'comment-action:1' })
    expect(optionsOf(0)).toMatchObject({ id: 'comment-action:1', duration: Infinity })
    expect(optionsOf(1)).toMatchObject({ id: 'comment-action:1', duration: 4000 })
  })

  it('other popups keep no fixed id, so each one shows', () => {
    toast.success('Saved')
    expect(optionsOf(0).id).toBeUndefined()
  })
})
