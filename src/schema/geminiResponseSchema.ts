import { Type } from '@google/genai';


export const geminiResponseSchema = {
  type: Type.OBJECT,
  properties: {
    meta: {
      type: Type.OBJECT,
      properties: {
        productName: { type: Type.STRING },
        oneLineSummary: { type: Type.STRING },
      },
      required: ['productName', 'oneLineSummary'],
    },
    product: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        concepts: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['summary', 'concepts'],
    },
    users: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          description: { type: Type.STRING },
        },
        required: ['id', 'name', 'description'],
      },
    },
    features: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          relatedUsers: { type: Type.ARRAY, items: { type: Type.STRING } },
          dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['id', 'name', 'description', 'relatedUsers', 'dependsOn'],
      },
    },
    techStack: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          choice: { type: Type.STRING },
          rationale: { type: Type.STRING },
        },
        required: ['category', 'choice', 'rationale'],
      },
    },
    architecture: {
      type: Type.OBJECT,
      properties: {
        nodes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              label: { type: Type.STRING },
              type: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['id', 'label', 'type', 'description'],
          },
        },
        edges: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING },
              to: { type: Type.STRING },
              label: { type: Type.STRING },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['nodes', 'edges'],
    },
    dataModel: {
      type: Type.OBJECT,
      properties: {
        entities: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              name: { type: Type.STRING },
              fields: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    type: { type: Type.STRING },
                  },
                  required: ['name', 'type'],
                },
              },
            },
            required: ['id', 'name', 'fields'],
          },
        },
        relations: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING },
              to: { type: Type.STRING },
              type: {
                type: Type.STRING,
                enum: ['one-to-one', 'one-to-many', 'many-to-many'],
              },
              label: { type: Type.STRING },
            },
            required: ['from', 'to', 'type'],
          },
        },
      },
      required: ['entities', 'relations'],
    },
    designSystem: {
      type: Type.OBJECT,
      properties: {
        colors: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              token: { type: Type.STRING },
              value: { type: Type.STRING },
            },
            required: ['token', 'value'],
          },
        },
        typography: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              token: { type: Type.STRING },
              value: { type: Type.STRING },
            },
            required: ['token', 'value'],
          },
        },
        spacing: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              token: { type: Type.STRING },
              value: { type: Type.STRING },
            },
            required: ['token', 'value'],
          },
        },
        components: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['colors', 'typography', 'spacing', 'components'],
    },
    developmentPlan: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          phase: { type: Type.INTEGER },
          title: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                description: { type: Type.STRING },
                relatedFeatures: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['description', 'relatedFeatures'],
            },
          },
        },
        required: ['phase', 'title', 'items'],
      },
    },
  },
  required: [
    'meta',
    'product',
    'users',
    'features',
    'techStack',
    'architecture',
    'dataModel',
    'designSystem',
    'developmentPlan',
  ],
};