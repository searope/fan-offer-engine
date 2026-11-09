import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { decide } from "@/engine/decide";
import { checkProposal, type GuardrailContext } from "@/engine/guardrails";
import { SAMPLE_AS_OF, SAMPLE_CARTS, SAMPLE_FAN_ACCOUNTS } from "@/engine/data/sample-carts";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import { draftCopy, type DraftedCopy } from "@/engine/copy/draft";
import { lintCopy, MessageCopySchema, PROMO_PLACEHOLDER, type MessageCopy } from "@/engine/copy/lint";
import { ClaudeAgentCopyModel, type CopyModel } from "@/engine/copy/model";
import { templateCopy } from "@/engine/copy/templates";
import type { Channel, ContactRecord, Decision, Offer, Proposal, RawCartRow, ReasonCode } from "@/engine/types";
import { DATA_DIR, db, getSetting, resetDb, setSetting, tx } from "./db";
import { providers } from "./delivery";

// ---------- clock ----------
/** Demo clock: the sample export's moment plus an offset you can advance from the UI. */
export function now(): string {
  return new Date(Date.parse(SAMPLE_AS_OF) + Number(getSetting("clock_offset_ms", "0"))).toISOString();
}

function copyModel(): CopyModel | null {
  return (process.env.COPY_MODEL_PROVIDER ?? "claude-agent-sdk") === "off" ? null : new ClaudeAgentCopyModel();
}

// ---------- views ----------
export type ProposalStatus = "pending_review" | "approved" | "sent" | "failed" | "blocked" | "rejected" | "expired" | "held" | "suppressed";

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: unknown;
}

export interface ProposalView {
  id: number;
  runId: number;
  decisionKey: string;
  tenantId: string | null;
  fanId: string | null;
  matchId: string;
  cartIds: string[];
  outcome: Decision["outcome"];
  reasonCodes: ReasonCode[];
  reason: string;
  proposal: Proposal | null;
  copy: MessageCopy | null;
  copySource: "model" | "template" | "marketer" | null;
  copyFallbackReason: DraftedCopy["fallbackReason"];
  copyNotes: string[];
  modelName: string | null;
  status: ProposalStatus;
  statusDetail: string | null;
  consent: { email: boolean; push: boolean } | null;
  /** The export rows behind this decision, unmodified (production: the carts table). */
  rawCarts: RawCartRow[];
  audit: AuditEntry[];
}

interface ProposalRow {
  id: number;
  run_id: number;
  decision_key: string;
  tenant_id: string | null;
  fan_id: string | null;
  match_id: string;
  cart_ids_json: string;
  outcome: Decision["outcome"];
  reason_codes_json: string;
  reason: string;
  proposal_json: string | null;
  copy_json: string | null;
  copy_source: ProposalView["copySource"];
  copy_fallback_reason: DraftedCopy["fallbackReason"];
  copy_notes_json: string | null;
  model_name: string | null;
  status: ProposalStatus;
  status_detail: string | null;
  idempotency_key: string | null;
}

const J = <T,>(s: string | null, d: T): T => (s ? (JSON.parse(s) as T) : d);

function consentOf(tenantId: string | null, fanId: string | null) {
  if (!tenantId || !fanId) return null;
  const r = db().prepare("SELECT email_opt_in, push_opt_in FROM fans WHERE tenant_id = ? AND fan_id = ?").get(tenantId, fanId) as
    | { email_opt_in: number; push_opt_in: number }
    | undefined;
  return r ? { email: !!r.email_opt_in, push: !!r.push_opt_in } : { email: false, push: false }; // unknown fan: fail closed
}

function toView(r: ProposalRow): ProposalView {
  const audit = (db().prepare("SELECT at, actor, action, detail_json FROM audit_log WHERE proposal_id = ? ORDER BY id").all(r.id) as {
    at: string;
    actor: string;
    action: string;
    detail_json: string | null;
  }[]).map((a) => ({ at: a.at, actor: a.actor, action: a.action, detail: J(a.detail_json, null) }));
  return {
    id: r.id,
    runId: r.run_id,
    decisionKey: r.decision_key,
    tenantId: r.tenant_id,
    fanId: r.fan_id,
    matchId: r.match_id,
    cartIds: J(r.cart_ids_json, []),
    outcome: r.outcome,
    reasonCodes: J(r.reason_codes_json, []),
    reason: r.reason,
    proposal: J(r.proposal_json, null),
    copy: J(r.copy_json, null),
    copySource: r.copy_source,
    copyFallbackReason: r.copy_fallback_reason,
    copyNotes: J(r.copy_notes_json, []),
    modelName: r.model_name,
    status: r.status,
    statusDetail: r.status_detail,
    consent: consentOf(r.tenant_id, r.fan_id),
    rawCarts: SAMPLE_CARTS.filter((c) => (J(r.cart_ids_json, []) as string[]).includes(c.cartId)),
    audit,
  };
}

function getRow(id: number): ProposalRow {
  const r = db().prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  if (!r) throw new HttpError(404, `Proposal ${id} not found`);
  return r;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public problems: string[] = [],
  ) {
    super(message);
  }
}

function audit(proposalId: number | null, actor: string, action: string, detail: unknown = null) {
  db().prepare("INSERT INTO audit_log(proposal_id, at, actor, action, detail_json) VALUES(?,?,?,?,?)").run(proposalId, new Date().toISOString(), actor, action, JSON.stringify(detail));
}

function setStatus(id: number, status: ProposalStatus, detail: string | null = null) {
  db().prepare("UPDATE proposals SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?").run(status, detail, new Date().toISOString(), id);
}

// ---------- fans (stand-in for the ticketing platform's fan/consent table) ----------
function seedFans() {
  const tenantByTeam = new Map(DEFAULT_TENANTS.map((t) => [t.teamName, t.tenantId]));
  const emailOf = new Map(SAMPLE_FAN_ACCOUNTS.map((a) => [a.fanId, a.email]));
  const agg = new Map<string, { tenantId: string; fanId: string; email: boolean; push: boolean }>();
  for (const c of SAMPLE_CARTS) {
    const tenantId = tenantByTeam.get(c.team);
    if (!tenantId || !/^F-\d+$/.test(c.fanId)) continue;
    const k = `${tenantId}:${c.fanId}`;
    const prev = agg.get(k) ?? { tenantId, fanId: c.fanId, email: true, push: true };
    agg.set(k, { ...prev, email: prev.email && c.emailOptIn === "Yes", push: prev.push && c.pushOptIn === "Yes" });
  }
  const ins = db().prepare("INSERT OR IGNORE INTO fans(tenant_id, fan_id, email, email_opt_in, push_opt_in, updated_at) VALUES(?,?,?,?,?,?)");
  for (const f of agg.values()) ins.run(f.tenantId, f.fanId, emailOf.get(f.fanId) ?? "", f.email ? 1 : 0, f.push ? 1 : 0, new Date().toISOString());
}

function contactHistory(): ContactRecord[] {
  return (db().prepare("SELECT tenant_id, fan_id, match_id, channel, offer_type, sent_at FROM contact_history").all() as {
    tenant_id: string;
    fan_id: string;
    match_id: string | null;
    channel: Channel;
    offer_type: Offer["type"];
    sent_at: string;
  }[]).map((r) => ({ tenantId: r.tenant_id, fanId: r.fan_id, matchId: r.match_id, channel: r.channel, offerType: r.offer_type, sentAt: r.sent_at }));
}

function guardCtx(tenantId: string | null, fanId: string | null): GuardrailContext {
  const tenant = DEFAULT_TENANTS.find((t) => t.tenantId === tenantId);
  if (!tenant) throw new HttpError(409, `Unknown tenant ${tenantId}`);
  return { tenant, consent: consentOf(tenantId, fanId) ?? { email: false, push: false }, asOf: now(), contactHistory: contactHistory() };
}

function asDecision(r: ProposalRow, proposal: Proposal): Decision {
  return {
    key: r.decision_key,
    tenantId: r.tenant_id,
    fanId: r.fan_id,
    matchId: r.match_id,
    cartIds: J(r.cart_ids_json, []),
    outcome: r.outcome,
    reasonCodes: J(r.reason_codes_json, []),
    reason: r.reason,
    proposal,
  };
}

/** Guardrails + copy lint. The single gate used by the engine self-check, every edit, and every send. */
function problemsFor(r: ProposalRow, proposal: Proposal, copy: MessageCopy | null): string[] {
  const v = checkProposal(asDecision(r, proposal), guardCtx(r.tenant_id, r.fan_id)).map((x) => x.message);
  if (!copy) v.push("No message copy.");
  else v.push(...lintCopy(copy, proposal.offer, proposal.channel, proposal.facts));
  return v;
}

// ---------- run ----------
export async function runEngine(actor: string) {
  seedFans();
  const asOf = now();
  const model = copyModel();
  const runId = Number(
    db().prepare("INSERT INTO runs(trigger, as_of, started_at, model_name) VALUES('cart_winback', ?, ?, ?)").run(asOf, new Date().toISOString(), model?.name ?? "off").lastInsertRowid,
  );
  // The cart export's opt-in columns are a snapshot; the fan record is the source of truth.
  // A channel counts as consented only if both say yes.
  const live = new Map(
    (db().prepare("SELECT fan_id, email_opt_in, push_opt_in FROM fans").all() as { fan_id: string; email_opt_in: number; push_opt_in: number }[]).map((f) => [f.fan_id, f]),
  );
  const carts = SAMPLE_CARTS.map((c) => {
    const f = live.get(c.fanId);
    return f ? { ...c, emailOptIn: c.emailOptIn === "Yes" && f.email_opt_in ? "Yes" : "No", pushOptIn: c.pushOptIn === "Yes" && f.push_opt_in ? "Yes" : "No" } : c;
  });
  const run = decide({ carts, fanAccounts: SAMPLE_FAN_ACCOUNTS, contactHistory: contactHistory(), tenants: DEFAULT_TENANTS, asOf, exportedAt: SAMPLE_AS_OF });

  // Open proposals that are now past expiry can't be sent any more.
  for (const r of db().prepare("SELECT * FROM proposals WHERE status IN ('pending_review','blocked','failed')").all() as unknown as ProposalRow[]) {
    const p = J<Proposal | null>(r.proposal_json, null);
    if (p && Date.parse(asOf) >= Date.parse(p.expiresAt)) {
      setStatus(r.id, "expired", "Kickoff is too close; this offer can no longer be sent.");
      audit(r.id, "engine", "expired");
    }
  }

  const ts = new Date().toISOString();
  const insert = db().prepare(`INSERT INTO proposals(run_id, decision_key, tenant_id, fan_id, match_id, cart_ids_json, outcome, reason_codes_json, reason,
     proposal_json, copy_json, copy_source, copy_fallback_reason, copy_notes_json, model_name, status, status_detail, idempotency_key, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Held / suppressed are informational: the latest run replaces them.
  db().exec("DELETE FROM proposals WHERE status IN ('held','suppressed')");
  for (const d of run.decisions.filter((x) => x.outcome !== "propose")) {
    insert.run(runId, d.key, d.tenantId, d.fanId, d.matchId, JSON.stringify(d.cartIds), d.outcome, JSON.stringify(d.reasonCodes), d.reason, null, null, null, null, null, null, d.outcome === "hold" ? "held" : "suppressed", null, null, ts, ts);
  }

  const fresh: Decision[] = [];
  let alreadyQueued = 0;
  for (const d of run.decisions.filter((x) => x.outcome === "propose")) {
    const exists = db().prepare("SELECT id FROM proposals WHERE idempotency_key = ?").get(d.proposal!.idempotencyKey);
    if (exists) alreadyQueued++;
    else fresh.push(d);
  }

  const drafts = await Promise.all(fresh.map((d) => draftCopy(d, model)));
  let engineGuardrailMismatches = 0;
  fresh.forEach((d, i) => {
    const dr = drafts[i];
    const violations = checkProposal(d, guardCtx(d.tenantId, d.fanId));
    const status: ProposalStatus = violations.length ? "blocked" : "pending_review";
    if (violations.length) engineGuardrailMismatches++;
    const id = Number(
      insert.run(
        runId, d.key, d.tenantId, d.fanId, d.matchId, JSON.stringify(d.cartIds), d.outcome, JSON.stringify(d.reasonCodes), d.reason,
        JSON.stringify(d.proposal), JSON.stringify(dr.copy), dr.source, dr.fallbackReason, JSON.stringify(dr.notes), dr.modelName,
        status, violations.length ? `ENGINE BUG: proposal failed its own guardrails: ${violations.map((v) => v.message).join(" ")}` : null,
        d.proposal!.idempotencyKey, ts, ts,
      ).lastInsertRowid,
    );
    audit(id, "engine", "proposed", { runId, copySource: dr.source, fallbackReason: dr.fallbackReason, notes: dr.notes });
    if (violations.length) audit(id, "engine", "blocked", { violations });
  });

  const count = (o: Decision["outcome"]) => run.decisions.filter((d) => d.outcome === o).length;
  const stats = {
    carts: SAMPLE_CARTS.length,
    proposed: count("propose"),
    newProposals: fresh.length,
    alreadyQueued,
    suppressed: count("suppress"),
    held: count("hold"),
    dataIssues: run.dataIssues,
    copyFromModel: drafts.filter((d) => d.source === "model").length,
    copyFallbacks: drafts.filter((d) => d.source === "template").map((d) => d.fallbackReason),
    engineGuardrailMismatches,
  };
  db().prepare("UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(stats), runId);
  audit(null, actor, "run", { runId, asOf, stats });
  return { runId, stats };
}

// ---------- marketer actions ----------
export async function approve(id: number, actor: string) {
  const r = getRow(id);
  if (r.status !== "pending_review" && r.status !== "failed") throw new HttpError(409, `Can't approve a proposal that is ${r.status.replace("_", " ")}.`);
  const proposal = J<Proposal | null>(r.proposal_json, null);
  const copy = J<MessageCopy | null>(r.copy_json, null);
  if (!proposal) throw new HttpError(409, "Nothing to approve.");

  // Send-time re-check against *current* consent, contact history, clock, and guardrails.
  const problems = problemsFor(r, proposal, copy);
  if (problems.length) {
    setStatus(id, "blocked", problems.join(" "));
    audit(id, actor, "blocked_at_send", { problems });
    return toView(getRow(id));
  }

  const fan = db().prepare("SELECT email FROM fans WHERE tenant_id = ? AND fan_id = ?").get(r.tenant_id, r.fan_id) as { email: string } | undefined;
  const outboxId = tx(() => {
    if (r.status === "pending_review") {
      setStatus(id, "approved");
      audit(id, actor, "approved");
    } else audit(id, actor, "retry");
    db()
      .prepare(`INSERT INTO outbox(idempotency_key, proposal_id, channel, payload_json, status, created_at, updated_at) VALUES(?,?,?,?, 'queued', ?, ?)
                ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(proposal.idempotencyKey, id, proposal.channel, JSON.stringify({ to: proposal.channel === "email" ? fan?.email : r.fan_id, copy }), new Date().toISOString(), new Date().toISOString());
    return (db().prepare("SELECT id FROM outbox WHERE idempotency_key = ?").get(proposal.idempotencyKey) as { id: number }).id;
  });
  await dispatch(outboxId, actor);
  return toView(getRow(id));
}

function mintCode(r: ProposalRow, p: Proposal): string | null {
  if (p.offer.type !== "promo_code" && p.offer.type !== "merch_addon") return null;
  const existing = db().prepare("SELECT code FROM promo_codes WHERE idempotency_key = ?").get(p.idempotencyKey) as { code: string } | undefined;
  if (existing) return existing.code; // retry reuses the same code
  const code = `${(r.tenant_id ?? "X").slice(0, 3).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
  // DB CHECK constraints enforce 1..15% and single use: a third line of defense after the engine and guardrails.
  db()
    .prepare("INSERT INTO promo_codes(code, tenant_id, fan_id, kind, percent_off, max_redemptions, idempotency_key, created_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(code, r.tenant_id, r.fan_id, p.offer.type, p.offer.percentOff, p.idempotencyKey, new Date().toISOString());
  return code;
}

async function dispatch(outboxId: number, actor: string) {
  const ob = db().prepare("SELECT * FROM outbox WHERE id = ?").get(outboxId) as { id: number; proposal_id: number; status: string; payload_json: string; idempotency_key: string; channel: Channel };
  const r = getRow(ob.proposal_id);
  if (ob.status === "sent") {
    setStatus(r.id, "sent");
    return; // idempotent: already delivered
  }
  const p = J<Proposal>(r.proposal_json, null as unknown as Proposal);
  const payload = J<{ to: string; copy: MessageCopy }>(ob.payload_json, { to: "", copy: { subject: "", body: "" } });
  try {
    const code = mintCode(r, p);
    const body = code ? payload.copy.body.split(PROMO_PLACEHOLDER).join(code) : payload.copy.body;
    const subject = code ? payload.copy.subject.split(PROMO_PLACEHOLDER).join(code) : payload.copy.subject;
    const res = await providers[ob.channel].send({ idempotencyKey: ob.idempotency_key, tenantId: r.tenant_id!, fanId: r.fan_id!, to: payload.to, subject, body }, r.id);
    tx(() => {
      db().prepare("UPDATE outbox SET status='sent', attempts=attempts+1, provider_message_id=?, last_error=NULL, updated_at=? WHERE id=?").run(res.providerMessageId, new Date().toISOString(), ob.id);
      db()
        .prepare("INSERT INTO contact_history(tenant_id, fan_id, match_id, channel, offer_type, sent_at, idempotency_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING")
        .run(r.tenant_id, r.fan_id, r.match_id, ob.channel, p.offer.type, now(), ob.idempotency_key);
      setStatus(r.id, "sent", ob.channel === "sales_task" ? "Task created for the salesperson." : `Delivered to the ${ob.channel} provider.`);
      audit(r.id, "system", "sent", { providerMessageId: res.providerMessageId, code });
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    db().prepare("UPDATE outbox SET status='failed', attempts=attempts+1, last_error=?, updated_at=? WHERE id=?").run(msg, new Date().toISOString(), ob.id);
    setStatus(r.id, "failed", `Send failed: ${msg}. Nothing reached the fan. Retry when the provider is back.`);
    audit(r.id, actor, "send_failed", { error: msg });
  }
}

const OfferSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reminder") }),
  z.object({ type: z.literal("promo_code"), percentOff: z.number().int(), singleUse: z.literal(true) }),
  z.object({ type: z.literal("merch_addon"), percentOff: z.number().int(), singleUse: z.literal(true) }),
  z.object({ type: z.literal("perk"), perkId: z.string(), label: z.string() }),
]);
export const EditSchema = z.object({
  offer: OfferSchema.optional(),
  channel: z.enum(["email", "push", "sales_task"]).optional(),
  copy: MessageCopySchema.optional(),
});

export function edit(id: number, patch: z.infer<typeof EditSchema>, actor: string) {
  const r = getRow(id);
  if (!["pending_review", "blocked", "failed"].includes(r.status)) throw new HttpError(409, `Can't edit a proposal that is ${r.status}.`);
  const before = { proposal: J<Proposal | null>(r.proposal_json, null), copy: J<MessageCopy | null>(r.copy_json, null) };
  if (!before.proposal) throw new HttpError(409, "Nothing to edit.");
  // A retry after a failed send must not change what is in the outbox.
  if (r.status === "failed") throw new HttpError(409, "This offer is already in the outbox. Retry it, or reject it.");

  const offer = (patch.offer ?? before.proposal.offer) as Offer;
  const channel = patch.channel ?? before.proposal.channel;
  const proposal: Proposal = {
    ...before.proposal,
    offer,
    channel,
    discountCostCents: offer.type === "promo_code" ? Math.round((before.proposal.cartValueCents * offer.percentOff) / 100) : 0,
  };
  const structural = JSON.stringify(offer) !== JSON.stringify(before.proposal.offer) || channel !== before.proposal.channel;
  const copy: MessageCopy = patch.copy ?? (structural ? templateCopy(offer, channel, proposal.facts) : before.copy!);
  const copySource = patch.copy ? "marketer" : structural ? "template" : r.copy_source;

  const problems = problemsFor(r, proposal, copy);
  if (problems.length) throw new HttpError(422, "This edit breaks a guardrail.", problems);

  db()
    .prepare("UPDATE proposals SET proposal_json=?, copy_json=?, copy_source=?, status='pending_review', status_detail=NULL, updated_at=? WHERE id=?")
    .run(JSON.stringify(proposal), JSON.stringify(copy), copySource, new Date().toISOString(), id);
  audit(id, actor, "edited", { before, after: { proposal, copy } });
  return toView(getRow(id));
}

/**
 * Bulk approve, deliberately narrow: only no-discount reminders by email/push that are pending review.
 * Each one still goes through approve(), so it gets the same send-time re-check and outbox idempotency.
 * Promos, merch codes and perks are always approved one by one.
 */
export function bulkEligible(p: Pick<ProposalView, "status" | "proposal">): boolean {
  return p.status === "pending_review" && p.proposal?.offer.type === "reminder" && p.proposal.channel !== "sales_task";
}

export async function bulkApprove(ids: number[], actor: string) {
  const results: { id: number; ok: boolean; status?: ProposalStatus; error?: string }[] = [];
  for (const id of ids) {
    try {
      const r = getRow(id);
      const v = { status: r.status, proposal: J<Proposal | null>(r.proposal_json, null) };
      if (!bulkEligible(v)) {
        results.push({ id, ok: false, error: "Not eligible for bulk approve (only pending no-discount reminders). Review it individually." });
        continue;
      }
      const after = await approve(id, `${actor} (bulk)`);
      results.push({ id, ok: after.status === "sent", status: after.status, error: after.status === "sent" ? undefined : (after.statusDetail ?? undefined) });
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return { results };
}

export const REJECT_REASONS = ["wrong_offer", "wrong_fan", "bad_copy", "bad_timing", "other"] as const;

export function reject(id: number, reason: (typeof REJECT_REASONS)[number], note: string, actor: string) {
  const r = getRow(id);
  if (!["pending_review", "blocked", "failed"].includes(r.status)) throw new HttpError(409, `Can't reject a proposal that is ${r.status}.`);
  setStatus(id, "rejected", `${reason.replace("_", " ")}${note ? `: ${note}` : ""}`);
  audit(id, actor, "rejected", { reason, note });
  return toView(getRow(id));
}

// ---------- queue + metrics ----------
export function queue() {
  seedFans();
  const rows = db().prepare("SELECT * FROM proposals ORDER BY id").all() as unknown as ProposalRow[];
  const proposals = rows.map(toView);
  const lastRun = db().prepare("SELECT id, as_of, model_name, stats_json, finished_at FROM runs ORDER BY id DESC LIMIT 1").get() as
    | { id: number; as_of: string; model_name: string; stats_json: string | null; finished_at: string | null }
    | undefined;
  return {
    now: now(),
    exportedAt: SAMPLE_AS_OF,
    lastRun: lastRun ? { id: lastRun.id, asOf: lastRun.as_of, modelName: lastRun.model_name, finishedAt: lastRun.finished_at, stats: J(lastRun.stats_json, null) } : null,
    proposals,
    metrics: metrics(proposals),
    fans: db().prepare("SELECT tenant_id AS tenantId, fan_id AS fanId, email_opt_in AS email, push_opt_in AS push FROM fans ORDER BY fan_id").all(),
    outages: { email: getSetting("outage:email", "0") === "1", push: getSetting("outage:push", "0") === "1" },
    salesTasks: db().prepare("SELECT id, fan_id AS fanId, title, status, created_at AS createdAt FROM sales_tasks ORDER BY id DESC").all(),
  };
}

function metrics(ps: ProposalView[]) {
  const by = (s: ProposalStatus) => ps.filter((p) => p.status === s).length;
  const offers = ps.filter((p) => p.proposal);
  const decided = offers.filter((p) => ["sent", "approved", "failed", "rejected"].includes(p.status));
  const edited = offers.filter((p) => p.audit.some((a) => a.action === "edited"));
  const sent = offers.filter((p) => p.status === "sent");
  const modelDrafts = offers.filter((p) => p.modelName);
  const fallbacks = modelDrafts.filter((p) => p.copyFallbackReason && p.copyFallbackReason !== "model_disabled");
  const alerts: { level: "error" | "warn" | "info"; message: string }[] = [];
  if (by("failed")) alerts.push({ level: "error", message: `${by("failed")} approved offer(s) failed to send. Nothing reached those fans; retry or reject.` });
  const engineBugs = offers.filter((p) => p.statusDetail?.startsWith("ENGINE BUG")).length;
  if (engineBugs) alerts.push({ level: "error", message: `${engineBugs} proposal(s) failed the engine's own guardrails. This is a code bug: page the engineer.` });
  if (modelDrafts.length && fallbacks.length / modelDrafts.length > 0.5)
    alerts.push({ level: "warn", message: `Model copy fell back to templates for ${fallbacks.length}/${modelDrafts.length} drafts (${[...new Set(fallbacks.map((f) => f.copyFallbackReason))].join(", ")}). Templates are safe; check the model connection.` });
  if (by("blocked")) alerts.push({ level: "warn", message: `${by("blocked")} offer(s) blocked by a send-time check (consent changed, already contacted, or a guardrail).` });
  if (by("held")) alerts.push({ level: "info", message: `${by("held")} cart(s) held: team not enabled or identity unresolved. Not sent, not lost.` });
  return {
    counts: {
      pending: by("pending_review"),
      sent: by("sent"),
      failed: by("failed"),
      blocked: by("blocked"),
      rejected: by("rejected"),
      expired: by("expired"),
      held: by("held"),
      suppressed: by("suppressed"),
    },
    approvalRate: decided.length ? (decided.length - by("rejected")) / decided.length : null,
    editRate: decided.length ? edited.filter((p) => decided.includes(p)).length / decided.length : null,
    revenueAtStakeCents: sent.reduce((s, p) => s + (p.proposal?.cartValueCents ?? 0), 0),
    discountCommittedCents: sent.reduce((s, p) => s + (p.proposal?.discountCostCents ?? 0), 0),
    modelCopyShare: offers.length ? offers.filter((p) => p.copySource === "model").length / offers.length : null,
    alerts,
  };
}

// ---------- demo controls ----------
export function resetDemo() {
  resetDb();
  for (const f of ["sent-email.jsonl", "sent-push.jsonl"]) rmSync(path.join(DATA_DIR, f), { force: true });
  seedFans();
}

export function advanceClock(days: number) {
  setSetting("clock_offset_ms", String(Number(getSetting("clock_offset_ms", "0")) + days * 86_400_000));
}

export function setConsent(fanId: string, channel: "email" | "push", value: boolean, actor: string) {
  db().prepare(`UPDATE fans SET ${channel === "email" ? "email_opt_in" : "push_opt_in"} = ?, updated_at = ? WHERE fan_id = ?`).run(value ? 1 : 0, new Date().toISOString(), fanId);
  audit(null, actor, "consent_changed", { fanId, channel, value });
}

export function setOutage(channel: "email" | "push", on: boolean) {
  setSetting(`outage:${channel}`, on ? "1" : "0");
}
