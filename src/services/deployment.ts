import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import {
  geminiDeploymentResponseSchema,
  GeneratedDeploymentSchema,
  type GeneratedDeployment,
} from '../schema/deployment.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are writing a deployment runbook for a software system, given its tech stack and architecture (nodes and edges) as JSON. The reader is a developer who will follow it to get this system live for the first time.

Write one entry in "components" for EVERY node in architecture.nodes — do not skip any:
- nodeId: that node's exact "id".
- kind: what the node IS, since that decides what "deploying" it means:
  - "application": the team's own code that gets built and deployed (a frontend, an API, a background worker).
  - "managed_resource": something provisioned from the hosting platform rather than built (a managed database, cache or queue broker).
  - "external_service": a third-party service the team signs up for and calls over an API (payments, SMS, email, analytics). It is never deployed.
  - "embedded": something with no deployment of its own because it runs inside another component (for example a job-queue library whose state lives in a Redis instance, or a module inside the API).
- platform: where it is provisioned or runs, taken from the tech stack (for example "Vercel" or "Railway"), or the service's own name for an external service (for example "Twilio account"). For an embedded component, the platform of its host.
- steps: ordered, concrete steps to get it set up, one action per step, tailored to its kind. For an application: how it is built and deployed on its platform. For a managed_resource: how it is provisioned and connected. For an external_service: creating the account and obtaining credentials. For an embedded component: an empty list.
- verify: how to confirm it is working once the steps are done.
- rollback: how to undo a bad release or change, or null where there is nothing to roll back (an external service account, an embedded component).
- operations: for an application or a managed_resource, an object with "exposure" ("public" if it is reachable from the internet, "internal" if only other components should reach it), "scaling", "healthCheck", and "backup" (how its data is backed up, or null if it is stateless). Null for an external_service or an embedded component.
- hostNodeId: for an embedded component, the id of the node it lives inside. Null for every other kind.

Also write:
- environments: the environments this system realistically needs (a small project may reasonably need only two), each with the purpose it serves.
- cicdSteps: the ordered CI/CD pipeline steps for this specific stack, from commit to production.
- migrations: how and when database migrations are applied relative to deploying the code that needs them (for example as a release step before the new API version receives traffic), or null if the system has no database.

Rules:
- Use real node ids only, and exactly one entry per node.
- Only name platforms, tools and services that appear in the given tech stack or architecture. Do not introduce others — for example do not add Docker, Kubernetes or a particular package manager unless the tech stack names it. Where a step needs a tool the stack does not name, describe the action without naming one.
- Do not state figures that depend on a platform's plan or current behavior (retention periods, limits, prices, regions). Say what to configure and tell the reader to confirm the details in the platform's documentation.
- If a step relies on something the system has not defined, such as a health-check route, say so ("add a /health route") rather than assuming it exists.
- Be specific to this system, not generic boilerplate.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  const payload = { techStack: system.techStack, architecture: system.architecture };
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem:\n"""\n${JSON.stringify(payload)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class DeploymentValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Grounds the plan against the real architecture:
// - drops any component whose nodeId isn't a real node, and any later
//   component that duplicates an earlier one's node;
// - enforces the rules that depend on `kind`, which the schema can't
//   express — hostNodeId only means something for an embedded
//   component (and must point at a different, real node), and an
//   external service or embedded component never has `operations`
//   (a health check or scaling policy for Stripe is meaningless, and
//   the first version of this feature produced exactly that).
// It can't invent an entry for a node the AI skipped, so coverage gaps
// are left in place and the renderer lists uncovered nodes in a visible
// "not covered" note instead of hiding them.
function groundDeployment(generated: GeneratedDeployment, system: MapprSystem): GeneratedDeployment {
  const validNodeIds = new Set(system.architecture.nodes.map((n) => n.id));
  const seen = new Set<string>();

  const components = generated.components
    .filter((component) => {
      if (!validNodeIds.has(component.nodeId) || seen.has(component.nodeId)) return false;
      seen.add(component.nodeId);
      return true;
    })
    .map((component) => {
      const hostIsValid =
        component.kind === 'embedded' &&
        component.hostNodeId !== null &&
        component.hostNodeId !== component.nodeId &&
        validNodeIds.has(component.hostNodeId);

      const hasNoOperations = component.kind === 'external_service' || component.kind === 'embedded';

      return {
        ...component,
        hostNodeId: hostIsValid ? component.hostNodeId : null,
        operations: hasNoOperations ? null : component.operations,
      };
    });

  const missing = system.architecture.nodes.filter((n) => !seen.has(n.id));
  if (missing.length > 0) {
    // Diagnostic only — shows how often the AI skips nodes despite being
    // told to cover every one.
    console.warn(
      `[deployment] ${missing.length} of ${validNodeIds.size} architecture nodes not covered: ${missing.map((n) => n.id).join(', ')}`
    );
  }

  // An empty or whitespace-only note means "no migrations", same as null.
  const migrations = generated.migrations && generated.migrations.trim() ? generated.migrations : null;

  return { ...generated, components, migrations };
}

export async function generateDeployment(system: MapprSystem): Promise<GeneratedDeployment> {
  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedDeploymentSchema,
      geminiResponseSchema: geminiDeploymentResponseSchema,
      groqSchemaName: 'deployment_runbook',
    });
    return groundDeployment(generated, system);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new DeploymentValidationError(err.zodError);
    }
    throw err;
  }
}