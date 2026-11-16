import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { jsonSchemaValidator, JsonSchemaType } from '@modelcontextprotocol/server';
import { AorkError } from '@aork/sdk';
/** The locked SDK exposes a synchronous wrapper. Never give it an async schema,
 * and never share its $id-keyed Ajv cache between immutable definitions. */
export const isolatedSchemaValidators: jsonSchemaValidator = { getValidator<T>(schema: JsonSchemaType) {
        let nodes = 0;
        const pending: {
            value: unknown;
            depth: number;
        }[] = [{ value: schema, depth: 0 }];
        while (pending.length) {
            const { value, depth } = pending.pop()!;
            if (depth > 16 || ++nodes > 512)
                throw new AorkError('TOOL_SCHEMA_INVALID', 'Schema structure exceeds supported bounds', 409);
            if (value && typeof value === 'object') {
                if ('$async' in value)
                    throw new AorkError('TOOL_SCHEMA_INVALID', 'Asynchronous JSON Schemas are not supported', 409);
                for (const child of Object.values(value))
                    pending.push({ value: child, depth: depth + 1 });
            }
        }
        try {
            return new AjvJsonSchemaValidator().getValidator<T>(schema);
        }
        catch {
            throw new AorkError('TOOL_SCHEMA_INVALID', 'JSON Schema cannot be compiled synchronously', 409);
        }
    } };
