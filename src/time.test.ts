import { describe, it, expect } from 'vitest'
import {
  SHOP_TZ,
  shopWallClock,
  shopTimeToInstant,
  startOfShopDay,
  startOfNextShopDay,
  startOfShopWeek,
  shopDateStamp,
  formatTime,
  formatHoursMinutes
} from './time'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Independent reimplementation via Intl, so tests don't trust the same code twice. */
function ptParts(d: Date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(d)
  const v = (t: string) => f.find(p => p.type === t)!.value
  return {
    weekday: v('weekday'),
    date: `${v('year')}-${v('month')}-${v('day')}`,
    hour: Number(v('hour')) % 24,
    minute: Number(v('minute')),
    second: Number(v('second'))
  }
}

/** What the old code did. Kept so the regression can't quietly come back. */
function legacyTodayFilter(now: Date) {
  return now.toISOString().slice(0, 10)
}

describe('shop timezone configuration', () => {
  it('defaults to Pacific when VITE_SHOP_TZ is unset', () => {
    expect(SHOP_TZ).toBe('America/Los_Angeles')
  })

  it('is a zone Intl actually recognises', () => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ })).not.toThrow()
  })
})

describe('the bug that lost a day of hours every evening', () => {
  it('does not roll over to tomorrow at 5pm Pacific', () => {
    // Fri 24 Jul 2026, 6:00pm in Richmond CA.
    const evening = new Date('2026-07-24T18:00:00-07:00')

    expect(legacyTodayFilter(evening)).toBe('2026-07-25') // the old bug
    expect(shopDateStamp(evening)).toBe('2026-07-24') // the fix
  })

  it('keeps Monday inside the week when checked on Monday evening', () => {
    const mondayEvening = new Date('2026-07-20T18:00:00-07:00')
    const weekStart = startOfShopWeek(mondayEvening)

    expect(ptParts(weekStart).weekday).toBe('Mon')
    expect(shopDateStamp(weekStart)).toBe('2026-07-20')
    expect(weekStart.getTime()).toBeLessThanOrEqual(mondayEvening.getTime())
  })

  it('still counts an entry started at 11:30pm Pacific as today', () => {
    const lateNight = new Date('2026-07-24T23:30:00-07:00')
    const dayStart = startOfShopDay(lateNight)
    const nextDay = startOfNextShopDay(lateNight)

    expect(lateNight.getTime()).toBeGreaterThanOrEqual(dayStart.getTime())
    expect(lateNight.getTime()).toBeLessThan(nextDay.getTime())
  })
})

describe('startOfShopDay / startOfNextShopDay', () => {
  it('brackets every hour of a full week', () => {
    const start = new Date('2026-07-20T00:00:00-07:00')

    for (let h = 0; h < 24 * 7; h++) {
      const now = new Date(start.getTime() + h * HOUR)
      const dayStart = startOfShopDay(now)
      const nextDay = startOfNextShopDay(now)
      const label = `${now.toISOString()} (${ptParts(now).weekday} ${ptParts(now).hour}:00 PT)`

      // The bracket must actually contain the moment being asked about.
      expect(dayStart.getTime(), label).toBeLessThanOrEqual(now.getTime())
      expect(nextDay.getTime(), label).toBeGreaterThan(now.getTime())

      // Both boundaries land on Pacific midnight.
      expect(ptParts(dayStart), label).toMatchObject({ hour: 0, minute: 0, second: 0 })
      expect(ptParts(nextDay), label).toMatchObject({ hour: 0, minute: 0, second: 0 })

      // And the bracket is the calendar day the shop is actually living in.
      expect(ptParts(dayStart).date, label).toBe(ptParts(now).date)
    }
  })

  it('handles the 23-hour spring-forward day', () => {
    const duringDst = new Date('2026-03-08T12:00:00-07:00')
    const span = startOfNextShopDay(duringDst).getTime() - startOfShopDay(duringDst).getTime()
    expect(span).toBe(23 * HOUR)
  })

  it('handles the 25-hour fall-back day', () => {
    const duringDst = new Date('2026-11-01T12:00:00-08:00')
    const span = startOfNextShopDay(duringDst).getTime() - startOfShopDay(duringDst).getTime()
    expect(span).toBe(25 * HOUR)
  })

  it('rolls month and year boundaries', () => {
    expect(shopDateStamp(startOfNextShopDay(new Date('2026-01-31T20:00:00-08:00')))).toBe('2026-02-01')
    expect(shopDateStamp(startOfNextShopDay(new Date('2026-12-31T20:00:00-08:00')))).toBe('2027-01-01')
  })
})

describe('startOfShopWeek', () => {
  it('is always the preceding Pacific Monday at midnight', () => {
    const start = new Date('2026-02-25T00:00:00-08:00')

    for (let h = 0; h < 24 * 30; h++) {
      const now = new Date(start.getTime() + h * HOUR)
      const weekStart = startOfShopWeek(now)
      const label = `${now.toISOString()} (${ptParts(now).weekday} PT)`

      expect(ptParts(weekStart).weekday, label).toBe('Mon')
      expect(ptParts(weekStart), label).toMatchObject({ hour: 0, minute: 0, second: 0 })
      expect(weekStart.getTime(), label).toBeLessThanOrEqual(now.getTime())
      // Never more than a week back, allowing an hour of DST slack.
      expect(now.getTime() - weekStart.getTime(), label).toBeLessThan(7 * DAY + HOUR)
    }
  })

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = new Date('2026-07-26T10:00:00-07:00')
    expect(shopDateStamp(startOfShopWeek(sunday))).toBe('2026-07-20')
  })

  it('does not mutate the date it is given', () => {
    const now = new Date('2026-07-24T18:00:00-07:00')
    const before = now.getTime()
    startOfShopWeek(now)
    startOfShopDay(now)
    expect(now.getTime()).toBe(before)
  })
})

describe('shopTimeToInstant', () => {
  it('round-trips a wall-clock reading', () => {
    for (const iso of ['2026-01-15T09:30:00-08:00', '2026-07-15T09:30:00-07:00']) {
      const original = new Date(iso)
      const w = shopWallClock(original)
      const rebuilt = shopTimeToInstant(w.year, w.month, w.day, w.hour, w.minute, w.second)
      expect(rebuilt.toISOString()).toBe(original.toISOString())
    }
  })

  it('resolves the nonexistent 2am hour on spring-forward day', () => {
    // 2:30am never happens on 8 Mar 2026; it must not throw or land in the past.
    const resolved = shopTimeToInstant(2026, 3, 8, 2, 30)
    expect(Number.isNaN(resolved.getTime())).toBe(false)
    expect(resolved.getTime()).toBeGreaterThan(new Date('2026-03-08T00:00:00-08:00').getTime())
  })
})

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatTime(0)).toBe('00:00:00')
    expect(formatTime(59)).toBe('00:00:59')
    expect(formatTime(3661)).toBe('01:01:01')
    expect(formatTime(36000)).toBe('10:00:00')
    expect(formatTime(360000)).toBe('100:00:00') // a long week should not wrap
  })

  it('never renders a negative duration from clock skew', () => {
    expect(formatTime(-5)).toBe('00:00:00')
    expect(formatHoursMinutes(-5)).toBe('0m')
  })

  it('formats hours and minutes for the shared summary', () => {
    expect(formatHoursMinutes(0)).toBe('0m')
    expect(formatHoursMinutes(90)).toBe('1m')
    expect(formatHoursMinutes(3600)).toBe('1h')
    expect(formatHoursMinutes(3660)).toBe('1h 1m')
  })
})
