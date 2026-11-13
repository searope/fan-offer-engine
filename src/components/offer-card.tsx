"use client";

import { useEffect, useRef, useState } from "react";
import type { ProposalView } from "@/server/service";
import type { Channel, CostLine, Offer, RawCartRow } from "@/engine/types";
import { describeChannel, describeOffer } from "@/engine/reasons";
import { PROMO_PLACEHOLDER } from "@/engine/copy/lint";

/**
 * The offer card and the small pieces it is built from, shared by the list views and the review board.
 */
export const ACTOR = "marketer@seawolves";

export const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", "x-actor": ACTOR, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { problems: (body.problems ?? []) as string[] });
  return body as T;
}

export const OPEN = ["pending_review", "blocked", "failed"];

/** Still open, but past its send-by time on the app's clock: it can't be sent any more. */
export const isLapsed = (p: ProposalView, now: string) => OPEN.includes(p.status) && !!p.proposal && Date.parse(p.proposal.expiresAt) <= Date.parse(now);

// ---------------------------------------------------------------------------

/** Mirrors the server's bulkEligible(); the server re-checks every id anyway. */
export const bulkEligible = (p: ProposalView) => p.status === "pending_review" && p.proposal?.offer.type === "reminder" && p.proposal.channel !== "sales_task";

export function HoldoutNote() {
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-3 text-sm text-violet-900">
      <div className="font-semibold">Not sent: held out for measurement</div>
      <p className="mt-1">
        This fan was picked at random and is not contacted about this match. The offer above is what they would have received. Comparing how often held-out fans
        still buy with how often offered fans buy shows whether offers earn revenue or just discount purchases that would have happened anyway.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewing at volume: filter, group (with per-group totals), compact rows, paging.

export function timeLeft(expiresAt: string, now: string) {
  const ms = Date.parse(expiresAt) - Date.parse(now);
  const h = Math.floor(ms / 3_600_000);
  const label = ms <= 0 ? "expired" : h >= 48 ? `${Math.floor(h / 24)}d left` : h >= 1 ? `${h}h left` : "<1h left";
  const cls = ms <= 0 || h < 24 ? "text-red-700" : h < 48 ? "text-amber-700" : "text-slate-500";
  return { label, cls };
}

export const costShort = (costs: CostLine[]) =>
  costs.length === 0
    ? "No discount"
    : costs.map((c) => (c.kind === "ticket_discount" ? `−${money(c.amountCents ?? 0)} ticket` : c.kind === "merch_voucher" ? `≤${money(c.amountCents ?? 0)} voucher` : "Perk")).join(", ");

export const SEGMENTS: Record<string, string> = { SEASON_PASS_HOLDER: "Season-pass holder", NEW_FAN: "First-time buyer", LAPSED_FAN: "Lapsed fan", REGULAR_FAN: "Regular fan" };

export const STATUS: Record<string, [string, string]> = {
  pending_review: ["Needs review", "bg-amber-100 text-amber-900"],
  blocked: ["Blocked", "bg-red-100 text-red-800"],
  failed: ["Send failed", "bg-red-100 text-red-800"],
  approved: ["Approved, sending", "bg-sky-100 text-sky-800"],
  sent: ["Sent", "bg-emerald-100 text-emerald-800"],
  rejected: ["Rejected", "bg-slate-200 text-slate-700"],
  expired: ["Expired", "bg-slate-200 text-slate-700"],
  held: ["Held", "bg-violet-100 text-violet-800"],
  suppressed: ["No offer", "bg-slate-200 text-slate-700"],
  holdout: ["Held out", "bg-violet-100 text-violet-800"],
};

export function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function SellThrough({ pct }: { pct: number }) {
  const color = pct >= 75 ? "bg-rose-500" : pct < 60 ? "bg-sky-500" : "bg-amber-500";
  return (
    <div className="flex items-center gap-2" title="Section sell-through for this match">
      <div className="h-1.5 w-24 overflow-hidden rounded bg-slate-200">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-600">{pct}% sold</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** One line per kind of cost. Never one "discount" number: ticket revenue, merch vouchers and perks are different money. */
export function CostLines({ costs }: { costs: CostLine[] }) {
  if (costs.length === 0) return <div>No discount</div>;
  return (
    <>
      {costs.map((c, i) =>
        c.kind === "ticket_discount" ? (
          <div key={i}>
            Ticket discount <b className="text-sm text-rose-700">{money(c.amountCents ?? 0)}</b>
          </div>
        ) : c.kind === "merch_voucher" ? (
          <div key={i} title="Worst case. The actual cost depends on what the fan buys in the shop, and is zero if the code is never used.">
            Merch voucher <b className="text-sm text-amber-700">up to {money(c.amountCents ?? 0)}</b>
            <div className="text-[11px] text-slate-400">only if redeemed</div>
          </div>
        ) : (
          <div key={i} title={c.label}>
            <b className="text-sm text-violet-700">Perk</b>, no discount
          </div>
        ),
      )}
    </>
  );
}

/** The send-by deadline, prominent and colored by urgency, measured against the app's clock. */
export function SendBy({ expiresAt, now }: { expiresAt: string; now: string }) {
  const ms = Date.parse(expiresAt) - Date.parse(now);
  const h = Math.floor(ms / 3_600_000);
  const left = ms <= 0 ? "expired" : h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h} h left` : "under 1 h left";
  const cls = ms <= 0 || h < 24 ? "border-red-200 bg-red-50 text-red-800" : h < 48 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <div className={`flex items-center gap-1.5 border-b px-4 py-1.5 text-sm ${cls}`} title="After this the offer can't be sent: it's too close to kickoff.">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.5V8l2.4 1.6" strokeLinecap="round" />
      </svg>
      <span>
        Send by <b>{fmtDate(expiresAt)}</b> · {left}
      </span>
    </div>
  );
}

export type CardMode = "view" | "edit" | "reject";

export function OfferCard({
  p,
  onChange,
  now,
  initialMode = "view",
  onDone,
}: {
  p: ProposalView;
  onChange: () => Promise<void>;
  now: string;
  /** Open straight into edit or reject (keyboard shortcuts in the split pane). */
  initialMode?: CardMode;
  /** Called after an approve, reject or edit succeeds (the split pane moves to the next item). */
  onDone?: (action: "approved" | "rejected" | "edited") => void;
}) {
  const [mode, setMode] = useState<CardMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; problems: string[] } | null>(null);
  const prop = p.proposal!;
  const f = prop.facts;
  const segment = p.reasonCodes.map((c) => SEGMENTS[c]).find(Boolean);
  const lapsed = isLapsed(p, now);
  const [statusLabel, statusCls] = STATUS[lapsed ? "expired" : p.status];
  const actionable = OPEN.includes(p.status) && !lapsed;

  const act = async (fn: () => Promise<unknown>, done?: "approved" | "rejected" | "edited") => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setMode("view");
      await onChange();
      if (done) onDone?.(done);
    } catch (e) {
      setErr({ message: (e as Error).message, problems: (e as { problems?: string[] }).problems ?? [] });
    } finally {
      setBusy(false);
    }
  };

  // Identity/merge notes move to "Source data"; the "why" keeps only the business reasons.
  const reasons = p.reason
    .replace(/\.$/, "")
    .split("; ")
    .filter((s) => !/carts for the same match were merged|guest checkout matched/i.test(s))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));

  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {actionable && <SendBy expiresAt={prop.expiresAt} now={now} />}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-base font-semibold">
            {describeOffer(prop.offer)} <span className="font-normal text-slate-500">via</span> {describeChannel(prop.channel)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
            <span>
              Fan {p.fanId}
              {segment ? ` · ${segment}` : ""}
            </span>
            <span>·</span>
            <span>
              {f.seats} seat{f.seats === 1 ? "" : "s"}, {f.section}, match in {f.daysToKickoff} days
            </span>
            <SellThrough pct={f.sectionSoldPct} />
            {prop.touchNumber === 2 && <Chip className="bg-orange-50 text-orange-700">Follow-up (2nd touch)</Chip>}
          </div>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right text-xs text-slate-500">
            <div>
              Cart <b className="text-sm text-slate-900">{money(prop.cartValueCents)}</b>
            </div>
            <CostLines costs={prop.costs ?? []} />
          </div>
          <Chip className={statusCls}>{statusLabel}</Chip>
        </div>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-[1.15fr_1fr]">
        <div>
          {mode === "edit" ? (
            <EditPanel p={p} busy={busy} onCancel={() => setMode("view")} onSave={(patch) => act(() => api(`/api/proposals/${p.id}`, { method: "PATCH", body: JSON.stringify(patch) }), "edited")} />
          ) : (
            p.status === "holdout" ? <HoldoutNote /> : <MessagePreview p={p} />
          )}
        </div>
        <div className="text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why</div>
          <ul className="mt-1 space-y-1 text-slate-700">
            {reasons.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-teal-600">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {p.statusDetail && (
        <div className={`mx-4 mb-3 rounded-lg px-3 py-2 text-sm ${["blocked", "failed"].includes(p.status) ? "bg-red-50 text-red-800" : "bg-slate-50 text-slate-600"}`}>{p.statusDetail}</div>
      )}
      {err && (
        <div className="mx-4 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          <b>{err.message}</b>
          {err.problems.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {err.problems.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === "reject" && (
        <RejectPanel
          title={`${describeOffer(prop.offer)} via ${describeChannel(prop.channel)} · fan ${p.fanId}`}
          busy={busy}
          error={err?.message}
          onCancel={() => {
            setErr(null);
            setMode("view");
          }}
          onReject={(reason, note) => act(() => api(`/api/proposals/${p.id}/reject`, { method: "POST", body: JSON.stringify({ reason, note }) }), "rejected")}
        />
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <div className="flex flex-wrap gap-4">
          <SourceData p={p} />
          <AuditTrail p={p} />
        </div>
        {actionable && mode === "view" && (
          <div className="flex gap-2">
            <button onClick={() => setMode("reject")} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200">
              Reject
            </button>
            {p.status !== "failed" && (
              <button onClick={() => setMode("edit")} disabled={busy} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100">
                Edit
              </button>
            )}
            {p.status !== "blocked" && (
              <button onClick={() => act(() => api(`/api/proposals/${p.id}/approve`, { method: "POST" }), "approved")} disabled={busy} className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60">
                {busy ? "Sending…" : p.status === "failed" ? "Retry send" : prop.channel === "sales_task" ? "Approve → create sales task" : "Approve & send"}
              </button>
            )}
          </div>
        )}
      </footer>
    </article>
  );
}

export function CopyBadge({ p }: { p: ProposalView }) {
  if (p.copySource === "model") return <Chip className="bg-purple-50 text-purple-700">Drafted by Claude · passed checks</Chip>;
  if (p.copySource === "marketer") return <Chip className="bg-slate-100 text-slate-700">Edited by marketer</Chip>;
  const why: Record<string, string> = {
    model_disabled: "model off",
    model_error: "Claude unavailable",
    model_timeout: "Claude timed out",
    schema_invalid: "Claude output malformed",
    lint_failed: "Claude draft broke a rule",
  };
  return (
    <span title={p.copyNotes.join("\n")}>
      <Chip className="bg-slate-100 text-slate-700">Template copy{p.copyFallbackReason ? ` · ${why[p.copyFallbackReason] ?? p.copyFallbackReason}` : ""}</Chip>
    </span>
  );
}

export function highlight(text: string) {
  return text.split(PROMO_PLACEHOLDER).flatMap((part, i, arr) =>
    i < arr.length - 1
      ? [part, <code key={i} className="rounded bg-amber-100 px-1 text-[11px] text-amber-900" title="A single-use code is minted at send time">CODE</code>]
      : [part],
  );
}

export function MessagePreview({ p }: { p: ProposalView }) {
  const c = p.copy;
  const ch = p.proposal!.channel;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{ch === "sales_task" ? "Task for the salesperson" : "What the fan will see"}</div>
        <CopyBadge p={p} />
      </div>
      {!c ? (
        <p className="text-sm text-red-700">No copy.</p>
      ) : ch === "push" ? (
        <div className="mx-auto max-w-sm rounded-2xl bg-slate-800 p-3 text-white shadow-inner">
          <div className="flex items-center gap-2 text-[11px] text-slate-300">
            <span className="h-4 w-4 rounded bg-teal-500" /> SEAWOLVES · now
          </div>
          <div className="mt-1 text-sm font-semibold">{highlight(c.subject)}</div>
          <div className="text-sm text-slate-200">{highlight(c.body)}</div>
        </div>
      ) : ch === "email" ? (
        <div className="rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-2 text-sm">
            <span className="text-slate-500">Subject: </span>
            <b>{highlight(c.subject)}</b>
          </div>
          <div className="whitespace-pre-line px-3 py-2 text-sm text-slate-700">{highlight(c.body)}</div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm">
          <div className="font-semibold">{c.subject}</div>
          <div className="mt-1 whitespace-pre-line text-slate-700">{c.body}</div>
        </div>
      )}
      {p.copySource === "template" && p.copyNotes.length > 0 && <p className="text-xs text-slate-500">Model note: {p.copyNotes.join(" ")}</p>}
    </div>
  );
}

export function EditPanel({ p, busy, onSave, onCancel }: { p: ProposalView; busy: boolean; onSave: (patch: object) => void; onCancel: () => void }) {
  const prop = p.proposal!;
  const [type, setType] = useState<Offer["type"]>(prop.offer.type);
  const [percent, setPercent] = useState<number>("percentOff" in prop.offer ? prop.offer.percentOff : 10);
  const [channel, setChannel] = useState<Channel>(prop.channel);
  const [subject, setSubject] = useState(p.copy?.subject ?? "");
  const [body, setBody] = useState(p.copy?.body ?? "");
  const structuralChange = type !== prop.offer.type || channel !== prop.channel || ("percentOff" in prop.offer && percent !== prop.offer.percentOff);
  const copyChanged = subject !== p.copy?.subject || body !== p.copy?.body;

  // The server fills a merch voucher's cap from the team setting; the UI never invents one.
  const offer = (): object =>
    type === "reminder"
      ? { type }
      : type === "perk"
        ? prop.offer.type === "perk"
          ? prop.offer
          : { type, perkId: "pitchside-access", label: "Pre-match pitch-side access for your group" }
        : type === "merch_addon"
          ? { type, percentOff: percent, singleUse: true, ...(prop.offer.type === "merch_addon" ? { maxValueCents: prop.offer.maxValueCents } : {}) }
          : { type, percentOff: percent, singleUse: true };

  const save = () => {
    const patch: Record<string, unknown> = {};
    if (structuralChange) Object.assign(patch, { offer: offer(), channel });
    if (copyChanged) patch.copy = { subject, body };
    onSave(patch);
  };

  const field = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-600 focus:outline-none";
  return (
    <div className="space-y-2 rounded-lg border border-teal-200 bg-teal-50/30 p-3 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-1">
          <span className="text-xs text-slate-500">Offer</span>
          <select className={field} value={type} onChange={(e) => setType(e.target.value as Offer["type"])}>
            <option value="reminder">Reminder (no discount)</option>
            <option value="promo_code">Promo code</option>
            <option value="merch_addon">Merch add-on</option>
            <option value="perk">Perk (sales call)</option>
          </select>
        </label>
        <label>
          <span className="text-xs text-slate-500">% off (max 15)</span>
          <input type="number" min={1} max={15} disabled={type === "reminder" || type === "perk"} className={field} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
        </label>
        <label>
          <span className="text-xs text-slate-500">Channel</span>
          <select className={field} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            <option value="email">Email {p.consent?.email ? "" : "(opted out)"}</option>
            <option value="push">Push {p.consent?.push ? "" : "(opted out)"}</option>
            <option value="sales_task">Sales call</option>
          </select>
        </label>
      </div>
      {type === "merch_addon" && <p className="text-xs text-amber-800">Merch vouchers are capped by the team setting, and the message must tell the fan the cap (&quot;up to $…&quot;).</p>}
      {structuralChange && !copyChanged && <p className="text-xs text-teal-800">Offer or channel changed: the message will be rewritten from the safe template. Edit it after saving.</p>}
      <label className="block">
        <span className="text-xs text-slate-500">Subject / title</span>
        <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={structuralChange} />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">
          Body {type === "promo_code" || type === "merch_addon" ? <>(keep <code>{PROMO_PLACEHOLDER}</code> where the code goes)</> : null}
        </span>
        <textarea rows={5} className={field} value={body} onChange={(e) => setBody(e.target.value)} disabled={structuralChange} />
      </label>
      <p className="text-xs text-slate-500">Every save is checked against the guardrails (15% cap, single-use, opt-ins, no invented numbers or prices).</p>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-200">
          Cancel
        </button>
        <button onClick={save} disabled={busy || (!structuralChange && !copyChanged)} className="rounded-md bg-teal-700 px-3 py-1.5 font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
          Save changes
        </button>
      </div>
    </div>
  );
}

export function RejectPanel({
  title,
  busy,
  error,
  onReject,
  onCancel,
}: {
  /** What is being rejected, e.g. "Reminder via email · fan F-511". */
  title: string;
  busy: boolean;
  error?: string;
  onReject: (reason: string, note: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // A native modal dialog: backdrop, focus kept inside, and Esc fires "cancel". Opened on mount, so the
  // R shortcut and the Reject button behave the same, and the card's position on the page doesn't matter.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-label="Reject offer"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      // A click on the backdrop lands on the <dialog> element itself: treat it as Cancel.
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel();
      }}
      // Keys typed in the dialog must not reach the split pane's J/K/A/E/R/Esc shortcuts behind it.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "SELECT") {
          // Browsers only submit on Enter from a text input; the select is where the focus starts.
          e.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-sm text-slate-900 shadow-xl backdrop:bg-slate-900/40"
    >
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && reason) onReject(reason, note.trim());
        }}
        className="space-y-3 p-4"
      >
        <div>
          <h3 className="text-base font-semibold">Reject this offer?</h3>
          <p className="mt-0.5 text-slate-600">{title}. Nothing is sent to the fan.</p>
        </div>
        <label className="block">
          <span className="block text-xs text-slate-500">Reason (required, feeds engine tuning)</span>
          <select required autoFocus className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="" disabled>
              Choose a reason…
            </option>
            <option value="wrong_offer">Wrong offer</option>
            <option value="wrong_fan">Shouldn&apos;t contact this fan</option>
            <option value="bad_copy">Copy isn&apos;t right</option>
            <option value="bad_timing">Bad timing</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-slate-500">Note (optional)</span>
          <input className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-red-800">{error}</div>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-slate-400">Enter to reject · Esc to close without rejecting</span>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="rounded-md bg-slate-800 px-3 py-1.5 font-semibold text-white disabled:opacity-60">
              {busy ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

export const RAW_COLUMNS: [keyof RawCartRow, string][] = [
  ["cartId", "Cart"],
  ["fanId", "Fan ID"],
  ["source", "Source"],
  ["match", "Match"],
  ["seats", "Seats"],
  ["section", "Section"],
  ["sectionSoldPct", "Sold %"],
  ["cartValue", "Value"],
  ["abandoned", "Abandoned"],
  ["lifetimeTickets", "Lifetime tix"],
  ["lastPurchase", "Last purchase"],
  ["shopSpend12mo", "Shop 12 mo"],
  ["seasonPass", "Season pass"],
  ["emailOptIn", "Email opt-in"],
  ["pushOptIn", "Push opt-in"],
];

/** The export rows exactly as received, so a marketer can check the engine against the data. */
export function SourceData({ p }: { p: ProposalView }) {
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer select-none">
        Source data ({p.rawCarts.length} cart{p.rawCarts.length === 1 ? "" : "s"})
      </summary>
      <div className="mt-2 space-y-1">
        {p.reasonCodes.includes("MERGED_DUPLICATE_CARTS") && <p>These carts are for the same fan and match, so they were merged into one offer. The fan gets one message, not {p.rawCarts.length}.</p>}
        {p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL") && <p>The guest checkout&apos;s email exactly matches this fan&apos;s account, so it was linked. Without an exact match it would be held, not guessed.</p>}
        <p>Opt-ins right now: email {p.consent?.email ? "yes" : "no"}, push {p.consent?.push ? "yes" : "no"} (re-checked at send).</p>
        <div className="max-w-full overflow-x-auto">
          <table className="mt-1 border-collapse text-[11px]">
            <thead>
              <tr>
                {RAW_COLUMNS.map(([, h]) => (
                  <th key={h} className="border border-slate-200 bg-slate-100 px-1.5 py-1 text-left font-medium whitespace-nowrap text-slate-600">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rawCarts.map((c) => (
                <tr key={c.cartId}>
                  {RAW_COLUMNS.map(([k]) => {
                    const v = String(c[k] ?? "");
                    const bad = /^(unknown|not synced)$/i.test(v);
                    return (
                      <td key={k} className={`border border-slate-200 px-1.5 py-1 whitespace-nowrap ${bad ? "bg-amber-50 text-amber-800" : "text-slate-700"}`}>
                        {v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export function AuditTrail({ p }: { p: ProposalView }) {
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer select-none">History ({p.audit.length})</summary>
      <ol className="mt-1 space-y-0.5">
        {p.audit.map((a, i) => (
          <li key={i}>
            <span className="text-slate-400">{new Date(a.at).toLocaleTimeString()}</span> · {a.actor} · <b>{a.action.replace(/_/g, " ")}</b>
            {a.action === "edited" ? " (before/after saved)" : a.detail ? ` · ${JSON.stringify(a.detail).slice(0, 140)}` : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
