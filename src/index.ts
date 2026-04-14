/**
 * ops-investigator — Infrastructure investigation agent.
 *
 * Accepts a TaskPayload from MC Backend, runs a deterministic step plan
 * over ArgoCD / Prometheus / Proxmox / events, produces an investigation
 * report, and reports back to MC.
 *
 * Also exposes an Express HTTP server so MC Backend can POST tasks.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { OpsInvestigatorInputSchema } from './schema.js';
import { buildPlan, executeStep, formatReport, type OpsStep, type OpsStepLog } from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3005', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

interface SharedAgentReporter {
  running(message: string): Promise<void>;
  complete(result: {
    taskId: string;
    agentName: string;
    status: 'complete';
    summary: string;
    artifacts: Array<{ type: string; label: string; content: string }>;
    durationMs: number;
    completedAt: string;
  }): Promise<void>;
  fail(message: string): Promise<void>;
}

interface SharedAgentsModule {
  AgentReporter: new (opts: { mcUrl: string; taskId: string; agentName: string }) => SharedAgentReporter;
  TaskPayloadSchema: z.ZodType<{
    taskId: string;
    agentName: string;
    trigger: string;
    input: Record<string, unknown>;
    issuedAt: string;
  }>;
  runDeterministicPlan: (opts: {
    steps: OpsStep[];
    executeStep: (step: OpsStep) => Promise<string>;
    onStepStart?: (step: OpsStep, index: number) => void | Promise<void>;
    stopOnError?: boolean;
  }) => Promise<{
    status: 'complete' | 'failed';
    logs: OpsStepLog[];
    completedSteps: number;
    failedStep?: OpsStepLog;
  }>;
}

async function loadSharedAgents(): Promise<SharedAgentsModule> {
  return import(SHARED_AGENTS_MODULE_PATH) as Promise<SharedAgentsModule>;
}

// ─── Agent Logic ─────────────────────────────────────────────────

async function runInvestigation(payload: { taskId: string; input: Record<string, unknown> }): Promise<void> {
  const startMs = Date.now();
  const input = OpsInvestigatorInputSchema.parse(payload.input);
  const shared = await loadSharedAgents();
  const { AgentReporter, runDeterministicPlan } = shared;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'ops-investigator',
  });

  const modeLabel = input.triggerEvent
    ? `event-driven (${input.triggerEvent.severity}: ${input.triggerEvent.source}/${input.triggerEvent.type})`
    : input.mode;

  await reporter.running(`Starting ops investigation (${modeLabel})...`);
  log.info({ taskId: payload.taskId, input }, 'ops-investigator starting');

  const steps = buildPlan(input);

  try {
    const result = await runDeterministicPlan({
      steps,
      executeStep,
      onStepStart: async (step, index) => {
        await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
      },
    });

    const durationMs = Date.now() - startMs;
    const report = formatReport(result.logs);
    const summary = result.failedStep
      ? `Failed at: ${result.failedStep.step.title}`
      : `Investigation complete — ${result.completedSteps} step(s) finished`;

    log.info({ taskId: payload.taskId, durationMs, steps: result.logs.length, status: result.status }, 'investigation complete');

    if (result.status === 'failed') {
      await reporter.fail(`${summary}\n\n${report}`);
      return;
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'ops-investigator',
      status: 'complete',
      summary,
      artifacts: [
        {
          type: 'investigation-report',
          label: 'Infrastructure Investigation Report',
          content: report,
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

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

const shared = await loadSharedAgents();
const { TaskPayloadSchema } = shared;

app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  runInvestigation(parsed.data).catch(err => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled investigation error');
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'ops-investigator', sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH });
});

app.listen(PORT, () => {
  log.info({ port: PORT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'ops-investigator listening');
});
