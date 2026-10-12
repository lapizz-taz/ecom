"use client";

import { ArrowDown, ArrowUp, ChevronDown, Copy, ImageUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { ICON_NAMES } from "@/components/ui/icon-names";
import { Icon } from "@/components/ui/Icon";

/* Small form building blocks for the CMS. */

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[12px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

const inputCls =
  "block w-full rounded-[10px] border border-line-strong bg-white px-3 py-2 text-[14px] text-ink transition placeholder:text-faint focus:border-brand-dark focus:ring-4 focus:ring-brand/10 focus:outline-none";

export function TextInput({
  label,
  value,
  onChange,
  hint,
  placeholder,
  multiline,
  rows = 3,
  maxLength = 2000,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  const flagged = /REPLACE/i.test(value);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        flagged ? (
          <span className="text-amber-700">Still a placeholder: replace this before launch.{hint ? <> {hint}</> : null}</span>
        ) : (
          hint
        )
      }
    >
      {multiline ? (
        <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={maxLength} placeholder={placeholder} className={`${inputCls} resize-y leading-relaxed`} />
      ) : (
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} placeholder={placeholder} className={`${inputCls} min-h-10`} />
      )}
    </Field>
  );
}

/** A list of short texts edited as one item per line. */
export function LinesInput({ label, value, onChange, hint, rows = 4 }: { label: string; value: string[]; onChange: (v: string[]) => void; hint?: string; rows?: number }) {
  const id = useId();
  const [raw, setRaw] = useState(value.join("\n"));
  return (
    <Field label={label} htmlFor={id} hint={hint ?? "One per line."}>
      <textarea
        id={id}
        value={raw}
        rows={rows}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
        }}
        className={`${inputCls} resize-y leading-relaxed`}
      />
    </Field>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 rounded-full transition ${checked ? "bg-brand-dark" : "bg-line-strong"}`}
      >
        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition ${checked ? "translate-x-4" : ""}`} />
      </button>
      <label htmlFor={id} className="cursor-pointer">
        <span className="block text-[14px] font-medium text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </label>
    </div>
  );
}

export function IconSelect({ label = "Icon", value, onChange }: { label?: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-surface text-ink-soft">
          <Icon name={value} className="size-5" />
        </span>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} min-h-10`}>
          {ICON_NAMES.map((n) => (
            <option key={n} value={n}>
              {n.replace(/([a-z])([A-Z])/g, "$1 $2")}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

/** Image picker: upload a file (stored in Supabase / locally) or paste a link. */
export function ImageInput({
  label,
  value,
  onChange,
  hint,
  disabled,
  aspect = "aspect-[16/9]",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
  aspect?: string;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/media", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed.");
      onChange(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Field label={label} htmlFor={id} hint={error ? <span className="text-danger">{error}</span> : hint ?? "JPG, PNG, WebP or AVIF, up to 5 MB."}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className={`relative w-full overflow-hidden rounded-[10px] border border-line bg-surface sm:w-44 ${aspect}`}>
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <span className="absolute inset-0 grid place-items-center text-[12px] text-faint">No image</span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => fileRef.current?.click()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-white transition hover:bg-graphite disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ImageUp className="size-3.5" aria-hidden="true" />}
              {busy ? "Uploading…" : "Upload image"}
            </button>
            {value && (
              <button type="button" onClick={() => onChange("")} className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted ring-1 ring-line hover:text-ink">
                <X className="size-3.5" aria-hidden="true" /> Remove
              </button>
            )}
          </div>
          <input
            id={id}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="…or paste an image link (https://…)"
            className={`${inputCls} min-h-9 text-[13px]`}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </div>
      </div>
    </Field>
  );
}

/** Editable list: add, duplicate, reorder, delete (with confirmation), collapse. */
export function ListEditor<T>({
  items,
  onChange,
  renderItem,
  newItem,
  itemTitle,
  addLabel = "Add item",
  max = 50,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  renderItem: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  newItem: () => T;
  itemTitle: (item: T, index: number) => string;
  addLabel?: string;
  max?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (open === i) setOpen(j);
  };
  const update = (i: number, patch: Partial<T>) => onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => {
    onChange(items.filter((_, k) => k !== i));
    setConfirmDelete(null);
    setOpen(null);
  };
  const duplicate = (i: number) => {
    const next = [...items];
    next.splice(i + 1, 0, JSON.parse(JSON.stringify(items[i])));
    onChange(next);
    setOpen(i + 1);
  };

  const iconBtn = "grid size-8 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-ink disabled:opacity-30";

  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="rounded-[10px] border border-dashed border-line-strong p-4 text-center text-[13px] text-muted">Nothing here yet.</p>}
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={i} className={`rounded-[12px] border bg-white ${isOpen ? "border-line-strong shadow-sm" : "border-line"}`}>
            <div className="flex items-center gap-1 py-1.5 pr-1.5 pl-3">
              <button type="button" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen} className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left">
                <ChevronDown className={`size-4 shrink-0 text-faint transition ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                <span className="font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate text-[14px] font-medium text-ink">{itemTitle(item, i) || "Untitled"}</span>
              </button>
              {confirmDelete === i ? (
                <span className="flex items-center gap-1 text-[12px]">
                  <span className="text-muted">Delete?</span>
                  <button type="button" onClick={() => remove(i)} className="rounded-full bg-danger px-2.5 py-1 font-medium text-white">
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-full px-2.5 py-1 text-muted ring-1 ring-line">
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <button type="button" className={iconBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={iconBtn} onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down">
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={iconBtn} onClick={() => duplicate(i)} disabled={items.length >= max} aria-label="Duplicate">
                    <Copy className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={`${iconBtn} hover:text-danger`} onClick={() => setConfirmDelete(i)} aria-label="Delete">
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
            {isOpen && <div className="space-y-4 border-t border-line p-4">{renderItem(item, (patch) => update(i, patch), i)}</div>}
          </div>
        );
      })}
      <button
        type="button"
        disabled={items.length >= max}
        onClick={() => {
          onChange([...items, newItem()]);
          setOpen(items.length);
        }}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-ink ring-1 ring-line-strong transition hover:bg-white disabled:opacity-40"
      >
        <Plus className="size-4" aria-hidden="true" /> {addLabel}
      </button>
    </div>
  );
}
