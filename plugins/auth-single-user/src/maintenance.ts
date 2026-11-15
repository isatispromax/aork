import { AorkError } from '@aork/sdk';
import type { LocalMaintenancePlugin } from '@aork/sdk/server';
import { rotateAccess } from './access.js';

export const maintain: LocalMaintenancePlugin['maintain'] = (context, action) => {
  if (action !== 'recover' && action !== 'rotate') throw new AorkError('MAINTENANCE_ACTION_INVALID', 'Unsupported access maintenance action');
  return { action, ...rotateAccess(context.state) };
};
