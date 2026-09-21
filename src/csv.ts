/**
 * CSV generation for the invoicing export.
 *
 * Kept separate from App.tsx so it can be tested directly: this file is the
 * boundary between free text typed on a shop floor and a spreadsheet somebody
 * opens to bill a client.
 */

/**
 * RFC 4180 quoting, plus formula-injection defence.
 *
 * Job names routinely contain commas. They can also start with `=`, `+`, `-`
 * or `@`, which Excel and Sheets treat as the start of a formula rather than
 * as text: a job called "-Smith" becomes a broken cell, and a maliciously
 * named one becomes a live formula in the invoicing spreadsheet. Prefixing
 * with an apostrophe forces text; Excel does not display it.
 *
 * See OWASP "CSV Injection".
 */
export function csvCell(value: string): string {
  const text = String(value ?? '')
  const needsGuard = /^[=+\-@\t\r]/.test(text)
  const guarded = needsGuard ? `'${text}` : text
  return /[",\n\r]/.test(guarded) || needsGuard
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded
}

export function buildCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n')
}
