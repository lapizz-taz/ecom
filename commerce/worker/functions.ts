// Every backend function, by the name in its address (/functions/v1/<name>).
// The same handlers Supabase runs (supabase/functions/<name>/handler.ts).

import adPlatforms from '../supabase/functions/ad-platforms/handler.ts'
import adminUsers from '../supabase/functions/admin-users/handler.ts'
import api from '../supabase/functions/api/handler.ts'
import billing from '../supabase/functions/billing/handler.ts'
import channels from '../supabase/functions/channels/handler.ts'
import checkout from '../supabase/functions/checkout/handler.ts'
import clerkAuth from '../supabase/functions/clerk-auth/handler.ts'
import clerkProxy from '../supabase/functions/clerk-proxy/handler.ts'
import clerkWebhook from '../supabase/functions/clerk-webhook/handler.ts'
import courier from '../supabase/functions/courier/handler.ts'
import courierRelay from '../supabase/functions/courier-relay/handler.ts'
import courierWebhook from '../supabase/functions/courier-webhook/handler.ts'
import domains from '../supabase/functions/domains/handler.ts'
import fraudCheck from '../supabase/functions/fraud-check/handler.ts'
import metaAds from '../supabase/functions/meta-ads/handler.ts'
import notificationsDispatch from '../supabase/functions/notifications-dispatch/handler.ts'
import paymentWebhook from '../supabase/functions/payment-webhook/handler.ts'
import payments from '../supabase/functions/payments/handler.ts'
import pbx from '../supabase/functions/pbx/handler.ts'
import platformAdmin from '../supabase/functions/platform-admin/handler.ts'
import siteApi from '../supabase/functions/site-api/handler.ts'
import sms from '../supabase/functions/sms/handler.ts'
import voicedrive from '../supabase/functions/voicedrive/handler.ts'

export type Handler = (req: Request) => Promise<Response>

export const FUNCTIONS: Record<string, Handler> = {
  'ad-platforms': adPlatforms,
  'admin-users': adminUsers,
  'api': api,
  'billing': billing,
  'channels': channels,
  'checkout': checkout,
  'clerk-auth': clerkAuth,
  'clerk-proxy': clerkProxy,
  'clerk-webhook': clerkWebhook,
  'courier': courier,
  // Listed in SUPABASE_FUNCTIONS: always runs on Supabase (couriers refuse Workers).
  'courier-relay': courierRelay,
  'courier-webhook': courierWebhook,
  'domains': domains,
  'fraud-check': fraudCheck,
  'meta-ads': metaAds,
  'notifications-dispatch': notificationsDispatch,
  'payment-webhook': paymentWebhook,
  'payments': payments,
  'pbx': pbx,
  'platform-admin': platformAdmin,
  'site-api': siteApi,
  'sms': sms,
  'voicedrive': voicedrive,
}
