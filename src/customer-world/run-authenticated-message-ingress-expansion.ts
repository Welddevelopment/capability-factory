import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FictionalInboxOrderWorld,
  fictionalOrderEmail,
} from "./inbox-order-world.js";
import {
  AuthenticatedMessageIngressClient,
  createAuthenticatedMessageIngress,
} from "../experimental/authenticated-message-ingress.js";
import {
  inboxMessageOperationKey,
} from "../experimental/inbox-message-driver.js";
import {
  RotatingMemorySecretProvider,
  type ScopedSecretDescriptor,
} from "../product/secrets.js";

const receiverAlias = "signed_message_ingress_key";
const senderAlias = "supplier_message_signing_key";
const receiverTarget = "fictional_signed_message_ingress";
const senderTarget = "fictional_supplier_webhook";
const sharedSecret = "fictional-shared-webhook-secret-with-sufficient-entropy";

function descriptor(input: {
  alias: string;
  targetAlias: string;
  actionName: string;
  version: string;
}): ScopedSecretDescriptor {
  return {
    alias: input.alias,
    version: input.version,
    scope: {
      targetAliases: [input.targetAlias],
      actionNames: [input.actionName],
      methods: ["POST"],
    },
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-factory-signed-message-demo-"));
  const world = new FictionalInboxOrderWorld(path.join(root, "world"));
  const receiverSecrets = new RotatingMemorySecretProvider();
  receiverSecrets.set(descriptor({
    alias: receiverAlias,
    targetAlias: receiverTarget,
    actionName: "accept-signed-message",
    version: "receiver-v1",
  }), sharedSecret);
  const senderSecrets = new RotatingMemorySecretProvider();
  senderSecrets.set(descriptor({
    alias: senderAlias,
    targetAlias: senderTarget,
    actionName: "send-signed-message",
    version: "sender-v1",
  }), sharedSecret);

  const ingress = createAuthenticatedMessageIngress({
    inboxRoot: world.inboxRoot,
    databasePath: path.join(root, "trusted-ingress.sqlite"),
    credentialAlias: receiverAlias,
    targetAlias: receiverTarget,
    secrets: receiverSecrets,
  });
  world.attachTrustedIngressReceiptLookup(
    (alias) => ingress.receipt(alias)?.messageSha256,
  );
  const origin = await ingress.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new AuthenticatedMessageIngressClient({
    origin,
    credentialAlias: senderAlias,
    targetAlias: senderTarget,
    secrets: senderSecrets,
  });

  try {
    const messageId = "<signed-demo-order@east-industrial.example>";
    const inputMessageAlias = "signed-demo-order.eml";
    const signedIngress = await client.submit({
      deliveryId: "signed-demo-delivery",
      inputMessageAlias,
      sentAt: new Date().toISOString(),
      message: fictionalOrderEmail({
        fileAlias: inputMessageAlias,
        purchaseOrderNumber: "SIGNED-DEMO-ORDER",
        messageId,
        lines: [
          { itemCode: "BOLT-10", quantity: 10 },
          { itemCode: "FILTER-42", quantity: 2 },
        ],
      }),
    });
    if (signedIngress.status !== 201) {
      throw new Error(`Signed ingress failed with HTTP ${signedIngress.status}.`);
    }
    const result = await world.complete({
      requestId: "signed-message-demo",
      operationKey: inboxMessageOperationKey(messageId),
      inputMessageAlias,
      expectedMessageSha256: String(signedIngress.body.messageSha256),
    });
    const replay = await client.submit({
      deliveryId: "signed-demo-delivery",
      inputMessageAlias,
      sentAt: new Date().toISOString(),
      message: fs.readFileSync(path.join(world.inboxRoot, inputMessageAlias)),
    });

    process.stdout.write(`${JSON.stringify({
      boundary: {
        environment: "local disposable fictional signed webhook, inbox, and draft store",
        capabilityMode: "experimental-inbox-message-actions",
        supportedWorkflow: "one HMAC-authenticated bounded plaintext supplier order to one independently verified draft",
        notClaimed: [
          "WhatsApp, SMS, Gmail, or provider-specific support",
          "attachments, arbitrary message formats, or consent management",
          "customer deployment",
          "production readiness",
        ],
      },
      trustedIngress: signedIngress.body,
      capabilityLoop: result,
      independentlyReadDrafts: world.listDrafts(),
      exactReplay: replay,
      preservedDemoRoot: root,
    }, null, 2)}\n`);
  } finally {
    await ingress.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
