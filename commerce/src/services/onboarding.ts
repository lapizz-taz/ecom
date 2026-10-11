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
}

export interface SignupBusiness {
  business_name: string
  full_name: string
  phone: string
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
