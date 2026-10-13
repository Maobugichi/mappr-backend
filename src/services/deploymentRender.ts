import type {
  DeploymentComponent,
  DeploymentExposure,
  DeploymentManagement,
  GeneratedDeployment,
} from '../schema/deployment.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

// Always Markdown — a deployment plan is a document, and there's no
// second target to parameterize over (config files like a Dockerfile
// depend on the hosting platform, which is deliberately out of scope).

const MANAGEMENT_LABEL: Record<DeploymentManagement, string> = {
  managed: 'Managed',
  self_managed: 'Self-managed',
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

function renderComponent(label: string, nodeType: string, component: DeploymentComponent): string {
  return [
    `### ${singleLine(label)}`,
    '',
    `- **Type:** ${singleLine(nodeType)}`,
    `- **Runs on:** ${singleLine(component.runsOn)}`,
    `- **Management:** ${MANAGEMENT_LABEL[component.management]}`,
    `- **Exposure:** ${EXPOSURE_LABEL[component.exposure]}`,
    `- **Scaling:** ${singleLine(component.scaling)}`,
    `- **Health check:** ${singleLine(component.healthCheck)}`,
    `- **Backup:** ${component.backup ? singleLine(component.backup) : 'None (stateless)'}`,
  ].join('\n');
}

export function renderDeployment(deployment: GeneratedDeployment, system: MapprSystem): string {
  const nodes = system.architecture.nodes;
  const byNodeId = new Map(deployment.components.map((c) => [c.nodeId, c]));

  // Components are listed in the architecture's own node order, not the
  // order the AI happened to return them in, so the document reads the
  // same way every time.
  const covered = nodes.filter((n) => byNodeId.has(n.id));
  const uncovered = nodes.filter((n) => !byNodeId.has(n.id));

  const sections: string[] = [`# Deployment Plan — ${singleLine(system.meta.productName)}`];

  if (covered.length > 0) {
    sections.push(
      [
        '## Components',
        '',
        covered.map((n) => renderComponent(n.label, n.type, byNodeId.get(n.id)!)).join('\n\n'),
      ].join('\n')
    );
  }

  // Placed straight after Components so a gap in coverage is seen next
  // to what it's a gap in, rather than buried at the end.
  if (uncovered.length > 0) {
    sections.push(
      [
        '## Not covered by this plan',
        '',
        'These architecture components have no deployment entry. Regenerate the plan to cover them.',
        '',
        ...uncovered.map((n) => `- **${singleLine(n.label)}** (\`${n.id}\`)`),
      ].join('\n')
    );
  }

  // Connections come straight from the map's own edges — nothing here
  // is AI-generated, so it can't drift from the architecture.
  if (system.architecture.edges.length > 0) {
    const labelById = new Map(nodes.map((n) => [n.id, n.label]));
    sections.push(
      [
        '## How components connect',
        '',
        ...system.architecture.edges.map((edge) => {
          const from = labelById.get(edge.from) ?? edge.from;
          const to = labelById.get(edge.to) ?? edge.to;
          return `- ${singleLine(from)} → ${singleLine(to)}${edge.label ? ` (${singleLine(edge.label)})` : ''}`;
        }),
      ].join('\n')
    );
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
    sections.push(
      [
        '## CI/CD pipeline',
        '',
        ...deployment.cicdSteps.map((step, i) => `${i + 1}. ${singleLine(step)}`),
      ].join('\n')
    );
  }

  return sections.join('\n\n') + '\n';
}