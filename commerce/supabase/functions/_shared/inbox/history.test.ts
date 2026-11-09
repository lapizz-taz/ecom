import { describe, expect, it } from 'vitest'
import { historyFields, parseHistory } from './history.ts'

// The shape of GET /{page-id}/conversations?fields=participants,updated_time,messages{…} (names made up).
const PAGE = '1065428719977183'
const messenger = {
  data: [
    {
      updated_time: '2026-11-09T10:05:00+0000',
      participants: { data: [{ id: '9001', name: 'Shahil Farhan' }, { id: PAGE, name: 'Isolation.pvt' }] },
      messages: { data: [
        { id: 'm_3', created_time: '2026-11-09T10:05:00+0000', from: { id: PAGE }, message: 'Yes, we deliver to Sylhet' },
        { id: 'm_2', created_time: '2026-11-09T10:01:00+0000', from: { id: '9001' }, message: '', attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://cdn/x.jpg' } }] } },
        { id: 'm_1', created_time: '2026-11-09T10:00:00+0000', from: { id: '9001' }, message: 'Do you deliver to Sylhet?' },
        { id: 'm_0', created_time: '2026-11-09T09:59:00+0000', from: { id: '9001' }, message: '' },
      ] },
    },
    {
      updated_time: '2026-08-01T10:00:00+0000',
      participants: { data: [{ id: '9002', name: 'Old Customer' }, { id: PAGE }] },
      messages: { data: [{ id: 'm_9', created_time: '2026-08-01T10:00:00+0000', from: { id: '9002' }, message: 'Price?' }] },
    },
  ],
  paging: { cursors: { after: 'CURSOR2' }, next: 'https://graph/next' },
}

describe('old chats from Meta', () => {
  it('asks for the participants and each chat\'s latest messages with their files', () => {
    expect(historyFields()).toContain('participants')
    expect(historyFields()).toContain('messages.limit(25)')
    expect(historyFields()).toContain('attachments{')
  })

  it('turns a page of conversations into chats, oldest message first, with who sent what', () => {
    const r = parseHistory(messenger, [PAGE], null)
    expect(r.chats).toHaveLength(2)
    const first = r.chats[0]
    expect(first.thread_key).toBe('9001')
    expect(first.customer).toEqual({ external_id: '9001', name: 'Shahil Farhan' })
    // Empty messages (nothing to show) are skipped; the rest oldest first.
    expect(first.messages.map((m) => [m.external_id, m.direction])).toEqual([['m_1', 'IN'], ['m_2', 'IN'], ['m_3', 'OUT']])
    expect(first.messages[0]).toMatchObject({ body: 'Do you deliver to Sylhet?', created_at: '2026-11-09T10:00:00.000Z' })
    expect(first.messages[1].attachments).toEqual([{ type: 'image', url: 'https://cdn/x.jpg', mime: 'image/jpeg' }])
    expect(r.after).toBe('CURSOR2')
    expect(r.done).toBe(false)
  })

  it('stops at chats last active before the chosen period', () => {
    const r = parseHistory(messenger, [PAGE], '2026-10-01T00:00:00.000Z')
    expect(r.chats.map((c) => c.thread_key)).toEqual(['9001'])
    expect(r.done).toBe(true)
    expect(r.after).toBeNull()
  })

  it('Instagram: the account and its Page are both the store; the username names the customer', () => {
    const ig = { data: [{
      updated_time: '2026-11-09T10:00:00+0000',
      participants: { data: [{ id: '178400', username: 'isolation.pvt' }, { id: '5550', username: 'nuraz' }] },
      messages: { data: [
        { id: 'aWdf2', created_time: '2026-11-09T10:00:00+0000', from: { id: '178400', username: 'isolation.pvt' }, message: 'Hi!' },
        { id: 'aWdf1', created_time: '2026-11-09T09:59:00+0000', from: { id: '5550', username: 'nuraz' }, message: 'Price koto?' },
      ] },
    }] }
    const r = parseHistory(ig, ['178400', PAGE], null)
    expect(r.chats[0].customer).toEqual({ external_id: '5550', name: 'nuraz' })
    expect(r.chats[0].messages.map((m) => m.direction)).toEqual(['IN', 'OUT'])
    expect(r.done).toBe(true)
  })

  it('an empty answer or garbage is nothing to import, not an error', () => {
    expect(parseHistory({}, [PAGE], null)).toEqual({ chats: [], after: null, done: true })
    expect(parseHistory('<html>', [PAGE], null).chats).toEqual([])
  })
})
