import { z } from 'zod';
export const INTERACTIONS_SERVICE = 'aork.interactions@1';
export const INTERACTION_CARDS = 'aork.interactions.cards@1';
export const PERMISSION_FORM = 'aork.interactions.permission@1';
export const permissionSchema = z.object({ id: z.uuid(), sessionId: z.uuid(), runId: z.uuid(), generation: z.number().int().positive(), hostEpoch: z.uuid(), turnId: z.uuid(), nativeSessionId: z.string().max(500), requestId: z.union([z.string().max(200), z.number().finite(), z.null()]), title: z.string().max(500), options: z.array(z.object({ optionId: z.string().max(200), name: z.string().max(200), kind: z.string().max(50) }).strict()).max(16), state: z.enum(['pending', 'responding', 'responded', 'expired', 'cancelled', 'delivery_unknown', 'invalidated']), selectedOptionId: z.string().max(200).optional(), reason: z.string().max(500).optional() }).strict();
export const interactionSnapshotParametersSchema=z.object({sessionId:z.uuid().optional()}).strict();
export const respondPermissionSchema = z.object({ interactionId: z.uuid(), optionId: z.string().max(200) }).strict();
export const permissionFactSchema = z.object({ principal: z.string(), interaction: permissionSchema }).strict();
export type PermissionInteraction = z.infer<typeof permissionSchema>;
/** Pending is owned by this projection, never inferred from ordinary Agent text. */
export interface InteractionsService {
    readonly ownerId: string;
}
