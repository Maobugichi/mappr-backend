import type { GeneratedReadme } from '../schema/readme.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

// Whether each of the four optional generated artifacts exists for
// this map's current version/hash — computed by the route (it already
// owns the lookups for each of those tables) and passed in here rather
// than queried by the renderer itself, which stays pure/DB-free like
// every other render module in this project.
export interface ReadmeArtifactFlags {
  hasApiContract: boolean;
  hasRelationalSchema: boolean;
  hasDocumentSchema: boolean;
  hasAdrs: boolean;
}

function renderFeatures(system: MapprSystem): string {
  const lines = ['## Features', ''];
  for (const feature of system.features) {
    lines.push(`- **${feature.name}** — ${feature.description}`);
  }
  return lines.join('\n');
}

function renderTechStack(system: MapprSystem): string {
  const lines = ['## Tech Stack', ''];
  for (const item of system.techStack) {
    lines.push(`- **${item.category}:** ${item.choice} — ${item.rationale}`);
  }
  return lines.join('\n');
}

function renderArchitecture(system: MapprSystem): string {
  const labelById = new Map(system.architecture.nodes.map((n) => [n.id, n.label]));
  const lines = ['## Architecture', ''];

  for (const node of system.architecture.nodes) {
    lines.push(`- **${node.label}** (${node.type}) — ${node.description}`);
  }

  if (system.architecture.edges.length > 0) {
    lines.push('', '**Connections:**', '');
    for (const edge of system.architecture.edges) {
      const from = labelById.get(edge.from) ?? edge.from;
      const to = labelById.get(edge.to) ?? edge.to;
      lines.push(`- ${from} → ${to}${edge.label ? ` (${edge.label})` : ''}`);
    }
  }

  return lines.join('\n');
}

function renderGettingStarted(steps: GeneratedReadme['gettingStarted']): string {
  const lines = ['## Getting Started', ''];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.description}`);
    if (step.command) {
      lines.push('', '   ```', `   ${step.command}`, '   ```');
    }
  });
  return lines.join('\n');
}

function renderRoadmap(system: MapprSystem): string {
  const nameById = new Map(system.features.map((f) => [f.id, f.name]));
  const lines = ['## Roadmap', ''];

  for (const phase of system.developmentPlan) {
    lines.push(`### Phase ${phase.phase}: ${phase.title}`, '');
    for (const item of phase.items) {
      const relatedNames = item.relatedFeatures.map((id) => nameById.get(id)).filter(Boolean);
      const suffix = relatedNames.length > 0 ? ` _(${relatedNames.join(', ')})_` : '';
      lines.push(`- ${item.description}${suffix}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderOtherArtifacts(flags: ReadmeArtifactFlags): string | null {
  const entries: string[] = [];
  if (flags.hasApiContract) entries.push('- **API Contract** — see the API Contract tab for the full endpoint list (OpenAPI export available).');
  if (flags.hasRelationalSchema) entries.push('- **Relational Database Schema** — see the DB Schema tab (Postgres/MySQL/SQLite DDL export available).');
  if (flags.hasDocumentSchema) entries.push('- **Document Database Schema** — see the DB Schema tab (MongoDB validator script export available).');
  if (flags.hasAdrs) entries.push('- **Architecture Decision Records** — see the ADRs tab for the reasoning behind the choices above.');

  if (entries.length === 0) return null;

  return ['## Other Generated Artifacts', '', ...entries].join('\n');
}

export function renderReadme(
  system: MapprSystem,
  ai: GeneratedReadme,
  flags: ReadmeArtifactFlags
): string {
  const sections = [
    `# ${system.meta.productName}`,
    '',
    ai.overview,
    '',
    renderFeatures(system),
    '',
    renderTechStack(system),
    '',
    renderArchitecture(system),
    '',
    renderGettingStarted(ai.gettingStarted),
    '',
    renderRoadmap(system),
  ];

  const otherArtifacts = renderOtherArtifacts(flags);
  if (otherArtifacts) {
    sections.push('', otherArtifacts);
  }

  return sections.join('\n');
}