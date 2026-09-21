import { describe, it, expect } from 'vitest'
import { csvCell, buildCsv } from './csv'

describe('csvCell', () => {
  it('leaves ordinary text alone', () => {
    expect(csvCell('Smith')).toBe('Smith')
    expect(csvCell('123 Elm St')).toBe('123 Elm St')
    expect(csvCell('')).toBe('')
  })

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"')
    expect(csvCell('The "Big" Job')).toBe('"The ""Big"" Job"')
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('neutralises formula-injection payloads', () => {
    // Excel and Sheets execute any cell starting with one of these.
    for (const payload of [
      '=1+1',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '=HYPERLINK("http://evil.example","click")',
      '=cmd|\' /c calc\'!A1'
    ]) {
      const cell = csvCell(payload)
      expect(cell.startsWith('"\''), payload).toBe(true)
    }
  })

  it('still guards a payload that also needs quoting', () => {
    expect(csvCell('=1,2')).toBe('"\'=1,2"')
  })

  it('does not mangle a legitimate name that merely contains a dash', () => {
    expect(csvCell('Smith-Jones')).toBe('Smith-Jones')
  })
})

describe('buildCsv', () => {
  it('joins rows with CRLF per RFC 4180', () => {
    expect(buildCsv([['Job Name', 'Total Time'], ['Smith', '01:00:00']]))
      .toBe('Job Name,Total Time\r\nSmith,01:00:00')
  })

  it('handles the blank spacer row the export uses', () => {
    expect(buildCsv([['a'], [], ['b']])).toBe('a\r\n\r\nb')
  })
})
