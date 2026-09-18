import { randomUUID } from 'node:crypto';

/** Server-generated ids (users, sessions, devices, ...). Client-generated report ids go through shared/ids.ts instead. */
export const newId = (): string => randomUUID();
