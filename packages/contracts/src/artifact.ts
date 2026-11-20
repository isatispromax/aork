import { z } from 'zod';
import type { ReadSnapshot, SyncTransaction } from '@aork/sdk/server';
/** Artifacts owns immutable copies; Workspace paths are capture provenance only. */
export const ARTIFACTS_SERVICE = 'aork.artifacts@1';
export const ARTIFACT_REGISTRATION = 'aork.artifacts.registration@1';
export const ARTIFACT_LIST = 'aork.artifacts.list@1';
export const ARTIFACT_VERSIONS = 'aork.artifacts.versions@1';
export const ARTIFACT_PREVIEW = 'aork.artifacts.preview@1';
/** Renderer views are versioned public UI contributions selected per media type. */
export const ARTIFACT_RENDERER = 'aork.artifacts.renderer@1';
const MEDIA_TYPES: Readonly<Record<string, string>> = { html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
/** Deterministic media type derived from the registered filename only; artifact bytes are never sniffed. */
export function artifactMediaType(filename: string): string { const extension = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : ''; return MEDIA_TYPES[extension] ?? 'application/octet-stream'; }
export const ARTIFACT_LIMITS = { transferBytes:8*1024*1024, textBytes:256*1024, previewBytes:2*1024*1024, metadataBytes:32*1024, pageBytes:64*1024, pageRows:25 } as const;
const id=z.uuid();
const association=z.object({sessionId:id,turnId:id}).strict();
const capturedSource=z.object({kind:z.literal('captured-file'),workspaceId:id,relativePath:z.string().min(1).max(4096)}).strict();
const externalUrl=z.string().max(4096).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}},'Use a credential-free HTTP or HTTPS URL');
const externalSource=z.object({kind:z.literal('external-reference'),url:externalUrl,label:z.string().max(120).optional()}).strict();
export const registerArtifactSchema=z.object({projectId:id,artifactId:id.optional(),title:z.string().trim().min(1).max(120),source:z.discriminatedUnion('kind',[capturedSource,externalSource]),association:association.optional()}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=ARTIFACT_LIMITS.metadataBytes-2048,'Artifact metadata exceeds the encoded byte limit');
export const artifactSchema=z.object({id,projectId:id,title:z.string(),createdAt:z.iso.datetime(),archived:z.boolean()}).strict();
export const artifactVersionSchema=z.object({id,artifactId:id,ordinal:z.number().int().positive(),createdAt:z.iso.datetime(),provenance:z.object({kind:z.literal('registered-by-user'),association:association.optional()}).strict(),content:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('captured-file'),contentId:id,sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(0).max(ARTIFACT_LIMITS.transferBytes),filename:z.string(),source:capturedSource.omit({kind:true})}).strict(),externalSource,
])}).strict();
export const artifactRegistrationResultSchema=z.object({artifactId:id,versionId:id,ordinal:z.number().int().positive()}).strict();
export const artifactChangedSchema=artifactRegistrationResultSchema.extend({projectId:id}).strict();
export const artifactListSchema=z.object({artifacts:z.array(artifactSchema.extend({versionCount:z.number().int(),latestVersionId:id})),next:z.string().nullable()}).strict();
export const artifactDetailSchema=z.object({artifact:artifactSchema,selected:artifactVersionSchema,versions:z.array(z.object({id,ordinal:z.number().int(),createdAt:z.iso.datetime(),kind:z.enum(['captured-file','external-reference'])}).strict()),next:z.string().nullable()}).strict();
export const artifactPreviewSchema=z.discriminatedUnion('status',[z.object({status:z.literal('text'),versionId:id,mediaType:z.string(),text:z.string()}).strict(),z.object({status:z.enum(['unsupported','too-large']),versionId:id,mediaType:z.string()}).strict(),z.object({status:z.literal('external-reference'),versionId:id}).strict()]);
export type RegisterArtifact=z.infer<typeof registerArtifactSchema>;
export type Artifact=z.infer<typeof artifactSchema>;
export type ArtifactVersion=z.infer<typeof artifactVersionSchema>;
export type ArtifactDetail=z.infer<typeof artifactDetailSchema>;
export type ArtifactList=z.infer<typeof artifactListSchema>;
export type ArtifactPreview=z.infer<typeof artifactPreviewSchema>;
export interface ContentInventoryEntry {contentId:string;versionId:string;storageKey:string;sha256:string;size:number}
/** Trusted server owner seam. All recorded versions, including archived history, are retention roots. */
export interface ArtifactsService {
 inspectVersion(principal:string,versionId:string,transaction?:SyncTransaction|ReadSnapshot):ArtifactVersion;
 readVersion(principal:string,versionId:string):Promise<Uint8Array>;
 contentInventory(after?:string,transaction?:SyncTransaction|ReadSnapshot):{entries:ContentInventoryEntry[];next:string|null};
}
/** Presentation and owner coordinates only. Children use the same authenticated owner APIs. */
export interface ArtifactViewContext {
 projectId:string;sessionId?:string;workspaceId?:string;relativePath?:string;
 artifactId?:string;versionId?:string;
 registered?(identity:{artifactId:string;versionId:string}):void;
 selectArtifact?(artifactId:string):void;selectVersion?(versionId:string):void;
 close?():void;
}
/** Selection is Project-scoped and preserves unrelated plugin keys. */
export function withArtifactSelection(hash:string,update:{projectId:string;artifactId?:string|null;versionId?:string|null}){const values=new URLSearchParams(hash.replace(/^#/,''));if(values.get('artifactProject')!==update.projectId){values.delete('artifact');values.delete('artifactVersion');}values.set('artifactProject',update.projectId);for(const [key,value]of [['artifact',update.artifactId],['artifactVersion',update.versionId]]as const){if(value===null)values.delete(key);else if(value!==undefined)values.set(key,value);}return values.toString();}
/** Renderer views render one pinned version of one media type. Content arrives only through the same authenticated artifacts reads; renderers never receive credentials and never mutate the version. */
export interface ArtifactRendererContext { versionId:string; mediaType:string; filename?:string }
/** The only sandbox combination active-content rendering may use: scripts run inside an opaque origin with no same-origin, top-navigation, form or popup privilege. There is no caller-selectable combination, and no path that restores workbench origin privileges. */
export const ARTIFACT_ACTIVE_SANDBOX = 'allow-scripts';
