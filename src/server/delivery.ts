import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, db, getSetting } from "./db";

/**
 * The only two outbound channels that exist: a transactional email provider and the mobile app's
 * in-app/push service. Both stubbed: they append to data/*.jsonl so you can see exactly what would
 * have gone out. Sales tasks land in a table the salesperson works from.
 * Swap these for the real providers (e.g. Postmark/SES, the app's push API) behind the same interface.
 */
export interface OutboundMessage {
  idempotencyKey: string; // passed to the provider as its idempotency key too
  tenantId: string;
  fanId: string;
  to: string; // email address or fan id for push
  subject: string;
  body: string;
}

export interface DeliveryProvider {
  readonly channel: "email" | "push" | "sales_task";
  send(msg: OutboundMessage, proposalId: number): Promise<{ providerMessageId: string }>;
}

function outageCheck(channel: string) {
  if (getSetting(`outage:${channel}`, "0") === "1") throw new Error(`${channel} provider unavailable (simulated outage: 503)`);
}

function logTo(file: string, entry: object) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(path.join(DATA_DIR, file), JSON.stringify(entry) + "\n");
}

export const providers: Record<"email" | "push" | "sales_task", DeliveryProvider> = {
  email: {
    channel: "email",
    async send(msg) {
      outageCheck("email");
      const providerMessageId = `email_${randomUUID()}`;
      logTo("sent-email.jsonl", { providerMessageId, ...msg, at: new Date().toISOString() });
      return { providerMessageId };
    },
  },
  push: {
    channel: "push",
    async send(msg) {
      outageCheck("push");
      const providerMessageId = `push_${randomUUID()}`;
      logTo("sent-push.jsonl", { providerMessageId, ...msg, at: new Date().toISOString() });
      return { providerMessageId };
    },
  },
  sales_task: {
    channel: "sales_task",
    async send(msg, proposalId) {
      const r = db()
        .prepare("INSERT INTO sales_tasks(proposal_id, tenant_id, fan_id, title, body, status, created_at) VALUES(?,?,?,?,?, 'open', ?)")
        .run(proposalId, msg.tenantId, msg.fanId, msg.subject, msg.body, new Date().toISOString());
      return { providerMessageId: `task_${r.lastInsertRowid}` };
    },
  },
};
