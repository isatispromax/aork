import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BootstrapFailure, createUiRuntime } from '@aork/ui';
import type { Bootstrap } from '@aork/sdk';
import type { UiRuntime } from '@aork/sdk/client';

function AccessGate({ runtime }: { runtime: UiRuntime }) {
  const [access, setAccess] = useState(runtime.bootstrap.access);
  useEffect(() => { const remove = runtime.onAccessChange(setAccess); return () => { void remove(); }; }, [runtime]);
  return runtime.renderView(access.state === 'authenticated' ? 'aork.workbench.layout@1' : 'aork.auth.login@1');
}
const root = createRoot(document.getElementById('root')!);
try {
  const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`Host bootstrap returned HTTP ${response.status}`);
  const bootstrap = await response.json() as Bootstrap;
  const diagnostics = bootstrap.diagnostics.filter(diagnostic => !(bootstrap.access.state === 'authenticated' && diagnostic.location === 'ui.providers.aork.auth.login@1'));
  if (bootstrap.apiVersion !== 1 || diagnostics.length) root.render(<BootstrapFailure diagnostics={diagnostics.length ? diagnostics : [{ code: 'API_INCOMPATIBLE', message: 'This page requires Aork HTTP API 1' }]} maintenance={bootstrap.maintenance.command} />);
  else {
    const loaded = await createUiRuntime(bootstrap);
    root.render(<AccessGate runtime={loaded.runtime} />);
    window.addEventListener('pagehide', () => {
      void loaded.dispose().catch(() => { console.error('AORK_UI_CLEANUP_FAILED: reload the page before continuing'); });
    }, { once: true });
  }
} catch (error) {
  root.render(<BootstrapFailure diagnostics={[{ code: 'BOOTSTRAP_FAILED', message: error instanceof Error ? error.message : 'Unable to load Host' }]} maintenance="pnpm aork doctor --data-dir <data-directory>" />);
}
