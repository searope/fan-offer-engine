# Fan Offer Engine: spec for trigger #1 (cart win-back)

Status: **draft for review**. This is the contract the engine is built against. The tests in
`src/engine/__tests__/` encode every decision in the table below. Change this file first, then the tests,
then the code.

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
| `RECENTLY_CONTACTED` | suppress | Fan received any offer in the last 7 days, or one for this match ever. |
| `DUPLICATE_CART` | merged | Same fan + same match: carts collapse into one decision. Never two sends. |

## 4. Offer table (yield-aware)

| Fan / inventory situation | Offer | Discount |
|---|---|---|
| Season-pass holder | `sales_handoff`: a task for the salesperson, no automated message | none |
| Section sell-through ≥ 75% | `reminder`, or `merch_addon` (match-day shop, 10%) for a lapsed fan (last purchase > 120 days) | **no ticket discount**: these seats sell at full price |
| Sell-through < 60%, match ≥ 7 days out, new or lapsed fan | `promo_code`, single-use, **10%** default, hard cap **15%** (marketer may edit up to 15) | yes |
| Anything else | `reminder` | none |

Channel: prefer the source of the fan's most recent cart (App → push, Web → email) if consented, otherwise
the other consented channel.

## 5. Expected decisions for the sample (the tests)

| Carts | Fan | Outcome | Offer | Channel | Why |
|---|---|---|---|---|---|
| C-1001 + C-1006 | F-204 | propose | reminder | push | Two attempts in an hour (web, then app): high intent. Lower Bowl 88% sold, regular buyer. A discount gives away revenue we'd get anyway. One send, not two. |
| C-1002 + C-1008 | F-511 | propose | promo_code 10% | email | First-time buyer; the guest cart is the same person (exact email match), so two attempts. Upper Deck 41% sold, 18 days out: those seats likely go unsold. $14 off a $140 cart wins a new fan. Email is the only consented channel. |
| C-1003 | F-092 | propose | merch_addon 10% | push | Lapsed (180 days), email opted out. Lower Bowl 88%: don't cut the ticket price. Add match-day merch value instead. |
| C-1004 | F-333 | propose | sales_handoff | sales_task | Season-pass holder, 40 tickets, 6 Club seats at $540. Club is 97% sold. A discount is pure giveaway; a personal call protects the relationship. |
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

- Send-time re-check: consent, frequency cap, cart not converted, proposal not expired, guardrails. Any
  failure moves the proposal to `blocked` with a reason in the UI. The send never drops quietly.
- Outbox idempotency key: `tenant:trigger:fan:match`. A second approval or a retry can't double-send.
- Every state change goes to an append-only audit log (who, when, before/after on edits).
