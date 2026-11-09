# Fan Offer Engine: cart win-back (trigger #1)

A proof of concept for the Seattle Seawolves. It processes stale ticket carts, decides which fans are worth a
win-back offer, and picks the offer, channel and reason. Claude drafts the message, and every offer waits in
a review queue where a marketer approves, edits or rejects it. **Nothing reaches a fan without approval.**

Stack: Next.js 16 (App Router) + TypeScript, `node:sqlite` for the POC store, Claude via the Claude Agent SDK
for copy, Vitest. No CRM: delivery goes through a transactional email provider and the app's push service
(both stubbed behind one interface), plus a task list for the salesperson.

## Run it (Windows / PowerShell)

```powershell
npm install
npm run dev        # http://localhost:3000, then click "Run engine on stale carts"
npm test           # 50 tests: per-cart decisions, invariants on generated carts, guardrails, copy lint
```

### Claude-written copy: template messages are the expected default

**If you unzipped this and ran it as-is, every card will say "Template copy · Claude unavailable", plus a
yellow "Model copy fell back to templates" banner. That is intended behavior, not a bug.** The copy step
calls Claude through the Claude Agent SDK, which needs a credential, and none ships with the code. When the
model is unavailable, times out, or writes something that breaks a rule, the engine uses a safe,
pre-checked template, labels the card, and raises an alert. Offers, discounts, channels, and every
guardrail are decided by rules and work the same either way. Only the wording changes.

To see Claude-drafted copy, pick one of these, then click "Run engine on stale carts" again:

- **Sign in with a Claude account** (one time; the login is stored in your user profile, not in this repo):

  ```powershell
  npx.cmd @anthropic-ai/claude-code auth login
  ```

- **Or use an API key:** create `.env.local` in the project root with `ANTHROPIC_API_KEY=sk-ant-...` and
  restart `npm run dev`. The SDK picks it up from the server's environment. `.env*` is git-ignored.

Check the model path end to end with `$env:LIVE_MODEL="1"; npx vitest run copy -t live`.

`$env:COPY_MODEL_PROVIDER="off"` turns the model off. "Demo controls" at the bottom of the page reset the
data, advance the clock (to show the discount escalation), toggle fan opt-ins, and simulate a provider outage.

## Where things are

| Path | What |
|---|---|
| `SPEC.md` | The decision contract, written and reviewed **before** the engine (see Section C) |
| `src/engine/decide.ts` | Pure, deterministic decisions: normalize → identity → group → gates → offer → channel |
| `src/engine/policy.ts`, `tenants.ts` | Every threshold in one place; per-team config (onboarding a team = config) |
| `src/engine/guardrails.ts` | Independent second check: 15% cap, single-use, consent, expiry, already contacted |
| `src/engine/copy/` | Model adapter (`CopyModel`), prompt, schema + lint, template fallback |
| `src/server/service.ts` | Run, approve (send-time re-check), edit, reject, bulk approve, outbox, metrics/alerts |
| `src/server/db.ts` | Schema: unique idempotency keys on outbox, contact history, promo codes; DB CHECK on 1–15% |
| `src/components/ReviewQueue.tsx` | The marketer UI |

---

## Section A: Written analysis

**Who gets an offer.** A stale cart signals intent; it isn't a reason to discount. The engine first checks
whether we may contact the fan. The team must be enabled on the platform. The fan must be
identified: a guest checkout links to an account only on an exact email match, otherwise it is held, never
guessed. The match can't have been played or be hours away. The fan must have opted into a channel, and must
not have been contacted recently. Then duplicates collapse: F-204's web and app carts, and F-511's account and
guest carts, each become one decision, so nobody gets two messages. Of 8 sample carts: 4 offers,
1 suppressed (C-1005, match played), 1 held (C-1007, league team still onboarding).

**Which offer.** Discount depth follows inventory. Where a section is selling (≥ 75% sold), a ticket discount
gives away revenue we'd get anyway. F-204, a regular, gets a plain reminder. F-092, lapsed 180 days, gets a
match-day merch voucher, which adds value without cutting the ticket price. Season-pass holders never get a
code: F-333's six Club seats (97% sold) go to the salesperson with a non-price perk. **A discount is never the
first touch.** F-511, a first-time buyer in a soft section 18 days out, gets a full-price reminder. Only if
that doesn't convert in 72 hours, with the section still under 60% sold, does the next run propose a
single-use 10% code (hard cap 15%).

**Which channel.** Consent first (live consent, not the export's snapshot), then where the fan last was:
an app cart gets push, a web cart gets email.

**Rules vs. model.** Eligibility, offer, discount and channel are rules: they involve money and trust, and
must be predictable and auditable. Claude writes the message, which is the work a marketer does by hand
today. Its output is schema-checked and linted (no unearned discount, prices, invented numbers or pressure
language). On any failure the card falls back to a safe template and says why. The
reason shown to the marketer is generated from reason codes, so it can't drift from the rule that fired.

**Not built yet:** real ingestion (the sample export is the input), auth and roles, real providers, holdout
groups, copy A/B tests, seat-upgrade and match-pass offers.
**Next:** holdout measurement (B1), hourly runs off ticketing's cart events, then trigger #2.

**A second trigger without a rewrite.** Everything after "who is a candidate" is trigger-agnostic: the
`Decision`/`Proposal` shape, guardrails, copy layer, review queue, outbox, idempotency keys and contact
history all carry a trigger name. A season-pass renewal trigger adds one module: a candidate selector
(holders inside the renewal window who haven't renewed) and its offer table (renewal reminder, or a perk via
the salesperson for long-tenured holders). Contact history and frequency caps are shared, so a fan in two
triggers still gets one message. The only refactor is splitting `decide()` into shared gates plus per-trigger
policy.

---

## Section B: Production plan

### B1. Knowing the offers are good, and catching bad sends before they reach a fan

**"Good" means incremental revenue, not conversions.** Many fans who get a reminder would have bought anyway
(F-204 probably would). So a random holdout (10–20% of eligible decisions, decided and logged but not sent)
is compared on cart completion within 7 days, per offer type. With a small fan base we read this over weeks
and across matches, not per send. Alongside it:
- **Discount efficiency:** redeemed discount $ per incremental $. Single-use codes are tied to the
  proposal's idempotency key, so every redemption traces back to one offer.
- **Marketer signal:** approve / edit / reject rates by offer type, with reject reasons (already captured in
  the UI). A high edit rate on copy means the prompt needs tuning; on offers, the rules do.
- **Fan health (a guardrail metric):** opt-outs, unsubscribes and push disables after sends. A rise pauses
  the trigger.
- **Model health:** fallback rate and lint-failure reasons (already shown as an alert).

**What could send something bad without anyone noticing, and the catch:**

| Risk | How it's caught |
|---|---|
| Source data looks valid but is wrong (stale sell-through → discount on a section that's selling; a consent column flipped in an export) | Consent comes from the fan record, never the export. Ingest data contract: per-field unknown/not-synced rates and day-over-day shift (e.g. opted-in share jumps) pause the run. Unreadable fields fail closed (opt-ins count as "No"). |
| Wrong identity merge (shared family email) | Exact match to exactly one account only, otherwise held. Merge count is monitored. |
| Rule regression in a code change (threshold edit makes everyone promo-eligible) | Golden tests on the sample + invariants on generated carts in CI. Guardrails run independently of `decide()`, and a mismatch is flagged as an engine bug. DB CHECK constraints reject codes over 15% or multi-use. Per-run anomaly check: proposal count and committed discount vs trailing average. |
| Model writes something false (fake scarcity, wrong %) | Lint, then human review. Rejected drafts are logged with reasons. |
| Double send (retry, re-run, double click) | Unique idempotency key per fan × match × touch on proposal, outbox, contact history and promo code. The same key goes to the provider. Re-run is tested to create no duplicates. |
| Send fails | Visible "Send failed. Nothing reached the fan", with retry. An alert banner, never a silent drop. |
| The run silently stops | Dead-man alert: no completed run in N hours. |
| Provider accepts but doesn't deliver | Reconcile provider webhooks (bounce, delivered) against the outbox; alert on delivery rate. |
| Rubber-stamp approvals | Bulk approve covers no-discount reminders only. Watch approve rate ≈ 100% with low time-on-card; spot-audit. |

**Ops with no ops team:** one daily digest email to the marketer and the engineer (runs, sends, failures,
discount committed, alerts); urgent alerts (failed sends, engine-guardrail mismatch, dead-man) to a shared
channel; a per-team kill switch (`offersEnabled`) and a per-team daily discount budget.

### B2. Where an AI coding assistant would be plausibly wrong (written without AI)

> **To be written by me, without AI assistance, as the brief requires.**
> _…scenario, what the incorrect output would look like, and what I'd check before acting on it…_

---

## Section C: AI usage log

Claude Code (Opus 5.5, desktop app) was the coding agent. The git history shows the sequence: `ecc9c13` is
the spec and tests *before* review, and `33232cd` contains my redirects. Lines marked **Me** are mine.

**1. Scoping.** *Asked:* build the engine from the challenge text. *AI gave:* three questions before any code
(missing README sections, which model, how to pace review). *Changed:* rather than let it guess the README
sections, I pointed it at the full challenge page, which showed B2 must be written without AI.
**Me:** _…_

**2. Agent task: spec and tests first, then my review (main redirect).** *Asked:* write the per-cart decisions
as a spec plus tests, and stop before building. *Guardrails:* `SPEC.md` is the contract; the tests encode every
per-cart decision plus invariants on generated carts (each cart decided once, one proposal per fan, consent,
15% cap, tenant enabled, determinism); the engine has to pass them, and tests are not edited to fit the code.
*AI gave:* F-511 a 10% promo on first touch, and F-333 a bare sales handoff. *Changed:* F-511 gets no discount
on first touch, with a promo only as a second touch after an unconverted reminder in a still-soft section
(SPEC §4a, five new tests); F-333 gets a non-price perk via the salesperson. *Kept:* F-092's merch add-on.
**Me (why):** _…_

**3. Agent self-corrections while running its own code.** The linter rejected the agent's own sales-task
template, so lint became channel-aware and perks are locked to the sales channel. End-to-end testing showed
consent was read from the export snapshot, so live consent now gates proposals too. Blocked or failed offers
past kickoff now expire. After login, the first live Claude run drafted 3 of 4 messages that passed. The 4th
(F-333's sales talking points) was rejected because the "no invented numbers" rule read Claude's list
numbering ("1.", "2.") as made-up facts. That was a linter false positive, not a model error. List markers
are now stripped first, and a test keeps a real scarcity claim ("only 3 seats left") failing; the re-run
gave 4 of 4. **Me (did I verify / reject anything):** _…_

**4. Model choice.** *Asked:* use "Claude Code, this session" as the model. *AI gave:* pushback, since a
running engine can't call back into a chat. It proposed the Claude Agent SDK behind a `CopyModel` interface
(Anthropic API in production). The first live call failed with "Not logged in", and the template fallback
worked as designed. **Me:** _…_

**5. UI review.** *Asked for:* simpler marketer cards, raw export data per card, and bulk approve. *AI pushed
back on bulk approve:* it built a version limited to no-discount reminders, with a confirm list and a per-id
server re-check; discounts and perks stay one by one. **Me (agree / change):** _…_
