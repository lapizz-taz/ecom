"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function CustomerEditor(props: { id: string; name: string | null; phone: string | null; tags: string[]; notes: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(props.name ?? "");
  const [phone, setPhone] = useState(props.phone ?? "");
  const [tags, setTags] = useState(props.tags.join(", "));
  const [notes, setNotes] = useState(props.notes ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
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
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Saved" : j.error ?? "Failed");
    router.refresh();
  }

  return (
    <div className="card">
      <h3>Edit profile</h3>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>Phone (manual edits are marked unverified)</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" />
      <label>Tags (comma separated)</label>
      <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, repeat-buyer" />
      <label>Internal notes</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save}>Save</button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
    </div>
  );
}
