import { z } from 'zod';
import { Type } from '@google/genai';

const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'uuid', 'datetime', 'array', 'object'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const ACCESS_LEVELS = ['public', 'authenticated'] as const;

const ContractFieldSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
});

const ContractErrorSchema = z.object({
  status: z.number().int(),
  description: z.string(),
});

export const ApiEndpointSchema = z.object({
  id: z.string(),
  method: z.enum(HTTP_METHODS),
  // Path parameters are written inline as {name}, e.g. /orders/{orderId} —
  // they're derived from the path when the OpenAPI document is built, not
  // listed separately.
  path: z.string(),
  summary: z.string(),
  featureIds: z.array(z.string()), // must reference features[].id
  entityIds: z.array(z.string()), // must reference dataModel.entities[].id
  access: z.enum(ACCESS_LEVELS),
  queryParams: z.array(ContractFieldSchema),
  bodyFields: z.array(ContractFieldSchema),
  successStatus: z.number().int(),
  responseFields: z.array(ContractFieldSchema),
  errors: z.array(ContractErrorSchema),
});

export const GeneratedApiContractSchema = z.object({
  endpoints: z.array(ApiEndpointSchema),
});

export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;
export type GeneratedApiContract = z.infer<typeof GeneratedApiContractSchema>;

// A contract is tied to one map version: there is at most one per
// (map, version), and `version` is the map version it was generated from.
export const ApiContractSchema = z.object({
  mapId: z.string(),
  version: z.number().int(),
  endpoints: z.array(ApiEndpointSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApiContract = z.infer<typeof ApiContractSchema>;

const geminiFieldSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    type: { type: Type.STRING, enum: [...FIELD_TYPES] },
    required: { type: Type.BOOLEAN },
  },
  required: ['name', 'type', 'required'],
};

export const geminiApiContractResponseSchema = {
  type: Type.OBJECT,
  properties: {
    endpoints: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          method: { type: Type.STRING, enum: [...HTTP_METHODS] },
          path: { type: Type.STRING },
          summary: { type: Type.STRING },
          featureIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          entityIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          access: { type: Type.STRING, enum: [...ACCESS_LEVELS] },
          queryParams: { type: Type.ARRAY, items: geminiFieldSchema },
          bodyFields: { type: Type.ARRAY, items: geminiFieldSchema },
          successStatus: { type: Type.INTEGER },
          responseFields: { type: Type.ARRAY, items: geminiFieldSchema },
          errors: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                status: { type: Type.INTEGER },
                description: { type: Type.STRING },
              },
              required: ['status', 'description'],
            },
          },
        },
        required: [
          'id',
          'method',
          'path',
          'summary',
          'featureIds',
          'entityIds',
          'access',
          'queryParams',
          'bodyFields',
          'successStatus',
          'responseFields',
          'errors',
        ],
      },
    },
  },
  required: ['endpoints'],
};