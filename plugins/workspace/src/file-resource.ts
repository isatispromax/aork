import type { UiRuntime } from '@aork/sdk/client';

/** What a failed file operation is reported as: its own message where it has one. */
export const failureText = (failure: unknown): string => failure instanceof Error ? failure.message : '文件操作失败';

/** Reads one Workspace file resource — or writes it, where bytes are given — and decodes its JSON answer. */
export async function fileJson<T>(runtime: UiRuntime, workspaceId: string, name: string, parameters: Record<string, string>, bytes?: Uint8Array): Promise<T> {
  const result = await runtime.resource(name, { workspaceId, ...parameters }, bytes);
  return JSON.parse(new TextDecoder().decode(result.bytes)) as T;
}
