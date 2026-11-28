/** The shortest trailing path-segment run that tells same-named entries apart, in the shape
 * of deepseek-harness's path-suffix (ui-workspace; MIT). Pure logic; the picker draws it. */

export interface PathSuffixEntry { id: string; name: string; directory: string }

/** For every entry, the shortest trailing `/`-segment run that no same-named peer shares.
 * Unambiguous names get the empty suffix. */
export function distinguishingPathSuffixes(entries: readonly PathSuffixEntry[]): Map<string, string> {
  const result = new Map<string, string>();
  const byName = new Map<string, PathSuffixEntry[]>();
  for (const entry of entries) {
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }
  for (const [, group] of byName) {
    for (const entry of group) {
      if (group.length < 2) { result.set(entry.id, ''); continue; }
      const segments = entry.directory.split('/').filter(Boolean);
      let taken: string[] = [];
      for (let count = 1; count <= segments.length; count++) {
        taken = segments.slice(-count);
        const label = taken.join('/');
        if (group.every(other => other.id === entry.id || other.directory.split('/').filter(Boolean).slice(-count).join('/') !== label)) break;
      }
      result.set(entry.id, taken.join('/'));
    }
  }
  return result;
}
