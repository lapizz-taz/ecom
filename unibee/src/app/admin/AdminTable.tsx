"use client";

import { ChevronDown, Download, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { COLUMNS, ENGLISH_TESTS, STUDY_LEVELS, type RegistrationRecord } from "@/lib/registration";

const SOURCE_LABEL: Record<string, string> = {
  supabase: "Supabase",
  "google-sheets": "Google Sheet",
  "local-file": "Local file (development only)",
  none: "No storage configured",
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

function toCsv(rows: RegistrationRecord[]) {
  const cell = (v: string) => {
    const s = /^[=+\-@]/.test(v) ? `'${v}` : v; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = COLUMNS.map(([, label]) => cell(label)).join(",");
  const body = rows.map((r) => COLUMNS.map(([k]) => cell(k === "created_at" ? fmtDate(r[k]) : r[k])).join(","));
  return "﻿" + [head, ...body].join("\r\n"); // BOM so Excel opens UTF-8 correctly
}

export function AdminTable({ rows, source, loadError, emailOn }: { rows: RegistrationRecord[]; source: string; loadError: string; emailOn: boolean }) {
  const [q, setQ] = useState("");
  const [test, setTest] = useState("");
  const [level, setLevel] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, "");
    return rows.filter(
      (r) =>
        (!test || r.english_test === test) &&
        (!level || r.study_level === level) &&
        (!s ||
          r.full_name.toLowerCase().includes(s) ||
          r.email.toLowerCase().includes(s) ||
          r.university.toLowerCase().includes(s) ||
          (digits.length >= 3 && (r.phone.replace(/\D/g, "").includes(digits) || r.whatsapp.replace(/\D/g, "").includes(digits)))),
    );
  }, [rows, q, test, level]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `unibee-registrations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const today = rows.filter((r) => new Date(r.created_at).toDateString() === new Date().toDateString()).length;

  return (
    <div>
      <main className="container-page py-8">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Total registrations", rows.length],
            ["Today", today],
            ["Showing", filtered.length],
          ].map(([label, n]) => (
            <div key={label} className="card p-5">
              <p className="text-[13px] font-medium text-muted">{label}</p>
              <p className="mt-1 font-heading text-[28px] font-bold">{n}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted">
          Data from: <strong className="text-ink-soft">{SOURCE_LABEL[source] ?? source}</strong> · Email alerts: <strong className="text-ink-soft">{emailOn ? "on" : "off"}</strong>
        </p>

        {loadError && <p role="alert" className="mt-4 rounded-[var(--radius-card)] bg-[#fef2f2] p-4 text-[15px] text-[#991b1b]">{loadError}</p>}

        <div className="card mt-6 grid gap-3 p-4 md:grid-cols-[1fr_200px_180px_auto]">
          <label className="relative">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, phone, university" className="field-input pl-10" />
          </label>
          <label>
            <span className="sr-only">English test</span>
            <select value={test} onChange={(e) => setTest(e.target.value)} className="field-input">
              <option value="">All English tests</option>
              {ENGLISH_TESTS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Study level</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="field-input">
              <option value="">All levels</option>
              {STUDY_LEVELS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <button type="button" onClick={exportCsv} disabled={!filtered.length} className="btn btn-primary-sm">
            <Download className="size-4" aria-hidden="true" /> Export CSV
          </button>
        </div>

        <div className="card mt-4 overflow-hidden">
          {filtered.length === 0 ? (
            <p className="p-10 text-center text-[15px] text-muted">{rows.length ? "No registrations match these filters." : "No registrations yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-[14px]">
                <thead className="border-b border-line bg-surface text-[13px] text-muted">
                  <tr>
                    {["Submitted", "Name", "WhatsApp", "Level", "English", "SSC / HSC", "University", ""].map((h) => (
                      <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const isOpen = open === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-b border-line align-top hover:bg-surface/60">
                          <td className="px-4 py-3 whitespace-nowrap text-muted">{fmtDate(r.created_at)}</td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-ink">{r.full_name}</p>
                            <a href={`mailto:${r.email}`} className="text-muted hover:text-brand-dark">{r.email}</a>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <a href={`https://wa.me/${r.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer" className="font-medium text-whatsapp-dark hover:underline">
                              {r.whatsapp}
                            </a>
                          </td>
                          <td className="px-4 py-3">{r.study_level}</td>
                          <td className="px-4 py-3">{r.english_test}{r.english_score && <span className="font-semibold"> · {r.english_score}</span>}</td>
                          <td className="px-4 py-3 whitespace-nowrap">{r.ssc_gpa} / {r.hsc_gpa}</td>
                          <td className="px-4 py-3">{r.university || <span className="text-muted">-</span>}</td>
                          <td className="px-4 py-3 text-right">
                            <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-semibold text-brand-dark hover:bg-brand-tint">
                              Details <ChevronDown className={`size-4 transition ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-line bg-surface/50">
                            <td colSpan={8} className="px-4 py-5">
                              <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                                {COLUMNS.filter(([k]) => r[k] && k !== "id").map(([k, label]) => (
                                  <div key={k} className={k === "why_lithuania" || k === "comments" ? "sm:col-span-2 lg:col-span-3" : ""}>
                                    <dt className="text-[12px] font-medium tracking-wide text-muted uppercase">{label}</dt>
                                    <dd className="mt-0.5 whitespace-pre-line text-ink">{k === "created_at" ? fmtDate(r[k]) : r[k]}</dd>
                                  </div>
                                ))}
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
