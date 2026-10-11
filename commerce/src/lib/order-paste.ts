// Reads an order typed or pasted from Messenger, WhatsApp or a note into its
// fields: name, phone, address, district and area. Works on labelled text
// ("Name: …, Phone: …") and on plain lines ("Rahim\n017…\nMirpur 10, Dhaka"),
// in English or Bangla, with Bangla digits. Runs in the browser: nothing is
// sent anywhere, and staff check the filled form before creating the order.

export interface PastedOrder {
  name?: string
  phone?: string
  altPhone?: string
  email?: string
  address?: string
  district?: string
  area?: string
  note?: string
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'
const toAsciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))

/** The 64 districts as used for delivery, with Bangla names and common spellings. */
const DISTRICT_NAMES: Record<string, string[]> = {
  Bagerhat: ['বাগেরহাট'], Bandarban: ['বান্দরবান'], Barguna: ['বরগুনা'], Barishal: ['বরিশাল', 'barisal'], Bhola: ['ভোলা'],
  Bogura: ['বগুড়া', 'bogra'], Brahmanbaria: ['ব্রাহ্মণবাড়িয়া', 'bbaria'], Chandpur: ['চাঁদপুর'],
  Chapainawabganj: ['চাঁপাইনবাবগঞ্জ', 'chapai nawabganj', 'chapainababganj'], Chattogram: ['চট্টগ্রাম', 'chittagong', 'ctg'],
  Chuadanga: ['চুয়াডাঙ্গা'], "Cox's Bazar": ['কক্সবাজার', 'coxs bazar', 'cox bazar', 'coxsbazar'], Cumilla: ['কুমিল্লা', 'comilla'],
  Dhaka: ['ঢাকা', 'dacca'], Dinajpur: ['দিনাজপুর'], Faridpur: ['ফরিদপুর'], Feni: ['ফেনী'], Gaibandha: ['গাইবান্ধা'],
  Gazipur: ['গাজীপুর'], Gopalganj: ['গোপালগঞ্জ'], Habiganj: ['হবিগঞ্জ'], Jamalpur: ['জামালপুর'], Jashore: ['যশোর', 'jessore'],
  Jhalokathi: ['ঝালকাঠি', 'jhalakati', 'jhalokati'], Jhenaidah: ['ঝিনাইদহ'], Joypurhat: ['জয়পুরহাট', 'jaipurhat'],
  Khagrachhari: ['খাগড়াছড়ি', 'khagrachari'], Khulna: ['খুলনা'], Kishoreganj: ['কিশোরগঞ্জ', 'kishorganj'], Kurigram: ['কুড়িগ্রাম'],
  Kushtia: ['কুষ্টিয়া'], Lakshmipur: ['লক্ষ্মীপুর', 'laxmipur', 'lakshmipur'], Lalmonirhat: ['লালমনিরহাট'], Madaripur: ['মাদারীপুর'],
  Magura: ['মাগুরা'], Manikganj: ['মানিকগঞ্জ'], Meherpur: ['মেহেরপুর'], Moulvibazar: ['মৌলভীবাজার', 'maulvibazar'],
  Munshiganj: ['মুন্সিগঞ্জ', 'munshigonj'], Mymensingh: ['ময়মনসিংহ', 'mymenshingh'], Naogaon: ['নওগাঁ'], Narail: ['নড়াইল'],
  Narayanganj: ['নারায়ণগঞ্জ', 'narayangonj', 'narayangang'], Narsingdi: ['নরসিংদী', 'narshingdi'], Natore: ['নাটোর'],
  Netrokona: ['নেত্রকোনা', 'netrakona'], Nilphamari: ['নীলফামারী'], Noakhali: ['নোয়াখালী'], Pabna: ['পাবনা'], Panchagarh: ['পঞ্চগড়'],
  Patuakhali: ['পটুয়াখালী'], Pirojpur: ['পিরোজপুর'], Rajbari: ['রাজবাড়ী'], Rajshahi: ['রাজশাহী'], Rangamati: ['রাঙ্গামাটি', 'রাঙামাটি'],
  Rangpur: ['রংপুর'], Satkhira: ['সাতক্ষীরা'], Shariatpur: ['শরীয়তপুর'], Sherpur: ['শেরপুর'], Sirajganj: ['সিরাজগঞ্জ'],
  Sunamganj: ['সুনামগঞ্জ'], Sylhet: ['সিলেট'], Tangail: ['টাঙ্গাইল'], Thakurgaon: ['ঠাকুরগাঁও'],
}

/** Well-known areas that name their district when the district is not written. */
const AREAS: Record<string, string[]> = {
  Dhaka: ['mirpur', 'dhanmondi', 'uttara', 'gulshan', 'banani', 'mohammadpur', 'badda', 'rampura', 'motijheel', 'jatrabari', 'tejgaon',
    'khilgaon', 'bashundhara', 'farmgate', 'lalbagh', 'shyamoli', 'keraniganj', 'savar', 'demra', 'wari', 'malibagh', 'mogbazar',
    'moghbazar', 'baridhara', 'khilkhet', 'pallabi', 'kafrul', 'shahbag', 'azimpur', 'hazaribagh', 'kamrangirchar', 'dhamrai',
    'mohakhali', 'agargaon', 'shewrapara', 'kazipara', 'basabo', 'shantinagar', 'paltan', 'kalabagan', 'adabor', 'banasree',
    'aftabnagar', 'jigatola', 'nikunja', 'dakshinkhan', 'uttarkhan', 'mugda', 'gendaria', 'shyampur', 'kadamtali', 'darus salam',
    'মিরপুর', 'ধানমন্ডি', 'উত্তরা', 'গুলশান', 'বনানী', 'মোহাম্মদপুর', 'বাড্ডা', 'রামপুরা', 'মতিঝিল', 'যাত্রাবাড়ী', 'সাভার', 'কেরানীগঞ্জ'],
  Chattogram: ['agrabad', 'halishahar', 'pahartali', 'panchlaish', 'chawkbazar', 'bahaddarhat', 'nasirabad', 'patenga', 'hathazari', 'আগ্রাবাদ', 'হালিশহর'],
  Gazipur: ['tongi', 'board bazar', 'joydebpur', 'kaliakair', 'kapasia', 'sreepur', 'টঙ্গী'],
  Narayanganj: ['fatullah', 'siddhirganj', 'rupganj', 'sonargaon', 'ফতুল্লা'],
  Sylhet: ['zindabazar', 'amberkhana', 'subidbazar'],
}

const LABELS: Record<keyof PastedOrder | 'skip', string[]> = {
  name: ['customer name', 'full name', 'name', 'nam', 'নাম', 'গ্রাহকের নাম'],
  phone: ['phone number', 'mobile number', 'contact number', 'phone', 'mobile', 'mob', 'cell', 'contact', 'number', 'মোবাইল নম্বর', 'মোবাইল', 'ফোন', 'নাম্বার', 'নম্বর'],
  altPhone: ['alternative number', 'alt number', 'alt phone', 'other number', 'বিকল্প নম্বর'],
  email: ['e-mail', 'email', 'ইমেইল'],
  address: ['delivery address', 'shipping address', 'full address', 'address', 'addr', 'location', 'ঠিকানা', 'পূর্ণ ঠিকানা'],
  district: ['district', 'zilla', 'zila', 'jela', 'জেলা'],
  area: ['police station', 'upazila', 'upozila', 'thana', 'area', 'থানা', 'উপজেলা', 'এলাকা'],
  note: ['instruction', 'comment', 'notes', 'note', 'নোট'],
  skip: ['product name', 'product', 'item', 'quantity', 'qty', 'size', 'color', 'colour', 'price', 'total', 'পণ্য', 'পরিমাণ', 'সাইজ', 'দাম'],
}

const ADDRESS_WORDS = /\b(house|home|road|rd|lane|block|sector|flat|floor|village|vill|holding|para|bazar|bazaar|market|union|post|po|ps|near|beside|opposite|thana|upazila|sadar|city|town|moholla|mohalla)\b|বাসা|বাড়ি|রোড|গ্রাম|পোস্ট|বাজার|থানা|উপজেলা|সদর|পাড়া|মহল্লা/i
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fold = (s: string) => s.toLowerCase().replace(/[’'`.]/g, '').replace(/gonj/g, 'ganj').replace(/\s+/g, ' ').trim()
const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s,;:|\-–]+|[\s,;:|\-–]+$/g, '').trim()
const title = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

/** Bangladeshi mobile numbers in the text, as 01XXXXXXXXX. */
export function findPhones(text: string): string[] {
  const found: string[] = []
  for (const m of toAsciiDigits(text).matchAll(/\+?\d[\d\s\-().]{8,18}\d/g)) {
    let d = m[0].replace(/\D/g, '')
    if (d.startsWith('0088')) d = d.slice(4)
    else if (d.startsWith('88') && d.length === 13) d = d.slice(2)
    if (d.length === 10 && d.startsWith('1')) d = `0${d}`
    if (/^01[3-9]\d{8}$/.test(d) && !found.includes(d)) found.push(d)
  }
  return found
}

/** The district a piece of text names, from the store's district list. */
function findDistrict(text: string, districts: readonly string[]): string | undefined {
  const t = ` ${fold(text)} `
  let best: { name: string; at: number } | undefined
  for (const name of districts) {
    for (const alias of [name, ...(DISTRICT_NAMES[name] ?? [])]) {
      const a = fold(alias)
      const isBangla = /[ঀ-৿]/.test(a)
      const re = isBangla ? new RegExp(escape(a), 'g') : new RegExp(`(?<![a-z])${escape(a)}(?![a-z])`, 'g')
      for (const m of t.matchAll(re)) if (!best || m.index! >= best.at) best = { name, at: m.index! } // the last one wins: addresses end with the district
    }
  }
  return best?.name
}

function findArea(text: string): { area: string; district: string } | undefined {
  const t = toAsciiDigits(text)
  for (const [district, areas] of Object.entries(AREAS)) {
    for (const a of areas) {
      const isBangla = /[ঀ-৿]/.test(a)
      const re = new RegExp(isBangla ? `${escape(a)}(?:\\s*[-–]?\\s*(\\d{1,2}))?` : `(?<![a-z])${escape(a)}(?![a-z])(?:\\s*[-–]?\\s*(?:sector\\s*)?(\\d{1,2})(?!\\d))?`, 'i')
      const m = re.exec(t)
      if (m) return { district, area: `${isBangla ? a : title(a)}${m[1] ? ` ${m[1]}` : ''}` }
    }
  }
  return undefined
}

/** Labelled values ("Name: …") and what is left over. */
function readLabels(text: string) {
  const all = Object.entries(LABELS).flatMap(([key, words]) => words.map((w) => ({ key, w })))
    .sort((a, b) => b.w.length - a.w.length)
  const alt = all.map((x) => escape(x.w)).join('|')
  const re = new RegExp(`(^|\\n|[,;|•])\\s*(?:\\d{1,2}[.)]\\s*|[-*]\\s*)?(${alt})\\s*(?:[:：=]|[-–]{1,2}|=>)\\s*`, 'gi')
  const hits: Array<{ key: string; start: number; valueStart: number }> = []
  for (const m of text.matchAll(re)) {
    const w = m[2].toLowerCase()
    hits.push({ key: all.find((x) => x.w.toLowerCase() === w)!.key, start: m.index! + m[1].length, valueStart: m.index! + m[0].length })
  }
  const values: Partial<Record<string, string>> = {}
  const taken: Array<[number, number]> = []
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length
    // A value runs to the end of its line, except an address, which may wrap.
    const raw = h.key === 'address' ? text.slice(h.valueStart, end) : text.slice(h.valueStart, end).split('\n')[0]
    const value = tidy(raw.replace(/\n+/g, ', '))
    if (value && !values[h.key]) values[h.key] = value
    taken.push([h.start, h.valueStart + raw.length])
  })
  let rest = text
  for (const [a, b] of [...taken].reverse()) rest = `${rest.slice(0, a)}\n${rest.slice(b)}`
  return { values, rest }
}

export function parseOrderText(input: string, districts: readonly string[] = Object.keys(DISTRICT_NAMES)): PastedOrder {
  const text = toAsciiDigits(input).replace(/\r/g, '').replace(/ /g, ' ')
  if (!text.trim()) return {}
  const { values, rest } = readLabels(text)
  const out: PastedOrder = {}

  const phones = [...findPhones(values.phone ?? ''), ...findPhones(text)].filter((p, i, a) => a.indexOf(p) === i)
  const alt = findPhones(values.altPhone ?? '')[0]
  if (phones[0]) out.phone = phones[0]
  if (alt && alt !== out.phone) out.altPhone = alt
  else if (phones[1]) out.altPhone = phones[1]
  const email = (values.email ?? text).match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]
  if (email) out.email = email

  // Unlabelled lines, without the phone numbers and e-mail.
  let free = rest
  for (const m of [...rest.matchAll(/\+?\d[\d\s\-().]{8,18}\d/g)]) if (findPhones(m[0]).length) free = free.replace(m[0], ' ')
  if (email) free = free.replace(email, ' ')
  let pieces = free.split('\n').map(tidy).filter((p) => p && !/^(?:hi|hello|assalamu|salam|thanks?|thank you|ধন্যবাদ)\b/i.test(p))
  // One long line ("Rahim, Mirpur 10, Dhaka"): its first part may be the name.
  if (pieces.length === 1 && pieces[0].includes(',') && !values.name) {
    const parts = pieces[0].split(',').map(tidy).filter(Boolean)
    pieces = [parts[0], parts.slice(1).join(', ')]
  }

  const looksLikeName = (p: string) => !/\d/.test(p) && p.length >= 2 && p.length <= 40 && p.split(/\s+/).length <= 5
    && !ADDRESS_WORDS.test(p) && !findDistrict(p, districts) && !findArea(p)
  if (values.name) out.name = values.name
  else {
    const i = pieces.findIndex(looksLikeName)
    if (i >= 0) { out.name = pieces[i]; pieces.splice(i, 1) }
  }
  if (out.name && /^[a-z\s.]+$/.test(out.name)) out.name = title(out.name)

  const addressText = values.address ?? pieces.join(', ')
  if (addressText) out.address = tidy(addressText.replace(/\n+/g, ', ').replace(/,\s*,/g, ','))

  const labelledDistrict = values.district ? findDistrict(values.district, districts) : undefined
  const area = values.area ? { area: tidy(values.area), district: '' } : findArea(`${out.address ?? ''} ${values.area ?? ''}`)
  out.district = labelledDistrict ?? findDistrict(out.address ?? '', districts) ?? (area?.district && districts.includes(area.district) ? area.district : undefined)
  if (area?.area) out.area = area.area
  else if (out.address && out.district) {
    // "…, Mirpur 10, Dhaka": the part just before the district is the area.
    const parts = out.address.split(',').map(tidy)
    const at = parts.findIndex((p) => findDistrict(p, [out.district!]) === out.district)
    const before = at > 0 ? parts[at - 1] : undefined
    if (before && before.length <= 30 && !ADDRESS_WORDS.test(before) && !/^\d+$/.test(before)) out.area = before
  }

  const note = [values.note, out.altPhone ? `Alt phone ${out.altPhone}` : ''].filter(Boolean).join(' · ')
  if (note) out.note = note
  return out
}
