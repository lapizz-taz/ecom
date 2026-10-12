/**
 * HOW IT WORKS: timeline on the Services page, plus the documents checklist.
 * `time` is the estimated duration shown on each step. REPLACE / confirm all of it.
 */
export const processSteps = [
  { icon: "MousePointerClick", title: "Register Online", text: "Fill in the short form on our website. It takes about 5 minutes.", time: "5 minutes" },
  { icon: "MessageCircle", title: "Free Consultation", text: "We call you on WhatsApp to understand your goals, budget and timeline.", time: "Within 24 hours" },
  { icon: "UserCheck", title: "Profile Assessment", text: "We review your SSC/HSC results and your English test or MOI.", time: "1–2 days" },
  { icon: "School", title: "University Selection", text: "We shortlist the best-fit universities and programs for you.", time: "2–3 days" },
  { icon: "FolderUp", title: "Document Collection", text: "You send your documents and we check every single one.", time: "1–2 weeks" },
  { icon: "FolderCheck", title: "File Processing", text: "We prepare your complete, ready-to-submit application file.", time: "1 week" },
  { icon: "Send", title: "Application Submission", text: "We apply to your chosen universities and track each application.", time: "1–2 days" },
  { icon: "Mail", title: "Offer Letter", text: "You receive your admission / offer letter from the university.", time: "2–6 weeks" },
  { icon: "Landmark", title: "Tuition & Visa File", text: "We guide your tuition payment and prepare your visa/TRP file.", time: "2–4 weeks" },
  { icon: "PlaneTakeoff", title: "Visa Approval & Departure", text: "Pre-departure briefing, then you fly to Lithuania. Welcome to Europe!", time: "Varies by embassy" },
];

export const documentsNeeded = [
  "Valid passport",
  "SSC & HSC certificates and transcripts",
  "English test result or MOI letter",
  "CV",
  "Motivation letter (we help you write it)",
  "Passport-size photos",
  "Bank documents (if required)",
];

/** Set to false once you've confirmed the steps, times and documents. */
export const processPlaceholder = true;
