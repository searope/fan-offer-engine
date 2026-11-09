# AI usage log (working notes for README Section C)

Running log of each significant AI interaction. Claude Code (Opus 5.5, desktop app) is the coding agent.
Lines marked **YOU** are for you to write: what you decided and why, in your own words. The agent records
only what was asked and what it produced. The git history shows the sequence: `ecc9c13` is the
pre-review spec; the redirects below come after it.

---

## 1. Scoping the brief

- **Asked:** Build the fan offer engine from the pasted challenge text.
- **AI gave:** Asked three questions before writing code: what README Sections A/B/C cover (they were missing
  from the paste), which model to call, and how to pace the work so there would be real review points.
- **Redirect:** Instead of letting it guess A/B/C, you pointed it at the full challenge page. That page showed
  B2 must be answered *without* AI, so the agent leaves B2 for you.
- **YOU (kept / changed / why):** _…_

## 2. Agent task: engine spec + tests before code, then review (the main redirect)

- **Asked:** Write the decision rules for each sample cart as a spec and tests, and stop for review before
  building.
- **Guardrails given to the agent:** `SPEC.md` is the contract. `src/engine/__tests__/decide.test.ts` encodes
  every per-cart decision, plus invariants on generated carts (each cart decided exactly once, one proposal
  per fan, consent, 15% cap, tenant enabled, determinism). The engine has to pass these, and the tests are
  not edited to fit the engine.
- **AI gave (commit `ecc9c13`):** F-511 (first-time buyer, Upper Deck 41% sold, 18 days out): a **10% promo
  on first touch**. F-333 (season-pass holder, Club 97%): a bare **sales handoff**. Plus 4 other decisions.
- **What you changed:**
  - F-511: **no discount on first touch.** A full-price reminder first; a 10% promo becomes a *second* touch
    only if the reminder didn't convert after 72 h and the section is still soft. This became SPEC §4a
    (discount escalation) with 5 new tests, and the demo can show it (advance clock 4 days, re-run).
  - F-333: sales handoff → a **non-price perk** (pitch-side access) delivered by the salesperson.
  - F-092 merch add-on: kept.
- **YOU (why):** _…e.g. "a discount on first contact trains fans to abandon carts to get a code; 18 days
  out there's time to try full price first"…_

## 3. Agent self-corrections found while running its own code (verify these yourself)

- **Template vs linter conflict:** the copy linter rejected the agent's own sales-task template ("Club is
  97% sold, so do not discount" read as discount talk). Fix: lint is now channel-aware (sales tasks are
  internal talking points), and a new guardrail says perks only go through `sales_task` and `sales_task`
  only carries perks.
- **Consent source:** end-to-end testing showed the engine read opt-ins from the *cart export*, so a
  revoked opt-in was only caught at send time. Fix: live fan consent is ANDed in before `decide()`.
  The send-time re-check stays as a second layer.
- **Expiry:** only `pending_review` proposals expired; blocked/failed ones past kickoff now expire too.
- **YOU (did you check these? anything you'd reject?):** _…_

## 4. Model choice

- **Asked:** Use "Claude Code, this session" as the model.
- **AI gave:** Pushed back. The engine runs at request time and can't call back into a chat session.
  Proposed the Claude Agent SDK (runs Claude Code headless on your Claude login) behind a `CopyModel`
  interface, with an Anthropic API implementation as the production path. You picked the SDK.
- **Observed:** the first live call failed with "Not logged in". The fallback path worked as designed
  (template copy, flagged on the card and in alerts).
- **YOU:** _…_

## 5. UI review (checkpoint 2)

- **Asked of you:** click through the queue and redirect.
- **What you asked for:** simpler cards for marketers, the raw export rows behind each decision, and bulk approve.
- **AI pushback:** the agent didn't build an unrestricted "approve all". Bulk approve is limited to *no-discount
  reminders*. It shows a confirm list of fans first, the server re-checks eligibility per id (the client list
  isn't trusted), and each send still runs the send-time re-check. Promos, merch codes and perks stay one by
  one. Reason: on a small, loyal fan base a wrong discount costs money and trust, and a wrong reminder costs much less.
- **YOU (agree? change?):** _…_
