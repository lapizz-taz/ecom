import type { Lang } from "./language";

/**
 * Fixed, pre-approved replies used when the AI must NOT improvise
 * (handoffs, outages, safety warnings). Localized for English / Bangla / Banglish.
 */
const REPLIES = {
  human_request: {
    en: "Sure — I'm connecting you with our team now. Someone will reply here shortly.",
    banglish: "Sure, amader team er ekjon apnar sathe ekhane kotha bolbe. Ektu wait korun please.",
    bn: "অবশ্যই — আমাদের টিমের একজন এখানেই আপনার সাথে কথা বলবে। একটু অপেক্ষা করুন প্লিজ।",
  },
  handoff_generic: {
    en: "I'll connect you with our team so they can check this for you.",
    banglish: "Amader team ke janacchi, uni check kore apnake ekhane janabe.",
    bn: "আমাদের টিমকে জানাচ্ছি, উনারা চেক করে এখানেই আপনাকে জানাবে।",
  },
  confirm_fallback: {
    en: "Let me get that confirmed for you — a team member will reply here shortly.",
    banglish: "Eta amader team theke confirm kore janacchi — ektu wait korun.",
    bn: "এটা আমাদের টিম থেকে কনফার্ম করে জানাচ্ছি — একটু অপেক্ষা করুন।",
  },
  shopify_down: {
    en: "One moment — I'm having trouble checking that right now. I'll get our team to confirm it.",
    banglish: "Ektu wait korun — ei muhurte check korte problem hocche. Amader team confirm kore janabe.",
    bn: "এক মিনিট — এই মুহূর্তে চেক করতে সমস্যা হচ্ছে। আমাদের টিম কনফার্ম করে জানাবে।",
  },
  ai_error: {
    en: "Thanks for your message! Our team will get back to you here shortly.",
    banglish: "Message er jonno thanks! Amader team ektu pore ekhane reply dibe.",
    bn: "মেসেজের জন্য ধন্যবাদ! আমাদের টিম একটু পরেই এখানে রিপ্লাই দেবে।",
  },
  sensitive_warning: {
    en: "Please don't share OTPs, PINs, passwords or card numbers in chat — Isolation will never ask for them. I've removed it from our records.",
    banglish: "Please OTP, PIN, password ba card number chat e share korben na — Isolation kokhono egula chay na. Oi info ta amra remove kore diyechi.",
    bn: "অনুগ্রহ করে OTP, PIN, পাসওয়ার্ড বা কার্ড নম্বর চ্যাটে শেয়ার করবেন না — Isolation কখনো এগুলো চায় না। তথ্যটি আমরা মুছে দিয়েছি।",
  },
  angry: {
    en: "I'm really sorry about this. I'm bringing in our team right now so they can sort it out with you personally.",
    banglish: "Really sorry eta r jonno. Amader team ke ekhoni janacchi, uni personally apnar sathe bepar ta dekhbe.",
    bn: "এর জন্য সত্যিই দুঃখিত। আমাদের টিমকে এখনই জানাচ্ছি, উনারা নিজে আপনার বিষয়টা দেখবে।",
  },
  refund: {
    en: "I understand. Refunds are handled by our team — I've passed this on and someone will check it with you here shortly.",
    banglish: "Bujhte parchi. Refund er bepar ta amader team dekhe — ami janiye diyechi, uni ekhane apnar sathe check korbe.",
    bn: "বুঝতে পারছি। রিফান্ডের বিষয়টা আমাদের টিম দেখে — জানিয়ে দিয়েছি, উনারা এখানেই আপনার সাথে চেক করবে।",
  },
  discount: {
    en: "I can't approve special prices myself — I've asked our team and they'll reply here.",
    banglish: "Special price ami nije approve korte pari na — team ke janiye diyechi, uni ekhane reply dibe.",
    bn: "স্পেশাল প্রাইস আমি নিজে অ্যাপ্রুভ করতে পারি না — টিমকে জানিয়ে দিয়েছি, উনারা এখানে রিপ্লাই দেবে।",
  },
  cancel: {
    en: "Got it. Order changes and cancellations are handled by our team — I've passed this on and they'll confirm here shortly.",
    banglish: "Bujhchi. Order cancel/change amader team handle kore — janiye diyechi, uni ekhane confirm korbe.",
    bn: "বুঝেছি। অর্ডার বাতিল/পরিবর্তন আমাদের টিম দেখে — জানিয়ে দিয়েছি, উনারা এখানে কনফার্ম করবে।",
  },
  payment_problem: {
    en: "Sorry for the trouble. I've flagged this payment issue to our team — they'll check it and reply here. Please don't share any PIN or OTP.",
    banglish: "Jhamela r jonno sorry. Payment issue ta team ke janiye diyechi — uni check kore ekhane janabe. PIN ba OTP share korben na please.",
    bn: "ঝামেলার জন্য দুঃখিত। পেমেন্ট সমস্যাটা টিমকে জানিয়েছি — উনারা চেক করে এখানে জানাবে। PIN বা OTP শেয়ার করবেন না প্লিজ।",
  },
  dissatisfied: {
    en: "Sorry this hasn't been sorted yet. I'm handing this to our team so a person can look into it for you.",
    banglish: "Sorry, eta ekhono solve hoyni. Amader team ke dicchi, ekjon manush apnar bepar ta dekhbe.",
    bn: "দুঃখিত, এখনো সমাধান হয়নি। আমাদের টিমকে দিচ্ছি, একজন মানুষ বিষয়টা দেখবে।",
  },
  order_failed: {
    en: "Sorry — I couldn't complete the order automatically. I've passed your details to our team and they'll finish it and confirm here.",
    banglish: "Sorry — order ta automatically complete korte parini. Apnar details team ke diyechi, uni complete kore ekhane confirm korbe.",
    bn: "দুঃখিত — অর্ডারটা স্বয়ংক্রিয়ভাবে সম্পন্ন করতে পারিনি। আপনার তথ্য টিমকে দিয়েছি, উনারা সম্পন্ন করে এখানে কনফার্ম করবে।",
  },
  rate_limited: {
    en: "Got your messages! Give me a moment — our team will follow up here.",
    banglish: "Message gula peyechi! Ektu somoy din — amader team ekhane follow up korbe.",
    bn: "মেসেজগুলো পেয়েছি! একটু সময় দিন — আমাদের টিম এখানে জানাবে।",
  },
} as const;

export type ReplyKey = keyof typeof REPLIES;

export function fixedReply(key: ReplyKey, lang: Lang): string {
  return REPLIES[key][lang] ?? REPLIES[key].en;
}
