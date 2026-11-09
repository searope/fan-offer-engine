# AI usage log (working notes for README Section C)

Running log of each significant AI interaction. Claude Code (Opus 5.5, desktop app) is the coding agent.
The **What I kept / changed / rejected** lines are yours to fill in. Write down what you actually did and why,
in your own words. Don't let the agent write those.

---

## 1. Scoping the brief

- **Asked:** Build the fan offer engine from the pasted challenge text.
- **AI gave:** Before writing code, three questions: README Sections A/B/C (missing from the paste), which
  model to call, and how to pace the work so there are real review points.
- **What I kept / changed / rejected:** _…(e.g. you pointed it at the full challenge page instead of guessing
  A/B/C; it then found that B2 must be answered without AI)…_

## 2. Agent task: engine spec + tests before code

- **Asked:** Write the decision rules for each sample cart as a spec and tests, and stop for review before
  building.
- **Guardrails given to the agent:** `SPEC.md` is the contract; `src/engine/__tests__/decide.test.ts` encodes
  every per-cart decision plus invariants (each cart decided exactly once, one proposal per fan, consent,
  15% cap, tenant enabled, determinism) on generated carts. The engine has to pass these. The tests are not
  changed to fit the engine.
- **AI gave:** `SPEC.md` decision table (4 proposals, 1 suppress, 1 hold), the rules-vs-model split, and
  failing tests.
- **What I kept / changed / rejected:** _…_

## 3. …

- **Asked:**
- **AI gave:**
- **What I kept / changed / rejected:**
