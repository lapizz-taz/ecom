-- =============================================================================
-- Reading the district from a store order's address, better.
--
-- Real orders from a live Shopify store failed to import because the
-- district could not be read: the address was in Bangla ("ঢাকা",
-- "চট্টগ্রাম"), used another spelling ("Kishorganj", "Cox’sBazar") or named
-- a well-known area or upazila instead ("Cantonment", "Bashundhara",
-- "Hathazari", "আশুগঞ্জ", "মাটিডালী"). Now:
--   * Bangla names of all 64 districts (and common alternative spellings);
--   * more English spellings; typographic apostrophes and missing spaces;
--   * well-known areas / upazilas mapped to their district.
-- An address that still cannot be read is not guessed: the order waits under
-- Need fixing, as before.
-- =============================================================================

create or replace function public._bd_district(p_hints text[])
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hint text;
  v_text text;
  v_flat text;
  v_name text;
  v_key text;
  v_bn jsonb := '{"ঢাকা": "Dhaka", "ফরিদপুর": "Faridpur", "গাজীপুর": "Gazipur", "গাজিপুর": "Gazipur", "গোপালগঞ্জ": "Gopalganj", "কিশোরগঞ্জ": "Kishoreganj", "মাদারীপুর": "Madaripur", "মাদারিপুর": "Madaripur", "মানিকগঞ্জ": "Manikganj", "মুন্সীগঞ্জ": "Munshiganj", "মুন্সিগঞ্জ": "Munshiganj", "নারায়ণগঞ্জ": "Narayanganj", "নারায়নগঞ্জ": "Narayanganj", "নরসিংদী": "Narsingdi", "নরসিংদি": "Narsingdi", "রাজবাড়ী": "Rajbari", "রাজবাড়ি": "Rajbari", "শরীয়তপুর": "Shariatpur", "শরিয়তপুর": "Shariatpur", "টাঙ্গাইল": "Tangail", "টাংগাইল": "Tangail", "বান্দরবান": "Bandarban", "ব্রাহ্মণবাড়িয়া": "Brahmanbaria", "ব্রাহ্মণবাড়ীয়া": "Brahmanbaria", "ব্রাক্ষণবাড়িয়া": "Brahmanbaria", "চাঁদপুর": "Chandpur", "চট্টগ্রাম": "Chattogram", "চিটাগাং": "Chattogram", "কুমিল্লা": "Cumilla", "কক্সবাজার": "Cox''s Bazar", "ফেনী": "Feni", "খাগড়াছড়ি": "Khagrachhari", "লক্ষ্মীপুর": "Lakshmipur", "লক্ষীপুর": "Lakshmipur", "নোয়াখালী": "Noakhali", "নোয়াখালি": "Noakhali", "রাঙ্গামাটি": "Rangamati", "রাঙামাটি": "Rangamati", "বগুড়া": "Bogura", "জয়পুরহাট": "Joypurhat", "নওগাঁ": "Naogaon", "নাটোর": "Natore", "চাঁপাইনবাবগঞ্জ": "Chapainawabganj", "চাপাইনবাবগঞ্জ": "Chapainawabganj", "পাবনা": "Pabna", "রাজশাহী": "Rajshahi", "সিরাজগঞ্জ": "Sirajganj", "বাগেরহাট": "Bagerhat", "চুয়াডাঙ্গা": "Chuadanga", "যশোর": "Jashore", "ঝিনাইদহ": "Jhenaidah", "খুলনা": "Khulna", "কুষ্টিয়া": "Kushtia", "মাগুরা": "Magura", "মেহেরপুর": "Meherpur", "নড়াইল": "Narail", "সাতক্ষীরা": "Satkhira", "বরগুনা": "Barguna", "বরিশাল": "Barishal", "ভোলা": "Bhola", "ঝালকাঠি": "Jhalokathi", "পটুয়াখালী": "Patuakhali", "পটুয়াখালি": "Patuakhali", "পিরোজপুর": "Pirojpur", "হবিগঞ্জ": "Habiganj", "মৌলভীবাজার": "Moulvibazar", "সুনামগঞ্জ": "Sunamganj", "সিলেট": "Sylhet", "দিনাজপুর": "Dinajpur", "গাইবান্ধা": "Gaibandha", "কুড়িগ্রাম": "Kurigram", "লালমনিরহাট": "Lalmonirhat", "নীলফামারী": "Nilphamari", "নীলফামারি": "Nilphamari", "পঞ্চগড়": "Panchagarh", "রংপুর": "Rangpur", "ঠাকুরগাঁও": "Thakurgaon", "জামালপুর": "Jamalpur", "ময়মনসিংহ": "Mymensingh", "নেত্রকোনা": "Netrokona", "নেত্রকোণা": "Netrokona", "শেরপুর": "Sherpur", "মিরপুর": "Dhaka", "উত্তরা": "Dhaka", "ধানমন্ডি": "Dhaka", "গুলশান": "Dhaka", "বাড্ডা": "Dhaka", "যাত্রাবাড়ী": "Dhaka", "যাত্রাবাড়ি": "Dhaka", "মোহাম্মদপুর": "Dhaka", "সাভার": "Dhaka", "আশুলিয়া": "Dhaka", "কেরানীগঞ্জ": "Dhaka", "কেরানিগঞ্জ": "Dhaka", "বসুন্ধরা": "Dhaka", "ক্যান্টনমেন্ট": "Dhaka", "খিলক্ষেত": "Dhaka", "রামপুরা": "Dhaka", "বনশ্রী": "Dhaka", "মতিঝিল": "Dhaka", "তেজগাঁও": "Dhaka", "মহাখালী": "Dhaka", "লালবাগ": "Dhaka", "ডেমরা": "Dhaka", "টঙ্গী": "Gazipur", "টঙ্গি": "Gazipur", "ফতুল্লা": "Narayanganj", "সিদ্ধিরগঞ্জ": "Narayanganj", "হাটহাজারী": "Chattogram", "হাটহাজারি": "Chattogram", "পটিয়া": "Chattogram", "সীতাকুণ্ড": "Chattogram", "আগ্রাবাদ": "Chattogram", "আশুগঞ্জ": "Brahmanbaria", "মাটিডালী": "Bogura", "মাটিডালি": "Bogura", "বেনাপোল": "Jashore"}'::jsonb;
  v_aliases jsonb := '{"chittagong": "Chattogram", "ctg": "Chattogram", "comilla": "Cumilla", "barisal": "Barishal", "bogra": "Bogura", "jessore": "Jashore", "jhalakati": "Jhalokathi", "jhalokati": "Jhalokathi", "khagrachari": "Khagrachhari", "netrakona": "Netrokona", "maulvibazar": "Moulvibazar", "chapai nawabganj": "Chapainawabganj", "nawabganj": "Chapainawabganj", "coxs bazar": "Cox''s Bazar", "cox bazar": "Cox''s Bazar", "b baria": "Brahmanbaria", "laxmipur": "Lakshmipur", "narsinghdi": "Narsingdi", "jaipurhat": "Joypurhat", "munshigonj": "Munshiganj", "narayangonj": "Narayanganj", "kishorgonj": "Kishoreganj", "gopalgonj": "Gopalganj", "manikgonj": "Manikganj", "sirajgonj": "Sirajganj", "habigonj": "Habiganj", "sunamgonj": "Sunamganj", "dacca": "Dhaka", "savar": "Dhaka", "mirpur": "Dhaka", "uttara": "Dhaka", "dhanmondi": "Dhaka", "gulshan": "Dhaka", "mohammadpur": "Dhaka", "tongi": "Gazipur", "kishorganj": "Kishoreganj", "kishoregonj": "Kishoreganj", "chittagang": "Chattogram", "chattagram": "Chattogram", "chottogram": "Chattogram", "chapainababganj": "Chapainawabganj", "chapai": "Chapainawabganj", "jhinaidah": "Jhenaidah", "jhenaidaha": "Jhenaidah", "jhenaida": "Jhenaidah", "jhenidah": "Jhenaidah", "kustia": "Kushtia", "kusthia": "Kushtia", "gaibanda": "Gaibandha", "thakurgao": "Thakurgaon", "panchagar": "Panchagarh", "jaypurhat": "Joypurhat", "nowgaon": "Naogaon", "noagaon": "Naogaon", "naogoan": "Naogaon", "tangile": "Tangail", "mymensing": "Mymensingh", "mymenshing": "Mymensingh", "maymansingh": "Mymensingh", "moymonsingh": "Mymensingh", "narshingdi": "Narsingdi", "norsingdi": "Narsingdi", "naraynganj": "Narayanganj", "narayangang": "Narayanganj", "sariatpur": "Shariatpur", "shoriatpur": "Shariatpur", "shatkhira": "Satkhira", "potuakhali": "Patuakhali", "sylet": "Sylhet", "silet": "Sylhet", "moulovibazar": "Moulvibazar", "moulvi bazar": "Moulvibazar", "lakhsmipur": "Lakshmipur", "luxmipur": "Lakshmipur", "lakshipur": "Lakshmipur", "brahmanbaria": "Brahmanbaria", "bbaria": "Brahmanbaria", "noakhali": "Noakhali", "rangamati": "Rangamati", "khagrachori": "Khagrachhari", "khagrachhori": "Khagrachhari", "rajshai": "Rajshahi", "chadpur": "Chandpur", "chandpur": "Chandpur", "pirojpure": "Pirojpur", "barguna": "Barguna", "meherpure": "Meherpur", "narayanganj": "Narayanganj", "banani": "Dhaka", "baridhara": "Dhaka", "bashundhara": "Dhaka", "badda": "Dhaka", "rampura": "Dhaka", "khilgaon": "Dhaka", "motijheel": "Dhaka", "malibagh": "Dhaka", "mogbazar": "Dhaka", "moghbazar": "Dhaka", "tejgaon": "Dhaka", "farmgate": "Dhaka", "kawran bazar": "Dhaka", "karwan bazar": "Dhaka", "mohakhali": "Dhaka", "cantonment": "Dhaka", "khilkhet": "Dhaka", "jatrabari": "Dhaka", "demra": "Dhaka", "kamrangirchar": "Dhaka", "lalbagh": "Dhaka", "old dhaka": "Dhaka", "puran dhaka": "Dhaka", "keraniganj": "Dhaka", "dohar": "Dhaka", "dhamrai": "Dhaka", "ashulia": "Dhaka", "hazaribagh": "Dhaka", "kalabagan": "Dhaka", "panthapath": "Dhaka", "shyamoli": "Dhaka", "adabor": "Dhaka", "agargaon": "Dhaka", "kafrul": "Dhaka", "pallabi": "Dhaka", "gabtoli": "Dhaka", "wari": "Dhaka", "sutrapur": "Dhaka", "gendaria": "Dhaka", "paltan": "Dhaka", "shahbag": "Dhaka", "ramna": "Dhaka", "shantinagar": "Dhaka", "hatirjheel": "Dhaka", "aftabnagar": "Dhaka", "banasree": "Dhaka", "banashree": "Dhaka", "vatara": "Dhaka", "nikunja": "Dhaka", "dakshinkhan": "Dhaka", "uttarkhan": "Dhaka", "turag": "Dhaka", "beraid": "Dhaka", "shewrapara": "Dhaka", "kazipara": "Dhaka", "mohammedpur": "Dhaka", "board bazar": "Gazipur", "kaliakair": "Gazipur", "kapasia": "Gazipur", "sreepur": "Gazipur", "joydebpur": "Gazipur", "chandra": "Gazipur", "fatullah": "Narayanganj", "siddhirganj": "Narayanganj", "rupganj": "Narayanganj", "sonargaon": "Narayanganj", "araihazar": "Narayanganj", "agrabad": "Chattogram", "halishahar": "Chattogram", "pahartali": "Chattogram", "panchlaish": "Chattogram", "khulshi": "Chattogram", "bayazid": "Chattogram", "hathazari": "Chattogram", "patiya": "Chattogram", "raozan": "Chattogram", "sitakunda": "Chattogram", "mirsharai": "Chattogram", "anwara": "Chattogram", "boalkhali": "Chattogram", "fatikchhari": "Chattogram", "rangunia": "Chattogram", "sandwip": "Chattogram", "banshkhali": "Chattogram", "chandanaish": "Chattogram", "satkania": "Chattogram", "muradpur": "Chattogram", "nasirabad": "Chattogram", "double mooring": "Chattogram", "ashuganj": "Brahmanbaria", "sarail": "Brahmanbaria", "nabinagar": "Brahmanbaria", "akhaura": "Brahmanbaria", "bancharampur": "Brahmanbaria", "matidali": "Bogura", "dhunat": "Bogura", "sariakandi": "Bogura", "sonatala": "Bogura", "chouddagram": "Cumilla", "laksam": "Cumilla", "daudkandi": "Cumilla", "debidwar": "Cumilla", "muradnagar": "Cumilla", "chandina": "Cumilla", "burichang": "Cumilla", "dagonbhuiyan": "Feni", "chhagalnaiya": "Feni", "parshuram": "Feni", "sonagazi": "Feni", "maijdee": "Noakhali", "begumganj": "Noakhali", "chowmuhani": "Noakhali", "senbag": "Noakhali", "hatiya": "Noakhali", "zindabazar": "Sylhet", "ambarkhana": "Sylhet", "subidbazar": "Sylhet", "beanibazar": "Sylhet", "golapganj": "Sylhet", "bishwanath": "Sylhet", "jaintiapur": "Sylhet", "sonadanga": "Khulna", "khalishpur": "Khulna", "dumuria": "Khulna", "phultala": "Khulna", "godagari": "Rajshahi", "charghat": "Rajshahi", "mithapukur": "Rangpur", "badarganj": "Rangpur", "trishal": "Mymensingh", "bhaluka": "Mymensingh", "muktagacha": "Mymensingh", "gafargaon": "Mymensingh", "kalihati": "Tangail", "madhupur": "Tangail", "sakhipur": "Tangail", "ghatail": "Tangail", "monohardi": "Narsingdi", "belabo": "Narsingdi", "benapole": "Jashore", "jhikargacha": "Jashore", "abhaynagar": "Jashore", "manirampur": "Jashore", "keshabpur": "Jashore", "bheramara": "Kushtia", "kumarkhali": "Kushtia", "shailkupa": "Jhenaidah", "sailkupa": "Jhenaidah"}'::jsonb;
  v_districts jsonb := coalesce(public.get_setting('delivery') -> 'districts', '[]'::jsonb);
begin
  foreach v_hint in array coalesce(p_hints, '{}') loop
    continue when coalesce(trim(v_hint), '') = '';
    -- Bangla: a district (or well-known area) named anywhere in the text, longest name first.
    for v_key in select k from jsonb_object_keys(v_bn) k order by length(k) desc loop
      if position(v_key in v_hint) > 0 then
        return v_bn ->> v_key;
      end if;
    end loop;
    v_text := lower(regexp_replace(regexp_replace(v_hint, '[''’‘`´]', '', 'g'), '[^A-Za-z ]+', ' ', 'g'));
    v_text := regexp_replace(v_text, '\m(district|division|zila|zilla|sadar|city|bd|bangladesh|upazila|thana)\M', ' ', 'g');
    v_text := trim(regexp_replace(v_text, '\s+', ' ', 'g'));
    continue when v_text = '';
    v_flat := replace(v_text, ' ', '');
    -- The district itself, alone or as a word.
    select d into v_name from jsonb_array_elements_text(v_districts) d
    where lower(regexp_replace(d, '[^A-Za-z]+', '', 'g')) = v_flat limit 1;
    if v_name is not null then return v_name; end if;
    select d into v_name from jsonb_array_elements_text(v_districts) d
    where v_text ~ ('\m' || lower(regexp_replace(d, '[^A-Za-z ]+', '', 'g')) || '\M')
    order by length(d) desc limit 1;
    if v_name is not null then return v_name; end if;
    -- Other spellings and well-known areas, longest first; "coxsbazar" matches "coxs bazar".
    for v_key in select k from jsonb_object_keys(v_aliases) k order by length(k) desc loop
      if v_text ~ ('\m' || v_key || '\M') or v_flat = replace(v_key, ' ', '') then
        return v_aliases ->> v_key;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
revoke all on function public._bd_district(text[]) from public, anon, authenticated;
