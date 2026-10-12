import type { Metadata } from "next";
import { Placeholder } from "@/components/ui/Placeholder";
import { getContent } from "@/lib/server/content-store";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How UniBee collects, uses and protects the information you share through our registration form.",
  alternates: { canonical: "/privacy" },
};

const updated = "REPLACE: date you publish this policy";

export default async function PrivacyPage() {
  const c = (await getContent()).contact;
  const sections: { title: string; body: React.ReactNode }[] = [
    {
      title: "Who we are",
      body: (
        <p>
          UniBee is a study-abroad consultancy based in Bangladesh that helps students apply to universities in Lithuania. This policy explains what
          information we collect through this website and how we use it.
        </p>
      ),
    },
    {
      title: "What we collect",
      body: (
        <>
          <p>When you fill in our registration form, we collect:</p>
          <ul>
            <li>Contact details: your full name, email address, phone and WhatsApp number.</li>
            <li>Academic details: SSC and HSC GPA, passing years and groups, and bachelor&apos;s details if you share them.</li>
            <li>Your study plans: preferred study level, English test or Medium of Instruction, and why you want to study in Lithuania.</li>
            <li>Anything you write in the comments box, and the university you chose (if any).</li>
            <li>Basic technical information, such as how you found our website (for example, a Facebook ad), to help us improve our service.</li>
          </ul>
        </>
      ),
    },
    {
      title: "How we use your information",
      body: (
        <ul>
          <li>To contact you by phone, WhatsApp or email about your study plans, as you agreed on the form.</li>
          <li>To assess your profile and suggest suitable universities and programs.</li>
          <li>To prepare and submit applications and visa documents, only when you ask us to.</li>
          <li>To understand which of our ads and pages work best (using Google Analytics and the Meta Pixel).</li>
        </ul>
      ),
    },
    {
      title: "Who we share it with",
      body: (
        <p>
          We never sell your information. We only share it with universities and official bodies when you ask us to apply on your behalf, and with
          service providers that help us run this website (for example, hosting, email and spreadsheet/database tools). They may only use it to provide
          their service to us.
        </p>
      ),
    },
    {
      title: "Saved progress in your browser",
      body: (
        <p>
          To stop you losing your answers, the registration form saves your progress in your own browser on your device. It is removed once you submit,
          or when you press &quot;Start over&quot;. You can also clear it by clearing your browser data.
        </p>
      ),
    },
    {
      title: "How long we keep it",
      body: <p>We keep your information for as long as we are helping you, and for up to 2 years afterwards unless you ask us to delete it sooner.</p>,
    },
    {
      title: "Your choices",
      body: (
        <p>
          You can ask us at any time to see, correct or delete your information, or to stop contacting you. Just email us at{" "}
          <a href={`mailto:${c.email}`}>{c.email}</a> or message us on WhatsApp.
        </p>
      ),
    },
    {
      title: "Contact",
      body: (
        <p>
          UniBee, {c.address}. Email: <a href={`mailto:${c.email}`}>{c.email}</a>. Phone: {c.phoneDisplay}.
        </p>
      ),
    },
  ];

  return (
    <section className="section bg-white">
      <div className="container-page max-w-[760px]">
        <p className="eyebrow">Legal</p>
        <h1 className="h1 mt-3">Privacy Policy</h1>
        <p className="mt-4 text-[15px] text-muted">
          Last updated: {updated} <Placeholder label="Review before launch" className="ml-1" />
        </p>
        <div className="mt-10 space-y-10 text-[16px] leading-relaxed text-ink-soft [&_a]:font-medium [&_a]:text-brand-dark [&_a]:underline [&_li]:mt-2 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
          {sections.map((s) => (
            <div key={s.title}>
              <h2 className="font-heading text-[22px] font-semibold tracking-[-0.01em] text-ink">{s.title}</h2>
              <div className="mt-3">{s.body}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
