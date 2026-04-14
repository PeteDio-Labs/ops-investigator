import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const OpsInvestigatorInputSchema = z.object({
  mode: z.enum([
    'full-check',   // gather all: argocd + cluster + proxmox + events
    'argocd',       // argocd status only
    'cluster',      // prometheus cluster health only
    'proxmox',      // proxmox nodes only
    'events',       // recent events only
    'sync-app',     // sync a specific ArgoCD app
    'restart-deployment', // restart a specific K8s deployment
  ]).default('full-check')
    .describe('Deterministic ops investigation mode'),
  // sync-app
  appName: z.string().optional()
    .describe('ArgoCD app name — required for sync-app mode'),
  // restart-deployment
  namespace: z.string().optional()
    .describe('K8s namespace — required for restart-deployment mode'),
  deploymentName: z.string().optional()
    .describe('Deployment name — required for restart-deployment mode'),
  // event filters
  eventSource: z.enum(['kubernetes', 'proxmox', 'argocd']).optional()
    .describe('Filter events by source'),
  eventSeverity: z.enum(['info', 'warning', 'critical']).optional()
    .describe('Filter events by severity'),
  eventLimit: z.number().int().min(1).max(100).default(20)
    .describe('Max events to fetch'),
  // trigger context (kept for event-driven invocations)
  triggerEvent: z.object({
    source: z.string(),
    type: z.string(),
    message: z.string(),
    severity: z.string(),
  }).optional().describe('Infra event that triggered this investigation'),
}).superRefine((input, ctx) => {
  if (input.mode === 'sync-app' && !input.appName) {
    ctx.addIssue({ code: 'custom', message: 'sync-app requires appName' });
  }
  if (input.mode === 'restart-deployment' && (!input.namespace || !input.deploymentName)) {
    ctx.addIssue({ code: 'custom', message: 'restart-deployment requires namespace and deploymentName' });
  }
});

export type OpsInvestigatorInput = z.infer<typeof OpsInvestigatorInputSchema>;

export const OpsTaskPayloadSchema = TaskPayloadSchema.extend({
  input: OpsInvestigatorInputSchema,
});
