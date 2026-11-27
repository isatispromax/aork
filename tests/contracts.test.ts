import { expect, test } from 'vitest';
import * as workspaceContracts from '@aork/contracts/workspace';
import { createWorkspaceSchema, readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema, workspaceSchema } from '@aork/contracts/workspace';
import { artifactChangedSchema, artifactSchema, registerArtifactSchema, withArtifactSelection } from '@aork/contracts/artifact';
import { completedReplyFactSchema, createLinkedSessionSchema, createSessionSchema, sessionReferencesSchema } from '@aork/contracts/session';
import { defaultPreferences, preferencesSchema, readPreferences, replySummarySchema, WORKBENCH_CONVERSATION_BAND, WORKBENCH_INSPECTOR, WORKBENCH_INSPECTOR_TABS, WORKBENCH_RAIL_SECTIONS, WORKBENCH_SIDEBAR } from '@aork/contracts/workbench';
import { UI_CONTRACTS, UI_EXTENSION_TARGETS } from '@aork/sdk/client';
import { pluginManifestSchema } from '@aork/sdk';

const uuid = () => crypto.randomUUID();
const externalWorkspace = {
  id: uuid(), name: 'Env', status: 'open',
  requestedDirectory: '/srv/env', directory: '/srv/env',
  scope: { root: '/srv/env', recursive: true }, directoryIdentity: { device: 'd1', inode: '42' },
};

test('workspace contract exports no project symbols', () => {
  const residue = Object.keys(workspaceContracts).filter(key => /project/i.test(key));
  expect(residue).toEqual([]);
});

test('workbench selection reads workspace-scoped URL state without project keys', () => {
  const selection = readWorkbenchSelection('#workspace=ws-1&session=s-1&reply=r-1&createSession=1&artifact=a-1&artifactVersion=v-1');
  expect(selection).toEqual({ workspaceId: 'ws-1', sessionId: 's-1', replyId: 'r-1', creatingSession: true });
});

test('workspace selection update preserves unrelated plugin keys and resets paging', () => {
  const hash = withWorkbenchSelection('page=home&artifact=a-9&custom=keep', { workspaceId: 'ws-2' });
  const values = new URLSearchParams(hash);
  expect(values.get('workspace')).toBe('ws-2');
  expect(values.get('custom')).toBe('keep');
  expect(values.has('page')).toBe(false);
});

test('switching workspace clears directory, file and artifact selection', () => {
  const hash = withWorkbenchSelection('workspace=ws-1&artifact=a-1&artifactVersion=v-2&directory=/srv/env&file=main.ts&line=3', { workspaceId: 'ws-2' });
  const values = new URLSearchParams(hash);
  expect(values.get('workspace')).toBe('ws-2');
  for (const key of ['artifact', 'artifactVersion', 'directory', 'file', 'line']) expect(values.has(key)).toBe(false);
});

test('selection update never emits project or artifactProject keys', () => {
  const hash = withArtifactSelection(withWorkbenchSelection('', { workspaceId: 'ws-1' }), { artifactId: 'a-1', versionId: 'v-1' });
  const values = new URLSearchParams(hash);
  expect(values.get('artifact')).toBe('a-1');
  expect(values.get('artifactVersion')).toBe('v-1');
  expect(values.has('artifactProject')).toBe(false);
  expect(values.has('project')).toBe(false);
});

test('artifact selection update preserves unrelated plugin keys and clears on null', () => {
  const hash = withArtifactSelection('workspace=ws-1&artifact=old&artifactVersion=old-v&custom=keep', { artifactId: 'a-2', versionId: null });
  const values = new URLSearchParams(hash);
  expect(values.get('artifact')).toBe('a-2');
  expect(values.has('artifactVersion')).toBe(false);
  expect(values.get('custom')).toBe('keep');
});

test('workspace schemas attribute everything to workspace, not project', () => {
  expect(workspaceSchema.safeParse(externalWorkspace).success).toBe(true);
  expect(workspaceSchema.safeParse({ ...externalWorkspace, projectId: uuid() }).success).toBe(false);
  const workspaceInput = { name: 'Env', directory: '/srv/env' };
  expect(createWorkspaceSchema.safeParse({ workspace: workspaceInput }).success).toBe(true);
  expect(createWorkspaceSchema.safeParse({ projectId: uuid(), workspace: workspaceInput }).success).toBe(false);
  // The managed/external discriminator is gone: any management field fails the strict input.
  expect(createWorkspaceSchema.safeParse({ workspace: { ...workspaceInput, management: 'external' } }).success).toBe(false);
  expect(createWorkspaceSchema.safeParse({ workspace: { name: 'Env', management: 'managed' } }).success).toBe(false);
  expect(workspaceOverviewSchema.safeParse({ workspaces: [externalWorkspace] }).success).toBe(true);
  expect(workspaceOverviewSchema.safeParse({ projects: [], workspaces: [] }).success).toBe(false);
});

test('artifact contracts attribute registration to workspace', () => {
  const workspaceId = uuid();
  const registration = { workspaceId, title: 'Report', source: { kind: 'external-reference', url: 'https://example.com/report' } };
  expect(registerArtifactSchema.safeParse(registration).success).toBe(true);
  expect(registerArtifactSchema.safeParse({ projectId: workspaceId, title: 'Report', source: { kind: 'external-reference', url: 'https://example.com/report' } }).success).toBe(false);
  const artifact = { id: uuid(), workspaceId, title: 'Report', createdAt: new Date().toISOString(), archived: false };
  expect(artifactSchema.safeParse(artifact).success).toBe(true);
  expect(artifactChangedSchema.safeParse({ artifactId: uuid(), versionId: uuid(), ordinal: 1, workspaceId }).success).toBe(true);
  expect(artifactChangedSchema.safeParse({ artifactId: uuid(), versionId: uuid(), ordinal: 1, projectId: workspaceId }).success).toBe(false);
});

test('session contracts drop project attribution', () => {
  const workspaceId = uuid(); const profileId = uuid();
  expect(createSessionSchema.safeParse({ name: 'S', workspaceId, profileId }).success).toBe(true);
  expect(createSessionSchema.safeParse({ name: 'S', projectId: uuid(), workspaceId, profileId }).success).toBe(false);
  expect(completedReplyFactSchema.safeParse({ principal: 'p1', activityId: uuid(), sessionId: uuid(), turnId: uuid(), workspaceId, sessionName: 'S', source: 'live-completion' }).success).toBe(true);
  expect(completedReplyFactSchema.safeParse({ principal: 'p1', activityId: uuid(), sessionId: uuid(), turnId: uuid(), projectId: uuid(), workspaceId, sessionName: 'S', source: 'live-completion' }).success).toBe(false);
  expect(sessionReferencesSchema.safeParse({ sessions: [{ id: uuid(), name: 'S', workspaceId }] }).success).toBe(true);
  expect(sessionReferencesSchema.safeParse({ sessions: [{ id: uuid(), name: 'S', projectId: uuid(), workspaceId }] }).success).toBe(false);
  expect(createLinkedSessionSchema.safeParse({ sourceSessionId: uuid(), name: 'S', workspaceId, profileId }).success).toBe(true);
  expect(createLinkedSessionSchema.safeParse({ sourceSessionId: uuid(), name: 'S', projectId: uuid(), workspaceId, profileId }).success).toBe(false);
});

test('reply summaries attribute activity to workspace only', () => {
  const summary = { activityId: uuid(), sessionId: uuid(), turnId: uuid(), workspaceId: uuid(), sessionName: 'S' };
  expect(replySummarySchema.safeParse(summary).success).toBe(true);
  expect(replySummarySchema.safeParse({ ...summary, projectId: uuid() }).success).toBe(false);
});

test('UI contracts drop the project page contract', () => {
  expect(UI_CONTRACTS).not.toContain('aork.workspace.project-page@1');
});


test('the three workbench regions are public contracts and each region owns extension targets', () => {
  for (const contract of [WORKBENCH_SIDEBAR, WORKBENCH_INSPECTOR]) expect(UI_CONTRACTS).toContain(contract);
  for (const target of [WORKBENCH_RAIL_SECTIONS, WORKBENCH_CONVERSATION_BAND, WORKBENCH_INSPECTOR_TABS]) expect(UI_EXTENSION_TARGETS).toContain(target);
  // Regions are separately replaceable, so a right-region section is not a Files-only surface.
  expect(UI_EXTENSION_TARGETS).not.toContain('aork.workbench.files@1');
  // The stacked-sections target was replaced by the panel-type registry in one release.
  expect(UI_EXTENSION_TARGETS).not.toContain('aork.workbench.inspector-sections@1');
});

test('a panel type declares its instances, start-page line and selection trigger, and nothing else', () => {
  const manifest = (extension: Record<string, unknown>) => ({ manifestVersion: 1, id: 'workspace', version: '0.1.0', sdkRange: '^0.1.0', ui: { providers: [], extensions: [{ id: 'files-section', target: WORKBENCH_INSPECTOR_TABS, ...extension }] } });
  const declared = pluginManifestSchema.parse(manifest({ order: 10, label: '文件', icon: 'files', multiple: false, description: '浏览、搜索、预览与编辑工作区文件', opensWith: 'file' }));
  expect(declared.ui.extensions[0]).toMatchObject({ label: '文件', icon: 'files', multiple: false, description: '浏览、搜索、预览与编辑工作区文件', opensWith: 'file' });
  // Every field is optional, so a panel type stays a one-line declaration.
  expect(pluginManifestSchema.parse(manifest({})).ui.extensions[0]).toMatchObject({ id: 'files-section', order: 0 });
  // The declaration stays closed: a typo is a startup diagnostic, not a silently ignored hint.
  expect(() => pluginManifestSchema.parse(manifest({ opensWhen: 'file' }))).toThrow();
  expect(() => pluginManifestSchema.parse(manifest({ opensWith: 'File Selection' }))).toThrow();
});

test('layout preferences name the right region rather than Files and read legacy records', () => {
  const current = { theme: 'dark', sidebarOpen: false, inspectorOpen: true, inspectorWide: true };
  expect(preferencesSchema.safeParse(current).success).toBe(true);
  expect(preferencesSchema.safeParse({ theme: 'dark', sidebarOpen: false, filesOpen: true, filesWide: true }).success).toBe(false);
  expect(readPreferences(current)).toEqual(current);
  // Legacy records keep the user's theme and both switches instead of resetting the page.
  expect(readPreferences({ theme: 'light', sidebarOpen: false, filesOpen: false, filesWide: true })).toEqual({ theme: 'light', sidebarOpen: false, inspectorOpen: false, inspectorWide: true });
  expect(readPreferences({ theme: 'light', sidebarOpen: false, inspectorOpen: false, filesWide: true })).toEqual({ theme: 'light', sidebarOpen: false, inspectorOpen: false, inspectorWide: true });
  // Malformed or absent records fall back per field without throwing.
  expect(readPreferences(undefined)).toEqual(defaultPreferences);
  expect(readPreferences('nonsense')).toEqual(defaultPreferences);
  expect(readPreferences({ theme: 'neon', sidebarOpen: true, inspectorOpen: 'yes', inspectorWide: null })).toEqual(defaultPreferences);
  expect(readPreferences({ ...current, theme: 'system' })).toEqual({ ...current, theme: 'system' });
});
