import type { ReactNode } from "react";
import { Headset, Languages, ShoppingBag } from "lucide-react";
import { CHANNEL_LABEL, ChannelIcon } from "@/components/ui";

/** Split-screen frame for the sign-in and first-time setup pages. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="brand">
          <span className="logo-mark">I</span>
          <span>
            <span className="brand-name" style={{ display: "block" }}>ISOLATION</span>
            <span className="brand-sub">AI sales & support console</span>
          </span>
        </div>
        <div className="auth-hero">
          <h2>Every DM answered in seconds.</h2>
          <p>One assistant for Instagram, Messenger and WhatsApp — connected to your Shopify store, with your team one click away.</p>
          <ul className="auth-points">
            <li><span className="pt-icon"><Languages width={16} height={16} aria-hidden /></span> Replies in English, Bangla and Banglish</li>
            <li><span className="pt-icon"><ShoppingBag width={16} height={16} aria-hidden /></span> Live prices, stock and orders from Shopify</li>
            <li><span className="pt-icon"><Headset width={16} height={16} aria-hidden /></span> Hands tricky chats to your team</li>
          </ul>
          <div className="auth-channels">
            {["INSTAGRAM", "MESSENGER", "WHATSAPP"].map((c) => (
              <span key={c} className="pill">
                <ChannelIcon channel={c} size={14} /> {CHANNEL_LABEL[c]}
              </span>
            ))}
          </div>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="brand auth-mobile-brand" style={{ padding: 0 }}>
            <span className="logo-mark">I</span>
            <span>
              <span className="brand-name" style={{ display: "block" }}>ISOLATION</span>
              <span className="brand-sub">AI sales & support console</span>
            </span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
