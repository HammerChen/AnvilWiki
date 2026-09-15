/**
 * Process-wide submit interlock. MCP clients may fire tool calls in parallel;
 * two concurrent submit_pr runs would each stage the whole worktree and open
 * two PRs for the same batch of changes (branch timestamps usually differ by a
 * minute, so nothing else stops them). Global (not per-repo) is deliberate:
 * the MCP server is a single process, submit touches shared git state, and
 * serializing it costs nothing. The single-process CLI never overlaps itself.
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
