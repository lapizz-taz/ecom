// The template engine, default texts and Meta's rules, shared with the senders
// (supabase/functions/_shared/notifications): the editor previews exactly what is sent.
export {
  EMAIL_VARIABLES, EVENT_INFO, MESSAGE_EVENTS, type MessageEvent, SAMPLE_DATA, UNSUBSCRIBE_EVENTS, WHATSAPP_BUTTONS, WHATSAPP_CONFIRM_TEXT,
  WHATSAPP_DEFAULTS, WHATSAPP_DEFAULTS_BN, WHATSAPP_VARIABLES, withUnsubscribeFooter,
} from '../../../supabase/functions/_shared/notifications/defaults.ts'
export { htmlToText, LiquidError, liquidError, renderLiquid } from '../../../supabase/functions/_shared/notifications/liquid.ts'
export { fillWhatsapp, WHATSAPP_MAX_BODY, whatsappProblems } from '../../../supabase/functions/_shared/notifications/whatsapp-template.ts'

/** The variables a message for this event can use (the rest have nothing to fill them with). */
export const variablesFor = <T extends { events?: readonly string[] }>(variables: T[], event: string) =>
  variables.filter((v) => !v.events || v.events.includes(event))
