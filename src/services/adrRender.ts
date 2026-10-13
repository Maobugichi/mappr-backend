import type { Adr } from '../schema/adr.js';

// ADRs are always Markdown — unlike the other three AI-backed schema
// features, there's no second target or dialect here to parameterize
// over, so this renderer takes no format argument.

function renderAdr(adr: Adr, index: number): string {
  const lines = [`## ${index + 1}. ${adr.title}`, '', '**Status:** Accepted', ''];

  lines.push('### Context', '', adr.context, '');
  lines.push('### Decision', '', adr.decision, '');

  if (adr.alternatives.length > 0) {
    lines.push('### Alternatives Considered', '');
    for (const alt of adr.alternatives) {
      lines.push(`- **${alt.option}** — ${alt.reasonRejected}`);
    }
    lines.push('');
  }

  if (adr.consequences.length > 0) {
    lines.push('### Consequences', '');
    for (const consequence of adr.consequences) {
      lines.push(`- ${consequence}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderAdrs(adrs: Adr[], productName: string): string {
  const techStackAdrs = adrs.filter((a) => a.subjectType === 'tech_stack');
  const architectureAdrs = adrs.filter((a) => a.subjectType !== 'tech_stack');

  const sections: string[] = [`# Architecture Decision Records — ${productName}`, ''];

  if (techStackAdrs.length > 0) {
    sections.push('# Tech Stack Decisions', '');
    techStackAdrs.forEach((adr, i) => sections.push(renderAdr(adr, i)));
  }

  if (architectureAdrs.length > 0) {
    sections.push('# Architecture Decisions', '');
    architectureAdrs.forEach((adr, i) => sections.push(renderAdr(adr, i)));
  }

  return sections.join('\n');
}