/**
 * Tool definitions for the ops-investigator Gemma 4 loop.
 * Each tool wraps a client call and returns a string result.
 */

import type { ToolDef } from '@petedio/shared/agents';
import {
  getArgoApps, getClusterHealth, getProxmoxNodes, getRecentEvents,
  mcHealthy, notifHealthy,
} from './clients.js';

export function buildTools(): ToolDef[] {
  return [
    {
      name: 'get_argocd_status',
      description: 'Get ArgoCD application sync and health status for all apps',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        if (!await mcHealthy()) return 'MC Backend unreachable';
        const apps = await getArgoApps();
        if (apps.length === 0) return 'No ArgoCD apps found';
        const lines = apps.map(a =>
          `${a.name}: sync=${a.status?.sync?.status ?? 'unknown'}, health=${a.status?.health?.status ?? 'unknown'}`
        );
        const degraded = apps.filter(a =>
          a.status?.sync?.status !== 'Synced' || a.status?.health?.status !== 'Healthy'
        );
        return [
          `ArgoCD Apps (${apps.length} total, ${degraded.length} degraded):`,
          ...lines,
        ].join('\n');
      },
    },

    {
      name: 'get_cluster_health',
      description: 'Get Prometheus cluster health metrics (node readiness, resource usage)',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        if (!await mcHealthy()) return 'MC Backend unreachable';
        const health = await getClusterHealth();
        return JSON.stringify(health, null, 2);
      },
    },

    {
      name: 'get_proxmox_nodes',
      description: 'Get Proxmox node status, CPU %, and memory % for pve01 and pve02',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        if (!await mcHealthy()) return 'MC Backend unreachable';
        const nodes = await getProxmoxNodes();
        if (nodes.length === 0) return 'No Proxmox nodes found';
        return nodes.map(n => {
          const cpu = `${(n.cpu * 100).toFixed(1)}%`;
          const mem = `${((n.mem / n.maxmem) * 100).toFixed(1)}%`;
          return `${n.node}: status=${n.status}, cpu=${cpu}, mem=${mem}`;
        }).join('\n');
      },
    },

    {
      name: 'get_recent_events',
      description: 'Get recent infrastructure events from the notification service',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max events to return (default 20)' },
          source: {
            type: 'string',
            description: 'Filter by source',
            enum: ['kubernetes', 'proxmox', 'argocd'],
          },
          severity: {
            type: 'string',
            description: 'Filter by severity',
            enum: ['info', 'warning', 'critical'],
          },
        },
      },
      async execute(args: { limit?: number; source?: string; severity?: string }) {
        if (!await notifHealthy()) return 'Notification service unreachable';
        const events = await getRecentEvents(args.limit ?? 20, args.source, args.severity);
        if (events.length === 0) return 'No events found';
        return events.map(e => {
          const parts = [`[${e.severity?.toUpperCase()}] ${e.source}/${e.type}: ${e.message}`];
          if (e.affected_service) parts.push(`  service: ${e.affected_service}`);
          if (e.namespace) parts.push(`  namespace: ${e.namespace}`);
          if (e.timestamp) parts.push(`  at: ${e.timestamp}`);
          return parts.join('\n');
        }).join('\n\n');
      },
    },
  ];
}
