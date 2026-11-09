"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProposalView, queue as queueFn } from "@/server/service";
import type { Channel, Offer } from "@/engine/types";
import { describeChannel, describeOffer } from "@/engine/reasons";
import { PROMO_PLACEHOLDER } from "@/engine/copy/lint";

type QueueData = ReturnType<typeof queueFn>;
type Tab = "review" | "sent" | "closed" | "not_actioned";

const ACTOR = "marketer@seawolves";
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", "x-actor": ACTOR, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { problems: (body.problems ?? []) as string[] });
  return body as T;
}

// ---------------------------------------------------------------------------

export function ReviewQueue() {
  const [data, setData] = useState<QueueData | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<QueueData>("/api/queue"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    let live = true;
    api<QueueData>("/api/queue")
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api("/api/runs", { method: "POST" });
      await load();
      setTab("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const groups = useMemo(() => {
    const ps = data?.proposals ?? [];
    return {
      review: ps.filter((p) => ["pending_review", "blocked", "failed"].includes(p.status)),
      sent: ps.filter((p) => p.status === "sent" || p.status === "approved"),
      closed: ps.filter((p) => p.status === "rejected" || p.status === "expired"),
      not_actioned: ps.filter((p) => p.status === "held" || p.status === "suppressed"),
    };
  }, [data]);

  if (!data) return <div className="p-10 text-slate-500">{error ?? "Loading…"}</div>;
  const m = data.metrics;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Seattle Seawolves · Fan offers</p>
          <h1 className="text-2xl font-semibold">Cart win-back: review queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Nothing reaches a fan until you approve it. Clock: <span className="font-medium text-slate-700">{fmtDate(data.now)}</span>
            {data.lastRun && <> · last run #{data.lastRun.id} · copy model: {data.lastRun.modelName}</>}
          </p>
        </div>
        <button onClick={run} disabled={running} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-60">
          {running ? "Running… (drafting copy with Claude)" : "Run engine on stale carts"}
        </button>
      </header>

      {error && <Banner level="error" message={error} />}
      <div className="mt-4 space-y-2">
        {m.alerts.map((a, i) => (
          <Banner key={i} level={a.level} message={a.message} />
        ))}
      </div>

      <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Needs review" value={String(m.counts.pending + m.counts.blocked + m.counts.failed)} />
        <Kpi label="Sent" value={String(m.counts.sent)} />
        <Kpi label="Cart value reached" value={money(m.revenueAtStakeCents)} hint="Value of carts behind sent offers" />
        <Kpi label="Discount committed" value={money(m.discountCommittedCents)} hint="Max give-away if every sent code is redeemed" />
        <Kpi label="Approval rate" value={pct(m.approvalRate)} hint="Approved ÷ decided" />
        <Kpi label="Edit rate" value={pct(m.editRate)} hint="Edited before approval. High = engine or copy needs tuning" />
        <Kpi label="Claude-written copy" value={pct(m.modelCopyShare)} hint="Rest is safe template copy" />
      </section>

      <nav className="mt-6 flex gap-1 border-b border-slate-200 text-sm">
        {(
          [
            ["review", `Needs review (${groups.review.length})`],
            ["sent", `Sent (${groups.sent.length})`],
            ["closed", `Rejected / expired (${groups.closed.length})`],
            ["not_actioned", `No offer (${groups.not_actioned.length})`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-teal-700 font-semibold text-teal-800" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </nav>

      <main className="mt-4 space-y-4">
        {groups[tab].length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            {data.lastRun ? "Nothing here." : "No runs yet. Click “Run engine on stale carts”."}
          </p>
        )}
        {tab === "not_actioned"
          ? groups.not_actioned.map((p) => <NoOfferRow key={p.id} p={p} />)
          : groups[tab].map((p) => <OfferCard key={p.id} p={p} onChange={load} />)}
      </main>

      {data.lastRun?.stats && <DataIssues issues={(data.lastRun.stats as { dataIssues: { cartId: string; field: string; raw: string; issue: string }[] }).dataIssues} />}
      <DemoControls data={data} onChange={load} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Banner({ level, message }: { level: "error" | "warn" | "info"; message: string }) {
  const cls = level === "error" ? "border-red-300 bg-red-50 text-red-800" : level === "warn" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-900";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{message}</div>;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

const SEGMENTS: Record<string, string> = { SEASON_PASS_HOLDER: "Season-pass holder", NEW_FAN: "First-time buyer", LAPSED_FAN: "Lapsed fan", REGULAR_FAN: "Regular fan" };
const STATUS: Record<string, [string, string]> = {
  pending_review: ["Needs review", "bg-amber-100 text-amber-900"],
  blocked: ["Blocked", "bg-red-100 text-red-800"],
  failed: ["Send failed", "bg-red-100 text-red-800"],
  approved: ["Approved, sending", "bg-sky-100 text-sky-800"],
  sent: ["Sent", "bg-emerald-100 text-emerald-800"],
  rejected: ["Rejected", "bg-slate-200 text-slate-700"],
  expired: ["Expired", "bg-slate-200 text-slate-700"],
  held: ["Held", "bg-violet-100 text-violet-800"],
  suppressed: ["No offer", "bg-slate-200 text-slate-700"],
};

function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function SellThrough({ pct }: { pct: number }) {
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

function OfferCard({ p, onChange }: { p: ProposalView; onChange: () => Promise<void> }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; problems: string[] } | null>(null);
  const prop = p.proposal!;
  const f = prop.facts;
  const segment = p.reasonCodes.map((c) => SEGMENTS[c]).find(Boolean);
  const [statusLabel, statusCls] = STATUS[p.status];
  const actionable = ["pending_review", "blocked", "failed"].includes(p.status);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setMode("view");
      await onChange();
    } catch (e) {
      setErr({ message: (e as Error).message, problems: (e as { problems?: string[] }).problems ?? [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Fan {p.fanId}</span>
          {segment && <Chip className="bg-slate-100 text-slate-700">{segment}</Chip>}
          {p.reasonCodes.includes("MERGED_DUPLICATE_CARTS") && <Chip className="bg-indigo-50 text-indigo-700">{p.cartIds.length} carts merged</Chip>}
          {p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL") && <Chip className="bg-indigo-50 text-indigo-700">Guest checkout linked by email</Chip>}
          {prop.touchNumber === 2 && <Chip className="bg-orange-50 text-orange-700">2nd touch</Chip>}
          <span className="text-xs text-slate-400">{p.cartIds.join(", ")}</span>
        </div>
        <Chip className={statusCls}>{statusLabel}</Chip>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-[1fr_1.1fr]">
        {/* left: decision */}
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-700">
            <span>
              Match in <b>{f.daysToKickoff} days</b> · {f.section} · {f.seats} seat{f.seats === 1 ? "" : "s"}
            </span>
            <SellThrough pct={f.sectionSoldPct} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip className="bg-teal-50 text-teal-800 ring-1 ring-teal-200">{describeOffer(prop.offer)}</Chip>
            <Chip className="bg-slate-100 text-slate-700">{describeChannel(prop.channel)}</Chip>
            {p.consent && (
              <span className="text-xs text-slate-500">
                Opt-ins: email {p.consent.email ? "✓" : "✗"} · push {p.consent.push ? "✓" : "✗"}
              </span>
            )}
          </div>
          <div className="flex gap-6 text-xs text-slate-600">
            <span>
              Cart value <b className="text-slate-900">{money(prop.cartValueCents)}</b>
            </span>
            <span>
              Discount given <b className={prop.discountCostCents ? "text-rose-700" : "text-slate-900"}>{money(prop.discountCostCents)}</b>
            </span>
            <span>Expires {fmtDate(prop.expiresAt)}</span>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why this offer</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700">
              {p.reason
                .replace(/\.$/, "")
                .split("; ")
                .map((s, i) => (
                  <li key={i}>{s.charAt(0).toUpperCase() + s.slice(1)}</li>
                ))}
            </ul>
          </div>
        </div>

        {/* right: message */}
        <div>
          {mode === "edit" ? (
            <EditPanel p={p} busy={busy} onCancel={() => setMode("view")} onSave={(patch) => act(() => api(`/api/proposals/${p.id}`, { method: "PATCH", body: JSON.stringify(patch) }))} />
          ) : (
            <MessagePreview p={p} />
          )}
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

      {mode === "reject" && <RejectPanel busy={busy} onCancel={() => setMode("view")} onReject={(reason, note) => act(() => api(`/api/proposals/${p.id}/reject`, { method: "POST", body: JSON.stringify({ reason, note }) }))} />}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <AuditTrail p={p} />
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
              <button onClick={() => act(() => api(`/api/proposals/${p.id}/approve`, { method: "POST" }))} disabled={busy} className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60">
                {busy ? "Sending…" : p.status === "failed" ? "Retry send" : prop.channel === "sales_task" ? "Approve → create sales task" : "Approve & send"}
              </button>
            )}
          </div>
        )}
      </footer>
    </article>
  );
}

function CopyBadge({ p }: { p: ProposalView }) {
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

function highlight(text: string) {
  return text.split(PROMO_PLACEHOLDER).flatMap((part, i, arr) =>
    i < arr.length - 1
      ? [part, <code key={i} className="rounded bg-amber-100 px-1 text-[11px] text-amber-900" title="A single-use code is minted at send time">CODE</code>]
      : [part],
  );
}

function MessagePreview({ p }: { p: ProposalView }) {
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

function EditPanel({ p, busy, onSave, onCancel }: { p: ProposalView; busy: boolean; onSave: (patch: object) => void; onCancel: () => void }) {
  const prop = p.proposal!;
  const [type, setType] = useState<Offer["type"]>(prop.offer.type);
  const [percent, setPercent] = useState<number>("percentOff" in prop.offer ? prop.offer.percentOff : 10);
  const [channel, setChannel] = useState<Channel>(prop.channel);
  const [subject, setSubject] = useState(p.copy?.subject ?? "");
  const [body, setBody] = useState(p.copy?.body ?? "");
  const structuralChange = type !== prop.offer.type || channel !== prop.channel || ("percentOff" in prop.offer && percent !== prop.offer.percentOff);
  const copyChanged = subject !== p.copy?.subject || body !== p.copy?.body;

  const offer = (): Offer =>
    type === "reminder"
      ? { type }
      : type === "perk"
        ? prop.offer.type === "perk"
          ? prop.offer
          : { type, perkId: "pitchside-access", label: "Pre-match pitch-side access for your group" }
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

function RejectPanel({ busy, onReject, onCancel }: { busy: boolean; onReject: (reason: string, note: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("wrong_offer");
  const [note, setNote] = useState("");
  return (
    <div className="mx-4 mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <label>
        <span className="block text-xs text-slate-500">Why reject? (feeds engine tuning)</span>
        <select className="rounded-md border border-slate-300 px-2 py-1.5" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="wrong_offer">Wrong offer</option>
          <option value="wrong_fan">Shouldn&apos;t contact this fan</option>
          <option value="bad_copy">Copy isn&apos;t right</option>
          <option value="bad_timing">Bad timing</option>
          <option value="other">Other</option>
        </select>
      </label>
      <input className="min-w-48 flex-1 rounded-md border border-slate-300 px-2 py-1.5" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
      <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-200">
        Cancel
      </button>
      <button onClick={() => onReject(reason, note)} disabled={busy} className="rounded-md bg-slate-800 px-3 py-1.5 font-semibold text-white">
        Reject offer
      </button>
    </div>
  );
}

function AuditTrail({ p }: { p: ProposalView }) {
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

function NoOfferRow({ p }: { p: ProposalView }) {
  const [label, cls] = STATUS[p.status];
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
      <Chip className={cls}>{label}</Chip>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {p.fanId ? `Fan ${p.fanId}` : "Unidentified"} <span className="font-normal text-slate-400">· {p.cartIds.join(", ")}</span>
        </div>
        <div className="text-slate-600">{p.reason}</div>
      </div>
    </div>
  );
}

function DataIssues({ issues }: { issues: { cartId: string; field: string; raw: string; issue: string }[] }) {
  if (!issues?.length) return null;
  return (
    <details className="mt-8 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <summary className="cursor-pointer font-medium">Data quality: {issues.length} field(s) unreadable in the last export</summary>
      <p className="mt-1 text-xs text-slate-500">Unknown values are treated as unknown, never guessed. Opt-ins that aren&apos;t a clear “Yes” count as “No”.</p>
      <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        {issues.map((i, k) => (
          <li key={k}>
            <b>{i.cartId}</b> {i.field}: “{i.raw}” ({i.issue.replace("_", " ")})
          </li>
        ))}
      </ul>
    </details>
  );
}

function DemoControls({ data, onChange }: { data: QueueData; onChange: () => Promise<void> }) {
  const dev = async (body: object) => {
    await api("/api/dev", { method: "POST", body: JSON.stringify(body) });
    await onChange();
  };
  const fans = data.fans as { fanId: string; email: number; push: number }[];
  const tasks = data.salesTasks as { id: number; fanId: string; title: string; status: string }[];
  return (
    <details className="mt-4 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-600">Demo controls (not part of the product)</summary>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5" onClick={() => dev({ action: "reset" })}>
          Reset demo
        </button>
        <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5" onClick={() => dev({ action: "advance_clock", days: 4 })}>
          Advance clock 4 days
        </button>
        {(["email", "push"] as const).map((ch) => (
          <button key={ch} className={`rounded-md border px-3 py-1.5 ${data.outages[ch] ? "border-red-300 bg-red-50 text-red-800" : "border-slate-300 bg-white"}`} onClick={() => dev({ action: "set_outage", channel: ch, on: !data.outages[ch] })}>
            {data.outages[ch] ? `End ${ch} outage` : `Simulate ${ch} outage`}
          </button>
        ))}
      </div>
      <div className="mt-3">
        <div className="text-xs font-semibold uppercase text-slate-500">Fan opt-ins (live consent, re-checked at send)</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {fans.map((f) => (
            <div key={f.fanId} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs">
              {f.fanId}{" "}
              {(["email", "push"] as const).map((ch) => (
                <label key={ch} className="ml-1">
                  <input type="checkbox" checked={!!f[ch]} onChange={(e) => dev({ action: "set_consent", fanId: f.fanId, channel: ch, value: e.target.checked })} /> {ch}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
      {tasks.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Salesperson task list</div>
          <ul className="mt-1 text-xs">
            {tasks.map((t) => (
              <li key={t.id}>
                #{t.id} · {t.fanId} · {t.title} · {t.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
