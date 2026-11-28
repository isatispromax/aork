import { createPortal } from 'react-dom';
import type { ViewProps } from '@aork/sdk/client';
import type { DirectoryPickerContext } from '@aork/contracts/workspace';
import { DirectoryPicker } from './directory-picker.js';

/** `aork.workspace.directory-picker@1`: the same picker for another plugin's surface — the new-Session
 * picker's 添加工作区… — over the public view contract, with the owner conversation as its context.
 * Drawn at the body: a caller's form — the new-Session surface is one — must not own the picker's
 * controls or disable them with its own busy state. */
export function DirectoryPickerView({ runtime, context }: ViewProps) {
  const owner = context as Partial<DirectoryPickerContext> | undefined;
  if (typeof owner?.onConfirm !== 'function' || typeof owner.onCancel !== 'function') return null;
  return createPortal(<DirectoryPicker runtime={runtime} onCancel={owner.onCancel} onConfirm={owner.onConfirm} />, document.body);
}
