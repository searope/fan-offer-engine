# Fan Offer Engine: spec for trigger #1 (cart win-back)

Status: **v2, reviewed**. Reviewer redirects: F-511 promo moved to a second touch (§4a); F-333 sales handoff now carries a non-price perk. This is the contract the engine is built against. The tests in
`src/engine/__tests__/` encode every decision in the table below. Change this file first, then the tests,
then the code.

## 0. The one assumption everything rests on

**The ticketing export's sell-through and consent can be trusted.** Sell-through decides whether a discount
earns revenue or gives it away; consent decides whether we may contact the fan at all. If either is wrong,
every rule below makes confidently wrong decisions.

So every run tests it first (`src/engine/contract.ts`, `checkExport()`), before `decide()` sees the data:

| Check | Fails when |
|---|---|
| Fresh | Export is older than 6 h, or stamped in the future |
| Consistent | One match + section reports two sell-through values more than 2 points apart |
| Plausible | Sell-through fell more than 10 points since the last accepted export (seats rarely un-sell) |
| Stable consent | Opted-in share moved more than 20 points vs the last accepted export (with ≥ 20 rows) |
| Consent agrees | More than 20% of fans are opted in per the export but opted out in their fan record (with ≥ 5 fans) |
| Readable | More than 25% of rows have an unreadable match, seats, price or sell-through |

A failing export **pauses the run**: nothing is proposed or sent, and the queue shows a red banner listing
the problems. A person can run anyway only with a written reason, which is audited and shown on the run.

## 1. Pipeline

```
raw cart export ─▶ normalize ─▶ resolve identity ─▶ group (fan × match) ─▶ gates (rules) ─▶ choose offer + channel (rules)
                       │                                                         │                        │
                  data issues                                            suppress / hold             proposal
                                                                                                          │
                                                                    draft copy (model, schema-checked) ◀──┘
                                                                                                          │
                                                       marketer queue: approve / edit / reject ◀──────────┘
                                                                                                          │
                                  send-time re-check (consent, cap, cart converted, expiry, guardrails) ◀─┘
                                                                                                          │
                                                       outbox (idempotent) ─▶ email stub / push stub ─▶ delivery log
```

`decide()` is **pure and synchronous**: same input, same decisions. Every cart that goes in comes out
in exactly one decision (`propose`, `suppress`, or `hold`), so nothing drops silently.

## 2. What is a rule, what is a model call

| Step | Rule or model | Why |
|---|---|---|
| Who is eligible (consent, tenant enabled, match not played, frequency cap) | Rule | Legal, trust, and money. It has to be auditable and testable, and the answer is never "it depends on phrasing". |
| Identity merge (guest ↔ account) | Rule (exact email match only) | A wrong merge sends an offer to the wrong person. Fuzzy matching is not worth that risk at this fan-base size. |
| Offer type and discount % | Rule (yield table below) | Discount depth is a revenue decision. The marketer has to be able to predict and explain it. A model picking 12% vs 15% adds risk and no value. |
| Channel | Rule | Consent plus recency of source. |
| Message copy (subject, body, push text) | **Model** | This is the real labor today. The marketer writes every message by hand. Model output is schema-validated and linted (no discount the offer doesn't carry, no invented facts, length limits). On failure it falls back to a template and the card shows a "model copy rejected" flag. |
| Marketer-facing reason | Rule-generated from reason codes | A reason has to match the logic that made the decision. If a model wrote it, the reason could drift from the actual rule. |

## 3. Gates (in order; first match wins)

| Code | Outcome | Rule |
|---|---|---|
| `UNKNOWN_TENANT` / `TENANT_NOT_ENABLED` | **hold** | Team not mapped, or offers not enabled for the team. Hold shows in the queue but can't be approved. Onboarding a team is a config change. |
| `UNRESOLVED_IDENTITY` | **hold** | Guest cart whose email does not exactly match one account. |
| `MATCH_ALREADY_PLAYED` | suppress | Kickoff is in the past. |
| `MATCH_TOO_SOON` | suppress | Kickoff < 6 h away. Too late for a considered send. |
| `NO_CONSENTED_CHANNEL` | suppress | Email and push both opted out (sales task is still allowed for season-pass holders). |
| `RECENTLY_CONTACTED` | suppress | Fan received an offer about a *different* match in the last 7 days. |
| `ALREADY_CONTACTED_FOR_MATCH` | suppress | Fan already got 2 touches for this match, or got 1 that doesn't qualify for escalation (§4a). |
| `DUPLICATE_CART` | merged | Same fan + same match: carts collapse into one decision. Never two sends. |

## 4. Offer table (yield-aware)

| Fan / inventory situation | Offer | Discount |
|---|---|---|
| Season-pass holder | `perk`: a non-price perk from the tenant's perk catalog (e.g. pre-match pitch-side access for the group), offered **personally by the salesperson** (`sales_task` channel, no automated message) | none |
| Section sell-through ≥ 75% | `reminder`, or `merch_addon` (match-day shop, 10%, **capped per voucher**, $10 for the Seawolves; the fan is told the cap) for a lapsed fan (last purchase > 120 days) | **no ticket discount**: these seats sell at full price |
| Anything else, **first touch** for this match | `reminder` | none: **a discount is never the first touch** |
| **Second touch** for this match, if §4a escalation applies | `promo_code`, single-use, **10%** default, hard cap **15%** (marketer may edit up to 15) | yes |

### 4b. Offer costs are typed lines, never one "discount" number

Each offer type declares what it gives away (`src/engine/offers.ts`):

| Offer | Cost line | Basis |
|---|---|---|
| `reminder` | none | |
| `promo_code` | ticket discount, e.g. $14 | exact (lost ticket revenue) |
| `merch_addon` | merch voucher, up to the tenant cap | max (shop margin, only if redeemed) |
| `perk` | perk | non-monetary |

Lines of different kinds are never added together: the card shows one line per kind, and the metrics report
ticket discount and voucher exposure separately. A new offer type adds one case to `costsOf()`. A merch voucher
without a cap, or above the tenant's cap, fails the guardrails (`MERCH_OVER_CAP`) and a DB CHECK.

### 4a. Discount escalation (reviewer redirect, see README Section C #2)

The first draft gave F-511 a 10% promo on first touch. The review changed this: 18 days out there's time
to try a full-price nudge first. A promo is a second touch for the same match, and only when all of these hold:

- the previous touch for this match was a no-discount `reminder`, sent ≥ 72 h ago, and the fan still has
  an open cart for the match;
- the section is still < 60% sold;
- kickoff is ≥ 48 h away;
- the fan is not a season-pass holder.

Max 2 touches per fan per match. Anything else after a first touch → `ALREADY_CONTACTED_FOR_MATCH`.

Channel: prefer the source of the fan's most recent cart (App → push, Web → email) if consented, otherwise
the other consented channel.

### 4c. Holdout: measuring whether offers cause purchases

A fixed share of first-touch decisions (`holdoutPct`, 15% for the Seawolves) is **decided but never sent**.
Assignment hashes experiment × tenant × fan × match (`HOLDOUT_EXPERIMENT = "cart-winback-holdout-v1"`), so it's
random across fans but stable across runs: a held-out fan stays held out for that match. Renaming the experiment
re-randomizes everyone.

- First touches only. A fan who got a reminder can still get the §4a follow-up.
- Season-pass perks are never held out: withholding a personal call from the best fans costs more than it measures.
- Held-out decisions keep the offer they would have received, get no copy drafted, and are never contacted.
- Measurement (intention to treat): cart completion within 7 days of the decision, for everyone eligible who
  wasn't held out vs everyone held out, whatever the marketer then did. The UI shows the lift but labels it
  "too early" below 30 decisions per group.

## 5. Expected decisions for the sample (the tests)

| Carts | Fan | Outcome | Offer | Channel | Why |
|---|---|---|---|---|---|
| C-1001 + C-1006 | F-204 | **holdout** (would be: reminder, push) | reminder | push | Two attempts in an hour (web, then app): high intent. Lower Bowl 88% sold, regular buyer. A discount gives away revenue we'd get anyway. One decision, not two. F-204 × this match hashes into the 15% holdout (§4c), so nothing is sent. |
| C-1002 + C-1008 | F-511 | propose | reminder | email | First-time buyer; the guest cart is the same person (exact email match), so two attempts = real intent. Upper Deck is soft (41%), but 18 days out we nudge at full price first. If it doesn't convert in 72 h, the next run escalates to a 10% promo (§4a). Email is the only consented channel. |
| C-1003 | F-092 | propose | merch_addon 10%, up to $10 | push | Lapsed (180 days), email opted out. Lower Bowl 88%: don't cut the ticket price. Add match-day merch value instead. |
| C-1004 | F-333 | propose | perk (pitch-side access) | sales_task | Season-pass holder, 40 tickets, bringing a group of 6 into Club at $540. Club is 97% sold, so a discount is pure giveaway. A perk costs little, rewards the club's best fan, and the salesperson delivers it personally. |
| C-1005 | F-777 | suppress | — | — | `MATCH_ALREADY_PLAYED`. |
| C-1007 | F-618 | hold | — | — | `TENANT_NOT_ENABLED`: league team still onboarding; shop data not synced (data issue logged). |

## 6. Invariants (tested on the sample and on generated carts)

1. Every input cart appears in exactly one decision.
2. At most one proposal per fan per run.
3. No proposal uses a channel the fan has not opted into. If a fan's carts disagree on consent (e.g.
   exported at different times), the most conservative value wins: a channel is consented only if every
   cart says so.
4. No promo above 15%; every promo is single-use. Codes are minted at **send** time, never at proposal time.
5. No proposal for a tenant that isn't enabled.
6. `decide()` is deterministic.

## 7. After approval (not in `decide()`)

- Send-time re-check: consent, frequency cap, cart not already bought (`cart_completions`), proposal not expired, guardrails. Any
  failure moves the proposal to `blocked` with a reason in the UI. The send never drops quietly.
- Outbox idempotency key: `tenant:trigger:fan:match`. A second approval or a retry can't double-send.
- Every state change goes to an append-only audit log (who, when, before/after on edits).
