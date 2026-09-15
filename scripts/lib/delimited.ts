/**
 * Minimal RFC-4180-ish delimited (CSV/TSV) parser shared by the deterministic
 * content generators (bulk-new-posts, sync-codes). Quoted fields, "" escapes;
 * auto-detects tab vs comma from the first line. Reports an unterminated
 * quote instead of silently swallowing the file tail.
 */
export function parseDelimited(text: string): { rows: string[][]; unterminatedQuote: boolean } {
  // Excel's "CSV UTF-8" export prefixes the file with U+FEFF. Left in place,
  // the first header cell becomes "\uFEFFlocale" and the column lookup returns
  // -1 — rows then silently default to the wrong locale. Strip it up front.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, unterminatedQuote: inQuotes };
}

/** The first row that is neither blank nor starts with "#" — the header. */
export function isBlankOrComment(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '') || (cells[0] ?? '').trim().startsWith('#');
}

// ---------------------------------------------------------------------------
// Shared newline/control-character guard
//
// A quoted CSV/TSV cell can smuggle a raw newline or control character past
// the parser (RFC 4180 allows it), where it would tear a generated file's
// single-line YAML scalar apart — a multi-line title written as frontmatter
// that only `pnpm build` (or worse, a fork's build) would catch. Rejected
// loudly at parse/answer time instead. Used by sync-codes, bulk-new-posts,
// and apply-template's answer intake; the escape helpers in
// lib/apply-rewrites.ts additionally strip them as defense-in-depth.
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE = /[\n\r\u0000-\u0008\u000B-\u001F\u007F]/;
// Same class with the global flag for replace() — sharing ONE regex object
// between .test() and .replace() would be wrong either way (stateless test vs
// replace-all).
const CONTROL_CHARS_GLOBAL_RE = /[\n\r\u0000-\u0008\u000B-\u001F\u007F]/g;

export function containsControlChar(value: string): boolean {
  return CONTROL_CHARS_RE.test(value);
}

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_GLOBAL_RE, '');
}
