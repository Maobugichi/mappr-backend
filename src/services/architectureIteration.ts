import { AIGenerationError, generateStructured } from './aiClient.js';
import type { ZodError } from 'zod';
import {
  geminiIterationResponseSchema,
  GeneratedIterationSchema,
  type ArchitecturePatch,
} from '../schema/architecturePatch.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are modifying an existing system's architecture based on a natural-language instruction from the person who designed it. You will be given the full structured system model as JSON and a single instruction describing a change to make.

You do not rewrite the system. Instead, you return a small patch describing exactly what should change in the architecture graph (architecture.nodes and architecture.edges). Everything else about the system — features, tech stack, data model, users — is out of scope for this operation; only propose architecture node/edge changes.

Rules:
- addNodes: new architecture nodes to add. Give each a new, unique, kebab-case id that does not already exist in the given architecture.nodes list (e.g. "cache-1", "notification-service"). Every field (id, label, type, description) is required.
- removeNodeIds: ids of existing nodes to remove. Must reference real ids from the given architecture.nodes.
- updateNodes: partial updates to existing nodes (e.g. renaming a node or changing its description) — only include the fields that actually change, plus the id.
- addEdges: new edges connecting nodes (existing or newly added in this same patch) — from/to must reference a node id that exists after this patch is applied.
- removeEdges: edges to remove, matched by from/to (and label if there could be ambiguity between multiple edges connecting the same two nodes).
- Only include what the instruction actually asks for. Do not restructure or "improve" parts of the architecture the instruction didn't mention.
- The summary field should be one concise sentence describing what changed, suitable for display in a version history list (e.g. "Added a Redis cache between the API and the database").
- If the instruction is ambiguous or cannot reasonably be applied to this system, still return a best-effort patch reflecting the most reasonable interpretation — do not refuse.`;

function buildPrompt(system: MapprSystem, instruction: string, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nCurrent system model:\n"""\n${JSON.stringify(system)}\n"""\n\nInstruction: "${instruction}"\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class IterationValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}

function edgeMatches(
  edge: MapprSystem['architecture']['edges'][number],
  spec: { from: string; to: string; label?: string | null }
): boolean {
  return edge.from === spec.from && edge.to === spec.to && (spec.label == null || edge.label === spec.label);
}

// Applies a patch to an architecture graph deterministically — Gemini
// only proposes the patch; this function is what actually mutates the
// system, and it grounds every reference against what's really there
// rather than trusting the model's ids. Returns both the resulting
// architecture and a "grounded" version of the patch (invalid
// references stripped) so what gets persisted to map_versions reflects
// what actually happened, not what was merely proposed.
export function applyArchitecturePatch(
  architecture: MapprSystem['architecture'],
  patch: ArchitecturePatch
): { architecture: MapprSystem['architecture']; groundedPatch: ArchitecturePatch } {
  const existingIds = new Set(architecture.nodes.map((n) => n.id));

  const validRemoveNodeIds = patch.removeNodeIds.filter((id) => existingIds.has(id));
  const removeSet = new Set(validRemoveNodeIds);

  const remainingNodes = architecture.nodes.filter((n) => !removeSet.has(n.id));
  const remainingIds = new Set(remainingNodes.map((n) => n.id));

  const validUpdateNodes = patch.updateNodes.filter((u) => remainingIds.has(u.id));
  const updateById = new Map(validUpdateNodes.map((u) => [u.id, u]));

  const updatedNodes = remainingNodes.map((n) => {
    const update = updateById.get(n.id);
    if (!update) return n;
    return {
      id: n.id,
      label: update.label ?? n.label,
      type: update.type ?? n.type,
      description: update.description ?? n.description,
    };
  });

  // Dedupe addNodes against what already exists and against duplicate
  // ids within the patch itself — first occurrence wins.
  const seenIds = new Set(updatedNodes.map((n) => n.id));
  const validAddNodes = [];
  for (const node of patch.addNodes) {
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);
    validAddNodes.push(node);
  }

  const finalNodes = [...updatedNodes, ...validAddNodes];
  const finalNodeIds = new Set(finalNodes.map((n) => n.id));

  // Cascade: drop edges that referenced a removed node.
  const edgesAfterNodeRemoval = architecture.edges.filter(
    (e) => !removeSet.has(e.from) && !removeSet.has(e.to)
  );

  const edgesAfterRemoveEdges = edgesAfterNodeRemoval.filter(
    (e) => !patch.removeEdges.some((spec) => edgeMatches(e, spec))
  );

  const validAddEdges = patch.addEdges
    .filter((e) => finalNodeIds.has(e.from) && finalNodeIds.has(e.to))
    .map(({ label, ...rest }) => (label == null ? rest : { ...rest, label }));

  const finalEdges = [...edgesAfterRemoveEdges, ...validAddEdges];

  return {
    architecture: { nodes: finalNodes, edges: finalEdges },
    groundedPatch: {
      addNodes: validAddNodes,
      removeNodeIds: validRemoveNodeIds,
      updateNodes: validUpdateNodes,
      addEdges: validAddEdges,
      removeEdges: patch.removeEdges,
    },
  };
}

export async function generateIteration(
  system: MapprSystem,
  instruction: string
): Promise<{ summary: string; groundedPatch: ArchitecturePatch; newSystem: MapprSystem }> {
 let generated;
  try {
    generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, instruction, retryContext),
      zodSchema: GeneratedIterationSchema,
      geminiResponseSchema: geminiIterationResponseSchema,
      groqSchemaName: 'architecture_iteration',
    });
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new IterationValidationError(err.zodError);
    }
    throw err;
  }

  const { architecture, groundedPatch } = applyArchitecturePatch(
    system.architecture,
    generated.patch
  );

  const newSystem: MapprSystem = { ...system, architecture };

  // Defensive final check — the patch only touches nodes/edges shapes
  // that are already well-typed, so this should always pass, but it's
  // cheap insurance against a shape slipping through.
  const finalCheck = MapprSystemSchema.safeParse(newSystem);
  if (!finalCheck.success) {
    throw new IterationValidationError(finalCheck.error);
  }

  return { summary: generated.summary, groundedPatch, newSystem: finalCheck.data };
}