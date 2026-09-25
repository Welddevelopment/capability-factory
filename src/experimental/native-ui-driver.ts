import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Native-UI driver (Phase 1, deterministic) — the containment layer over the
 * ax-helper binary, mirroring the browser family's discipline:
 *
 * - The driver acts ONLY on controls in a declared surface, by accessibility
 *   identifier with an explicitly permitted action set. A control that exists
 *   in the app but is absent from the surface (e.g. the Dealer Desk
 *   "Delete ALL requests" tripwire) is a refusal, not an option.
 * - One write budget per session: a single press of a control marked
 *   `commitsWrite` is permitted; any further commit attempt is refused.
 * - Snapshots are sanitized upstream (role + identifier + opaque id only);
 *   this layer never sees window contents or values.
 * - Anything unresolvable fails closed with a NativeUiRefusal.
 */

export interface DeclaredNativeControl {
  identifier: string;
  role: "AXButton" | "AXTextField";
  actions: readonly ("press" | "settext")[];
  commitsWrite?: boolean;
}

export interface NativeUiSurface {
  appBundleId: string;
  controls: readonly DeclaredNativeControl[];
}

export interface NativeSnapshotEntry {
  opaqueId: string;
  role: string;
  identifier: string;
}

export class NativeUiRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeUiRefusal";
  }
}

export class NativeUiDriver {
  private writesCommitted = 0;

  constructor(
    private readonly helperPath: string,
    private readonly pid: number,
    private readonly surface: NativeUiSurface,
    private readonly maxWrites = 1,
  ) {}

  snapshot(): NativeSnapshotEntry[] {
    const raw = execFileSync(this.helperPath, ["snapshot", String(this.pid)], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new NativeUiRefusal("snapshot was not a list; failing closed");
    if (parsed.length === 0) {
      // A dead pid and a not-yet-registered AX server both present as an
      // empty tree with no error. An empty surface is never actionable.
      throw new NativeUiRefusal("snapshot returned no controls (app gone or AX not ready); failing closed");
    }
    return parsed as NativeSnapshotEntry[];
  }

  /** Resolve a declared control against the live snapshot; refusal on any mismatch. */
  private resolve(identifier: string, action: "press" | "settext"): { entry: NativeSnapshotEntry; declared: DeclaredNativeControl } {
    const declared = this.surface.controls.find((control) => control.identifier === identifier);
    if (!declared) {
      throw new NativeUiRefusal(`control "${identifier}" is not in the declared surface; refusing`);
    }
    if (!declared.actions.includes(action)) {
      throw new NativeUiRefusal(`action "${action}" is not permitted on "${identifier}"; refusing`);
    }
    const entry = this.snapshot().find((candidate) => candidate.identifier === identifier);
    if (!entry) {
      throw new NativeUiRefusal(`control "${identifier}" did not resolve against the live snapshot; refusing`);
    }
    if (entry.role !== declared.role) {
      throw new NativeUiRefusal(`control "${identifier}" role drifted (${entry.role} != ${declared.role}); refusing`);
    }
    return { entry, declared };
  }

  setText(identifier: string, value: string): void {
    const { entry } = this.resolve(identifier, "settext");
    this.helperAct(entry.opaqueId, "settext", value);
  }

  press(identifier: string): void {
    const { entry, declared } = this.resolve(identifier, "press");
    if (declared.commitsWrite) {
      if (this.writesCommitted >= this.maxWrites) {
        throw new NativeUiRefusal(`write budget exhausted (${this.maxWrites}); refusing further commits`);
      }
      this.writesCommitted += 1;
    }
    this.helperAct(entry.opaqueId, "press");
  }

  private helperAct(opaqueId: string, action: string, value?: string): void {
    const args = ["act", String(this.pid), opaqueId, action, ...(value === undefined ? [] : [value])];
    try {
      execFileSync(this.helperPath, args, { encoding: "utf8", timeout: 15_000 });
    } catch (error) {
      throw new NativeUiRefusal(`helper refused or failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function defaultHelperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, "native", "dealer-desk", "ax-helper");
}
