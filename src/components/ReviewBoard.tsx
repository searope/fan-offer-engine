"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProposalView } from "@/server/service";
import { describeChannel } from "@/engine/reasons";
import { api, Chip, costShort, money, OfferCard, STATUS, SEGMENTS, timeLeft, type CardMode } from "@/components/offer-card";
import { buildBoard, cellKey, isRoutine, judgmentReason, splitSlice, spotCheck, type BoardColumns } from "@/components/board";
import { summarize } from "@/components/queueView";

/**
 * "Needs review" for a marketer with hundreds of offers: a board of slices instead of one long list.
 *  1. Board: matches x offer type (or offer type x deadline lane), each cell a slice with totals.
 *  2. Slice, exceptions first: routine reminders collapse into one batch with a spot-check sample;
 *     only items needing judgment are listed one by one.
 *  3. Split pane: list on the left, full card on the right, keyboard J/K/A/E/R.
 */
type Slice =
  | { kind: "cell"; row: string; col: string }
  | { kind: "row"; row: string }
  | { kind: "judgment" }
  | { kind: "status"; status: "blocked" | "failed" }
  | { kind: "all" };

export function ReviewBoard({ proposals, now, onChange }: { proposals: ProposalView[]; now: string; onChange: () => Promise<void> }) {
  const [columns, setColumns] = useState<BoardColumns>("offer");
  const [slice, setSlice] = useState<Slice | null>(null);
  const board = useMemo(() => buildBoard(proposals, columns, now), [proposals, columns, now]);

  if (slice) {
    const { items, title } = resolveSlice(slice, proposals, board);
    return <SliceView key={JSON.stringify(slice)} title={title} items={items} now={now} onChange={onChange} onBack={() => setSlice(null)} />;
  }

  const judgment = proposals.filter((p) => !isRoutine(p)).length;
  const by = (s: string) => proposals.filter((p) => p.status === s).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Columns</span>
        <div className="flex overflow-hidden rounded-md border border-slate-300">
          {(["offer", "deadline"] as const).map((c) => (
            <button key={c} onClick={() => setColumns(c)} className={`px-2 py-1 ${columns === c ? "bg-teal-700 text-white" : "bg-white"}`}>
              {c === "offer" ? "Offer type" : "Deadline"}
            </button>
          ))}
        </div>
        <span className="ml-2 text-slate-500">Jump to:</span>
        <ChipButton onClick={() => setSlice({ kind: "judgment" })} cls="border-amber-300 bg-amber-50 text-amber-900">
          Needs judgment ({judgment})
        </ChipButton>
        {by("failed") > 0 && (
          <ChipButton onClick={() => setSlice({ kind: "status", status: "failed" })} cls="border-red-300 bg-red-50 text-red-800">
            Send failed ({by("failed")})
          </ChipButton>
        )}
        {by("blocked") > 0 && (
          <ChipButton onClick={() => setSlice({ kind: "status", status: "blocked" })} cls="border-red-300 bg-red-50 text-red-800">
            Blocked ({by("blocked")})
          </ChipButton>
        )}
        <ChipButton onClick={() => setSlice({ kind: "all" })} cls="border-slate-300 bg-white text-slate-700">
          Everything ({proposals.length})
        </ChipButton>
      </div>

      {proposals.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">Nothing to review.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-3 py-2 font-medium">{columns === "offer" ? "Match" : "Offer"}</th>
                {board.cols.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">All</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => {
                const rowItems = Object.values(board.cells).filter((c) => c.rowKey === r.key).flatMap((c) => c.items);
                return (
                  <tr key={r.key} className="border-t border-slate-100 align-top">
                    <th className="px-3 py-2 text-left font-semibold text-slate-800">{r.label}</th>
                    {board.cols.map((c) => {
                      const cell = board.cells[cellKey(r.key, c.key)];
                      return (
                        <td key={c.key} className="p-1.5">
                          {cell ? <CellButton items={cell.items} judgment={cell.judgment} earliest={cell.earliestDeadline} now={now} onClick={() => setSlice({ kind: "cell", row: r.key, col: c.key })} /> : <div className="px-2 py-3 text-center text-slate-300">—</div>}
                        </td>
                      );
                    })}
                    <td className="p-1.5">
                      <CellButton items={rowItems} judgment={rowItems.filter((p) => !isRoutine(p)).length} earliest={rowItems.map((p) => p.proposal!.expiresAt).sort()[0]} now={now} onClick={() => setSlice({ kind: "row", row: r.key })} muted />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Click a cell to work that slice. Routine reminders inside it collapse into one batch with a spot-check; only discounts, perks, blocked sends and guest-linked fans are listed one by one.
      </p>
    </div>
  );
}

function resolveSlice(s: Slice, ps: ProposalView[], board: ReturnType<typeof buildBoard>): { items: ProposalView[]; title: string } {
  const rowLabel = (k: string) => board.rows.find((r) => r.key === k)?.label ?? k;
  const colLabel = (k: string) => board.cols.find((c) => c.key === k)?.label ?? k;
  switch (s.kind) {
    case "cell":
      return { items: board.cells[cellKey(s.row, s.col)]?.items ?? [], title: `${rowLabel(s.row)} · ${colLabel(s.col)}` };
    case "row":
      return { items: Object.values(board.cells).filter((c) => c.rowKey === s.row).flatMap((c) => c.items), title: rowLabel(s.row) };
    case "judgment":
      return { items: ps.filter((p) => !isRoutine(p)), title: "Needs judgment" };
    case "status":
      return { items: ps.filter((p) => p.status === s.status), title: s.status === "failed" ? "Send failed" : "Blocked" };
    case "all":
      return { items: ps, title: "Everything" };
  }
}

function ChipButton({ children, onClick, cls }: { children: React.ReactNode; onClick: () => void; cls: string }) {
  return (
    <button onClick={onClick} className={`rounded-full border px-2.5 py-0.5 font-medium hover:brightness-95 ${cls}`}>
      {children}
    </button>
  );
}

function CellButton({ items, judgment, earliest, now, onClick, muted }: { items: ProposalView[]; judgment: number; earliest: string; now: string; onClick: () => void; muted?: boolean }) {
  const s = summarize(items);
  const t = timeLeft(earliest, now);
  return (
    <button onClick={onClick} className={`w-full min-w-36 rounded-md border px-2.5 py-2 text-left hover:border-teal-500 hover:bg-teal-50/40 ${muted ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-slate-900">{s.count}</span>
        <span className={`text-[11px] font-medium ${t.cls}`}>{t.label}</span>
      </div>
      <div className="text-[11px] text-slate-500">carts {money(s.cartValueCents)}</div>
      {(s.ticketDiscountCents > 0 || s.merchVoucherMaxCents > 0 || s.perks > 0) && (
        <div className="text-[11px] text-slate-600">
          {[s.ticketDiscountCents ? `−${money(s.ticketDiscountCents)} ticket` : "", s.merchVoucherMaxCents ? `≤${money(s.merchVoucherMaxCents)} vouchers` : "", s.perks ? `${s.perks} perk${s.perks === 1 ? "" : "s"}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {judgment > 0 && <div className="mt-0.5 text-[11px] font-medium text-amber-700">{judgment} need judgment</div>}
    </button>
  );
}

// ---------------------------------------------------------------------------

function SliceView({ title, items, now, onChange, onBack }: { title: string; items: ProposalView[]; now: string; onChange: () => Promise<void>; onBack: () => void }) {
  const { routine, judgment } = useMemo(() => splitSlice(items), [items]);
  const [showRoutine, setShowRoutine] = useState(false);
  const list = useMemo(() => (showRoutine ? [...judgment, ...routine] : judgment), [showRoutine, judgment, routine]);
  const [selectedId, setSelectedId] = useState<number | null>(list[0]?.id ?? null);
  const [mode, setMode] = useState<{ mode: CardMode; nonce: number }>({ mode: "view", nonce: 0 });
  const [msg, setMsg] = useState<string | null>(null);

  // Keep a valid selection as items leave the list (approved, rejected): stay at the same position.
  const [lastIndex, setLastIndex] = useState(0);
  const selIndex = list.findIndex((p) => p.id === selectedId);
  const current = selIndex >= 0 ? list[selIndex] : list[Math.min(lastIndex, list.length - 1)];
  const select = useCallback(
    (i: number) => {
      const p = list[Math.max(0, Math.min(i, list.length - 1))];
      if (!p) return;
      setSelectedId(p.id);
      setLastIndex(list.indexOf(p));
      setMode({ mode: "view", nonce: 0 });
    },
    [list],
  );
  const idx = current ? list.indexOf(current) : -1;

  const approveCurrent = useCallback(async () => {
    if (!current || current.status !== "pending_review") return;
    setMsg(null);
    try {
      await api(`/api/proposals/${current.id}/approve`, { method: "POST" });
      setLastIndex(idx);
      setSelectedId(null);
      await onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, [current, idx, onChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "arrowdown") {
        e.preventDefault();
        select(idx + 1);
      } else if (k === "k" || k === "arrowup") {
        e.preventDefault();
        select(idx - 1);
      } else if (k === "a") {
        e.preventDefault();
        void approveCurrent();
      } else if (k === "e" || k === "r") {
        e.preventDefault();
        setMode((m) => ({ mode: k === "e" ? "edit" : "reject", nonce: m.nonce + 1 }));
      } else if (k === "escape") {
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, select, approveCurrent, onBack]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-100">
          ← Board
        </button>
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-slate-500">
          {items.length} offer{items.length === 1 ? "" : "s"} · {judgment.length} need judgment · {routine.length} routine
        </span>
        <span className="ml-auto text-xs text-slate-400">Keys: J/K move · A approve · E edit · R reject · Esc back</span>
      </div>

      {routine.length > 0 && <BatchCard routine={routine} onChange={onChange} onShow={(id) => { setShowRoutine(true); setSelectedId(id); }} showing={showRoutine} onToggle={() => setShowRoutine(!showRoutine)} />}
      {msg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{msg}</div>}

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/40 p-8 text-center text-sm text-emerald-800">
          {routine.length ? "Nothing here needs judgment. Approve the batch above, or list it to review one by one." : "All done in this slice."}{" "}
          <button className="underline" onClick={onBack}>
            Back to the board
          </button>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[22rem_1fr]">
          {/* Side by side, the card sets the row height: the list is taken out of flow (absolute) and scrolls
              inside exactly that height. Stacked on narrow screens, it gets a capped height instead. */}
          <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-white lg:min-h-64">
            <div className="max-h-[60vh] overflow-y-auto lg:absolute lg:inset-0 lg:max-h-none">
            {list.map((p, i) => {
              const t = timeLeft(p.proposal!.expiresAt, now);
              const [label, cls] = STATUS[p.status];
              const seg = p.reasonCodes.map((c) => SEGMENTS[c]).find(Boolean);
              return (
                <button
                  key={p.id}
                  ref={p === current ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  onClick={() => select(i)}
                  className={`flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 ${p === current ? "bg-teal-50" : "hover:bg-slate-50"}`}
                >
                  <span className={`w-14 shrink-0 text-xs font-medium ${t.cls}`}>{t.label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {p.fanId} <span className="text-xs font-normal text-slate-500">{seg}</span>
                    </span>
                    <span className="block truncate text-xs text-slate-600">
                      {costShort(p.proposal!.costs ?? [])} · {describeChannel(p.proposal!.channel).replace(" (task for the salesperson)", "")}
                    </span>
                    {judgmentReason(p) && <span className="block truncate text-[11px] font-medium text-amber-700">{judgmentReason(p)}</span>}
                  </span>
                  {p.status !== "pending_review" && <Chip className={cls}>{label}</Chip>}
                </button>
              );
            })}
            </div>
          </div>
          <div>
            {current && (
              <OfferCard
                key={`${current.id}:${mode.nonce}`}
                p={current}
                now={now}
                onChange={onChange}
                initialMode={mode.mode}
                onDone={() => {
                  setLastIndex(idx);
                  setSelectedId(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BatchCard({ routine, onChange, onShow, showing, onToggle }: { routine: ProposalView[]; onChange: () => Promise<void>; onShow: (id: number) => void; showing: boolean; onToggle: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const sample = spotCheck(routine);
  const channels = Object.entries(
    routine.reduce<Record<string, number>>((acc, p) => {
      const c = describeChannel(p.proposal!.channel);
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([c, n]) => `${n} ${c.toLowerCase()}`)
    .join(", ");

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: { ok: boolean }[] }>("/api/proposals/bulk-approve", { method: "POST", body: JSON.stringify({ ids: routine.map((p) => p.id) }) });
      const ok = r.results.filter((x) => x.ok).length;
      setResult(`${ok} sent${r.results.length - ok ? `, ${r.results.length - ok} not sent (now listed under needs judgment with the reason)` : ""}.`);
      setConfirming(false);
      await onChange();
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <b>
            {routine.length} routine reminder{routine.length === 1 ? "" : "s"}
          </b>{" "}
          <span className="text-slate-600">· no discount · {channels} · carts {money(summarize(routine).cartValueCents)}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={onToggle} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-100">
            {showing ? "Hide from list" : "Review one by one"}
          </button>
          {!confirming && (
            <button onClick={() => setConfirming(true)} className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800">
              Approve batch of {routine.length}…
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 text-xs text-slate-600">
        Spot-check before approving ({sample.length} picked at random):
        <ul className="mt-1 space-y-0.5">
          {sample.map((p) => (
            <li key={p.id}>
              <button className="text-left hover:underline" onClick={() => onShow(p.id)}>
                <span className="font-medium text-slate-800">{p.fanId}</span> · {describeChannel(p.proposal!.channel)} · “{p.copy?.subject ?? "no copy"}”
              </button>
            </li>
          ))}
        </ul>
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-white p-2">
          <span>Send {routine.length} reminders now? Each is still re-checked (opt-ins, already contacted, already bought, expiry) right before it sends.</span>
          <button onClick={() => setConfirming(false)} className="rounded-md px-3 py-1 text-xs text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={send} disabled={busy} className="rounded-md bg-teal-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60">
            {busy ? "Sending…" : `Confirm: send ${routine.length}`}
          </button>
        </div>
      )}
      {result && <div className="mt-2 text-xs text-slate-700">{result}</div>}
    </div>
  );
}

