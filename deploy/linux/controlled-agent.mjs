// Controlled ACP test agent for Linux deployment validation (ticket 19).
//
// This is the external-agent stand-in allowed by the spec's testing
// decisions: a real separate OS process speaking ACP over stdio, spawned
// and supervised by the Host. It writes its observed wire traffic to
// ./negotiated-wire inside the (managed) workspace it runs in, so the
// validation can prove the managed process really executed on the guest.
// Standalone Node, no repo dependencies. Port of tests/fixtures/negotiated-agent.ts.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0); }

let mode = 'inspect';
let config = [{
  id: 'engine', name: 'Research model', category: 'model', type: 'select', currentValue: 'research-small',
  options: [{ group: 'research', name: 'Research family', options: [{ value: 'research-small', name: 'Research Small' }, { value: 'research-large', name: 'Research Large' }] }],
}];
config = config.map(option => ({ ...option, _meta: { token: 'agent-private-config' } }));

const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  appendFileSync('negotiated-wire', JSON.stringify(r) + '\n');
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentInfo: { name: 'Linux validation agent', version: '1.2.3' }, agentCapabilities: { promptCapabilities: { embeddedContext: true, image: true } }, authMethods: [] } });
  if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'native-linux-validation', _meta: { token: 'agent-private-native' }, configOptions: config, modes: { currentModeId: mode, availableModes: [{ id: 'inspect', name: 'Inspect' }, { id: 'write', name: 'Write' }] } } });
  if (r.method === 'session/set_mode') { mode = r.params.modeId; send({ id: r.id, result: {} }); }
  if (r.method === 'session/set_config_option') { config = config.map(c => c.id === r.params.configId ? { ...c, currentValue: r.params.value } : c); send({ id: r.id, result: { configOptions: config } }); }
  if (r.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'native-linux-validation', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Linux validation answer' } } } });
    send({ id: r.id, result: { stopReason: 'end_turn' } });
  }
});
