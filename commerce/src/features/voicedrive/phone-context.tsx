import { useQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import { pbx, pbxCallState, type CallRequest } from '@/services/voicedrive'
import { shouldResume, softphone, type PhoneState, type Softphone } from './softphone'

export interface DialTarget {
  phone: string
  orderId?: string
  /** Which order list the call is from (recorded on the call). */
  kind?: 'APPROVED_ORDER' | 'WEB_ORDER'
  /** Calling back a missed call. */
  callbackOf?: string
}

interface PhoneApi {
  engine: Softphone | null
  state: PhoneState | null
  /** True when this staff member has an extension on an active line. */
  canCall: boolean
  dial: (t: DialTarget) => Promise<CallRequest>
}

const PhoneContext = createContext<PhoneApi | null>(null)
const OFF: PhoneState = { status: 'off', availability: 'AVAILABLE', extension: null, error: null, call: null, credentialExpiresAt: null }
const noop = () => () => undefined

function waitReady(engine: Softphone, ms = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (engine.getState().status === 'ready') return resolve()
    const timer = setTimeout(() => { off(); reject(new Error(engine.getState().error ?? 'The phone did not connect — check My Setup')) }, ms)
    const off = engine.subscribe(() => {
      const s = engine.getState()
      if (s.status === 'ready') { clearTimeout(timer); off(); resolve() }
      if (s.status === 'error') { clearTimeout(timer); off(); reject(new Error(s.error ?? 'The phone could not start')) }
    })
  })
}

export function PhoneProvider({ children }: { children: ReactNode }) {
  const { access, can } = useAuth()
  const enabled = Boolean(access && can('pbx.call'))
  const engine = useMemo(() => (enabled ? softphone() : null), [enabled])
  const state = useSyncExternalStore(engine?.subscribe ?? noop, engine?.getState ?? (() => OFF))
  const availability = useQuery({
    queryKey: ['vd-availability'],
    queryFn: pbxCallState.getOrderCallStateAvailability,
    enabled,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!engine) return
    void shouldResume().then((on) => { if (on) void engine.start() })
  }, [engine])

  const dial = useCallback(async (t: DialTarget) => {
    if (!engine) throw new Error('You do not have phone access')
    if (engine.getState().status !== 'ready') {
      void engine.start()
      await waitReady(engine)
    }
    const req = t.orderId
      ? await (t.kind === 'APPROVED_ORDER' ? pbx.startApprovedOrderCall(t.orderId) : pbx.startWebOrderCall(t.orderId))
      : t.callbackOf ? await pbx.startCallback(t.callbackOf, t.phone) : await pbx.startManualPbxCall(t.phone)
    try {
      await engine.dial(req, t.orderId ?? null)
    } catch (error) {
      await pbx.cancelWebOrderCall(req.id).catch(() => undefined)
      throw error
    }
    return req
  }, [engine])

  const value = useMemo<PhoneApi>(() => ({ engine, state: engine ? state : null, canCall: Boolean(availability.data?.canCall), dial }),
    [engine, state, availability.data?.canCall, dial])
  return <PhoneContext.Provider value={value}>{children}</PhoneContext.Provider>
}

export function usePhone(): PhoneApi {
  return useContext(PhoneContext) ?? { engine: null, state: null, canCall: false, dial: () => Promise.reject(new Error('Phone not available')) }
}
