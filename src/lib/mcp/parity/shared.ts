import { z } from 'zod';

/**
 * Small input pieces the parity tools share (tools.ts keeps its own private
 * copies; these match them).
 */
export const id = (what: string) => z.uuid(`${what} must be a uuid`);
export const page = z.number().int().min(1).optional().describe('Page number, from 1');
export const limit = (fallback: number, max = 100) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Rows per page (1-${max}, default ${fallback})`);
export const atLeastOne = (fields: string[]) => (value: Record<string, unknown>) =>
  fields.some((field) => value[field] !== undefined);
