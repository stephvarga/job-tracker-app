/**
 * Date/time helpers pinned to the shop's local timezone.
 *
 * The shop is in Richmond, CA. Every "day" and "week" boundary in this app is
 * a *Pacific* boundary, not a UTC one and not the viewing device's one. A phone
 * that's travelled to another timezone should still see the same workday.
 *
 * The old code did `new Date().toISOString().slice(0, 10)` to get "today".
 * That's the UTC date, so from 5pm Pacific onward it returned *tomorrow* and
 * the day's tracked hours dropped out of every query. See time.test.ts.
 *
 * Configure with VITE_SHOP_TZ; defaults to Pacific.
 */

const DEFAULT_SHOP_TZ = 'America/Los_Angeles'

/**
 * Deliberately *not* the browser's timezone. The shop's workday is fixed to
 * one place; a phone that travels, or a laptop with a wrong clock, must not
 * silently shift which day someone's hours land on. Set VITE_SHOP_TZ to an
 * IANA name (e.g. "America/Chicago") if your shop isn't in Pacific.
 */
function resolveShopTz(): string {
  const configured = import.meta.env.VITE_SHOP_TZ?.trim()
  if (!configured) return DEFAULT_SHOP_TZ

  try {
    // Throws RangeError on an unknown zone. Better to find out here than
    // three calls deep in a date boundary.
    new Intl.DateTimeFormat('en-US', { timeZone: configured }).format()
    return configured
  } catch {
    throw new Error(
      `VITE_SHOP_TZ is set to "${configured}", which is not a valid IANA timezone.\n` +
        `Use a name like "America/Los_Angeles" or "America/New_York", ` +
        `not an abbreviation like "PST".`
    )
  }
}

export const SHOP_TZ = resolveShopTz()

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock reading in the shop's timezone at a given instant. */
export function shopWallClock(instant: Date = new Date()): WallClock {
  const parts = partsFormatter.formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(p => p.type === type)!.value)

  // Intl renders midnight as hour 24 in some engines under hour12: false.
  const hour = get('hour') % 24

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second')
  }
}

/** Offset of the shop timezone from UTC, in ms, at a given instant. */
function shopOffsetMs(instant: Date): number {
  const w = shopWallClock(instant)
  const asIfUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // Trim to whole seconds so the ms component doesn't leak into the offset.
  return asIfUTC - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The instant at which the given wall-clock time occurs in the shop timezone.
 *
 * Two passes: the first guess uses the offset at the naive UTC instant, which
 * can be wrong within a few hours of a DST transition. Re-reading the offset at
 * the corrected instant fixes it.
 */
export function shopTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second)
  let instant = naive - shopOffsetMs(new Date(naive))
  instant = naive - shopOffsetMs(new Date(instant))
  return new Date(instant)
}

/** Midnight Pacific at the start of the day containing `instant`. */
export function startOfShopDay(instant: Date = new Date()): Date {
  const w = shopWallClock(instant)
  return shopTimeToInstant(w.year, w.month, w.day, 0, 0, 0)
}

/** Midnight Pacific at the start of the *next* day. Use as an exclusive upper bound. */
export function startOfNextShopDay(instant: Date = new Date()): Date {
  const w = shopWallClock(instant)
  // Date.UTC normalises overflow, so day + 1 past month end is handled.
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1))
  return shopTimeToInstant(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0
  )
}

/**
 * Midnight Pacific on the Monday of the week containing `instant`.
 * Weeks run Monday-Sunday.
 */
export function startOfShopWeek(instant: Date = new Date()): Date {
  const w = shopWallClock(instant)
  // getUTCDay on a UTC-constructed date gives the weekday of those calendar
  // parts without any timezone shifting. 0 = Sunday.
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()
  const daysSinceMonday = (weekday + 6) % 7
  const monday = new Date(Date.UTC(w.year, w.month - 1, w.day - daysSinceMonday))
  return shopTimeToInstant(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    0,
    0,
    0
  )
}

/** `YYYY-MM-DD` for the shop's calendar date at `instant`. Safe for filenames. */
export function shopDateStamp(instant: Date = new Date()): string {
  const w = shopWallClock(instant)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

/** e.g. "Jul 20, 2026", rendered in the shop's timezone. */
export function formatShopDate(instant: Date): string {
  return instant.toLocaleDateString('en-US', {
    timeZone: SHOP_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export function formatHoursMinutes(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}
