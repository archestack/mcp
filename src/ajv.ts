// The schema check the npm package runs on every API document (see Compile in api.ts).
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from '@modelcontextprotocol/server/validators/ajv';
import type { Compile } from './api.js';

// A fresh engine per schema version, so hourly refetches do not pile up compiled schemas. The
// schemas use no keyword newer than draft-07. removeAdditional drops fields newer than a cached
// schema instead of failing: v1 only ever adds fields.
export const compile: Compile = (schema) => {
  const ajv = new Ajv({
    strict: false,
    validateSchema: false,
    allErrors: true,
    removeAdditional: true,
  });
  return new AjvJsonSchemaValidator(addFormats(ajv)).getValidator<unknown>(schema);
};
