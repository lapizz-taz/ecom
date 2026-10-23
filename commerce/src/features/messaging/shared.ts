// The template engine, default texts and Meta's rules, shared with the senders
// (supabase/functions/_shared/notifications): the editor previews exactly what is sent.
export { EMAIL_VARIABLES, EVENT_INFO, MESSAGE_EVENTS, type MessageEvent, SAMPLE_DATA, WHATSAPP_VARIABLES } from '../../../supabase/functions/_shared/notifications/defaults.ts'
export { htmlToText, LiquidError, liquidError, renderLiquid } from '../../../supabase/functions/_shared/notifications/liquid.ts'
export { fillWhatsapp, WHATSAPP_MAX_BODY, whatsappProblems } from '../../../supabase/functions/_shared/notifications/whatsapp-template.ts'
