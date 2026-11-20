import { z } from 'zod';

export const SESSION_INPUT_OPTIONS = 'aork.sessions.input-options@1';
export const SESSION_INPUT_EXTENSIONS = 'aork.sessions.input-extensions@1';
export const INPUT_LIMITS = { attachments: 4, attachmentBytes: 128 * 1024, totalBytes: 256 * 1024 } as const;
const identifier = z.string().min(1).max(200);
const label = z.string().min(1).max(200);
export const configOptionSchema = z.discriminatedUnion('type', [
  z.object({ id: identifier, name: label, category: identifier.optional(), type:z.literal('select'), currentValue:identifier, options:z.array(z.object({value:identifier,name:label,group:label.optional()}).strict()).min(1).max(100) }).strict(),
  z.object({ id: identifier, name: label, category: identifier.optional(), type:z.literal('boolean'), currentValue:z.boolean() }).strict(),
]);
export const negotiatedInputSchema = z.object({
  revision:z.number().int().positive(),
  prompt:z.object({image:z.boolean(),audio:z.boolean(),embeddedContext:z.boolean()}).strict(),
  modes:z.object({currentModeId:identifier,availableModes:z.array(z.object({id:identifier,name:label}).strict()).min(1).max(100)}).strict().optional(),
  configOptions:z.array(configOptionSchema).max(32),
}).strict();
export type NegotiatedInput = z.infer<typeof negotiatedInputSchema>;
export const configurationChangeSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('mode'),modeId:identifier}).strict(),
  z.object({kind:z.literal('option'),configId:identifier,value:z.union([identifier,z.boolean()])}).strict(),
]);
export type ConfigurationChange=z.infer<typeof configurationChangeSchema>;
export const configureRunSchema=z.object({runId:z.uuid(),generation:z.number().int().positive(),expectedRevision:z.number().int().positive(),change:configurationChangeSchema}).strict();
export const configurationOperationSchema=z.object({id:z.uuid(),expectedRevision:z.number().int().positive().optional(),sequence:z.number().int().positive().optional(),state:z.enum(['accepted','dispatching','applied','failed','delivery_unknown']),change:configurationChangeSchema,reason:z.string().max(500).optional()}).strict();
/** Attachments either reference a Workspace file path or a registered Artifact version.
 * Both forms capture immutable content at acceptance; capability rules apply equally. */
const attachmentKind=z.enum(['text','image','audio']);
export const fileAttachmentSchema=z.object({path:z.string().min(1).max(4096),kind:attachmentKind}).strict();
export const artifactAttachmentSchema=z.object({artifactVersionId:z.uuid(),kind:attachmentKind}).strict();
export const attachmentReferenceSchema=z.union([fileAttachmentSchema,artifactAttachmentSchema]);
export type AttachmentReference=z.infer<typeof attachmentReferenceSchema>;
export const attachmentSnapshotSchema=z.union([
  fileAttachmentSchema.extend({size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  artifactAttachmentSchema.extend({size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
/** Structured target for either attachment form; views decide their own labels. */
export function attachmentTarget(attachment: AttachmentReference): { kind: 'workspace-file'; path: string } | { kind: 'artifact-version'; versionId: string } {
  return 'path' in attachment ? { kind: 'workspace-file', path: attachment.path } : { kind: 'artifact-version', versionId: attachment.artifactVersionId };
}
export const promptContentSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),text:z.string()}).strict(),
  z.object({type:z.literal('resource'),resource:z.object({uri:z.string(),mimeType:z.string(),text:z.string()}).strict()}).strict(),
  z.object({type:z.literal('image'),data:z.string(),mimeType:z.string()}).strict(),
  z.object({type:z.literal('audio'),data:z.string(),mimeType:z.string()}).strict(),
]);
export type PromptContent=z.infer<typeof promptContentSchema>;
/** Passed by any composer to the selected input-options view and input extensions.
 * Callbacks modify that composer's draft only; the Host rechecks every command. */
export interface SessionInputContext {
  version:1;sessionId:string;attachments:readonly AttachmentReference[];disabled:boolean;
  onAttachmentsChange(attachments:AttachmentReference[]):void;
}
