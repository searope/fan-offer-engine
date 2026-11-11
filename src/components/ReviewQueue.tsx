"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProposalView, queue as queueFn } from "@/server/service";
import { describeChannel, describeOffer } from "@/engine/reasons";
import { api, bulkEligible, Chip, costShort, fmtDate, isLapsed, money, OfferCard, OPEN, SEGMENTS, STATUS, timeLeft } from "@/components/offer-card";
import { applyFilters, DEFAULT_FILTERS, groupProposals, type Filters, type Group, type GroupBy } from "@/components/queueView";
import { ReviewBoard } from "@/components/ReviewBoard";

type QueueData = ReturnType<typeof queueFn>;

type Tab = "review" | "sent" | "rejected" | "expired" | "holdout" | "not_actioned";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export function ReviewQueue() {
  const [data, setData] = useState<QueueData | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [view, setView] = useState<"cards" | "compact">("cards");
  const [reviewMode, setReviewMode] = useState<"board" | "list">("board");
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
        {tab === "review" && (
          <div className="flex justify-end">
            <div className="flex overflow-hidden rounded-md border border-slate-300 text-xs">
              {(["board", "list"] as const).map((m) => (
                <button key={m} onClick={() => setReviewMode(m)} className={`px-3 py-1 ${reviewMode === m ? "bg-slate-800 text-white" : "bg-white"}`}>
                  {m === "board" ? "Board" : "List"}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === "review" && reviewMode === "board" ? (
          <ReviewBoard proposals={groups.review} now={data.now} onChange={load} />
        ) : (
          <>
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
          </>
        )}
      </main>

      {data.lastRun?.stats && <DataIssues issues={(data.lastRun.stats as { dataIssues: { cartId: string; field: string; raw: string; issue: string }[] }).dataIssues} />}
      <DemoControls data={data} onChange={load} />
    </div>
  );
}

// ---------------------------------------------------------------------------

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
