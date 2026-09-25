import fs from "node:fs";
import path from "node:path";
import { CapabilityRegistry } from "../registry.js";
import { CapabilityExecutionError, CapabilityRuntime } from "../runtime.js";
import {
  createErpNextReferenceCapability,
  startErpNextDevelopmentWorld,
  type ErpNextDevelopmentWorldHandle,
} from "./erpnext-world.js";

interface CaseEvidence {
  caseId: string;
  passed: boolean;
  expectedFailure?: { category: string; status?: number };
  verifier: ReturnType<ErpNextDevelopmentWorldHandle["verify"]>;
}

function input(salesOrderId: string, injectLostResponse = false) {
  return {
    salesOrderId,
    trackingNumber: `PF-${salesOrderId}`,
    labelReference: `LABEL-${salesOrderId}`,
    injectLostResponse,
  };
}

async function complete(
  world: ErpNextDevelopmentWorldHandle,
  caseId: string,
  salesOrderId: string,
  runId: string,
  injectLostResponse = false,
): Promise<void> {
  const manifest = createErpNextReferenceCapability(world.documentation, world.secretAlias(caseId));
  const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
  await runtime.execute(manifest, "read_sales_order", { salesOrderId }, { runId });
  const createInput = input(salesOrderId, injectLostResponse);
  if (injectLostResponse) {
    try {
      await runtime.execute(manifest, "create_delivery_note", createInput, { runId });
      throw new Error("Lost-response fault did not fire.");
    } catch (error) {
      if (!(error instanceof CapabilityExecutionError) || error.category !== "service" || error.status !== 503) {
        throw error;
      }
    }
    await runtime.execute(manifest, "create_delivery_note", createInput, { runId });
  } else {
    await runtime.execute(manifest, "create_delivery_note", createInput, { runId });
  }
  await runtime.execute(
    manifest,
    "update_sales_order",
    {
      salesOrderId,
      trackingNumber: `PF-${salesOrderId}`,
      labelReference: `LABEL-${salesOrderId}`,
    },
    { runId },
  );
}

async function expectedFailure(
  world: ErpNextDevelopmentWorldHandle,
  caseId: string,
  salesOrderId: string,
): Promise<{ category: string; status?: number }> {
  const manifest = createErpNextReferenceCapability(world.documentation, world.secretAlias(caseId));
  const runtime = new CapabilityRuntime(world.runtimeConfiguration(caseId));
  try {
    await runtime.execute(manifest, "create_delivery_note", input(salesOrderId), { runId: `proof-${caseId}` });
  } catch (error) {
    if (error instanceof CapabilityExecutionError) {
      return {
        category: error.category,
        ...(error.status === undefined ? {} : { status: error.status }),
      };
    }
    throw error;
  }
  throw new Error(`Case ${caseId} unexpectedly wrote successfully.`);
}

function packageVersion(filename: string): string {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as { version?: string };
  return parsed.version ?? "unknown";
}

async function main(): Promise<void> {
  const repository = process.cwd();
  const outputDirectory = path.join(repository, "artifacts", "customer-world-transfer", "latest");
  const workDirectory = path.join(outputDirectory, "work");
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(workDirectory, { recursive: true });
  const world = await startErpNextDevelopmentWorld(workDirectory);
  const evidence: CaseEvidence[] = [];
  try {
    const alreadyHash = world.reset("already-satisfied");
    evidence.push({
      caseId: "already-satisfied",
      passed: world.stateHash() === alreadyHash && world.verify("already-satisfied").passed,
      verifier: world.verify("already-satisfied"),
    });

    world.reset("first-build");
    await complete(world, "first-build", "SO-DEV-0002", "proof-first-build");
    evidence.push({ caseId: "first-build", passed: world.verify("first-build").passed, verifier: world.verify("first-build") });

    const registryFile = path.join(workDirectory, "registry.json");
    const manifest = createErpNextReferenceCapability(world.documentation, world.secretAlias("fresh-session-reuse"));
    const firstRegistryProcess = new CapabilityRegistry(registryFile);
    firstRegistryProcess.register(manifest);
    firstRegistryProcess.install(manifest.id);
    const freshRegistryProcess = new CapabilityRegistry(registryFile);
    const retained = freshRegistryProcess.install(manifest.id);
    world.reset("fresh-session-reuse");
    const reuseRuntime = new CapabilityRuntime(world.runtimeConfiguration("fresh-session-reuse"));
    await reuseRuntime.execute(retained, "create_delivery_note", input("SO-DEV-0003"), { runId: "proof-reuse" });
    await reuseRuntime.execute(
      retained,
      "update_sales_order",
      {
        salesOrderId: "SO-DEV-0003",
        trackingNumber: "PF-SO-DEV-0003",
        labelReference: "LABEL-SO-DEV-0003",
      },
      { runId: "proof-reuse" },
    );
    evidence.push({
      caseId: "fresh-session-reuse",
      passed: world.verify("fresh-session-reuse").passed,
      verifier: world.verify("fresh-session-reuse"),
    });

    for (const caseId of ["permission-denial", "incomplete-permission"] as const) {
      const resetHash = world.reset(caseId);
      const failure = await expectedFailure(world, caseId, "SO-DEV-0004");
      const verifier = world.verify(caseId);
      evidence.push({
        caseId,
        passed: failure.category === "permission" && world.stateHash() === resetHash && verifier.passed,
        expectedFailure: failure,
        verifier,
      });
    }

    const invalidHash = world.reset("invalid-target");
    const invalidFailure = await expectedFailure(world, "invalid-target", "SO-DEV-0005");
    const invalidVerifier = world.verify("invalid-target");
    evidence.push({
      caseId: "invalid-target",
      passed: invalidFailure.status === 422 && world.stateHash() === invalidHash && invalidVerifier.passed,
      expectedFailure: invalidFailure,
      verifier: invalidVerifier,
    });

    world.reset("lost-response-retry");
    await complete(world, "lost-response-retry", "SO-DEV-0006", "proof-stable-retry", true);
    const retryVerifier = world.verify("lost-response-retry");
    evidence.push({ caseId: "lost-response-retry", passed: retryVerifier.passed, verifier: retryVerifier });

    const resetHashOne = world.reset("first-build");
    const resetHashTwo = world.reset("first-build");
    const sqliteVersion = world.database.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    const proof = {
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      milestone: "Phase B zero-cost local transfer plumbing",
      classification: "development plumbing; not a model evaluation, customer validation, pilot, or production claim",
      adapter: world.adapterKind,
      externalAccountsCreated: 0,
      externalNetworkCalls: 0,
      modelCalls: 0,
      versions: {
        node: process.version,
        sqlite: sqliteVersion.version,
        typescript: packageVersion(path.join(repository, "node_modules", "typescript", "package.json")),
        vitest: packageVersion(path.join(repository, "node_modules", "vitest", "package.json")),
        fastify: packageVersion(path.join(repository, "node_modules", "fastify", "package.json")),
      },
      documentationHash: world.documentation.sha256,
      secretAliasesOnly: world.cases.map((testCase) => ({
        caseId: testCase.id,
        credentialProfile: testCase.credentialProfile,
        alias: world.secretAlias(testCase.id),
      })),
      allowedSurface: {
        host: "127.0.0.1 on an ephemeral port",
        methodsAndRoutes: [
          "GET /api/resource/Sales%20Order/:name",
          "GET /api/resource/Delivery%20Note/:name",
          "POST /api/resource/Delivery%20Note",
          "PUT /api/resource/Sales%20Order/:name",
        ],
      },
      deterministicReset: { passed: resetHashOne === resetHashTwo, stateHash: resetHashTwo },
      retainedCapabilityFreshProcess: { passed: retained.id === manifest.id, capabilityId: retained.id },
      fixtureTables: [
        "tabCustomer",
        "tabAddress",
        "tabItem",
        "tabWarehouse",
        "tabBin",
        "tabSalesOrder",
        "tabSalesOrderItem",
        "tabDeliveryNote",
        "tabDeliveryNoteItem",
      ],
      cases: evidence,
      passed: evidence.every((item) => item.passed) && resetHashOne === resetHashTwo,
      limitations: [
        "This is an ERPNext REST- and DocType-compatible synthetic fixture, not the full Frappe/ERPNext application.",
        "The reference capability is deterministic and hand-authored; no model selected, generated, repaired, or executed it.",
        "The fixture demonstrates local transfer plumbing only and does not establish real-customer API compatibility.",
        "No held-out external system has been selected; that remains gated on founder-conversation evidence.",
      ],
    };
    fs.writeFileSync(path.join(outputDirectory, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    if (!proof.passed) throw new Error("Deterministic customer-world proof failed.");
    process.stdout.write(`${JSON.stringify({ passed: true, cases: evidence.length, output: path.join(outputDirectory, "proof.json") })}\n`);
  } finally {
    await world.close();
  }
}

await main();
