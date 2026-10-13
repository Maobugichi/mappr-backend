import type { EnvVar } from '../schema/envVars.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

// Always one file, grouped into sections — never one file per
// component, since that would mean guessing the repo layout (monorepo
// vs. separate repos), which the map doesn't say.

// Anything that could break the file's line structure is flattened
// here: a newline inside a description would turn the rest of it into
// a stray non-comment line, and one inside a value would split the
// assignment.
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// .env values containing whitespace, #, quotes or backslashes need
// quoting to survive loaders like dotenv; plain values stay bare so
// the common case (a URL, a number) reads cleanly.
function formatValue(value: string): string {
  const v = singleLine(value);
  return /[\s#"'\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

function renderVar(envVar: EnvVar): string {
  const markers = [envVar.secret ? '[secret]' : '[config]'];
  if (!envVar.required) markers.push('[optional]');

  const comment = `# ${markers.join(' ')} ${singleLine(envVar.description)}`;
  const assignment = `${envVar.name}=${formatValue(envVar.placeholder)}`;

  // Optional variables are commented out, so copying this file to .env
  // doesn't switch on a feature (or load a fake "key" as if it were
  // real) the developer never meant to enable.
  return `${comment}\n${envVar.required ? '' : '# '}${assignment}`;
}

function renderSection(title: string, vars: EnvVar[]): string {
  return [`# --- ${singleLine(title)} ---`, '', vars.map(renderVar).join('\n\n')].join('\n');
}

export function renderEnvVars(vars: EnvVar[], system: MapprSystem): string {
  const header = [
    `# Environment variables — ${singleLine(system.meta.productName)}`,
    '#',
    '# Copy this file to .env and replace the placeholder values. Never commit real secrets.',
    '# [secret] values grant access and must stay private; [config] values are plain settings.',
    '# [optional] variables are commented out — uncomment one to override its default.',
  ].join('\n');

  const knownNodeIds = new Set(system.architecture.nodes.map((n) => n.id));

  // "General" holds shared config, plus any variable pointing at a node
  // that doesn't exist — grounding already nulls those out, but a
  // renderer that silently dropped a variable would be worse than one
  // that files it somewhere visible.
  const general = vars.filter((v) => v.nodeId === null || !knownNodeIds.has(v.nodeId));

  const sections: string[] = [];
  if (general.length > 0) {
    sections.push(renderSection('General', general));
  }
  for (const node of system.architecture.nodes) {
    const nodeVars = vars.filter((v) => v.nodeId === node.id);
    if (nodeVars.length > 0) {
      sections.push(renderSection(node.label, nodeVars));
    }
  }

  if (sections.length === 0) {
    sections.push('# No environment variables were identified for this system.');
  }

  return [header, ...sections].join('\n\n') + '\n';
}