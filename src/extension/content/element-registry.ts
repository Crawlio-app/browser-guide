export type InvalidationReason = "mutation" | "navigation" | "session-ended" | "new-snapshot";

export interface RegistryResolution {
  ok: true;
  element: Element;
}

export interface RegistryRejection {
  ok: false;
  error: "stale-snapshot" | "invalid-ref" | "detached-element";
}

export class ElementRegistry {
  private elementToRef = new WeakMap<Element, string>();
  private refToElement = new Map<string, Element>();
  private counter = 0;
  private currentSnapshotId: string | null = null;
  private valid = false;
  private readonly invalidationListeners = new Set<(snapshotId: string | null, reason: InvalidationReason) => void>();

  beginSnapshot(): string {
    if (this.valid || this.currentSnapshotId) this.invalidate("new-snapshot");
    this.elementToRef = new WeakMap<Element, string>();
    this.refToElement = new Map<string, Element>();
    this.counter = 0;
    this.currentSnapshotId = createSnapshotId();
    this.valid = true;
    return this.currentSnapshotId;
  }

  nextRefPreview(): string {
    return `e${this.counter + 1}`;
  }

  register(element: Element): string {
    if (!this.valid || !this.currentSnapshotId) throw new Error("Cannot register an element without an active snapshot");
    const existing = this.elementToRef.get(element);
    if (existing) return existing;
    const ref = `e${++this.counter}`;
    this.elementToRef.set(element, ref);
    this.refToElement.set(ref, element);
    return ref;
  }

  resolve(snapshotId: string, ref: string): RegistryResolution | RegistryRejection {
    if (!this.valid || snapshotId !== this.currentSnapshotId) return { ok: false, error: "stale-snapshot" };
    if (!/^e[1-9][0-9]*$/.test(ref)) return { ok: false, error: "invalid-ref" };
    const element = this.refToElement.get(ref);
    if (!element) return { ok: false, error: "invalid-ref" };
    if (!element.isConnected) {
      this.invalidate("mutation");
      return { ok: false, error: "detached-element" };
    }
    return { ok: true, element };
  }

  invalidate(reason: InvalidationReason): void {
    const snapshotId = this.currentSnapshotId;
    const shouldNotify = this.valid || reason === "session-ended" || reason === "navigation";
    this.valid = false;
    this.elementToRef = new WeakMap<Element, string>();
    this.refToElement.clear();
    if (shouldNotify) {
      for (const listener of this.invalidationListeners) listener(snapshotId, reason);
    }
  }

  onInvalidated(listener: (snapshotId: string | null, reason: InvalidationReason) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  get snapshotId(): string | null {
    return this.currentSnapshotId;
  }

  get refsValid(): boolean {
    return this.valid;
  }

  get size(): number {
    return this.refToElement.size;
  }
}

function createSnapshotId(): string {
  if (typeof crypto.randomUUID === "function") return `snapshot-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `snapshot-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
