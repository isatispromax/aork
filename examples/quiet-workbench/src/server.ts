import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';

export function activate(context: ServerPluginContext) {
  const settings = { read: () => ({ label: context.state.get<string>('label') ?? '我的工作台' }) };
  context.provide('quiet.settings@1', settings);
  context.query('quiet.settings', { access: 'authenticated', execute: () => context.service<typeof settings>('quiet.settings@1').read() });
  context.command('quiet.settings.save', { access: 'authenticated', execute: payload => {
    if (!payload || typeof payload !== 'object' || !('label' in payload) || typeof payload.label !== 'string' || !payload.label.trim() || payload.label.length > 80) throw new AorkError('SETTING_INVALID', '工作台名称须为 1–80 个字符');
    context.state.set('label', payload.label.trim());
    return settings.read();
  } });
}
