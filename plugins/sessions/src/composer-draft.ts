import { attachmentReferenceSchema, INPUT_LIMITS } from '@aork/contracts/input';
import type { AttachmentReference } from '@aork/contracts/input';

interface DraftInput {
  text: string;
  attachments?: AttachmentReference[];
  commandId: string;
}
interface Draft extends DraftInput {
  uncertain?: DraftInput;
}
type Operation = 'send' | 'turn-control' | null;
interface ComposerState {
  draft: Draft;
  operation: Operation;
}

const attachmentList = attachmentReferenceSchema.array().max(INPUT_LIMITS.attachments);
function isDraftInput(data: unknown): data is DraftInput {
  if (!data || typeof data !== 'object') return false;
  const input = data as Partial<DraftInput>;
  return typeof input.text === 'string' && typeof input.commandId === 'string' &&
    attachmentList.safeParse(input.attachments ?? []).success;
}

function readDraft(key: string): Draft {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (isDraftInput(saved) && (!('uncertain' in saved) || isDraftInput(saved.uncertain))) return saved;
  } catch { /* The draft remains available in memory when browser storage is disabled. */ }
  return { text: '', commandId: crypto.randomUUID() };
}

function createComposerState(key: string) {
  let state: ComposerState = { draft: readDraft(key), operation: null };
  const listeners = new Set<() => void>();
  function publish(next: ComposerState) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save(draft: Draft) {
      try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep the draft in memory. */ }
      publish({ ...state, draft });
    },
    setOperation(operation: Operation) {
      publish({ ...state, operation });
    },
  };
}

// A receipt can arrive after this session's composer unmounts and mounts again.
const composers = new Map<string, ReturnType<typeof createComposerState>>();
export function composerState(key: string) {
  let state = composers.get(key);
  if (!state) {
    state = createComposerState(key);
    composers.set(key, state);
  }
  return state;
}
