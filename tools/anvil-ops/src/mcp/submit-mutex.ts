/**
 * Process-wide submit interlock (fast path). MCP clients may fire tool calls
 * in parallel; two concurrent submit_pr runs would each stage the whole
 * worktree and open two PRs for the same batch. Global (not per-repo) is
 * deliberate: submit touches shared git state and serializing it costs
 * nothing. This mutex is in-process by design — the cross-process truth
 * (CLI + multiple MCP server processes + offloaded workers) is the file lock
 * in core/gitops.ts acquireSubmitLock, taken inside submit() itself.
 */
export interface SubmitMutex {
  /** true = acquired; false = another submit is already in flight. */
  tryAcquire(): boolean;
  release(): void;
}

export function createSubmitMutex(): SubmitMutex {
  let busy = false;
  return {
    tryAcquire(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
  };
}
