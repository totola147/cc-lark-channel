export class LruDedup {
  private readonly map = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Returns true if the key was already seen (duplicate). */
  check(key: string): boolean {
    if (this.map.has(key)) return true;
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
    this.map.set(key, true);
    return false;
  }
}
