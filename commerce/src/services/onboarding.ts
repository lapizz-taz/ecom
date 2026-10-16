import { authRedirect } from '@/lib/auth-links'
import { supabase } from '@/lib/supabase'

// Public sign-up: a new business opens its account and starts a plan.
// The database does every check again (sign-up open, e-mail confirmed, a
// public plan, one business per person); the page only guides.

export interface SignupPlan {
  code: string
  name: string
  description: string | null
  price: number
  currency: string
  billing_interval: string
  trial_days: number
  limits: Record<string, number>
  features: string[]
}

export interface SignupOptions {
  enabled: boolean
  default_plan: string | null
  order_fee: { fee: number; free_per_month: number } | null
  plans: SignupPlan[]
  /** How a new business is activated: paid online at once, or by the team after a WhatsApp message. */
  onboarding?: { method: 'online_payment' | 'whatsapp'; whatsapp_number: string | null }
  /** Sign-up by WhatsApp: the details are sent to the team, who open the account. */
  whatsapp_signup?: { enabled: boolean; number: string | null }
}

export interface SignupBusiness {
  business_name: string
  full_name: string
  phone: string
  /** For the Fullfilio support group on WhatsApp; empty means the same as `phone`. */
  whatsapp?: string
  business_type: string
  website: string
  sells_on: string[]
  orders_per_month: string
  plan_code: string
}

export interface SelfOnboardResult {
  merchant_id: string
  already?: boolean
  plan?: string
  status?: string
  trial_ends_at?: string | null
}

export async function signupOptions(): Promise<SignupOptions> {
  const { data, error } = await supabase.rpc('public_signup_options' as never)
  if (error) throw error
  return data as unknown as SignupOptions
}

export async function selfOnboard(business: SignupBusiness): Promise<SelfOnboardResult> {
  // The online store starts off: the owner chooses it on the dashboard, so no
  // store address exists until they do.
  const { data, error } = await supabase.rpc('merchant_self_onboard' as never, { p: { ...business, online_store: false } } as never)
  if (error) throw error
  return data as unknown as SelfOnboardResult
}

export interface SignupRequestResult { id: string; reference: string; whatsapp_number: string; message: string }

/** Sign-up by WhatsApp: keeps the details for the team (no login is created) and returns the message to send. */
export async function signupRequest(business: SignupBusiness & { email?: string }): Promise<SignupRequestResult> {
  const { data, error } = await supabase.rpc('public_signup_request' as never, { p: business } as never)
  if (error) throw error
  return data as unknown as SignupRequestResult
}

/** The WhatsApp link that opens a chat with the number and the message typed in. */
export const whatsappLink = (number: string, message: string) => `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`

// The details typed before the e-mail confirmation are kept with the account
// (and in this browser), so the business opens as soon as the link is clicked.
const DRAFT_KEY = 'fullfilio-signup'

export function saveSignupDraft(b: SignupBusiness) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(b)) } catch { /* private mode */ }
}

export function readSignupDraft(meta?: Record<string, unknown> | null): SignupBusiness | null {
  const fromMeta = meta?.signup as SignupBusiness | undefined
  if (fromMeta?.business_name) return fromMeta
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const parsed = raw ? (JSON.parse(raw) as SignupBusiness) : null
    return parsed?.business_name ? parsed : null
  } catch {
    return null
  }
}

export function clearSignupDraft() {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* private mode */ }
}

export async function signUpOwner(email: string, password: string, business: SignupBusiness) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { full_name: business.full_name, phone: business.phone, signup: business },
      emailRedirectTo: authRedirect('/start/finish'),
    },
  })
  if (error) throw error
  // Supabase answers an already-registered e-mail with a user that has no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('VALIDATION: this e-mail already has an account. Sign in to open your business')
  }
  return data
}

/**
 * After sign-up: sign in once the e-mail has been confirmed, wherever the link
 * was opened (another tab, the phone, or an address the link fell back to).
 * True when signed in; false while the address is still unconfirmed.
 */
export async function signInOnceConfirmed(email: string, password: string): Promise<boolean> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (!error) return true
  if (/not confirmed/i.test(error.message)) return false
  throw error
}

export const BUSINESS_TYPES = ['Fashion & clothing', 'Cosmetics & beauty', 'Electronics & gadgets', 'Home & living', 'Food & grocery', 'Handicrafts', 'Kids & toys', 'Health', 'Other']
export const SELLS_ON: Array<{ value: string; label: string }> = [
  { value: 'FACEBOOK', label: 'Facebook page' },
  { value: 'WEBSITE', label: 'Own website' },
  { value: 'WOOCOMMERCE', label: 'WooCommerce' },
  { value: 'SHOPIFY', label: 'Shopify' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'MARKETPLACE', label: 'Daraz / marketplace' },
]
export const ORDER_VOLUMES = ['Under 100', '100–500', '500–2,000', '2,000+']

export interface StoreSlugCheck { slug: string; available: boolean; reason: string | null; root_domain: string | null }

/** Is this store address free? (Also says the platform's root domain for the preview.) */
export async function checkStoreSlug(slug: string): Promise<StoreSlugCheck> {
  const { data, error } = await supabase.rpc('store_slug_check', { p_slug: slug })
  if (error) throw error
  return data as unknown as StoreSlugCheck
}

/** A free store address made from the business name. */
export async function suggestStoreSlug(name: string): Promise<string> {
  const { data, error } = await supabase.rpc('store_slug_suggest', { p_name: name })
  if (error) throw error
  return data as string
}

/** The website contact form. */
export interface ContactInput { name: string; email?: string; phone?: string; business?: string; topic: 'SALES' | 'SUPPORT' | 'PARTNERSHIP' | 'GENERAL'; message: string }
export async function submitContact(input: ContactInput): Promise<{ id: number }> {
  const { data, error } = await supabase.rpc('platform_contact_submit' as never, { p: { ...input, page: location.pathname } } as never)
  if (error) throw error
  return data as unknown as { id: number }
}
