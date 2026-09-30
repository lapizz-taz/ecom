/**
 * Deterministic pre-LLM guards. These run BEFORE the model so that safety-critical
 * behaviour (human handoff, refunds, anger, credential sharing) never depends on the model.
 */

// Note: Bangladeshi customers often open with "Admin vai, ..." — that alone is NOT a handoff request.
const HUMAN_RE = new RegExp(
  [
    String.raw`\b(talk|speak|chat|kotha)\b[^.?!\n]{0,25}\b(human|person|someone|real|admin|owner|manager|agent|representative|staff|team|manush)\b`,
    String.raw`\b(human|real person|real human|live agent|live person|customer (care|service)|representative|manush|manusher|admin ?er|owner ?er|manager ?er)\b[^.?!\n]{0,20}\b(den|din|dao|chai|lagbe|please|plz|sathe|shathe|sate|connect|kotha)\b`,
    String.raw`\b(want|need|get|connect( me)?( to| with)?)\b( to)?( talk to)?( a| an| the| some)? ?(human|real person|agent|representative|admin|owner|manager|staff)\b`,
    String.raw`^\s*(human|agent|admin|owner|manager|representative|real person)\s*(please|plz|pls)?[\s.!?]*$`,
    String.raw`\bnot (a )?(bot|robot|ai)\b`,
    String.raw`(মানুষ|এডমিন|অ্যাডমিন|মালিক|ওনার|কাস্টমার কেয়ার)[^।?!\n]{0,15}(সাথে|সঙ্গে|চাই|দেন|লাগবে|কথা)`,
  ].join("|"),
  "i"
);

const ANGER_RE =
  /\b(fraud|froud|scam|scammer|cheat(er|ing)?|batpar|batper|bator|fake seller|worst|disgusting|pathetic|useless|bullshit|wtf|fuck\w*|shit|bastard|chor|chorer|faltu|bazey|baje service|joghonno|bokachoda|harami|shala|sala)\b|প্রতারক|প্রতারণা|ফালতু|চোর|বাটপার|জঘন্য|ভুয়া|হারামি|শালা/i;

const REFUND_RE = /\b(refund|refand|rifund|money back|taka ?ferot|ferot ?(chai|den|diben|dite)|return (my )?money)\b|টাকা ফেরত|রিফান্ড/i;

const DISCOUNT_REQUEST_RE =
  /\b((give|gimme|want|need|get)( me)?( a| some)? discount|discount (den|diben|dao|chai|koren|korben|deya|dewa|please|plz)|dam kom(ano|iye|ay)?|kom (rakh|rakhen|koren|korun|den|diben|korte)|kom e (den|diben|dewa)|last price|lowest price|best price|less (koren|korun|price)|cheaper price|special price)\b|ডিসকাউন্ট (দেন|দিবেন|চাই)|দাম কম|কম রাখ|লাস্ট প্রাইস/i;

const CANCEL_RE = /\b(cancel+|cancle|cancell?ation|batil)\b|বাতিল|ক্যানসেল|ক্যান্সেল/i;

const PAYMENT_PROBLEM_RE =
  /(payment (problem|issue|failed|fail|hoy ?ni|jay ?ni)|paid but|taka ket(e|a) (geche|nise|niyeche)|double (charge|payment)|charged twice|(bkash|bikash|nagad|rocket|card)[^.\n]{0,30}(problem|issue|hoy ?ni|fail|kete|kata)|transaction (failed|problem|issue))|পেমেন্ট (সমস্যা|হয়নি)|টাকা কেটে/i;

const NEGATIVE_RE =
  /(not happy|unhappy|disappointed|bad service|not satisfied|dissatisf|terrible|horrible|still (not|haven'?t|hasn'?t|no)|not (received|arrived|delivered)|hasn'?t (arrived|come)|haven'?t (received|got)|wrong (item|product|size|color|colour)|damaged|broken|late|ekhono (pai ?ni|ashe ?ni|asheni|paini)|pai ?ni|ashe ?ni|asheni|kharap|valo na|bhalo na|vul (product|mal|jinis)|nosto|venge|bhanga)|পাইনি|আসেনি|খারাপ|ভালো না|ভাঙা|নষ্ট|ভুল প্রোডাক্ট/i;

const AFFIRM_TOKEN_RE =
  /(^|[\s,.!])(y|yes|yeah|yep|yup|ya|ha|haa|hya|hae|ji|jii|ok|okay|okk+|sure|done|confirm(ed)?|go ahead|place (it|the order|order)|proceed|korun|koren|kore (den|din|dao)|thik ache|thik ase|correct|right)(?=$|[\s,.!👍🔥🙂❤️])|হ্যাঁ|হ্যা|জি|জ্বি|ঠিক আছে|কনফার্ম|ওকে/i;
const NEGATION_RE =
  /(^|[\s,.!])(no|not|nah|nope|na|nai|don'?t|dont|wait|hold|change|cancel+|vul|wrong|but|kintu|later|pore)(?=$|[\s,.!?])|না|ভুল|কিন্তু|পরে|বদল|\?/i;

export interface GuardSignals {
  humanRequest: boolean;
  anger: boolean;
  refund: boolean;
  discountRequest: boolean;
  cancel: boolean;
  paymentProblem: boolean;
  negative: boolean;
}

export function analyzeMessage(text: string): GuardSignals {
  const t = text.normalize("NFC");
  const letters = t.replace(/[^A-Za-z]/g, "");
  const shouting = letters.length >= 15 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8;
  return {
    humanRequest: HUMAN_RE.test(t),
    anger: ANGER_RE.test(t) || (shouting && /!{2,}/.test(t)),
    refund: REFUND_RE.test(t),
    discountRequest: DISCOUNT_REQUEST_RE.test(t),
    cancel: CANCEL_RE.test(t),
    paymentProblem: PAYMENT_PROBLEM_RE.test(t),
    negative: NEGATIVE_RE.test(t),
  };
}

/** Customer's message is an explicit "yes / confirm" (required before an order is submitted). */
export function isAffirmative(text: string): boolean {
  const t = text.trim();
  if (!t || t.split(/\s+/).length > 10) return false;
  return AFFIRM_TOKEN_RE.test(t) && !NEGATION_RE.test(t);
}

/** Rough intent tags used only for aggregate analytics ("most common questions"). */
export function intentTags(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  const add = (tag: string, re: RegExp) => re.test(t) && tags.push(tag);
  add("price", /(price|koto|dam|how much|cost|দাম|কত)/);
  add("availability", /(available|stock|ache|ase|pawa jabe|আছে|স্টক)/);
  add("delivery", /(delivery|shipping|courier|ডেলিভারি|charge)/);
  add("size_color", /(size|color|colour|cm|black|white|silver|সাইজ|কালার)/);
  add("order", /(order|buy|kinbo|nibo|korbo|অর্ডার)/);
  add("order_status", /(where is my order|order status|track|kobe pabo|ekhono|পাইনি|কবে পাবো)/);
  add("payment", /(cod|cash on delivery|bkash|nagad|payment|পেমেন্ট)/);
  add("return_exchange", /(return|exchange|change kor|ferot|bodl|রিটার্ন|এক্সচেঞ্জ)/);
  add("refund", REFUND_RE);
  add("discount", /(discount|offer|promo|coupon|kom|ডিসকাউন্ট|অফার)/);
  add("human", HUMAN_RE);
  return tags.length ? tags : ["other"];
}
