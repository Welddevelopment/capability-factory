import { createHash, randomBytes } from "node:crypto";
import { DEVELOPMENT_GOAL } from "./config.js";

export type AuthContract =
  | { kind: "apiKey"; headerName: string; secretAlias: string }
  | { kind: "bearer"; secretAlias: string };

export interface ProcurementContract {
  docsPath: string;
  catalogPath: string;
  orderPath: string;
  auth: AuthContract;
  queryFields: {
    requiredMinTemp: string;
    requiredMaxTemp: string;
    deliverBy: string;
  };
  orderFields: {
    productSku: string;
    quantity: string;
    warehouseId: string;
    deliverBy: string;
  };
}

export interface ShipmentRecord {
  id: string;
  arrivalAt: string;
  warehouseId: string;
  minTempC: number;
  maxTempC: number;
}

export interface WarehouseRecord {
  id: string;
  name: string;
}

export interface EquipmentRecord {
  id: string;
  warehouseId: string;
  productSku: string;
  minTempC: number;
  maxTempC: number;
}

export interface CatalogRecord {
  productSku: string;
  name: string;
  minTempC: number;
  maxTempC: number;
  leadTimeHours: number;
  priceCents: number;
}

export type ExpectedOutcome =
  | {
      kind: "order";
      productSku: string;
      quantity: number;
      warehouseId: string;
      deliverBy: string;
    }
  | { kind: "none" }
  | { kind: "handoff"; reason: "permission" | "no-route" | "no-product" };

export interface Scenario {
  id: string;
  goal: string;
  now: string;
  shipments: ShipmentRecord[];
  warehouses: WarehouseRecord[];
  installedEquipment: EquipmentRecord[];
  catalog: CatalogRecord[];
  credential: {
    secretAlias: string;
    secretValue: string;
    canWrite: boolean;
  };
  contract: ProcurementContract;
  expected: ExpectedOutcome;
  orderBehavior?: {
    structuredFailuresBeforeSuccess: number;
  };
}

export type DevelopmentCaseName =
  | "cold-shipment"
  | "already-ready"
  | "varied-bearer-contract"
  | "structured-error-retry"
  | "missing-write-permission";

const apiKeyContract: ProcurementContract = {
  docsPath: "/docs/procurement/openapi.json",
  catalogPath: "/buy/catalog/items",
  orderPath: "/buy/purchase-orders",
  auth: {
    kind: "apiKey",
    headerName: "x-procurement-key",
    secretAlias: "PROCUREMENT_API_KEY",
  },
  queryFields: {
    requiredMinTemp: "required_min_temp_c",
    requiredMaxTemp: "required_max_temp_c",
    deliverBy: "deliver_by",
  },
  orderFields: {
    productSku: "sku",
    quantity: "units",
    warehouseId: "destination_warehouse",
    deliverBy: "deliver_before",
  },
};

export function developmentScenario(): Scenario {
  return {
    id: "cold-shipment-development",
    goal: DEVELOPMENT_GOAL,
    now: "2026-07-20T09:00:00.000Z",
    shipments: [
      {
        id: "SHIP-204",
        arrivalAt: "2026-07-24T15:00:00.000Z",
        warehouseId: "WH-NORTH",
        minTempC: -18,
        maxTempC: -14,
      },
    ],
    warehouses: [{ id: "WH-NORTH", name: "North receiving warehouse" }],
    installedEquipment: [
      {
        id: "EQ-AMBIENT-1",
        warehouseId: "WH-NORTH",
        productSku: "SENSOR-AMBIENT",
        minTempC: 0,
        maxTempC: 30,
      },
    ],
    catalog: [
      {
        productSku: "SENSOR-COLD-16",
        name: "Modular cold-storage unit -25°C to -10°C",
        minTempC: -25,
        maxTempC: -10,
        leadTimeHours: 48,
        priceCents: 12_900,
      },
      {
        productSku: "SENSOR-FREEZER-40",
        name: "Deep-freeze storage unit -50°C to -30°C",
        minTempC: -50,
        maxTempC: -30,
        leadTimeHours: 24,
        priceCents: 18_500,
      },
      {
        productSku: "SENSOR-COLD-SLOW",
        name: "Cold-storage unit with delayed delivery",
        minTempC: -25,
        maxTempC: -10,
        leadTimeHours: 144,
        priceCents: 9_900,
      },
    ],
    credential: {
      secretAlias: "PROCUREMENT_API_KEY",
      secretValue: "dev-procurement-secret",
      canWrite: true,
    },
    contract: structuredClone(apiKeyContract),
    expected: {
      kind: "order",
      productSku: "SENSOR-COLD-16",
      quantity: 1,
      warehouseId: "WH-NORTH",
      deliverBy: "2026-07-24T15:00:00.000Z",
    },
  };
}

export function developmentScenarioForCase(name: DevelopmentCaseName): Scenario {
  if (name === "cold-shipment") return developmentScenario();
  if (name === "varied-bearer-contract") {
    return generateScenario("development-varied-bearer-contract", "build");
  }
  const scenario = developmentScenario();
  scenario.id = `development-${name}`;
  if (name === "already-ready") {
    const shipment = scenario.shipments[0];
    if (!shipment) throw new Error("Development scenario has no shipment");
    scenario.installedEquipment = [
      {
        id: "EQ-COLD-READY",
        warehouseId: shipment.warehouseId,
        productSku: "INSTALLED-COLD-STORAGE",
        minTempC: shipment.minTempC - 5,
        maxTempC: shipment.maxTempC + 5,
      },
    ];
    scenario.expected = { kind: "none" };
  } else if (name === "structured-error-retry") {
    scenario.orderBehavior = { structuredFailuresBeforeSuccess: 1 };
  } else if (name === "missing-write-permission") {
    scenario.credential.canWrite = false;
    scenario.expected = { kind: "handoff", reason: "permission" };
  }
  return scenario;
}

export const DEVELOPMENT_CASES: readonly DevelopmentCaseName[] = [
  "cold-shipment",
  "already-ready",
  "varied-bearer-contract",
  "structured-error-retry",
  "missing-write-permission",
];

class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[Math.floor(this.next() * values.length)];
    if (value === undefined) throw new Error("Cannot pick from an empty array");
    return value;
  }
}

export function createHeldOutSeed(): string {
  return randomBytes(32).toString("hex");
}

export function generateScenario(
  seed: string,
  kind: "reuse" | "build" | "handoff" | "confirmation",
): Scenario {
  const random = new SeededRandom(`${seed}:${kind}`);
  const suffix = createHash("sha256").update(`${seed}:${kind}`).digest("hex").slice(0, 8);
  const minTemp = random.pick([-22, -18, -12] as const);
  const maxTemp = minTemp + 5;
  const arrivalAt = "2026-08-07T15:00:00.000Z";
  const warehouseId = `WH-${suffix.slice(0, 4).toUpperCase()}`;
  const productSku = `PX-${suffix.toUpperCase()}`;
  const compatibleProductName = random.pick([
    "Modular cold-storage unit",
    "Temperature-controlled receiving unit",
    "Portable refrigerated storage unit",
  ] as const);
  const bearer = random.next() > 0.5;
  const routeStem = random.pick(["supply", "acquire", "vendor"] as const);
  const contract: ProcurementContract = {
    docsPath: `/docs/${routeStem}/${suffix}.json`,
    catalogPath: `/${routeStem}/${suffix}/products/search`,
    orderPath: `/${routeStem}/${suffix}/orders/create`,
    auth: bearer
      ? { kind: "bearer", secretAlias: `TOKEN_${suffix.toUpperCase()}` }
      : {
          kind: "apiKey",
          headerName: `x-${suffix}-key`,
          secretAlias: `KEY_${suffix.toUpperCase()}`,
        },
    queryFields: {
      requiredMinTemp: `minimum_${suffix.slice(0, 3)}`,
      requiredMaxTemp: `maximum_${suffix.slice(0, 3)}`,
      deliverBy: `needed_${suffix.slice(0, 3)}`,
    },
    orderFields: {
      productSku: `item_${suffix.slice(0, 3)}`,
      quantity: `count_${suffix.slice(0, 3)}`,
      warehouseId: `site_${suffix.slice(0, 3)}`,
      deliverBy: `deadline_${suffix.slice(0, 3)}`,
    },
  };
  const secretAlias = contract.auth.secretAlias;
  const canWrite = kind !== "handoff";

  return {
    id: `${kind}-${suffix}`,
    goal: DEVELOPMENT_GOAL,
    now: "2026-08-03T09:00:00.000Z",
    shipments: [
      {
        id: `SHIP-${suffix.slice(0, 5).toUpperCase()}`,
        arrivalAt,
        warehouseId,
        minTempC: minTemp,
        maxTempC: maxTemp,
      },
    ],
    warehouses: [{ id: warehouseId, name: `Receiving site ${suffix.slice(0, 4)}` }],
    installedEquipment: [],
    catalog: [
      {
        productSku,
        name: `${compatibleProductName} ${suffix}`,
        minTempC: minTemp - 8,
        maxTempC: maxTemp + 8,
        leadTimeHours: 24,
        priceCents: 10_000 + Math.floor(random.next() * 5_000),
      },
      {
        productSku: `WRONG-${suffix.toUpperCase()}`,
        name: `Incompatible ambient-storage unit ${suffix}`,
        minTempC: maxTemp + 10,
        maxTempC: maxTemp + 30,
        leadTimeHours: 12,
        priceCents: 5_000,
      },
    ],
    credential: {
      secretAlias,
      secretValue: `held-out-${suffix}-secret`,
      canWrite,
    },
    contract,
    expected: canWrite
      ? { kind: "order", productSku, quantity: 1, warehouseId, deliverBy: arrivalAt }
      : { kind: "handoff", reason: "permission" },
  };
}
