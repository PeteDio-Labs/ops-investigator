import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const OpsInvestigatorInputSchema = z.object({
  focus: z.enum(['full', 'argocd', 'cluster', 'proxmox', 'events']).default('full')
    .describe('Which systems to investigate'),
  eventSource: z.enum(['kubernetes', 'proxmox', 'argocd']).optional()
    .describe('Narrow event query to a specific source'),
  eventSeverity: z.enum(['info', 'warning', 'critical']).optional()
    .describe('Narrow event query to a specific severity'),
  triggerEvent: z.object({
    source: z.string(),
    type: z.string(),
    message: z.string(),
    severity: z.string(),
  }).optional().describe('Infra event that triggered this investigation'),
});

export type OpsInvestigatorInput = z.infer<typeof OpsInvestigatorInputSchema>;

// TaskPayload.input typed as OpsInvestigatorInput
export const OpsTaskPayloadSchema = TaskPayloadSchema.extend({
  input: OpsInvestigatorInputSchema,
});
