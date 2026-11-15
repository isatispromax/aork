import { createRoot } from 'react-dom/client';
import { BootstrapFailure, createUiRuntime } from '@aork/ui';
import type { Bootstrap } from '@aork/sdk';

const root = createRoot(document.getElementById('root')!);
try {
  const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`Host bootstrap returned HTTP ${response.status}`);
  const bootstrap = await response.json() as Bootstrap;
  if (bootstrap.apiVersion !== 1 || bootstrap.diagnostics.length) root.render(<BootstrapFailure diagnostics={bootstrap.diagnostics.length ? bootstrap.diagnostics : [{ code: 'API_INCOMPATIBLE', message: 'This page requires Aork HTTP API 1' }]} maintenance={bootstrap.maintenance.command} />);
  else {
    const loaded = await createUiRuntime(bootstrap);
    const contract = bootstrap.access.state === 'authenticated' ? 'aork.workbench.layout@1' : 'aork.auth.login@1';
    root.render(loaded.runtime.renderView(contract));
    window.addEventListener('pagehide', () => { void loaded.dispose(); }, { once: true });
  }
} catch (error) {
  root.render(<BootstrapFailure diagnostics={[{ code: 'BOOTSTRAP_FAILED', message: error instanceof Error ? error.message : 'Unable to load Host' }]} maintenance="pnpm aork doctor --data-dir <data-directory>" />);
}
