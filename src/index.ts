/**
 * ops-investigator — Infrastructure investigation agent.
 *
 * Accepts a TaskPayload from MC Backend, runs a Gemma 4 tool-calling loop
 * over ArgoCD / Prometheus / Proxmox / events, produces an investigation
 * report, and reports back to MC.
 *
 * Also exposes an Express HTTP server so MC Backend can POST tasks.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { OpsInvestigatorInputSchema } from './schema.js';
import { buildTools } from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3005', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';

// ─── Agent Logic ─────────────────────────────────────────────────

async function runInvestigation(payload: z.infer<typeof TaskPayloadSchema>): Promise<void> {
  const startMs = Date.now();
  const input = OpsInvestigatorInputSchema.parse(payload.input);

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'ops-investigator',
  });

  await reporter.running('Gathering infrastructure data...');
  log.info({ taskId: payload.taskId, input }, 'ops-investigator starting');

  const focusNote = input.triggerEvent
    ? `This investigation was triggered by: [${input.triggerEvent.severity.toUpperCase()}] ${input.triggerEvent.source}/${input.triggerEvent.type}: ${input.triggerEvent.message}`
    : `Performing a ${input.focus} infrastructure health check.`;

  const userPrompt = `
You are an infrastructure investigator for a homelab Kubernetes cluster.
${focusNote}

Your job:
1. Use the available tools to gather current status (ArgoCD apps, cluster health, Proxmox nodes, recent events)
2. Identify any problems, degraded services, or anomalies
3. Write a concise investigation report with:
   - Overall health: HEALTHY / DEGRADED / CRITICAL
   - Findings (bullet points per system)
   - Issues found (if any)
   - Recommended actions (if any)

Focus areas: ${input.focus}
${input.eventSource ? `Event source filter: ${input.eventSource}` : ''}
${input.eventSeverity ? `Event severity filter: ${input.eventSeverity}` : ''}

Start by gathering the data, then produce the report.
`.trim();

  try {
    const { finalResponse, toolCallLog, iterations } = await runToolLoop({
      ollamaUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      system: 'You are an expert SRE investigating homelab infrastructure. Be concise and factual. Use tools to gather data before forming conclusions.',
      userPrompt,
      tools: buildTools(),
      onIteration: (i, content) => {
        if (content) log.info({ taskId: payload.taskId, iteration: i }, 'loop response');
      },
    });

    const durationMs = Date.now() - startMs;
    log.info({ taskId: payload.taskId, iterations, durationMs }, 'investigation complete');

    const toolSummary = toolCallLog.length > 0
      ? `\n\n---\n**Tools used:** ${[...new Set(toolCallLog.map(t => t.tool))].join(', ')}`
      : '';

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'ops-investigator',
      status: 'complete',
      summary: firstLine(finalResponse),
      artifacts: [
        {
          type: 'investigation-report',
          label: 'Infrastructure Investigation Report',
          content: finalResponse + toolSummary,
        },
      ],
      durationMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'investigation failed');
    await reporter.fail(msg);
  }
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim().length > 0) ?? text.slice(0, 100);
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

// MC Backend POSTs here to dispatch a task
app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  // Run async — don't await (MC doesn't wait for completion)
  runInvestigation(parsed.data).catch(err => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled investigation error');
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'ops-investigator', model: OLLAMA_MODEL });
});

app.listen(PORT, () => {
  log.info({ port: PORT, model: OLLAMA_MODEL }, 'ops-investigator listening');
});
