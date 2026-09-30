"use client";
import { useEffect, useState } from "react";

interface User { id: string; email: string; name: string | null; role: string; active: boolean; lastLoginAt: string | null }

export function UsersEditor() {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "AGENT", password: "" });
  const [msg, setMsg] = useState<string | null>(null);

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
    setMsg(res.ok ? "✅ Saved" : `❌ ${j.details?.join("; ") ?? j.error ?? "Failed"}`);
    load();
    return res.ok;
  }

  return (
    <>
      {msg && <p className="small">{msg}</p>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}<div className="small muted">{u.name}</div></td>
                <td>
                  <select value={u.role} onChange={(e) => call("PATCH", { id: u.id, role: e.target.value })} style={{ width: 110 }}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="AGENT">AGENT</option>
                  </select>
                </td>
                <td>{u.active ? <span className="badge ok">active</span> : <span className="badge bad">disabled</span>}</td>
                <td className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                <td className="row">
                  <button onClick={() => call("PATCH", { id: u.id, active: !u.active })}>{u.active ? "Disable" : "Enable"}</button>
                  <button
                    onClick={() => {
                      const pw = prompt("New password (12+ chars, upper, lower, number)");
                      if (pw) call("PATCH", { id: u.id, password: pw });
                    }}
                  >
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Add staff account</h3>
        <p className="small muted">ADMIN: everything. AGENT: conversations, customers, orders, products, test chat — cannot change settings, knowledge base or staff.</p>
        <div className="grid grid-2">
          <div><label>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div>
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="AGENT">AGENT</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
          <div><label>Temporary password</label><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="primary" onClick={async () => (await call("POST", form)) && setForm({ email: "", name: "", role: "AGENT", password: "" })}>Create</button>
        </div>
      </div>
    </>
  );
}
