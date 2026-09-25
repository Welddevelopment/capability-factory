import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FictionalInboxOrderWorld,
  fictionalOrderEmail,
} from "../src/customer-world/inbox-order-world.js";
import {
  AuthenticatedMessageIngressClient,
  createAuthenticatedMessageIngress,
} from "../src/experimental/authenticated-message-ingress.js";
import {
  inboxMessageOperationKey,
} from "../src/experimental/inbox-message-driver.js";
import {
  buildCapabilityModePackageSidecar,
  CapabilityModePackageManager,
} from "../src/product/capability-mode-package.js";
import {
  CAPABILITY_MODE_SCHEMA_VERSION,
  type CapabilityModeEnvelope,
} from "../src/product/capability-mode-contract.js";
import { createInboxMessageModeRunner } from "../src/product/capability-mode-router.js";
import {
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../src/product/secrets.js";

const roots: string[] = [];
const sharedSecret = "fictional-shared-webhook-secret-with-sufficient-entropy";
const receiverAlias = "signed_message_ingress_key";
const senderAlias = "supplier_message_signing_key";
const receiverTarget = "fictional_signed_message_ingress";
const senderTarget = "fictional_supplier_webhook";

function receiverDescriptor(): ScopedSecretDescriptor {
  return {
    alias: receiverAlias,
    version: "receiver-v1",
    scope: {
      targetAliases: [receiverTarget],
      actionNames: ["accept-signed-message"],
      methods: ["POST"],
    },
  };
}

function senderSecrets(secret = sharedSecret): RotatingMemorySecretProvider {
  const provider = new RotatingMemorySecretProvider();
  provider.set({
    alias: senderAlias,
    version: "sender-v1",
    scope: {
      targetAliases: [senderTarget],
      actionNames: ["send-signed-message"],
      methods: ["POST"],
    },
  }, secret);
  return provider;
}

async function waitForTerminal(
  app: Awaited<ReturnType<typeof buildCapabilityModePackageSidecar>>["app"],
  token: string,
  tenantId: string,
  jobId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/capability-mode-jobs/${jobId}?tenantId=${tenantId}`,
      headers: { "x-capability-sidecar-token": token },
    });
    const job = response.json();
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Packaged signed-message job did not finish.");
}

function inboxEnvelope(input: {
  requestId: string;
  operationKey: string;
  inputMessageAlias: string;
  expectedMessageSha256: string;
}): CapabilityModeEnvelope {
  return {
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: "experimental-inbox-message-actions",
    request: {
      tenantId: "fictional-distributor-inbox",
      requestId: input.requestId,
      parentGoalId: `parent-${input.requestId}`,
      ordinaryGoal: "Accept the authenticated supplier order, create one verified draft, and continue fulfilment.",
      needKey: "convert-approved-order-email-to-draft",
      contractHash: "",
      operationKey: input.operationKey,
      inputMessageAlias: input.inputMessageAlias,
      expectedMessageSha256: input.expectedMessageSha256,
      approvals: ["create-approved-draft-order"],
    },
  } as CapabilityModeEnvelope;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("authenticated signed-message ingress", () => {
  it("joins real loopback ingress to the packaged inbox capability loop and retained reuse", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-signed-inbox-package-"));
    roots.push(root);
    const trustedContract = path.join(root, "trusted-inbox-contract.json");
    fs.writeFileSync(trustedContract, `${JSON.stringify({
      schemaVersion: "1.0",
      kind: "fictional-bounded-signed-order-message",
    })}\n`, { mode: 0o600 });

    const manager = new CapabilityModePackageManager(path.join(root, "package"), {
      portProbe: async () => true,
    });
    manager.initialize({
      installationId: "signed-inbox-package-test",
      productVersion: "0.1.0",
      tenantId: "fictional-distributor-inbox",
      modes: [{
        capabilityMode: "experimental-inbox-message-actions",
        driverVersion: "inbox-message-driver-v0.1",
        contractFiles: [{
          sourcePath: trustedContract,
          packagedName: "trusted-inbox-contract.json",
        }],
        requiredSecrets: [receiverDescriptor()],
      }],
    });
    manager.writeSecret(receiverAlias, sharedSecret);
    expect(await manager.readiness()).toMatchObject({ ready: true });

    const world = new FictionalInboxOrderWorld(
      path.join(manager.stateDirectory("experimental-inbox-message-actions"), "fictional-order-world"),
    );
    const built = await buildCapabilityModePackageSidecar(
      manager,
      async () => [createInboxMessageModeRunner(world.sdk())],
    );
    const ingress = createAuthenticatedMessageIngress({
      app: built.app,
      inboxRoot: world.inboxRoot,
      databasePath: path.join(
        manager.stateDirectory("experimental-inbox-message-actions"),
        "trusted-ingress.sqlite",
      ),
      credentialAlias: receiverAlias,
      targetAlias: receiverTarget,
      secrets: manager.secretProvider(),
    });
    world.attachTrustedIngressReceiptLookup(
      (alias) => ingress.receipt(alias)?.messageSha256,
    );

    const origin = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new AuthenticatedMessageIngressClient({
      origin,
      credentialAlias: senderAlias,
      targetAlias: senderTarget,
      secrets: senderSecrets(),
    });
    try {
      const firstMessageId = "<signed-order-1@east-industrial.example>";
      const firstAlias = "signed-order-1.eml";
      const firstSource = fictionalOrderEmail({
        fileAlias: firstAlias,
        purchaseOrderNumber: "SIGNED-ORDER-1",
        messageId: firstMessageId,
        lines: [{ itemCode: "BOLT-10", quantity: 4 }],
      });
      const firstIngress = await client.submit({
        deliveryId: "delivery-signed-order-1",
        inputMessageAlias: firstAlias,
        sentAt: new Date().toISOString(),
        message: firstSource,
      });
      expect(firstIngress).toMatchObject({
        status: 201,
        body: {
          accepted: true,
          inputMessageAlias: firstAlias,
          secretVersion: "receiver-v1",
        },
      });

      const firstEnvelope = inboxEnvelope({
        requestId: "signed-message-first",
        operationKey: inboxMessageOperationKey(firstMessageId),
        inputMessageAlias: firstAlias,
        expectedMessageSha256: String(firstIngress.body.messageSha256),
      });
      if (firstEnvelope.capabilityMode !== "experimental-inbox-message-actions") {
        throw new Error("Expected inbox mode.");
      }
      firstEnvelope.request.contractHash = world.contractHash;
      const token = manager.readAccessTokenForLocalClient();
      const firstSubmission = await built.app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: firstEnvelope,
      });
      expect(firstSubmission.statusCode).toBe(202);
      const firstTerminal = await waitForTerminal(
        built.app,
        token,
        "fictional-distributor-inbox",
        firstSubmission.json().jobId,
      );
      expect(firstTerminal).toMatchObject({
        status: "completed",
        result: {
          capabilityMode: "experimental-inbox-message-actions",
          acquisitionPath: "built-capability",
          parentResumed: true,
          parentCompleted: true,
        },
      });

      const secondMessageId = "<signed-order-2@east-industrial.example>";
      const secondAlias = "signed-order-2.eml";
      const secondIngress = await client.submit({
        deliveryId: "delivery-signed-order-2",
        inputMessageAlias: secondAlias,
        sentAt: new Date().toISOString(),
        message: fictionalOrderEmail({
          fileAlias: secondAlias,
          purchaseOrderNumber: "SIGNED-ORDER-2",
          messageId: secondMessageId,
          lines: [{ itemCode: "FILTER-42", quantity: 2 }],
        }),
      });
      expect(secondIngress.status).toBe(201);
      const secondEnvelope = inboxEnvelope({
        requestId: "signed-message-reuse",
        operationKey: inboxMessageOperationKey(secondMessageId),
        inputMessageAlias: secondAlias,
        expectedMessageSha256: String(secondIngress.body.messageSha256),
      });
      if (secondEnvelope.capabilityMode !== "experimental-inbox-message-actions") {
        throw new Error("Expected inbox mode.");
      }
      secondEnvelope.request.contractHash = world.contractHash;
      const secondSubmission = await built.app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: secondEnvelope,
      });
      expect(secondSubmission.statusCode).toBe(202);
      const secondTerminal = await waitForTerminal(
        built.app,
        token,
        "fictional-distributor-inbox",
        secondSubmission.json().jobId,
      );
      expect(secondTerminal).toMatchObject({
        status: "completed",
        result: {
          acquisitionPath: "retained-capability",
          parentCompleted: true,
        },
      });
      expect(world.listDrafts()).toHaveLength(2);
    } finally {
      await built.close();
    }
  });

  it("rejects bad authentication, stale delivery, and replay before business action", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-signed-inbox-policy-"));
    roots.push(root);
    const receiver = new RotatingMemorySecretProvider();
    receiver.set(receiverDescriptor(), sharedSecret);
    const inboxRoot = path.join(root, "inbox");
    const ingress = createAuthenticatedMessageIngress({
      inboxRoot,
      databasePath: path.join(root, "receipts", "trusted-ingress.sqlite"),
      credentialAlias: receiverAlias,
      targetAlias: receiverTarget,
      secrets: receiver,
      maxClockSkewMs: 60_000,
    });
    const origin = await ingress.app.listen({ host: "127.0.0.1", port: 0 });
    const validClient = new AuthenticatedMessageIngressClient({
      origin,
      credentialAlias: senderAlias,
      targetAlias: senderTarget,
      secrets: senderSecrets(),
    });
    const invalidClient = new AuthenticatedMessageIngressClient({
      origin,
      credentialAlias: senderAlias,
      targetAlias: senderTarget,
      secrets: senderSecrets("wrong-fictional-shared-secret"),
    });
    const source = fictionalOrderEmail({
      fileAlias: "policy-order.eml",
      purchaseOrderNumber: "POLICY-ORDER",
      messageId: "<policy-order@east-industrial.example>",
      lines: [{ itemCode: "BOLT-10", quantity: 1 }],
    });
    try {
      const invalid = await invalidClient.submit({
        deliveryId: "invalid-signature",
        inputMessageAlias: "invalid-signature.eml",
        sentAt: new Date().toISOString(),
        message: source,
      });
      expect(invalid.status).toBe(401);
      expect(ingress.receipt("invalid-signature.eml")).toBeUndefined();
      expect(fs.existsSync(path.join(inboxRoot, "invalid-signature.eml"))).toBe(false);

      const stale = await validClient.submit({
        deliveryId: "stale-delivery",
        inputMessageAlias: "stale-delivery.eml",
        sentAt: new Date(Date.now() - 120_000).toISOString(),
        message: source,
      });
      expect(stale.status).toBe(401);
      expect(ingress.receipt("stale-delivery.eml")).toBeUndefined();

      const acceptedInput = {
        deliveryId: "accepted-delivery",
        inputMessageAlias: "accepted-delivery.eml",
        sentAt: new Date().toISOString(),
        message: source,
      };
      expect((await validClient.submit(acceptedInput)).status).toBe(201);
      expect((await validClient.submit(acceptedInput))).toMatchObject({
        status: 409,
        body: { replay: true },
      });

      const concurrentSource = fictionalOrderEmail({
        fileAlias: "concurrent-order.eml",
        purchaseOrderNumber: "CONCURRENT-ORDER",
        messageId: "<concurrent-order@east-industrial.example>",
        lines: [{ itemCode: "FILTER-42", quantity: 2 }],
      });
      const concurrent = await Promise.all([
        validClient.submit({
          deliveryId: "concurrent-delivery-a",
          inputMessageAlias: "concurrent-order.eml",
          sentAt: new Date().toISOString(),
          message: concurrentSource,
        }),
        validClient.submit({
          deliveryId: "concurrent-delivery-b",
          inputMessageAlias: "concurrent-order.eml",
          sentAt: new Date().toISOString(),
          message: concurrentSource,
        }),
      ]);
      expect(concurrent.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(fs.readFileSync(path.join(inboxRoot, "concurrent-order.eml"), "utf8")).toBe(concurrentSource);
      expect(ingress.receipt("concurrent-order.eml")?.messageSha256).toBe(
        concurrent.find((result) => result.status === 201)?.body.messageSha256,
      );
      expect(fs.readdirSync(inboxRoot).filter((name) => name.endsWith(".eml")).sort()).toEqual([
        "accepted-delivery.eml",
        "concurrent-order.eml",
      ]);
    } finally {
      await ingress.close();
    }
  });

  it("persists the trusted-ingress receipt across a fresh process boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-signed-inbox-restart-"));
    roots.push(root);
    const receiver = new RotatingMemorySecretProvider();
    receiver.set(receiverDescriptor(), sharedSecret);
    const options = {
      inboxRoot: path.join(root, "inbox"),
      databasePath: path.join(root, "receipts", "trusted-ingress.sqlite"),
      credentialAlias: receiverAlias,
      targetAlias: receiverTarget,
      secrets: receiver,
    };
    const first = createAuthenticatedMessageIngress(options);
    const origin = await first.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new AuthenticatedMessageIngressClient({
      origin,
      credentialAlias: senderAlias,
      targetAlias: senderTarget,
      secrets: senderSecrets(),
    });
    const source = fictionalOrderEmail({
      fileAlias: "restart-order.eml",
      purchaseOrderNumber: "RESTART-ORDER",
      messageId: "<restart-order@east-industrial.example>",
      lines: [{ itemCode: "GLOVE-7", quantity: 2 }],
    });
    const accepted = await client.submit({
      deliveryId: "restart-delivery",
      inputMessageAlias: "restart-order.eml",
      sentAt: new Date().toISOString(),
      message: source,
    });
    expect(accepted.status).toBe(201);
    await first.close();

    const fresh = createAuthenticatedMessageIngress(options);
    try {
      expect(fresh.receipt("restart-order.eml")).toMatchObject({
        deliveryId: "restart-delivery",
        inputMessageAlias: "restart-order.eml",
        messageSha256: accepted.body.messageSha256,
        secretVersion: "receiver-v1",
      });
    } finally {
      await fresh.close();
    }
  });
});
