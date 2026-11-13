import { z } from 'zod';

const revision = z.number().int().min(1).max(2147483647);
export const PreviewRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(2000),
  context: z.strictObject({
    activeView: z.string().min(1).max(64),
    selectedTarget: z.union([z.null(), z.strictObject({
      kind: z.enum(['feature', 'entity', 'architecture_node']), id: z.string().min(1).max(128),
    })]),
  }),
  expectedBaseRevision: revision,
});
export const ApplyRequestSchema = z.strictObject({ approved: z.literal(true), expectedBaseRevision: revision });
export const RejectRequestSchema = z.strictObject({ rejected: z.literal(true), expectedBaseRevision: revision });
export const SummaryOutputSchema = z.strictObject({ summary: z.string().trim().min(1).max(4000) });
export const SummaryOperationsSchema = z.tuple([z.strictObject({
  op: z.literal('set_field'), path: z.literal('product.summary'), value: z.string().min(1).max(4000),
})]);
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;
export type SummaryOperations = z.infer<typeof SummaryOperationsSchema>;
