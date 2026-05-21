/**
 * handoff_factory.ts — Autonomous work package factory for the orchestrator loop.
 *
 * Replaces the manual copy-paste cross-agent workflow with a machine-readable
 * dispatch envelope that any vendor-specific runner can consume without
 * a human in the loop.
 *
 * Each dispatch produces a `work_package` JSON sidecar + a `task_claim` message
 * in the shared inbox.  The sidecar contains:
 *  - task summary + file paths
 *  - success criteria (verifiable without LLM)
 *  - the loop prompt (nested loop lifecycle)
 *  - vendor-specific runner flag
 *
 * Supports these vendor flags (upstream CI gate swaps to real runner flags):
 *   kilocode     → @kilocode/plugin requires()
 *   claude-code  → Claude Agent SDK headless
 *   kiro         → kiro-cli chat --no-interactive
 *   cursor       → cursor-agent
 *   antigravity  → gemini CLI
 *
 * Kanban types (COORDINATION_IMPROVEMENTS §2.4 cc/velocity/nfr/task):
 *  - cc       — corrective-change (bug fix)
 *  - velocity — throughput improvement (refactor, de-tech-debt)
 *  - nfr      — non-functional requirement
 *  - task     — plain user story / spike
 *
 * Supports kubernetes-workload workload isolation (lb-f451c70f)
 * — spawns vendors as Kubernetes Pod-based tasks so every sub-agent
 * runs in its own isolated namespace.
 */

import * as fs from 'fs';
import * as path from 'path';
import { COMMS_DIR_REL, SHARED_INBOX_REL } from './orchestratorLoop';
import type { WorkPackage, VendorKind } from './orchestratorLoop';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Kanban-lane tokens
// ---------------------------------------------------------------------------

export type KanbanLane = 'cc' | 'velocity' | 'nfr' | 'task';

const LANE_EFFORT: Record<KanbanLane, number> = {
  cc: 3,
  velocity: 2,
  nfr: 4,
  task: 1,
};

// ---------------------------------------------------------------------------
// Task descriptor (lightweight input for factory)
// ---------------------------------------------------------------------------

export interface TaskDescriptor {
  id: string;
  lane: KanbanLane;
  name: string;
  description: string;
  filePaths: string[];
  successCriteria: string[];
  fileGlobs?: string[];       // glob scan surface for cc/velocity diffs
  expectedTestFiles?: string[];
  priority?: number;          // 1=hottest, optional
  sprint?: number;
  criticality?: 1 | 2 | 3;    // DAG criticality tier (1=CRITICAL, 2=MAJOR, 3=ROUTINE)
}

// ---------------------------------------------------------------------------
// Context (enriched by caller before dispatch)
// ---------------------------------------------------------------------------

export interface DispatchContext {
  workspaceRoot: string;
  vendor: VendorKind;
  agentId: string;
  sprint: number;
  /** Commitment to never stop working on this package until verification. */
  commitmentText: string;
  /**
   * Enable Kubernetes Pod-based workload isolation.
   * When true every dispatch goes through a k8s-wrapper: envoy as sidecar
   * + workload container where the vendor autoresolves to create the sub-claude
   * inproc, governed by the native k8s service-account.
   */
  k8sWorkload?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PackageResult {
  pkg: WorkPackage;
  why: string;
  sidecarPending: boolean;
  contextSatisfying: boolean;
}

/**
 * Build a deterministic work package.
 * Pure synchronous computation — all file I/O is deferred to dispatch.
 */
export function buildPackage(
  desc: TaskDescriptor,
  ctx: DispatchContext
): PackageResult {
  const effort = LANE_EFFORT[desc.lane];
  const vendor = ctx.vendor;
  const timeBudgetMs = effort * 60 * 60 * 1000; // effort hours → ms

  const pkg: WorkPackage = {
    type: 'work_package',
    taskId: desc.id,
    taskName: desc.name,
    description: `[${desc.lane}] ${desc.description}`,
    filePaths: desc.filePaths,
    successCriteria: desc.successCriteria,
    sprint: ctx.sprint,
    assignToVendor: vendor,
    priority: effort >= 4 ? 'high' : effort >= 2 ? 'medium' : 'low',
    timeBudgetMs,
  };

  // Derive a "why" string for the loop journal.
  const whyParts: string[] = [];
  whyParts.push(`lane=${desc.lane}`);
  whyParts.push(`vendor=${vendor}`);
  if (desc.criticality) { whyParts.push(`criticality=${desc.criticality}`); }
  if (desc.fileGlobs) { whyParts.push(`globs=${desc.fileGlobs.join(',')}`); }
  const why = whyParts.join(' ');

  // Context-satisfying: success criteria + file paths or globs
  const contextSatisfying: boolean =
    desc.successCriteria.length > 0 &&
    (desc.filePaths.length > 0 || (desc.fileGlobs != null && desc.fileGlobs.length > 0));

  return { pkg, why, sidecarPending: true, contextSatisfying };
}

// ---------------------------------------------------------------------------
// Kanban-to-task helpers
// ---------------------------------------------------------------------------

/**
 * Create a cc (corrective-change) task descriptor from a file-glob match.
 */
export function ccTask(
  repoRoot: string,
  fileGlobCandidate: string,
  laneHint?: 'cc' | 'velocity' | 'nfr' | 'task'
): TaskDescriptor {
  const lane: KanbanLane = laneHint ?? 'cc';
  const id = `${lane}-${Date.now().toString(36)}`;

  return {
    id,
    lane,
    name: `Fix in ${fileGlobCandidate}`,
    description: `Address outstanding changes in \`${fileGlobCandidate}\`. Run the existing test suite, fix failing tests or lint, and keep the existing API stable.`,
    filePaths: [path.join(repoRoot, fileGlobCandidate)],
    fileGlobs: [fileGlobCandidate],
    successCriteria: [
      `npm run test passes`,
      `npm run lint clean`,
      `Changes scoped to ${fileGlobCandidate} only`,
      `task_complete message written to shared inbox`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Commit helpers
// ---------------------------------------------------------------------------

const DISPATCH_LOG_DIR = path.join(COMMS_DIR_REL, 'agents', '_dispatch');

export interface CommitResult {
  sidecarPath: string;
  messagePath: string;
  committed: boolean;
}

/**
 * Finalise a package: write the sidecar file and the task_claim message.
 * Returns the commit record path so the caller can confirm or retry.
 */
export async function commitPackage(
  workspaceRoot: string,
  pkg: WorkPackage,
  ctx: DispatchContext
): Promise<CommitResult> {
  const commsDirRel = COMMS_DIR_REL;
  const commsDirAbs = path.join(workspaceRoot, commsDirRel);

  // Build the sidecar record.
  const record = {
    at: new Date().toISOString(),
    type: 'work_package' as const,
    taskId: pkg.taskId,
    taskName: pkg.taskName,
    lane: pkg.taskId.split('-')[0] as KanbanLane,
    vendor: pkg.assignToVendor,
    vendorAgentId: ctx.agentId,
    sprint: pkg.sprint,
    filePaths: pkg.filePaths,
    successCriteria: pkg.successCriteria,
    priority: pkg.priority,
    timeBudgetMs: pkg.timeBudgetMs,
    k8sWorkload: ctx.k8sWorkload ?? false,
    commitment: ctx.commitmentText,
    prompt: JSON.stringify(buildPackagePrompt(pkg, ctx)),
  };

  // Write sidecar.
  const sidecarFilename = `${pkg.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  const sidecarDir = path.join(workspaceRoot, DISPATCH_LOG_DIR);
  await fsPromises.mkdir(sidecarDir, { recursive: true });
  const sidecarPathFull = path.join(sidecarDir, sidecarFilename);
  await fsPromises.writeFile(sidecarPathFull, JSON.stringify(record, null, 2), 'utf8');

  // Write task_claim to shared inbox.
  const sharedInbox = path.join(workspaceRoot, SHARED_INBOX_REL);
  const claimMsg = {
    id: `msg-claim-${pkg.taskId}-${Date.now().toString(36)}`,
    from: 'orchestrator-loop',
    to: ctx.agentId,
    type: 'task_claim' as const,
    timestamp: new Date().toISOString(),
    task_id: pkg.taskId,
    payload: {
      sidecar: path.relative(sharedInbox, sidecarPathFull),
      vendor: pkg.assignToVendor,
      priority: pkg.priority,
      successCriteria: pkg.successCriteria,
    },
    requires_response: true,
  };
  await fsPromises.mkdir(sharedInbox, { recursive: true });
  const msgFilename = `${claimMsg.timestamp.replace(/[:.]/g, '-')}-task_claim-${pkg.taskId}.json`;
  const messagePathFull = path.join(sharedInbox, msgFilename);
  await fsPromises.writeFile(messagePathFull, JSON.stringify(claimMsg, null, 2), 'utf8');

  // Append to comms-log.
  const logPath = path.join(workspaceRoot, commsDirRel, 'comms-log.jsonl');
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  await fsPromises.appendFile(logPath, JSON.stringify(claimMsg) + '\n', 'utf8');

  return {
    sidecarPath: sidecarPathFull,
    messagePath: messagePathFull,
    committed: true,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the nested-loop prompt injected into every work package.
 * The nested loop lifecycle for a sub-agent:
 *
 *  1. Read success criteria
 *  2. Make changes
 *  3. Verify
 *  4. Loop back until ALL criteria pass
 *  5. Write task_complete only on verified success
 */
export function buildPackagePrompt(
  pkg: WorkPackage,
  ctx: DispatchContext
): string {
  const lines: string[] = [];
  lines.push('<!-- AutoClaw Nested Loop — DO NOT STOP UNTIL CRITERIA VERIFIED -->');
  lines.push('');
  lines.push(`## Task ${pkg.taskId}: ${pkg.taskName}`);
  lines.push(`Vendor: ${pkg.assignToVendor} | Agent: ${ctx.agentId}`);
  lines.push(`Priority: ${pkg.priority} | Sprint: ${pkg.sprint}`);
  if (pkg.timeBudgetMs > 0) {
    lines.push(`Time budget: ${Math.round(pkg.timeBudgetMs / 3600000)}h`);
  }
  lines.push('');
  lines.push('### Description');
  lines.push(pkg.description);
  lines.push('');

  if (pkg.filePaths.length > 0) {
    lines.push('### File Paths');
    for (const f of pkg.filePaths) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('### Context (Do Not Ignore)');
  lines.push('The success criteria below are mandatory. You are operating in a');
  lines.push('nested loop — do not stop until ALL criteria are verified as passing.');
  lines.push('Failure to verify is not completion.');
  lines.push('');
  lines.push('### Success Criteria');
  for (const i in pkg.successCriteria) lines.push(`${Number(i) + 1}. ${pkg.successCriteria[i]}`);

  lines.push('');
  lines.push('### Nested Loop Lifecycle');
  lines.push('1. Make the changes required by the criteria.');
  lines.push('2. Verify each criterion explicitly.');
  lines.push('3. If any criterion fails → return to step 1 with fixes.');
  lines.push('4. Only write `task_complete` to the shared inbox when EVERY criterion passes.');
  lines.push('');
  lines.push('### Task Complete Message');
  lines.push(`When done, write to \`.autoclaw/orchestrator/comms/inboxes/orchestrator-loop/\`: `);
  lines.push('```json');
  lines.push(`{`);
  lines.push(`  "id": "msg-taskcomplete-${pkg.taskId}-${Date.now().toString(36)}",`);
  lines.push(`  "from": "${ctx.agentId}",`);
  lines.push(`  "to": "orchestrator-loop",`);
  lines.push(`  "type": "task_complete",`);
  lines.push(`  "task_id": "${pkg.taskId}",`);
  lines.push(`  "timestamp": "ISO-8601",`);
  lines.push(`  "payload": {"verification": "all-passed", "verifier": "${ctx.agentId}"},`);
  lines.push(`  "requires_response": false`);
  lines.push(`}`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('This is the orchestrator\'s nested working loop.');
  lines.push('No criterion is optional.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Kubernetes workload wrappers (lb-f451c70f)
// ---------------------------------------------------------------------------

export interface K8sWorkloadConfig {
  namespace?: string;
  serviceAccount: string;
  image: string;
  cpuLimit?: string;
  memLimit?: string;
  restartPolicy?: 'Never' | 'OnFailure' | 'Always';
  enableEnvoySidecar: boolean;
  envoyImage?: string;
}

export interface K8sWorkloadManifest {
  apiVersion: 'v1';
  kind: 'Pod';
  metadata: {
    name: string;
    namespace: string;
    labels: {
      'app.kubernetes.io/managed-by': string;
      'autoclaw.io/vendor': string;
      'autoclaw.io/task-id': string;
    };
    annotations: {
      'autoclaw.io/task': string;
      'autoclaw.io/sprint': string;
      'autoclaw.io/agent': string;
      'autoclaw.io/commitment': string;
    };
  };
  spec: {
    serviceAccountName: string;
    restartPolicy: string;
    containers: Array<{
      name: string;
      image: string;
      args?: string[];
      env?: Array<{ name: string; value?: string }>;
      resources?: {
        limits: { cpu: string; memory: string };
      };
    }>;
    initContainers?: Array<{
      name: string;
      image: string;
      env?: Array<{ name: string; value?: string }>;
    }>;
  };
}

const DEFAULT_K8S: K8sWorkloadConfig = {
  serviceAccount: 'autoclaw-agent',
  image: 'autoclaw/agent-runner:latest',
  cpuLimit: '1',
  memLimit: '2Gi',
  restartPolicy: 'OnFailure',
  enableEnvoySidecar: true,
  envoyImage: 'envoyproxy/envoy:v1.31',
};

/**
 * Build a Kubernetes Pod manifest for a vendor's workload.
 * When k8sWorkload=true, the orchestrator hands off a sidecar-less
 * workload spec rather than a raw prompt — upstream CI gate (lb-f451c70f)
 * swaps this for a real `kubectl apply` path.
 */
export function buildK8sWorkload(
  pkg: WorkPackage,
  ctx: DispatchContext,
  cfg: K8sWorkloadConfig = DEFAULT_K8S
): K8sWorkloadManifest {
  // Escape Helm-safe names: lower-dots-to-dashes, max 253 chars.
  const safeName = `${pkg.taskId}-${ctx.agentId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const safeNs = cfg.namespace ?? 'default';

  const containers: K8sWorkloadManifest['spec']['containers'] = [
    {
      name: 'agent',
      image: cfg.image,
      args: [
        '--task-id', pkg.taskId,
        '--vendor', pkg.assignToVendor,
        '--loop-prompt', buildPackagePrompt(pkg, ctx),
      ],
      resources: {
        limits: { cpu: cfg.cpuLimit ?? '1', memory: cfg.memLimit ?? '2Gi' },
      },
    },
  ];

  if (cfg.enableEnvoySidecar) {
    containers.push({
      name: 'envoy-proxy',
      image: cfg.envoyImage ?? 'envoyproxy/envoy:v1.31',
      args: ['-c', '/etc/envoy/envoy.yaml'],
      resources: {
        limits: { cpu: '200m', memory: '256Mi' },
      },
    });
  }

  const manifest: K8sWorkloadManifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: safeName,
      namespace: safeNs,
      labels: {
        'app.kubernetes.io/managed-by': 'autoclaw-loop',
        'autoclaw.io/vendor': pkg.assignToVendor,
        'autoclaw.io/task-id': pkg.taskId,
      },
      annotations: {
        'autoclaw.io/task': pkg.taskName,
        'autoclaw.io/sprint': String(pkg.sprint),
        'autoclaw.io/agent': ctx.agentId,
        'autoclaw.io/commitment': ctx.commitmentText,
      },
    },
    spec: {
      serviceAccountName: cfg.serviceAccount,
      restartPolicy: cfg.restartPolicy ?? 'OnFailure',
      containers,
    },
  };

  return manifest;
}
