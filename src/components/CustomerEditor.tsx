"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, PencilLine } from "lucide-react";
import { CardHeader } from "@/components/ui";

export function CustomerEditor(props: { id: string; name: string | null; phone: string | null; tags: string[]; notes: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(props.name ?? "");
  const [phone, setPhone] = useState(props.phone ?? "");
  const [tags, setTags] = useState(props.tags.join(", "));
  const [notes, setNotes] = useState(props.notes ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const res = await fetch(`/api/admin/customers/${props.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || null,
        phone: phone || null,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        notes: notes || null,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? { ok: true, text: "Saved" } : { ok: false, text: j.error ?? "Failed" });
    router.refresh();
  }

  return (
    <div className="card">
      <CardHeader icon={PencilLine} title="Edit profile" description="Visible to staff only." />
      <div className="card-body">
        <div className="field">
          <label htmlFor="c-name">Name</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="c-phone">Phone</label>
          <input id="c-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" />
          <p className="hint">Manual edits are marked unverified.</p>
        </div>
        <div className="field">
          <label htmlFor="c-tags">Tags</label>
          <input id="c-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, repeat-buyer" />
          <p className="hint">Separate tags with commas.</p>
        </div>
        <div className="field">
          <label htmlFor="c-notes">Internal notes</label>
          <textarea id="c-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the team should know…" />
        </div>
      </div>
      <div className="card-footer">
        <button className="btn-primary" onClick={save} disabled={busy}>
          {busy && <LoaderCircle width={15} height={15} className="spin" aria-hidden />}
          Save changes
        </button>
        {msg && <span className={`feedback ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}
