import { z } from "zod";

export const pilotValueAssetSchema = z.object({
  schemaVersion: z.literal("1.0"),
  companyAlias: z.string().min(2).max(160).regex(/^[a-zA-Z0-9_.-]+$/),
  status: z.literal("internal-unreviewed-hypothesis"),
  sourceSnapshotDate: z.string().date(),
  sourceUrls: z.array(z.string().url()).min(1).max(8),
  hypothesis: z.string().min(20).max(2_000),
  ordinaryGoal: z.string().min(20).max(2_000),
  missingAction: z.string().min(3).max(160).regex(/^[a-z][a-z0-9_]+$/),
  allowedActions: z.array(z.string().min(3).max(160)).min(1).max(16),
  excludedWork: z.array(z.string().min(3).max(500)).min(1).max(16),
  exactPass: z.string().min(20).max(2_000),
  decisiveFalsifier: z.string().min(20).max(2_000),
  productionAccess: z.literal(false),
  personalData: z.literal(false),
}).strict();

export const pilotValueAssetListSchema = z.array(pilotValueAssetSchema).min(1).max(100).superRefine((assets, context) => {
  if (new Set(assets.map((asset) => asset.companyAlias)).size !== assets.length) context.addIssue({ code: "custom", message: "Company aliases must be unique." });
});

export type PilotValueAsset = z.infer<typeof pilotValueAssetSchema>;

