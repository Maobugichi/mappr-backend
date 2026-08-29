import { z } from 'zod';


const DesignTokenSchema = z.object({
  token: z.string(),
  value: z.string(),
});

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

const FeatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  relatedUsers: z.array(z.string()), 
  dependsOn: z.array(z.string()), 
});

const TechStackItemSchema = z.object({
  category: z.string(), 
  choice: z.string(),
  rationale: z.string(),
});

const ArchitectureNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(), 
  description: z.string(), 
});

const ArchitectureEdgeSchema = z.object({
  from: z.string(), 
  to: z.string(), 
  label: z.string().optional(),
});

const EntityFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
});

const EntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.array(EntityFieldSchema),
});

const RelationSchema = z.object({
  from: z.string(), 
  to: z.string(), 
  type: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
  label: z.string().optional(),
});

const DesignComponentSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const DevelopmentPlanPhaseSchema = z.object({
  phase: z.number().int().positive(),
  title: z.string(),
  items: z.array(z.string()), 
});

export const MapprSystemSchema = z.object({
  meta: z.object({
    productName: z.string(),
    oneLineSummary: z.string(),
  }),

  product: z.object({
    summary: z.string(),
    concepts: z.array(z.string()),
  }),

  users: z.array(UserSchema),

  features: z.array(FeatureSchema),

  techStack: z.array(TechStackItemSchema),

  architecture: z.object({
    nodes: z.array(ArchitectureNodeSchema),
    edges: z.array(ArchitectureEdgeSchema),
  }),

  dataModel: z.object({
    entities: z.array(EntitySchema),
    relations: z.array(RelationSchema),
  }),

  designSystem: z.object({
    colors: z.array(DesignTokenSchema),
    typography: z.array(DesignTokenSchema),
    spacing: z.array(DesignTokenSchema),
    components: z.array(DesignComponentSchema),
  }),

  developmentPlan: z.array(DevelopmentPlanPhaseSchema),
});

export type MapprSystem = z.infer<typeof MapprSystemSchema>;