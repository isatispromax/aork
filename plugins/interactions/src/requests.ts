import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import type { InputDiagnostic } from '@aork/contracts/structured-input';

type SelectionKey = 'interaction' | 'input';
type RequestRecord = { id: string; sessionId: string; state: string };
type RequestHistory<T> = { interactions: T[]; diagnostics?: InputDiagnostic[]; truncated?: boolean };

function requestStage(state: string) {
    if (state === 'pending') return 0;
    if (state === 'responding') return 1;
    return 2;
}

export function selectRequest(key: SelectionKey, id: string) {
    const selection = new URLSearchParams(location.hash.slice(1));
    selection.delete(key === 'input' ? 'interaction' : 'input');
    selection.set(key, id);
    location.hash = selection.toString();
}

function useSelection() {
    const read = () => new URLSearchParams(location.hash.slice(1));
    const [selection, setSelection] = useState(read);
    useEffect(() => {
        const update = () => setSelection(read());
        addEventListener('hashchange', update);
        return () => removeEventListener('hashchange', update);
    }, []);
    return selection;
}

function useRequestSnapshot<T, R>(
    runtime: UiRuntime,
    name: string,
    key: 'id' | 'sessionId',
    scope: string | null,
    parse: (value: T) => R,
) {
    const [snapshot, setSnapshot] = useState<{ scope: string; value: R | undefined; error?: string }>();
    useEffect(() => {
        setSnapshot(undefined);
        if (!scope) return;
        let active = true;
        const stop = runtime.observeSnapshot<T>(name, { [key]: scope }, {
            next(value) {
                if (active) setSnapshot({ scope, value: parse(value) });
            },
            error(failure) {
                if (active) setSnapshot(previous => ({
                    scope,
                    value: previous?.scope === scope ? previous.value : undefined,
                    error: failure.message,
                }));
            },
        }, { owners: ['interactions'] });
        return () => { active = false; void stop(); };
    }, [runtime, name, key, scope, parse]);
    return snapshot?.scope === scope ? snapshot : undefined;
}

export function useRequests<T extends RequestRecord>(runtime: UiRuntime, key: SelectionKey, parse: (value: unknown) => T) {
    const selection = useSelection();
    const sessionId = selection.get('session');
    const requested = sessionId ? selection.get(key) : null;
    const parseHistory = useCallback((value: RequestHistory<unknown>): RequestHistory<T> => ({
        ...value,
        interactions: value.interactions.map(parse),
    }), [parse]);
    const history = useRequestSnapshot(
        runtime, key === 'input' ? 'interactions.inputHistory' : 'interactions.history', 'sessionId', sessionId, parseHistory,
    );
    const detail = useRequestSnapshot(runtime, 'interactions.request', 'id', requested, parse);
    const detailValue = detail?.value;
    const selected = detailValue?.sessionId === sessionId && detailValue?.id === requested ? detailValue : undefined;
    const values = history?.value?.interactions.filter(item => item.sessionId === sessionId) ?? [];
    if (selected) {
        const index = values.findIndex(item => item.id === selected.id);
        if (index < 0) values.push(selected);
        // History and exact detail may arrive in either order. Once either
        // source confirms a response or closure, an older snapshot cannot reopen it.
        else if (requestStage(selected.state) >= requestStage(values[index]!.state)) values[index] = selected;
    }
    return {
        values,
        value: requested ? values.find(item => item.id === requested) : values.find(item => item.state === 'pending'),
        requested,
        selected,
        diagnostics: history?.value?.diagnostics?.filter(item => item.sessionId === sessionId) ?? [],
        truncated: history?.value?.truncated === true,
        historyError: history?.error,
        actionError: requested ? detail?.error || (detailValue && !selected ? '此会话中没有这条请求。' : undefined) : history?.error,
        opening: Boolean(requested && !detailValue && !detail?.error),
    };
}

export function useRequestFocus(id: string | undefined) {
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        if (id) heading.current?.focus();
    }, [id]);
    return heading;
}
