"use client";
import { useEffect, useState } from "react";
import { KeyRound, Power, ShieldCheck, UserPlus } from "lucide-react";
import { Avatar, CardHeader } from "@/components/ui";

interface User { id: string; email: string; name: string | null; role: string; active: boolean; lastLoginAt: string | null }

export function UsersEditor() {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "AGENT", password: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const j = await (await fetch("/api/admin/users")).json();
    setUsers(j.users ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function call(method: string, body: object) {
    const res = await fetch("/api/admin/users", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? { ok: true, text: "Saved" } : { ok: false, text: j.details?.join("; ") ?? j.error ?? "Failed" });
    load();
    return res.ok;
  }

  return (
    <div className="stack">
      <div className="card flush">
        <CardHeader
          icon={ShieldCheck}
          title="Team"
          description="Admins can do everything. Agents handle conversations, customers, orders, products and test chat — but can't change settings, knowledge or staff."
          actions={msg ? <span className={`feedback ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</span> : undefined}
        />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Last sign-in</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="cell-person">
                      <Avatar name={u.name ?? u.email} size="sm" />
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{u.name ?? u.email}</div>
                        {u.name && <div className="small muted">{u.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <select aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => call("PATCH", { id: u.id, role: e.target.value })} style={{ width: 120, minHeight: 32, paddingTop: 4, paddingBottom: 4 }}>
                      <option value="ADMIN">Admin</option>
                      <option value="AGENT">Agent</option>
                    </select>
                  </td>
                  <td>{u.active ? <span className="pill tone-good">Active</span> : <span className="pill tone-critical">Disabled</span>}</td>
                  <td className="small muted nowrap">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Never"}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <button className="btn-sm" onClick={() => call("PATCH", { id: u.id, active: !u.active })}>
                        <Power width={14} height={14} aria-hidden /> {u.active ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="btn-sm"
                        onClick={() => {
                          const pw = prompt("New password (12+ chars, upper, lower, number)");
                          if (pw) call("PATCH", { id: u.id, password: pw });
                        }}
                      >
                        <KeyRound width={14} height={14} aria-hidden /> Reset password
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <CardHeader icon={UserPlus} title="Add a staff member" description="Share the temporary password privately. An admin can reset it at any time." />
        <div className="card-body">
          <div className="form-grid">
            <div className="field"><label htmlFor="u-email">Email</label><input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@isolationpvt.shop" /></div>
            <div className="field"><label htmlFor="u-name">Name</label><input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="u-role">Role</label>
              <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="AGENT">Agent</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="u-pw">Temporary password</label>
              <input id="u-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <p className="hint">12+ characters with upper-case, lower-case and a number.</p>
            </div>
          </div>
        </div>
        <div className="card-footer">
          <button className="btn-primary" onClick={async () => (await call("POST", form)) && setForm({ email: "", name: "", role: "AGENT", password: "" })}>
            <UserPlus width={15} height={15} aria-hidden /> Create account
          </button>
        </div>
      </div>
    </div>
  );
}
