// Writes schemas/tool-outputs.schema.json: one JSON Schema (draft-07) covering
// the result of every tool that has an output schema (src/mcp/outputSchemas.ts),
// with shared types (NextStep, MoveMenu, ...) under `definitions`. Clients such
// as zekel Live generate their TypeScript types from this file.
// src/mcp/__tests__/outputSchemas.test.ts fails when it is out of date.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputSchemasJson } from '../src/mcp/outputSchemas.js';

// Written beside the package (packages/mcp/schemas), wherever this is run from.
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'tool-outputs.schema.json'), JSON.stringify(outputSchemasJson(), null, 2) + '\n');
process.stderr.write(`wrote ${resolve(dir, 'tool-outputs.schema.json')}\n`);
