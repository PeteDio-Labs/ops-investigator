/**
 * Deterministic step runner for ops-investigator.
 * Each mode maps to a fixed sequence of OpsStep actions.
 * No Ollama — all logic is coded.
 */

import type { OpsInvestigatorInput } from './schema.js';
import {
  getArgoApps, getClusterHealth, getProxmoxNodes, getRecentEvents,
  syncArgoApp, restartDeployment,
  mcHealthy, notifHealthy,
} from './clients.js';

// ─── Step types ───────────────────────────────────────────────────

export type OpsAction =
  | 'get-argocd-status'
  | 'get-cluster-health'
  | 'get-proxmox-nodes'
  | 'get-recent-events'
  | 'sync-argocd-app'
  | 'restart-k8s-deployment';

export interface OpsStep {
  title: string;
  action: OpsAction;
  args?: Record<string, unknown>;
}

export interface OpsStepLog {
  step: OpsStep;
  status: 'complete' | 'failed';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// ─── Plan builder ─────────────────────────────────────────────────

export function buildPlan(input: OpsInvestigatorInput): OpsStep[] {
  switch (input.mode) {
    case 'argocd':
      return [{ title: 'Get ArgoCD app status', action: 'get-argocd-status' }];

    case 'cluster':
      return [{ title: 'Get cluster health', action: 'get-cluster-health' }];

    case 'proxmox':
      return [{ title: 'Get Proxmox node status', action: 'get-proxmox-nodes' }];

    case 'events':
      return [{
        title: 'Get recent infrastructure events',
        action: 'get-recent-events',
        args: { limit: input.eventLimit, source: input.eventSource, severity: input.eventSeverity },
      }];

    case 'sync-app':
      return [
        { title: 'Get ArgoCD app status (pre-sync)', action: 'get-argocd-status' },
        { title: `Sync ArgoCD app: ${input.appName}`, action: 'sync-argocd-app', args: { name: input.appName } },
      ];

    case 'restart-deployment':
      return [
        { title: `Restart deployment: ${input.deploymentName} in ${input.namespace}`, action: 'restart-k8s-deployment', args: { namespace: input.namespace, name: input.deploymentName } },
        { title: 'Get recent events (post-restart)', action: 'get-recent-events', args: { limit: 10 } },
      ];

    case 'full-check':
    default:
      return [
        { title: 'Get ArgoCD app status', action: 'get-argocd-status' },
        { title: 'Get cluster health', action: 'get-cluster-health' },
        { title: 'Get Proxmox node status', action: 'get-proxmox-nodes' },
        {
          title: 'Get recent events',
          action: 'get-recent-events',
          args: { limit: input.eventLimit, source: input.eventSource, severity: input.eventSeverity },
        },
      ];
  }
}

// ─── Step executor ────────────────────────────────────────────────

export async function executeStep(step: OpsStep): Promise<string> {
  switch (step.action) {
    case 'get-argocd-status': {
      if (!await mcHealthy()) return 'MC Backend unreachable';
      const apps = await getArgoApps();
      if (apps.length === 0) return 'No ArgoCD apps found';
      const degraded = apps.filter(a =>
        a.status?.sync?.status !== 'Synced' || a.status?.health?.status !== 'Healthy'
      );
      const lines = apps.map(a =>
        `${a.name}: sync=${a.status?.sync?.status ?? 'unknown'}, health=${a.status?.health?.status ?? 'unknown'}`
      );
      return [
        `ArgoCD Apps (${apps.length} total, ${degraded.length} degraded):`,
        ...lines,
      ].join('\n');
    }

    case 'get-cluster-health': {
      if (!await mcHealthy()) return 'MC Backend unreachable';
      const health = await getClusterHealth();
      return JSON.stringify(health, null, 2);
    }

    case 'get-proxmox-nodes': {
      if (!await mcHealthy()) return 'MC Backend unreachable';
      const nodes = await getProxmoxNodes();
      if (nodes.length === 0) return 'No Proxmox nodes found';
      return nodes.map(n => {
        const cpu = `${(n.cpu * 100).toFixed(1)}%`;
        const mem = `${((n.mem / n.maxmem) * 100).toFixed(1)}%`;
        return `${n.node}: status=${n.status}, cpu=${cpu}, mem=${mem}`;
      }).join('\n');
    }

    case 'get-recent-events': {
      if (!await notifHealthy()) return 'Notification service unreachable';
      const args = step.args ?? {};
      const events = await getRecentEvents(
        typeof args.limit === 'number' ? args.limit : 20,
        typeof args.source === 'string' ? args.source : undefined,
        typeof args.severity === 'string' ? args.severity : undefined,
      );
      if (events.length === 0) return 'No events found';
      return events.map(e => {
        const parts = [`[${e.severity?.toUpperCase()}] ${e.source}/${e.type}: ${e.message}`];
        if (e.affected_service) parts.push(`  service: ${e.affected_service}`);
        if (e.namespace) parts.push(`  namespace: ${e.namespace}`);
        if (e.timestamp) parts.push(`  at: ${e.timestamp}`);
        return parts.join('\n');
      }).join('\n\n');
    }

    case 'sync-argocd-app': {
      if (!await mcHealthy()) return 'MC Backend unreachable — cannot sync app';
      const name = String(step.args?.name ?? '');
      if (!name) return 'sync-argocd-app: missing app name';
      const result = await syncArgoApp(name);
      if (result.success) return `Synced ${name} successfully.`;
      return `Sync failed: ${result.error ?? result.message ?? 'unknown error'}`;
    }

    case 'restart-k8s-deployment': {
      if (!await mcHealthy()) return 'MC Backend unreachable — cannot restart deployment';
      const namespace = String(step.args?.namespace ?? '');
      const name = String(step.args?.name ?? '');
      if (!namespace || !name) return 'restart-k8s-deployment: missing namespace or name';
      const result = await restartDeployment(namespace, name);
      if (result.success) return `Restarted ${name} in ${namespace}.`;
      return `Restart failed: ${result.error ?? result.message ?? 'unknown error'}`;
    }

    default:
      throw new Error(`Unknown ops action: ${(step as OpsStep).action}`);
  }
}

// ─── Report formatter ─────────────────────────────────────────────

export function formatReport(logs: OpsStepLog[]): string {
  if (logs.length === 0) return 'No steps executed.';
  return logs.map((log, index) => {
    const lines = [
      `${index + 1}. ${log.step.title} [${log.status}]`,
      `duration: ${log.durationMs}ms`,
    ];
    if (log.output) {
      lines.push('output:');
      lines.push(log.output);
    }
    return lines.join('\n');
  }).join('\n\n');
}
