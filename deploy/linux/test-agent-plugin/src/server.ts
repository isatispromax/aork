// Provider plugin for the Linux validation ACP test agent (ticket 19).
// Installed through the public plugin installation path
// (`aork plugin install`), never by patching the Host.
// Mirrors the session-test-agent provider used by the repo's own tests.
import { execFileSync } from 'node:child_process';

const node = '/usr/local/bin/node';
const agent = '/opt/aork/test-agent/controlled-agent.mjs';

export function activate(context: any) {
  const dispose = context.service('aork.agent.providers@1').register({
    id: 'linux.test',
    label: 'Linux Validation Agent',
    version: '1.2.0',
    authentication: ['none'],
    parameters: [{ name: 'model', label: 'Model', type: 'string' }],
    launch: { executable: node, arguments: [agent], protocol: 'acp-stdio' },
    parseParameters(value: Record<string, unknown>) {
      if (Object.keys(value).some(key => key !== 'model')) throw new Error('invalid parameters');
      return value;
    },
    detect() {
      return { status: 'available', version: execFileSync(node, [agent, '--version'], { encoding: 'utf8', timeout: 1000 }).trim() };
    },
  }, context.owner);
  context.effect(() => dispose);
}
