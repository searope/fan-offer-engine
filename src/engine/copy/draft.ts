import type { Decision } from "../types";
import { lintCopy, MessageCopySchema, type MessageCopy } from "./lint";
import type { CopyModel } from "./model";
import { templateCopy } from "./templates";

export type CopySource = "model" | "template";

export interface DraftedCopy {
  copy: MessageCopy;
  source: CopySource;
  /** Why the model draft wasn't used, if it wasn't. Shown on the card and counted in metrics. */
  fallbackReason: "model_disabled" | "model_error" | "model_timeout" | "schema_invalid" | "lint_failed" | null;
  notes: string[];
  modelName: string | null;
}

/**
 * Model drafts, deterministic code checks. Any failure falls back to the template and says so.
 * Copy is never blank and never unchecked.
 */
export async function draftCopy(d: Decision, model: CopyModel | null, timeoutMs = 45_000): Promise<DraftedCopy> {
  const p = d.proposal;
  if (!p) throw new Error(`draftCopy called for ${d.key} with no proposal`);
  const fallback = templateCopy(p.offer, p.channel, p.facts);
  const fb = (fallbackReason: DraftedCopy["fallbackReason"], notes: string[]): DraftedCopy => ({
    copy: fallback,
    source: "template",
    fallbackReason,
    notes,
    modelName: model?.name ?? null,
  });

  if (!model) return fb("model_disabled", []);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let raw: unknown;
  try {
    raw = await model.draft({ offer: p.offer, channel: p.channel, facts: p.facts }, ac.signal);
  } catch (e) {
    return fb(ac.signal.aborted ? "model_timeout" : "model_error", [String((e as Error)?.message ?? e).slice(0, 300)]);
  } finally {
    clearTimeout(timer);
  }

  const parsed = MessageCopySchema.safeParse(raw);
  if (!parsed.success) return fb("schema_invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const problems = lintCopy(parsed.data, p.offer, p.channel, p.facts);
  if (problems.length) return fb("lint_failed", problems);
  return { copy: parsed.data, source: "model", fallbackReason: null, notes: [], modelName: model.name };
}
