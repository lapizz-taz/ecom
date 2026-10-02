// Small immutable helpers for editing nested JSON settings.

export type Path = Array<string | number>

/** Immutable nested set: setIn({a: {b: 1}}, ['a', 'b'], 2) → {a: {b: 2}}. */
export function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  const source = (obj ?? (typeof head === 'number' ? [] : {})) as Record<string | number, unknown>
  const copy = (Array.isArray(source) ? [...source] : { ...source }) as Record<string | number, unknown>
  copy[head] = setIn(source[head], rest, value)
  return copy as T
}

export function getIn(obj: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string | number, unknown>)[k]), obj)
}
