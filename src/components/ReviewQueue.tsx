"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProposalView, queue as queueFn } from "@/server/service";
import type { Channel, CostLine, Offer, RawCartRow } from "@/engine/types";
import { describeChannel, describeOffer } from "@/engine/reasons";
import { PROMO_PLACEHOLDER } from "@/engine/copy/lint";
import { applyFilters, DEFAULT_FILTERS, groupProposals, type Filters, type Group, type GroupBy } from "@/components/queueView";

type QueueData = ReturnType<typeof queueFn>;
type Tab = "review" | "sent" | "rejected" | "expired" | "holdout" | "not_actioned";

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

const OPEN = ["pending_review", "blocked", "failed"];
/** Still open, but past its send-by time on the app's clock: it can't be sent any more. */
const isLapsed = (p: ProposalView, now: string) => OPEN.includes(p.status) && !!p.proposal && Date.parse(p.proposal.expiresAt) <= Date.parse(now);

// ---------------------------------------------------------------------------

export function ReviewQueue() {
  const [data, setData] = useState<QueueData | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [view, setView] = useState<"cards" | "compact">("cards");
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

  const run = async (overrideReason?: string) => {
    setRunning(true);
    setError(null);
    try {
      await api("/api/runs", { method: "POST", body: JSON.stringify(overrideReason ? { overrideReason } : {}) });
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
    const lapsed = (p: ProposalView) => !!data && isLapsed(p, data.now);
    return {
      // Only offers that can still be sent; most urgent first.
      review: ps
        .filter((p) => OPEN.includes(p.status) && !lapsed(p))
        .sort((a, b) => (a.proposal?.expiresAt ?? "").localeCompare(b.proposal?.expiresAt ?? "") || a.id - b.id),
      sent: ps.filter((p) => p.status === "sent" || p.status === "approved"),
      rejected: ps.filter((p) => p.status === "rejected"),
      // Marked expired by a run, or still open but past send-by on the app's clock (a send would be refused).
      expired: ps.filter((p) => p.status === "expired" || (OPEN.includes(p.status) && lapsed(p))),
      holdout: ps.filter((p) => p.status === "holdout"),
      not_actioned: ps.filter((p) => p.status === "held" || p.status === "suppressed"),
    };
  }, [data]);

  const visible = tab === "not_actioned" ? groups.not_actioned : applyFilters(groups[tab], filters);
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
        <button onClick={() => run()} disabled={running} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:opacity-60">
          {running ? "Running… (drafting copy with Claude)" : "Run engine on stale carts"}
        </button>
      </header>

      {error && <Banner level="error" message={error} />}
      {data.lastRun && <RunCheckBanner run={data.lastRun} running={running} onOverride={(reason) => run(reason)} />}
      <div className="mt-4 space-y-2">
        {m.alerts.map((a, i) => (
          <Banner key={i} level={a.level} message={a.message} />
        ))}
      </div>

      <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-9">
        <Kpi label="Needs review" value={String(groups.review.length)} />
        <Kpi label="Sent" value={String(m.counts.sent)} />
        <Kpi label="Cart value reached" value={money(m.revenueAtStakeCents)} hint="Value of carts behind sent offers" />
        <Kpi label="Ticket discount committed" value={money(m.ticketDiscountCommittedCents)} hint="Ticket revenue given away if every sent ticket code is used" />
        <Kpi
          label="Merch vouchers (max)"
          value={money(m.merchVoucherMaxCents)}
          hint={`Worst case if every sent voucher is used to its cap. Shop margin, not ticket revenue.${m.perksPromised ? ` Plus ${m.perksPromised} perk(s) promised.` : ""}`}
        />
        <Kpi label="Approval rate" value={pct(m.approvalRate)} hint="Approved ÷ decided" />
        <Kpi label="Edit rate" value={pct(m.editRate)} hint="Edited before approval. High = engine or copy needs tuning" />
        <Kpi label="Claude-written copy" value={pct(m.modelCopyShare)} hint="Rest is safe template copy" />
        <LiftKpi m={m.measurement} />
      </section>

      <nav className="mt-6 flex gap-1 border-b border-slate-200 text-sm">
        {(
          [
            ["review", `Needs review (${groups.review.length})`],
            ["sent", `Sent (${groups.sent.length})`],
            ["rejected", `Rejected (${groups.rejected.length})`],
            ["expired", `Expired (${groups.expired.length})`],
            ["holdout", `Holdout (${groups.holdout.length})`],
            ["not_actioned", `No offer (${groups.not_actioned.length})`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-teal-700 font-semibold text-teal-800" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </nav>

      <main className="mt-4 space-y-4">
        {tab !== "not_actioned" && (
          <QueueToolbar filters={filters} setFilters={setFilters} groupBy={groupBy} setGroupBy={setGroupBy} view={view} setView={setView} shown={visible.length} total={groups[tab].length} />
        )}
        {tab === "review" && <BulkReminderBar proposals={visible} onChange={load} />}
        {groups[tab].length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            {data.lastRun ? "Nothing here." : "No runs yet. Click “Run engine on stale carts”."}
          </p>
        )}
        {tab === "not_actioned"
          ? groups.not_actioned.map((p) => <NoOfferRow key={p.id} p={p} />)
          : groupProposals(visible, groupBy).map((g) => (
              <GroupBlock key={`${tab}:${groupBy}:${JSON.stringify(filters)}:${view}:${g.key}`} group={g} showHeader={groupBy !== "none"} view={view} now={data.now} onChange={load} />
            ))}
      </main>

      {data.lastRun?.stats && <DataIssues issues={(data.lastRun.stats as { dataIssues: { cartId: string; field: string; raw: string; issue: string }[] }).dataIssues} />}
      <DemoControls data={data} onChange={load} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Mirrors the server's bulkEligible(); the server re-checks every id anyway. */
const bulkEligible = (p: ProposalView) => p.status === "pending_review" && p.proposal?.offer.type === "reminder" && p.proposal.channel !== "sales_task";

function BulkReminderBar({ proposals, onChange }: { proposals: ProposalView[]; onChange: () => Promise<void> }) {
  const eligible = proposals.filter(bulkEligible);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: number; ok: boolean; error?: string }[] | null>(null);
  if (eligible.length < 2 && !result) return null;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: { id: number; ok: boolean; error?: string }[] }>("/api/proposals/bulk-approve", { method: "POST", body: JSON.stringify({ ids: eligible.map((p) => p.id) }) });
      setResult(r.results);
      setConfirming(false);
      await onChange();
    } catch (e) {
      setResult([{ id: 0, ok: false, error: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/50 px-4 py-3 text-sm">
      {result ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Bulk approve: <b>{result.filter((r) => r.ok).length} sent</b>
            {result.some((r) => !r.ok) && <span className="text-red-700">, {result.filter((r) => !r.ok).length} not sent (see the cards for why)</span>}
          </span>
          <button className="text-xs text-slate-500 underline" onClick={() => setResult(null)}>
            Dismiss
          </button>
        </div>
      ) : !confirming ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <b>{eligible.length} no-discount reminders</b> in this view are ready. Promos, merch codes and perks are always approved one by one.
          </span>
          <button onClick={() => setConfirming(true)} className="rounded-md border border-teal-700 bg-white px-3 py-1.5 font-semibold text-teal-800 hover:bg-teal-50">
            Approve all reminders…
          </button>
        </div>
      ) : (
        <div>
          <p className="font-medium">Send these {eligible.length} reminders now?</p>
          <ul className="mt-1 list-disc pl-5 text-slate-700">
            {eligible.map((p) => (
              <li key={p.id}>
                Fan {p.fanId}: {describeChannel(p.proposal!.channel)}, “{p.copy?.subject}”
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-slate-500">Each one is still re-checked (opt-ins, already contacted, expiry) right before it sends.</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirming(false)} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-200">
              Cancel
            </button>
            <button onClick={send} disabled={busy} className="rounded-md bg-teal-700 px-3 py-1.5 font-semibold text-white hover:bg-teal-800 disabled:opacity-60">
              {busy ? "Sending…" : `Confirm: send ${eligible.length}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SPEC §0: every run first checks the export it's about to trust. A failed check pauses the run
 * (nothing proposed, nothing sent). A person can run anyway, but only with a written reason, which is audited.
 */
function RunCheckBanner({ run, running, onOverride }: { run: NonNullable<QueueData["lastRun"]>; running: boolean; onOverride: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (run.status === "overridden" && run.contract) {
    return (
      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Run #{run.id} used an export that failed its checks ({run.contract.problems.map((p) => p.code.toLowerCase().replace(/_/g, " ")).join(", ")}). Run anyway by{" "}
        {run.contract.overriddenBy}: “{run.contract.overrideReason}”.
      </div>
    );
  }
  if (run.status !== "paused" || !run.contract) return null;
  return (
    <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
      <div className="font-semibold">Run #{run.id} paused: the cart export failed its checks. Nothing was proposed or sent.</div>
      <ul className="mt-1 list-disc pl-5">
        {run.contract.problems.map((p, i) => (
          <li key={i}>{p.message}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-red-800">The offer rules trust this export&apos;s sell-through and opt-ins. Fix the export and run again, or run anyway if you know why it&apos;s safe.</p>
      {!open ? (
        <button onClick={() => setOpen(true)} className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 text-red-800 hover:bg-red-100">
          Run anyway…
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="min-w-72 flex-1 rounded-md border border-red-300 bg-white px-2 py-1.5 text-slate-900"
            placeholder="Why is it safe? (required, logged)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 text-red-800 hover:bg-red-100">
            Cancel
          </button>
          <button
            onClick={() => onOverride(reason.trim())}
            disabled={running || reason.trim().length < 10}
            className="rounded-md bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800 disabled:opacity-50"
          >
            {running ? "Running…" : "Run anyway"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Offered vs held out: did offers make fans buy, or would they have bought anyway? */
function LiftKpi({ m }: { m: QueueData["metrics"]["measurement"] }) {
  const value = m.liftPts === null ? "—" : `${m.liftPts > 0 ? "+" : ""}${m.liftPts} pts`;
  const hint =
    `Cart completion within ${m.windowDays} days. Offered: ${m.offered.converted}/${m.offered.n}. Held out: ${m.holdout.converted}/${m.holdout.n}. ` +
    `Needs at least ${m.minPerGroup} in each group before the difference means anything.`;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">Lift vs holdout</div>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-slate-400">{m.enoughData ? `n = ${m.offered.n} / ${m.holdout.n}` : `too early (n = ${m.offered.n} / ${m.holdout.n})`}</div>
    </div>
  );
}

function HoldoutNote() {
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

const PAGE = 10;
const sel = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs";

function QueueToolbar(props: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  view: "cards" | "compact";
  setView: (v: "cards" | "compact") => void;
  shown: number;
  total: number;
}) {
  const { filters: f, setFilters } = props;
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters({ ...f, [k]: v });
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <label className="flex items-center gap-1">
        Group
        <select className={sel} value={props.groupBy} onChange={(e) => props.setGroupBy(e.target.value as GroupBy)}>
          <option value="none">None (by deadline)</option>
          <option value="match">Match</option>
          <option value="match_section">Match &amp; section</option>
          <option value="offer">Offer type</option>
        </select>
      </label>
      <select className={sel} value={f.offer} onChange={(e) => set("offer", e.target.value as Filters["offer"])} aria-label="Offer type">
        <option value="all">All offers</option>
        <option value="reminder">Reminders</option>
        <option value="promo_code">Ticket promo codes</option>
        <option value="merch_addon">Merch vouchers</option>
        <option value="perk">Perks</option>
      </select>
      <select className={sel} value={f.channel} onChange={(e) => set("channel", e.target.value as Filters["channel"])} aria-label="Channel">
        <option value="all">All channels</option>
        <option value="email">Email</option>
        <option value="push">Push</option>
        <option value="sales_task">Sales call</option>
      </select>
      <select className={sel} value={f.segment} onChange={(e) => set("segment", e.target.value as Filters["segment"])} aria-label="Fan segment">
        <option value="all">All fans</option>
        <option value="NEW_FAN">First-time buyers</option>
        <option value="REGULAR_FAN">Regular fans</option>
        <option value="LAPSED_FAN">Lapsed fans</option>
        <option value="SEASON_PASS_HOLDER">Season-pass holders</option>
      </select>
      <input className={`${sel} w-36`} placeholder="Fan or cart ID" value={f.q} onChange={(e) => set("q", e.target.value)} />
      {JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS) && (
        <button className="text-slate-500 underline" onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear
        </button>
      )}
      <span className="ml-auto">
        Showing {props.shown} of {props.total}
      </span>
      <div className="flex overflow-hidden rounded-md border border-slate-300">
        {(["cards", "compact"] as const).map((v) => (
          <button key={v} onClick={() => props.setView(v)} className={`px-2 py-1 ${props.view === v ? "bg-teal-700 text-white" : "bg-white"}`}>
            {v === "cards" ? "Cards" : "Compact"}
          </button>
        ))}
      </div>
    </div>
  );
}

function GroupBlock({ group, showHeader, view, now, onChange }: { group: Group; showHeader: boolean; view: "cards" | "compact"; now: string; onChange: () => Promise<void> }) {
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState(true);
  const s = group.summary;
  const items = group.items.slice(0, shown);
  return (
    <section className="space-y-3">
      {showHeader && (
        <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-200 pb-1 text-left text-sm">
          <span className="font-semibold text-slate-800">
            {open ? "▾" : "▸"} {group.label}
          </span>
          <span className="text-xs text-slate-500">
            {s.count} offer{s.count === 1 ? "" : "s"} · carts {money(s.cartValueCents)}
            {s.ticketDiscountCents ? ` · ticket discount ${money(s.ticketDiscountCents)}` : ""}
            {s.merchVoucherMaxCents ? ` · vouchers up to ${money(s.merchVoucherMaxCents)}` : ""}
            {s.perks ? ` · ${s.perks} perk${s.perks === 1 ? "" : "s"}` : ""}
          </span>
        </button>
      )}
      {open && (
        <>
          {view === "compact" ? (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {items.map((p) => (
                <CompactRow key={p.id} p={p} now={now} onChange={onChange} />
              ))}
            </div>
          ) : (
            items.map((p) => <OfferCard key={p.id} p={p} onChange={onChange} now={now} />)
          )}
          {group.items.length > shown && (
            <button className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-xs text-slate-600 hover:bg-slate-100" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, group.items.length - shown)} more ({group.items.length - shown} left)
            </button>
          )}
        </>
      )}
    </section>
  );
}

function timeLeft(expiresAt: string, now: string) {
  const ms = Date.parse(expiresAt) - Date.parse(now);
  const h = Math.floor(ms / 3_600_000);
  const label = ms <= 0 ? "expired" : h >= 48 ? `${Math.floor(h / 24)}d left` : h >= 1 ? `${h}h left` : "<1h left";
  const cls = ms <= 0 || h < 24 ? "text-red-700" : h < 48 ? "text-amber-700" : "text-slate-500";
  return { label, cls };
}

const costShort = (costs: CostLine[]) =>
  costs.length === 0
    ? "No discount"
    : costs.map((c) => (c.kind === "ticket_discount" ? `−${money(c.amountCents ?? 0)} ticket` : c.kind === "merch_voucher" ? `≤${money(c.amountCents ?? 0)} voucher` : "Perk")).join(", ");

/** One line per offer for scanning many; "Open" expands the full card for detail and editing. */
function CompactRow({ p, now, onChange }: { p: ProposalView; now: string; onChange: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prop = p.proposal!;
  const lapsed = isLapsed(p, now);
  const [statusLabel, statusCls] = STATUS[lapsed ? "expired" : p.status];
  const canApprove = p.status === "pending_review" && !lapsed;
  const segment = p.reasonCodes.map((c) => SEGMENTS[c]).find(Boolean);
  const t = timeLeft(prop.expiresAt, now);
  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/proposals/${p.id}/approve`, { method: "POST" });
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 px-3 py-2 text-sm md:grid-cols-[4.5rem_10rem_1fr_7rem_4.5rem_9rem_6.5rem_auto]">
        <span className={`text-xs font-medium ${OPEN.includes(p.status) ? t.cls : "text-slate-400"}`}>{OPEN.includes(p.status) ? t.label : "—"}</span>
        <span className="truncate">
          {p.fanId} <span className="text-xs text-slate-500">{segment}</span>
        </span>
        <span className="hidden truncate md:block">{describeOffer(prop.offer)}</span>
        <span className="hidden text-xs text-slate-600 md:block">{describeChannel(prop.channel).replace(" (task for the salesperson)", "")}</span>
        <span className="hidden text-right md:block">{money(prop.cartValueCents)}</span>
        <span className="hidden text-xs text-slate-600 md:block">{costShort(prop.costs ?? [])}</span>
        <span className="hidden md:block">
          <Chip className={statusCls}>{statusLabel}</Chip>
        </span>
        <span className="flex justify-end gap-1">
          {canApprove && (
            <button onClick={approve} disabled={busy} className="rounded bg-teal-700 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60">
              {busy ? "…" : prop.channel === "sales_task" ? "Task" : "Approve"}
            </button>
          )}
          <button onClick={() => setOpen(!open)} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
            {open ? "Close" : "Open"}
          </button>
        </span>
      </div>
      {err && <div className="px-3 pb-2 text-xs text-red-700">{err}</div>}
      {open && (
        <div className="bg-slate-50 p-3">
          <OfferCard p={p} onChange={onChange} now={now} />
        </div>
      )}
    </div>
  );
}

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
  holdout: ["Held out", "bg-violet-100 text-violet-800"],
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

/** One line per kind of cost. Never one "discount" number: ticket revenue, merch vouchers and perks are different money. */
function CostLines({ costs }: { costs: CostLine[] }) {
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
function SendBy({ expiresAt, now }: { expiresAt: string; now: string }) {
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

function OfferCard({ p, onChange, now }: { p: ProposalView; onChange: () => Promise<void>; now: string }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; problems: string[] } | null>(null);
  const prop = p.proposal!;
  const f = prop.facts;
  const segment = p.reasonCodes.map((c) => SEGMENTS[c]).find(Boolean);
  const lapsed = isLapsed(p, now);
  const [statusLabel, statusCls] = STATUS[lapsed ? "expired" : p.status];
  const actionable = OPEN.includes(p.status) && !lapsed;

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
            <EditPanel p={p} busy={busy} onCancel={() => setMode("view")} onSave={(patch) => act(() => api(`/api/proposals/${p.id}`, { method: "PATCH", body: JSON.stringify(patch) }))} />
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

      {mode === "reject" && <RejectPanel busy={busy} onCancel={() => setMode("view")} onReject={(reason, note) => act(() => api(`/api/proposals/${p.id}/reject`, { method: "POST", body: JSON.stringify({ reason, note }) }))} />}

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

const RAW_COLUMNS: [keyof RawCartRow, string][] = [
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
function SourceData({ p }: { p: ProposalView }) {
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
  const decidedFans = [...new Set(data.proposals.filter((p) => p.proposal && p.fanId).map((p) => p.fanId!))].sort();
  return (
    <details className="mt-4 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-600">Demo controls (not part of the product)</summary>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5" onClick={() => dev({ action: "reset" })}>
          Reset demo
        </button>
        <div className="flex overflow-hidden rounded-md border border-slate-300" title="Switching starts from a clean slate">
          {(["sample", "synthetic"] as const).map((d) => (
            <button key={d} onClick={() => dev({ action: "set_dataset", dataset: d })} className={`px-3 py-1.5 ${data.dataset === d ? "bg-slate-800 text-white" : "bg-white"}`}>
              {d === "sample" ? "Sample (8 carts)" : "Synthetic (~150 carts, template copy)"}
            </button>
          ))}
        </div>
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
          {fans.slice(0, 12).map((f) => (
            <div key={f.fanId} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs">
              {f.fanId}{" "}
              {(["email", "push"] as const).map((ch) => (
                <label key={ch} className="ml-1">
                  <input type="checkbox" checked={!!f[ch]} onChange={(e) => dev({ action: "set_consent", fanId: f.fanId, channel: ch, value: e.target.checked })} /> {ch}
                </label>
              ))}
            </div>
          ))}
          {fans.length > 12 && <span className="self-center text-xs text-slate-500">and {fans.length - 12} more</span>}
        </div>
      </div>
      {decidedFans.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Fan bought (stands in for a ticketing &quot;order completed&quot; event)</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {decidedFans.slice(0, 12).map((fanId) => (
              <button key={fanId} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs" onClick={() => dev({ action: "complete_cart", fanId })}>
                {fanId} bought
              </button>
            ))}
          </div>
        </div>
      )}
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
