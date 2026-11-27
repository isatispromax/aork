/** Bounds of Workspace file transfers, owned by the file service and read by whatever shows a
 * file: the Files view, the preview panel. Kept apart from the schemas, so a browser bundle can
 * take the numbers without taking them. */
export const FILE_LIMITS = { transferBytes: 8 * 1024 * 1024, textBytes: 256 * 1024, entries: 500, searchEntries: 5000, searchResults: 200, responseBytes: 750 * 1024 } as const;
