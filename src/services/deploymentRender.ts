import type {
  DeploymentComponent,
  DeploymentComponentKind,
  DeploymentExposure,
  GeneratedDeployment,
} from '../schema/deployment.js';
import type { EnvVar } from '../schema/envVars.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

// Always Markdown — a runbook is a document, and there's no second
// target to parameterize over (config files like a Dockerfile depend on
// the hosting platform, which is deliberately out of scope).

type ArchNode = MapprSystem['architecture']['nodes'][number];
type ArchEdge = MapprSystem['architecture']['edges'][number];

const KIND_LABEL: Record<DeploymentComponentKind, string> = {
  application: 'Application',
  managed_resource: 'Managed resource',
  external_service: 'External service',
  embedded: 'Embedded',
};

const EXPOSURE_LABEL: Record<DeploymentExposure, string> = {
  public: 'Public',
  internal: 'Internal',
};

// A newline inside AI-written text would break out of its list item
// and corrupt the Markdown structure around it, so every free-text
// value is flattened to one line first.
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// An embedded component has no deployment of its own, so anything that
// touches it — an edge pointing at it, an environment variable assigned
// to it — is treated as touching the component it lives inside.
function resolveToHost(byId: Map<string, DeploymentComponent>, nodeId: string): string {
  const component = byId.get(nodeId);
  return component && component.kind === 'embedded' && component.hostNodeId
    ? component.hostNodeId
    : nodeId;
}

// An edge A → B means A depends on B, so B has to exist first. Only
// things that are actually deployed take part: external services are
// accounts, embedded components resolve to their host, and nodes the
// plan doesn't cover are skipped. Ties keep the architecture's own
// node order, so the result is stable. If components depend on each
// other in a loop there's no true order, so the one with the fewest
// unmet dependencies goes next and the caller is told it was a guess.
function computeDeployOrder(
  nodes: ArchNode[],
  edges: ArchEdge[],
  byId: Map<string, DeploymentComponent>
): { order: ArchNode[]; hadCycle: boolean } {
  const deployable = nodes.filter((n) => {
    const kind = byId.get(n.id)?.kind;
    return kind === 'application' || kind === 'managed_resource';
  });
  const deployableIds = new Set(deployable.map((n) => n.id));
  const deps = new Map<string, Set<string>>(deployable.map((n) => [n.id, new Set<string>()]));

  for (const edge of edges) {
    const from = resolveToHost(byId, edge.from);
    const to = resolveToHost(byId, edge.to);
    if (from !== to && deployableIds.has(from) && deployableIds.has(to)) {
      deps.get(from)!.add(to);
    }
  }

  const done = new Set<string>();
  const remaining = [...deployable];
  const order: ArchNode[] = [];
  let hadCycle = false;

  const unmet = (id: string) => [...deps.get(id)!].filter((d) => !done.has(d)).length;

  while (remaining.length > 0) {
    let next = remaining.find((n) => unmet(n.id) === 0);
    if (!next) {
      hadCycle = true;
      next = remaining.reduce((best, n) => (unmet(n.id) < unmet(best.id) ? n : best));
    }
    order.push(next);
    done.add(next.id);
    remaining.splice(remaining.indexOf(next), 1);
  }

  return { order, hadCycle };
}

function renderEnvVarLine(envVar: EnvVar): string {
  const flags = `${envVar.secret ? ' (secret)' : ''}${envVar.required ? '' : ' (optional)'}`;
  return `- \`${envVar.name}\`${flags} — ${singleLine(envVar.description)}`;
}

function renderNumberedSteps(steps: string[]): string[] {
  return steps.map((step, i) => `${i + 1}. ${singleLine(step)}`);
}

// A third-party account: nothing is deployed, so this is a setup task.
function renderExternalService(node: ArchNode, component: DeploymentComponent, vars: EnvVar[]): string {
  const lines = [`### ${singleLine(node.label)} — ${singleLine(component.platform)}`];

  if (component.steps.length > 0) {
    lines.push('', ...renderNumberedSteps(component.steps));
  }
  if (vars.length > 0) {
    lines.push('', '**Credentials to copy into your environment variables**', '', ...vars.map(renderEnvVarLine));
  }
  lines.push('', `**Verify:** ${singleLine(component.verify)}`);

  return lines.join('\n');
}

function renderComponentRunbook(
  position: number,
  node: ArchNode,
  component: DeploymentComponent,
  vars: EnvVar[]
): string {
  const exposure = component.operations ? ` · ${EXPOSURE_LABEL[component.operations.exposure]}` : '';
  const lines = [
    `### ${position}. ${singleLine(node.label)}`,
    '',
    `**${KIND_LABEL[component.kind]}** · ${singleLine(component.platform)}${exposure}`,
  ];

  if (component.steps.length > 0) {
    lines.push('', '**Steps**', '', ...renderNumberedSteps(component.steps));
  }
  if (vars.length > 0) {
    lines.push('', '**Environment variables**', '', ...vars.map(renderEnvVarLine));
  }
  lines.push('', `**Verify:** ${singleLine(component.verify)}`);
  if (component.rollback) {
    lines.push('', `**Rollback:** ${singleLine(component.rollback)}`);
  }

  return lines.join('\n');
}

// `envVars` is the map's generated Env Vars set, or null if none exists
// for its current techStack+architecture. Passed in rather than queried
// here, so this stays pure/DB-free like every other render module.
export function renderDeployment(
  deployment: GeneratedDeployment,
  system: MapprSystem,
  envVars: EnvVar[] | null
): string {
  const nodes = system.architecture.nodes;
  const edges = system.architecture.edges;
  const byId = new Map(deployment.components.map((c) => [c.nodeId, c]));
  const labelById = new Map(nodes.map((n) => [n.id, n.label]));

  const varsFor = (componentId: string): EnvVar[] =>
    (envVars ?? []).filter((v) => v.nodeId !== null && resolveToHost(byId, v.nodeId) === componentId);

  const externals = nodes.filter((n) => byId.get(n.id)?.kind === 'external_service');
  const embedded = nodes.filter((n) => byId.get(n.id)?.kind === 'embedded');
  const uncovered = nodes.filter((n) => !byId.has(n.id));
  const { order, hadCycle } = computeDeployOrder(nodes, edges, byId);

  const sections: string[] = [`# Deployment Runbook — ${singleLine(system.meta.productName)}`];

  if (externals.length > 0) {
    sections.push(
      [
        '## Before you start',
        '',
        'Set up these third-party services first — the steps below need the credentials they give you.',
        '',
        externals
          .map((n) => renderExternalService(n, byId.get(n.id)!, varsFor(n.id)))
          .join('\n\n'),
      ].join('\n')
    );
  }

  if (order.length > 0) {
    const lines = [
      '## Deploy order',
      '',
      'Each component is deployed after the components it depends on.',
      '',
      ...order.map((n, i) => {
        const c = byId.get(n.id)!;
        return `${i + 1}. **${singleLine(n.label)}** — ${KIND_LABEL[c.kind]} on ${singleLine(c.platform)}`;
      }),
    ];
    if (hadCycle) {
      lines.push(
        '',
        '_Some components depend on each other in a loop, so this order is a best guess — adjust it to suit._'
      );
    }
    sections.push(lines.join('\n'));
  }

  // Placed straight after the deploy order so a gap in coverage is seen
  // next to what it's a gap in, rather than buried at the end.
  if (uncovered.length > 0) {
    sections.push(
      [
        '## Not covered by this plan',
        '',
        'These architecture components have no runbook entry. Regenerate the plan to cover them.',
        '',
        ...uncovered.map((n) => `- **${singleLine(n.label)}** (\`${n.id}\`)`),
      ].join('\n')
    );
  }

  // Connections come straight from the map's own edges — nothing here
  // is AI-generated, so it can't drift from the architecture.
  if (edges.length > 0) {
    sections.push(
      [
        '## How components connect',
        '',
        ...edges.map((edge) => {
          const from = labelById.get(edge.from) ?? edge.from;
          const to = labelById.get(edge.to) ?? edge.to;
          return `- ${singleLine(from)} → ${singleLine(to)}${edge.label ? ` (${singleLine(edge.label)})` : ''}`;
        }),
      ].join('\n')
    );
  }

  if (order.length > 0) {
    const hint =
      envVars === null
        ? '_Generate the Env Vars tab to see which environment variables each component needs._'
        : '_Environment variables come from your generated Env Vars set; shared ones are listed under "General" in the .env.example._';

    sections.push(
      [
        '## Component runbooks',
        '',
        hint,
        '',
        order
          .map((n, i) => renderComponentRunbook(i + 1, n, byId.get(n.id)!, varsFor(n.id)))
          .join('\n\n'),
      ].join('\n')
    );
  }

  if (embedded.length > 0) {
    sections.push(
      [
        '## Embedded components',
        '',
        'These have no deployment of their own.',
        '',
        ...embedded.map((n) => {
          const hostId = byId.get(n.id)!.hostNodeId;
          const host = hostId ? labelById.get(hostId) : undefined;
          return host
            ? `- **${singleLine(n.label)}** — runs inside **${singleLine(host)}**.`
            : `- **${singleLine(n.label)}** — no host component identified.`;
        }),
      ].join('\n')
    );
  }

  if (deployment.migrations) {
    sections.push(['## Database migrations', '', singleLine(deployment.migrations)].join('\n'));
  }

  if (deployment.environments.length > 0) {
    sections.push(
      [
        '## Environments',
        '',
        ...deployment.environments.map(
          (env) => `- **${singleLine(env.name)}** — ${singleLine(env.purpose)}`
        ),
      ].join('\n')
    );
  }

  if (deployment.cicdSteps.length > 0) {
    sections.push(['## CI/CD pipeline', '', ...renderNumberedSteps(deployment.cicdSteps)].join('\n'));
  }

  const withOperations = nodes.filter((n) => byId.get(n.id)?.operations);
  if (withOperations.length > 0) {
    sections.push(
      [
        '## Operations reference',
        '',
        ...withOperations.map((n) => {
          const component = byId.get(n.id)!;
          const ops = component.operations!;
          // A null backup only means "stateless" for something the team
          // builds. For a managed datastore it more likely means the
          // plan left it out, and calling a database stateless would be
          // a false statement, so say it was unspecified instead.
          const backup = ops.backup
            ? singleLine(ops.backup)
            : component.kind === 'managed_resource'
              ? "None specified — check your platform's backup options"
              : 'None (stateless)';
          return `- **${singleLine(n.label)}** (${EXPOSURE_LABEL[ops.exposure]}) — Scaling: ${singleLine(ops.scaling)} · Health check: ${singleLine(ops.healthCheck)} · Backup: ${backup}`;
        }),
      ].join('\n')
    );
  }

  return sections.join('\n\n') + '\n';
}