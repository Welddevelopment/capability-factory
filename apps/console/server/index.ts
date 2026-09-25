import { createConsoleApp } from "./app.js";
import { CapabilityFactorySidecarClient } from "../../../src/product/client.js";
import {
  REAL_ERPNEXT_PILOT_GOAL,
  REAL_ERPNEXT_PILOT_SCOPE_KEY,
} from "../../../src/customer-world/real-erpnext-broad-goal-pilot-adapter.js";
import { HmacGoalContinuationAuthority } from "../../../src/product/continuation.js";

const port = Number(process.env.CF_CONSOLE_PORT ?? 4317);
const databasePath = process.env.CF_CONSOLE_DB ?? "apps/console/.data/console.sqlite";
const sidecarUrl = process.env.CF_CONSOLE_SIDECAR_URL;
const sidecarToken = process.env.CF_CONSOLE_SIDECAR_TOKEN;
const continuationSecret = process.env.CF_CONTINUATION_AUTHORITY_SECRET?.trim();
const continuationAuthority = continuationSecret
  ? new HmacGoalContinuationAuthority(
      process.env.CF_CONTINUATION_AUTHORITY_KEY_ID?.trim() || "local-pilot-continuation-v1",
      continuationSecret,
    )
  : undefined;
if (Boolean(sidecarUrl) !== Boolean(sidecarToken)) {
  throw new Error("CF_CONSOLE_SIDECAR_URL and CF_CONSOLE_SIDECAR_TOKEN must be configured together.");
}
const sidecar = sidecarUrl && sidecarToken
  ? {
      client: new CapabilityFactorySidecarClient({ baseUrl: sidecarUrl, accessToken: sidecarToken }),
      tenantId: process.env.CF_CONSOLE_SIDECAR_TENANT ?? "local-erpnext-pilot",
      scopeKey: process.env.CF_CONSOLE_SIDECAR_SCOPE ?? REAL_ERPNEXT_PILOT_SCOPE_KEY,
      fixtureLabel: process.env.CF_CONSOLE_SIDECAR_FIXTURE ?? "Genuine disposable local ERPNext · fictional procurement batch",
      workflowLabel: process.env.CF_CONSOLE_SIDECAR_WORKFLOW ?? "Durable sidecar · approved ERPNext procurement",
      suggestedGoal: process.env.CF_CONSOLE_SIDECAR_GOAL ?? REAL_ERPNEXT_PILOT_GOAL,
      ...(continuationAuthority ? { continuationAuthority } : {}),
    }
  : undefined;
const { app } = createConsoleApp({ databasePath, ...(sidecar ? { sidecar } : {}) });
void app.listen({ host: "127.0.0.1", port }).then(() => {
  console.log(`Capability Factory Console: http://127.0.0.1:${port}/runs`);
});
