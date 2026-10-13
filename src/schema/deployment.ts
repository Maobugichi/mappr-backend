import { z } from 'zod';
import { Type } from '@google/genai';

// What a component IS decides what deploying it means:
// - application:       the team's own code (frontend, API, worker) — built and deployed.
// - managed_resource:  provisioned from the hosting platform (a managed database or cache) — set up, not built.
// - external_service:  a third-party account (payments, SMS, email) — signed up for, never deployed.
// - embedded:          no deployment of its own; it lives inside another component
//                      (e.g. a job-queue library running on a Redis instance). hostNodeId says which.
const COMPONENT_KINDS = ['application', 'managed_resource', 'external_service', 'embedded'] as const;
const EXPOSURE_TYPES = ['public', 'internal'] as const;

export type DeploymentComponentKind = (typeof COMPONENT_KINDS)[number];
export type DeploymentExposure = (typeof EXPOSURE_TYPES)[number];

// Day-two facts about a running component. The whole object is null for
// an external service or an embedded component, where "how does it
// scale / what's its health check" has no real answer — so the AI is
// never pushed into inventing one (it did, for Stripe, in the first
// version of this feature). Same "nullable, not optional" convention
// used since relationalSchema.ts.
const DeploymentOperationsSchema = z.object({
  exposure: z.enum(EXPOSURE_TYPES),
  scaling: z.string(),
  healthCheck: z.string(),
  // How its data is backed up. Null for a stateless component.
  backup: z.string().nullable(),
});

// What the map already says (that the component exists, and which
// others it connects to via architecture.edges) is deliberately NOT
// repeated here — and neither is the order to deploy things in, or the
// environment variables each component needs. Code derives the first
// from the edges and pulls the second from the Env Vars set, so none of
// it can drift from the map or be hallucinated.
const DeploymentComponentSchema = z.object({
  // Must reference architecture.nodes[].id.
  nodeId: z.string(),
  kind: z.enum(COMPONENT_KINDS),
  // Where it's provisioned or runs, in terms of the tech stack (e.g.
  // "Vercel", "Railway", "Twilio account").
  platform: z.string(),
  // Ordered steps to set it up or deploy it, specific to its kind: build
  // and deploy for an application, provisioning for a managed resource,
  // sign-up and credential steps for an external service. Empty for an
  // embedded component.
  steps: z.array(z.string()),
  // How to confirm it's working once the steps are done.
  verify: z.string(),
  // How to undo a bad release or change. Null where there's nothing to
  // roll back (an external account, an embedded component).
  rollback: z.string().nullable(),
  operations: DeploymentOperationsSchema.nullable(),
  // For an embedded component only: the node it lives inside. Must
  // reference architecture.nodes[].id. Null otherwise.
  hostNodeId: z.string().nullable(),
});

const DeploymentEnvironmentSchema = z.object({
  name: z.string(),
  purpose: z.string(),
});

export const GeneratedDeploymentSchema = z.object({
  components: z.array(DeploymentComponentSchema),
  environments: z.array(DeploymentEnvironmentSchema),
  // Ordered pipeline steps, e.g. "Run tests", "Build", "Deploy to staging".
  cicdSteps: z.array(z.string()),
  // How and when database migrations are applied relative to deploying
  // the code that needs them. Null when the system has no database.
  migrations: z.string().nullable(),
});

export type DeploymentOperations = z.infer<typeof DeploymentOperationsSchema>;
export type DeploymentComponent = z.infer<typeof DeploymentComponentSchema>;
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;
export type GeneratedDeployment = z.infer<typeof GeneratedDeploymentSchema>;

// Keyed by the same techStack+architecture hash as ADRs and env vars
// (see adr.ts's techArchHash), not by map version — where things run
// depends on exactly those two sections, so a features-only or
// data-model-only edit shouldn't invalidate it.
export const DeploymentRecordSchema = z.object({
  mapId: z.string(),
  techArchHash: z.string(),
  components: z.array(DeploymentComponentSchema),
  environments: z.array(DeploymentEnvironmentSchema),
  cicdSteps: z.array(z.string()),
  migrations: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;

export const geminiDeploymentResponseSchema = {
  type: Type.OBJECT,
  properties: {
    components: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          nodeId: { type: Type.STRING },
          kind: { type: Type.STRING, enum: [...COMPONENT_KINDS] },
          platform: { type: Type.STRING },
          steps: { type: Type.ARRAY, items: { type: Type.STRING } },
          verify: { type: Type.STRING },
          rollback: { type: Type.STRING, nullable: true },
          operations: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              exposure: { type: Type.STRING, enum: [...EXPOSURE_TYPES] },
              scaling: { type: Type.STRING },
              healthCheck: { type: Type.STRING },
              backup: { type: Type.STRING, nullable: true },
            },
            required: ['exposure', 'scaling', 'healthCheck', 'backup'],
          },
          hostNodeId: { type: Type.STRING, nullable: true },
        },
        required: [
          'nodeId',
          'kind',
          'platform',
          'steps',
          'verify',
          'rollback',
          'operations',
          'hostNodeId',
        ],
      },
    },
    environments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          purpose: { type: Type.STRING },
        },
        required: ['name', 'purpose'],
      },
    },
    cicdSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
    migrations: { type: Type.STRING, nullable: true },
  },
  required: ['components', 'environments', 'cicdSteps', 'migrations'],
};