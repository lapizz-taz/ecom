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

## Editing the website: the CMS

Log in at **`/admin`** and open the **Website content** tab. Everything on the site can be edited there, with no code:

| Section | What you can change |
| --- | --- |
| General | Business name, tagline, Google/link-preview description, footer text, Page 3 name, the "New" announcement above the hero, placeholder tags on/off |
| Contact & social | Phone, WhatsApp number + pre-filled message, email, address, map location, office hours, social media links |
| Home hero | Headline, text, trust line, cover photos (computer + phone), photo description |
| Universities | Add / remove / reorder / duplicate; name, city, logo upload, about, programs, fees, intakes, requirements, deadline, website, "to be confirmed" flag |
| Services | Service cards (icon, title, description) |
| Process | Timeline steps (title, text, time, icon) and the documents checklist |
| English Prep | Header, "what you'll learn", class details, instructor (photo, bio, qualifications, stats), YouTube video |
| Version history | Every save is kept: load an earlier version and save it to roll back |

Press **Save changes** (or Ctrl/Cmd + S). The live site updates within a few seconds; no redeploy needed. The editor warns you before leaving with unsaved changes.

**How it works:** content is stored in Supabase (table `site_content`, with every save copied to `site_content_history`), and uploaded images go to the public Supabase Storage bucket `site-media`. Pages are pre-rendered for speed and refreshed the moment you save. Until the first save, the site shows the starting content from `src/content/` (the files listed below).

**CMS setup (one time):** run [`docs/supabase-schema.sql`](docs/supabase-schema.sql) in Supabase → SQL Editor (creates the tables and the image bucket), then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel. Without Supabase the CMS opens read-only. On your own computer it saves to `.data/` so you can try it straight away.

**Safety:** only logged-in admins can save or upload; requests from other websites are refused; links must be `http(s)`; uploads must be real JPG/PNG/WebP/AVIF images up to 5 MB (SVG isn't accepted because it can carry scripts); all text is trimmed to sensible lengths.

### Starting content (developers)

The defaults live in **`src/content/`** and are only used until something is saved in the CMS:

| What | File |
| --- | --- |
| Contact details, social links, names | `src/content/site.ts` |
| Partner universities | `src/content/universities.json` |
| Service cards | `src/content/services.ts` |
| "How it works" steps + documents | `src/content/process.ts` |
| English Prep page | `src/content/english-prep.ts` |

### (a) Add, edit or remove a university

In the CMS: **Website content → Universities**. Click **Add university**, fill in the fields, upload the logo and press **Save changes**. Use the arrows to change the order (the banner follows this order), the copy icon to duplicate, and the bin to delete.

Tip: you can link straight to the form with a university pre-selected: `https://your-domain.com/?university=vilnius-university#register` (the last part of the link is the university's name in lowercase with dashes).

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

In the CMS: **Website content → Contact & social**. The WhatsApp number you enter there is used by every WhatsApp button on the site (floating button, hero, footer, thank-you screen). Leave a social link empty to hide that icon.

### Photos

Upload them in the CMS (Home hero, university logos, instructor photo). For the hero use one landscape photo (about 2000×900) and one portrait crop for phones (about 800×1000), then switch off "Mark photo as placeholder". The share image for Facebook/WhatsApp link previews is `public/images/og-image.png` (1200×630). Logo files are traced from your original artwork in `public/brand/` (regenerate with `node scripts/make-brand-assets.mjs path/to/logo.png`).

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
- **Visual style: Linear-style layout, in white.** Large left-aligned headings with tight letter-spacing, muted grey copy, hairline dividers instead of boxed cards, framed "product panels" (the cover photo, the form, the map), a changelog-style process timeline, and a quiet white footer. Decoration is kept to a minimum: no icon tiles, no section labels, plain text links. UniBee red is the single accent (buttons, active dots, links). Headings use Inter to match the reference. To go back to Poppins, load it in `src/app/layout.tsx` and point `--font-heading` at it in `src/app/globals.css`. All colours, radii and shadows live in `globals.css`.
- **Accessibility.** Buttons and small red text use #E02424, which passes WCAG AA with white. #FF3333 is kept for non-text accents (dots, highlights). All inputs have labels; modals and the mobile menu trap focus and close with Escape; animations switch off for "reduce motion" users.

## Spam protection

A hidden honeypot field, a minimum fill time (3 s), server-side validation of every field, and a rate limit of 5 submissions per 10 minutes per IP. The rate limit lives in each server instance's memory, so it stops bursts but is not a strict global limit. No captcha is used.
