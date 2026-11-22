import { expect, test } from 'vitest';
import * as workspaceContracts from '@aork/contracts/workspace';
import { createWorkspaceSchema, readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema, workspaceSchema } from '@aork/contracts/workspace';
import { artifactChangedSchema, artifactSchema, registerArtifactSchema, withArtifactSelection } from '@aork/contracts/artifact';
import { completedReplyFactSchema, createLinkedSessionSchema, createSessionSchema, sessionReferencesSchema } from '@aork/contracts/session';
import { replySummarySchema } from '@aork/contracts/workbench';
import { UI_CONTRACTS } from '@aork/sdk/client';

const uuid = () => crypto.randomUUID();
const externalWorkspace = {
  id: uuid(), name: 'Env', status: 'open',
  requestedDirectory: '/srv/env', directory: '/srv/env', access: 'read-write',
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
  const workspaceInput = { name: 'Env', directory: '/srv/env', access: 'read-write' };
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
