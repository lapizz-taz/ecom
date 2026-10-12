# UniBee website

Marketing website + student registration for **UniBee**, a study-in-Lithuania consultancy in Bangladesh.

- **Stack:** Next.js 15 (App Router) + Tailwind CSS 4, deployable on Vercel.
- **Pages:** Home · Our Services · English Prep · Privacy Policy · `/admin` (password protected)
- **Registration data:** Google Sheet and/or Supabase, plus an instant email for every new registration (Resend).

> This folder is a standalone app. It sits inside the `ecom` repository but shares nothing with the other project there.

---

## Quick start (on your computer)

```bash
cd unibee
npm install
cp .env.example .env.local   # optional for local testing
npm run dev                  # http://localhost:3000
```

Without any storage settings, local registrations are saved to `unibee/.data/registrations.json`, so you can try the whole form straight away. To try `/admin` locally, set `ADMIN_PASSWORD` in `.env.local`.

Other commands: `npm run build` (production build) · `npm test` (validation tests) · `npm run typecheck` · `npm run preview:export` (static click-through preview in `preview-out/`).

---

## Where to edit things (no layout code needed)

All editable content lives in **`src/content/`**:

| What | File |
| --- | --- |
| Contact details, social links, office hours, map, announcement bar, Page 3 name | `src/content/site.ts` |
| Partner universities | `src/content/universities.json` |
| Service cards | `src/content/services.ts` |
| "How it works" steps + documents checklist | `src/content/process.ts` |
| English Prep page (course, schedule, instructor, video) | `src/content/english-prep.ts` |

### (a) Add, edit or remove a university

Open `src/content/universities.json`. Each university is one block `{ ... }` in the list:

```json
{
  "slug": "vilnius-university",          // short id, lowercase-with-dashes, must be unique
  "name": "Vilnius University",
  "shortName": "VU",                     // shown on the placeholder logo tile
  "city": "Vilnius",
  "logo": "/universities/vu.svg",        // put the file in public/universities/ ("" = monogram tile)
  "color": "#7A1F3D",                    // colour of the monogram tile
  "about": "2–3 lines about the university.",
  "programs": { "bachelor": ["..."], "master": ["..."] },
  "tuition": "€3,500 – €6,500 per year",
  "intakes": ["September", "February"],
  "requirements": { "academic": "...", "english": "..." },
  "deadline": "15 June",
  "website": "https://www.vu.lt/en/",
  "placeholder": false                   // remove or set false once details are confirmed
}
```

- **Add:** copy a whole block, paste it after a comma, and change the values.
- **Remove:** delete the block (and the comma before it).
- **Order:** the banner shows universities in the order of this file.
- Logos: SVG or PNG with a transparent background, ideally ~300px wide. They appear greyscale and turn full colour on hover automatically.
- "Apply with UniBee" in the pop-up pre-fills the form comments with the university name. You can also link straight to it: `https://your-domain.com/?university=vilnius-university#register`.

### (b) View form submissions

You have three ways. Use whichever suits your team:

1. **Admin page:** go to `https://your-domain.com/admin` and log in with `ADMIN_PASSWORD`. Search by name, email, phone or university. Filter by English test and study level. Click **Details** for the full answers and **Export CSV** to download (opens in Excel or Google Sheets).
2. **Google Sheet:** every registration is a new row (if you chose the Google Sheet option).
3. **Email:** each registration arrives in your inbox immediately, with a one-tap "Chat on WhatsApp" button.

#### Google Sheet setup (recommended for simplicity)

1. Create a Google Sheet, then **Extensions → Apps Script**.
2. Paste the contents of [`docs/google-sheets-apps-script.js`](docs/google-sheets-apps-script.js). Change `SECRET` to a long random string.
3. **Deploy → New deployment → Web app**, set *Execute as: Me* and *Who has access: Anyone*, then deploy and copy the URL.
4. In Vercel, add `GOOGLE_SHEETS_WEBHOOK_URL` (the URL) and `GOOGLE_SHEETS_SECRET` (the same secret).

#### Supabase setup (if you prefer a database)

1. Create a project at supabase.com and open **SQL Editor**.
2. Run [`docs/supabase-schema.sql`](docs/supabase-schema.sql).
3. In **Project Settings → API**, copy the Project URL and the `service_role` key into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never put this key in public code).

You can switch on both. Every registration is then saved to each one, and the admin page reads from Supabase.

#### Email alerts

Create a free account at resend.com, verify your domain, and set `RESEND_API_KEY`, `NOTIFY_EMAIL_TO` (comma-separate several addresses) and `NOTIFY_EMAIL_FROM` (e.g. `UniBee Website <noreply@your-domain.com>`). If saving ever fails, the server still tries to email the registration so no lead is lost.

### (c) Change contact details and social links

Open `src/content/site.ts`:

- `contact.phone` / `phoneDisplay`: the number for calls (link format / how it's shown).
- `contact.whatsapp`: digits only with country code, e.g. `8801712345678`. Every WhatsApp button on the site (floating button, hero, footer, thank-you screen) uses this.
- `contact.whatsappMessage`: the pre-filled chat message.
- `contact.email`, `contact.address`, `contact.hours`.
- `contact.mapsQuery`: what Google Maps searches for (your full address or exact business name). It controls both the embedded map and the "open in Maps" link.
- `socials`: change each URL. Delete a line to hide that icon. The WhatsApp entry fills itself in.
- `page3.name`: rename the "English Prep" page (menu, footer and title follow).
- `announcement.text`: the slim bar above the header. Set it to `""` to hide it.
- `showPlaceholderBadges`: set to `false` to hide all amber "Placeholder" tags at once.

### Photos

- Hero cover photo: replace `public/images/hero-mobile.webp` (portrait, ~800×1000) and `public/images/hero-desktop.webp` (landscape, ~2000×900). Then set `placeholder: false` in `src/components/home/Hero.tsx`. The current photo is your Vilnius banner with the text removed, used only as a stand-in.
- Share image (Facebook/WhatsApp link previews): `public/images/og-image.png` (1200×630).
- Logo files are traced from your original artwork: `public/brand/`. To regenerate from a better master file: `node scripts/make-brand-assets.mjs path/to/logo.png`.

---

## Deploying to Vercel (only after the preview is approved)

1. In Vercel: **Add New → Project → import the `ecom` repository**.
2. Set **Root Directory** to `unibee`. Framework preset: Next.js.
3. Add the environment variables from `.env.example`.
4. Deploy, then add your domain under **Settings → Domains**.

Functions run in Singapore (`sin1`), the closest Vercel region to Bangladesh.

---

## Tracking

Set `NEXT_PUBLIC_GA4_ID` and/or `NEXT_PUBLIC_META_PIXEL_ID`. Events sent:

- **Lead** (Meta) / **generate_lead** (GA4): when a registration is submitted successfully.
- **Contact** (Meta) / **whatsapp_click** (GA4): every WhatsApp button click, with its location.
- GA4 also gets `view_university` and `apply_with_unibee`.

The form also records where each student came from (UTM tags or referring site, e.g. `facebook / cpc / sept-intake · m.facebook.com`) in the **Source** column.

---

## Design & UX decisions

- **"Register Now" scrolls to the form (no pop-up).** The form has 3 steps and up to 20 fields. In a modal on a phone, the on-screen keyboard covers half the window, scrolling inside the modal is fiddly, and the back button closes it (losing focus and context). Facebook and Instagram in-app browsers make this worse. An on-page form keeps the native scroll and keyboard behaviour, works with the back button, and can be linked directly (`/#register`). That generally converts better on mobile.
- **3 steps with a progress bar (not one long form).** Each screen shows 4–8 fields, errors are caught step by step instead of all at the end, and step 1 (name, email, WhatsApp) is short so people start easily. Answers are saved on the device as people type, so nobody loses their work if they leave and come back.
- **Brand + style references.** Brand rules come from the UniBee brief (red #FF3333 as the single accent, Poppins headings + Inter body, pill buttons, 12px cards). The *Arcade* and *Basis Theory* references shaped the rest: white canvas with alternating light-grey bands, hairline borders with layered soft shadows, tight heading letter-spacing, centred section headings, greyscale partner logos, monospace step labels, a dark panel for the documents checklist, and stacked "sheets" behind the form card. All tokens live in `src/app/globals.css`.
- **Accessibility.** White text on #FF3333 is used only for large bold text (19px+ bold buttons). Small white-on-red text uses #E02424 (footer, small buttons, timeline numbers) to pass WCAG AA. All inputs have labels; modals and the mobile menu trap focus and close with Escape; animations switch off for "reduce motion" users.

## Spam protection

A hidden honeypot field, a minimum fill time (3 s), server-side validation of every field, and a rate limit of 5 submissions per 10 minutes per IP. The rate limit lives in each server instance's memory, so it stops bursts but is not a strict global limit. No captcha is used.
