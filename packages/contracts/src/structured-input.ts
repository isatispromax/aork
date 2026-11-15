import { z } from 'zod';
import { permissionSchema } from './interaction.js';
export const INPUT_CARDS = 'aork.interactions.input-cards@1';
export const STRUCTURED_FORM = 'aork.interactions.form@1';
const metadata = z.object({}).strict().nullish();
const display = { title: z.string().max(200).nullish(), description: z.string().max(500).nullish(), _meta: metadata };
const length = z.number().int().min(0).max(2000).nullish();
const boundedText = z.string().max(4000).refine(value => Array.from(value).length <= 2000);
const stringField = z.object({ type: z.literal('string'), ...display, minLength: length, maxLength: length, enum: z.array(z.string().max(200)).min(1).max(16).nullish(), default: boundedText.nullish() }).strict();
const numberFields = { ...display, minimum: z.number().finite().nullish(), maximum: z.number().finite().nullish(), default: z.number().finite().nullish() };
export const inputFieldSchema = z.discriminatedUnion('type', [stringField, z.object({ type: z.literal('number'), ...numberFields }).strict(), z.object({ type: z.literal('integer'), ...numberFields }).strict(), z.object({ type: z.literal('boolean'), ...display, default: z.boolean().nullish() }).strict()]);
const fieldName = z.string().min(1).max(80).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
export const requestedInputSchema = z.object({ type: z.literal('object'), ...display, properties: z.record(fieldName, inputFieldSchema).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16), required: z.array(fieldName).max(16).nullish() }).strict().superRefine((schema, ctx) => {
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length || required.some(name => !Object.hasOwn(schema.properties, name)))
        ctx.addIssue({ code: 'custom', message: 'Required fields must be unique offered properties' });
    for (const [name, field] of Object.entries(schema.properties)) {
        if (field.type === 'string' && ((field.minLength ?? 0) > (field.maxLength ?? 2000) || field.enum && new Set(field.enum).size !== field.enum.length) || (field.type === 'number' || field.type === 'integer') && field.minimum != null && field.maximum != null && field.minimum > field.maximum)
            ctx.addIssue({ code: 'custom', message: 'Inconsistent field constraints', path: ['properties', name] });
        if (field.default != null && fieldError(field, field.default))
            ctx.addIssue({ code: 'custom', message: 'Default violates field constraints', path: ['properties', name, 'default'] });
    }
});
export type InputField = z.infer<typeof inputFieldSchema>;
export type RequestedInput = z.infer<typeof requestedInputSchema>;
const contentWithinBudget=(value:Record<string,unknown>)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=48000;
export const inputContentSchema = z.record(fieldName, z.union([boundedText, z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 16&&contentWithinBudget(value));
export type InputContent = z.infer<typeof inputContentSchema>;
function fieldError(field: InputField, value: unknown): string | undefined {
    if (field.type === 'string') {
        if (typeof value !== 'string')
            return '请输入文本';
        const size = Array.from(value).length;
        if (size < (field.minLength ?? 0) || size > (field.maxLength ?? 2000))
            return `长度须为 ${field.minLength ?? 0}–${field.maxLength ?? 2000} 个字符`;
        if (field.enum && !field.enum.includes(value))
            return '请选择请求提供的选项';
    }
    else if (field.type === 'boolean') {
        if (typeof value !== 'boolean')
            return '请选择是或否';
    }
    else {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return '请输入有限数值';
        if (field.type === 'integer' && !Number.isInteger(value))
            return '请输入整数';
        if (field.minimum != null && value < field.minimum || field.maximum != null && value > field.maximum)
            return '数值超出请求范围';
    }
}
/** Same bounded constraints in the browser, command admission, and live dispatch. */
export function validateInputContent(schema: RequestedInput, content: InputContent): Record<string, string> {
    const errors: Record<string, string> = Object.create(null);
    if(!contentWithinBudget(content))errors['']='表单信息超过 48,000 字节，请缩短内容';
    for (const name of Object.keys(content))
        if (!Object.hasOwn(schema.properties, name))
            errors[name] = '请求没有提供此字段';
    for (const [name, field] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(content, name)) {
            if (schema.required?.includes(name))
                errors[name] = '此字段为必填';
            continue;
        }
        const error = fieldError(field, content[name]);
        if (error)
            errors[name] = error;
    }
    return errors;
}
export const nativeInputRequestSchema = z.object({ mode: z.literal('form'), sessionId: z.string().max(500), toolCallId: z.string().max(200).nullish(), message: z.string().min(1).max(500), requestedSchema: requestedInputSchema, _meta: metadata }).strict();
export const structuredInputSchema = permissionSchema.omit({ options: true, selectedOptionId: true }).extend({ kind: z.literal('structured'), source: z.object({ method: z.literal('elicitation/create'), providerId: z.string().max(200), toolCallId: z.string().max(200).optional() }).strict(), requestedSchema: requestedInputSchema, selectedAction: z.enum(['accept', 'decline', 'cancel']).optional() }).strict();
export const structuredInputFactSchema = z.object({ principal: z.string(), interaction: structuredInputSchema }).strict();
export const inputSubmissionSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('accept'), content: inputContentSchema }).strict(), z.object({ action: z.literal('decline') }).strict(), z.object({ action: z.literal('cancel') }).strict()]);
export const submitInputSchema = z.discriminatedUnion('action', [z.object({ interactionId: z.uuid(), action: z.literal('accept'), content: inputContentSchema }).strict(), z.object({ interactionId: z.uuid(), action: z.literal('decline') }).strict(), z.object({ interactionId: z.uuid(), action: z.literal('cancel') }).strict()]);
export type StructuredInput = z.infer<typeof structuredInputSchema>;
export type InputSubmission = z.infer<typeof inputSubmissionSchema>;
export const inputDiagnosticSchema = z.object({ id: z.uuid(), sessionId: z.uuid(), runId: z.uuid(), turnId: z.uuid(), hostEpoch: z.uuid(), generation: z.number().int().positive(), code: z.literal('INPUT_UNSUPPORTED'), message: z.literal('此 Agent 请求超出当前工作表单能力；认证、URL 或未知字段约束未启用。') }).strict();
export const inputDiagnosticFactSchema = z.object({ principal: z.string(), diagnostic: inputDiagnosticSchema }).strict();
export type InputDiagnostic = z.infer<typeof inputDiagnosticSchema>;
