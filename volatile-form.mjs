/**
 * Verbatim re-implementation of `volatileForm` from
 * `dsh-settings/lib/types/schema.js`, used by stress.mjs to prove this
 * plugin's Config survives settings projection.
 *
 * `describe()` skips an entry whose `volatileForm(schema)` is `undefined`, and
 * that happens for any Config with no `.volatile()` field — the exact bug this
 * assertion guards against.
 */
import Schema from '@deepseek-ai/schemastery';

export function volatileForm(schema) {
  if (schema.meta.volatile) return schema;
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child);
      return field === undefined ? [] : [[key, field]];
    }));
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict);
  }
  return undefined;
}
