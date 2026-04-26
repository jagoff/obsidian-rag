/**
 * LRU cache simple con TTL para evitar refetches del mismo path en
 * ráfagas (ej. el user clickea entre 3 notas en 5 segundos y vuelve a la
 * primera — la 4ta vez la cacheada gana).
 *
 * No agregamos `lru-cache` npm porque para 50 entries no vale el bundle
 * size. Implementación: Map con orden de inserción, evict cuando se
 * supera maxSize.
 *
 * TTL es soft — si la entrada expiró pero no fue evicted, igual la
 * borramos al `get`. Cuando el corpus se reindexa, el web server bumpa
 * `col.id` y el shape cambia automáticamente; el cache front-side acá
 * NO sabe de eso, pero el TTL corto (5 min default) lo cubre — peor
 * caso ves data stale 5 min hasta que la cache expira.
 *
 * Agregamos `version` para invalidación manual: cuando el plugin
 * detecta `vault.modify` en la nota actual, la view llama
 * `cache.invalidate(path)` y el siguiente fetch va al backend. Eso
 * cubre el caso "edité la nota, quiero ver relacionadas frescas".
 */
export class LruCache<K, V> {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly map = new Map<K, { value: V; expires: number }>();

  constructor(opts: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = opts.maxSize ?? 50;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert para que pase al final del orden de inserción (LRU touch).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    // Evict el más viejo (el primero en el orden de inserción) si overflow.
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
  }

  invalidate(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}
