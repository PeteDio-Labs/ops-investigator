/**
 * Lightweight HTTP clients for ops-investigator.
 * Lifted from mcp-homelab, self-contained.
 */

const MC_URL = process.env.MC_BACKEND_URL || 'http://localhost:3000';
const NOTIF_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';
const TIMEOUT_MS = 10_000;

// ─── MC Backend ──────────────────────────────────────────────────

export interface ArgoApp {
  name: string;
  status: { sync: { status: string }; health: { status: string } };
}

export interface ProxmoxNode {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
}

async function mcGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MC_URL}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MC Backend ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function mcPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MC_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MC Backend ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getArgoApps(): Promise<ArgoApp[]> {
  const data = await mcGet<{ applications: ArgoApp[] }>('/api/v1/argocd/applications');
  return data.applications ?? [];
}

export async function getClusterHealth(): Promise<Record<string, unknown>> {
  return mcGet('/api/v1/prometheus/cluster/health');
}

export async function syncArgoApp(name: string): Promise<{ success: boolean; message?: string; error?: string }> {
  return mcPost(`/api/v1/argocd/applications/${encodeURIComponent(name)}/sync`, {});
}

export async function restartDeployment(namespace: string, name: string): Promise<{ success: boolean; message?: string; error?: string }> {
  return mcPost('/api/v1/kubernetes/deployments/restart', { namespace, name });
}

export async function getProxmoxNodes(): Promise<ProxmoxNode[]> {
  const data = await mcGet<{ nodes: ProxmoxNode[] }>('/api/v1/proxmox/nodes');
  return data.nodes ?? [];
}

export async function mcHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MC_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch { return false; }
}

// ─── Notification Service ────────────────────────────────────────

export interface InfraEvent {
  id?: string;
  source: string;
  type: string;
  severity: string;
  message: string;
  affected_service?: string;
  namespace?: string;
  timestamp?: string;
}

export async function getRecentEvents(limit = 30, source?: string, severity?: string): Promise<InfraEvent[]> {
  let url = `${NOTIF_URL}/api/v1/events?limit=${limit}`;
  if (source) url += `&source=${source}`;
  if (severity) url += `&severity=${severity}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Notification service /events → ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data as { events: InfraEvent[] }).events ?? [];
}

export async function notifHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${NOTIF_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch { return false; }
}
