import { randomUUID } from "node:crypto"
import { parsePhoneNumberFromString } from "libphonenumber-js/max"
import { weekdayOf } from "./slots.mjs"

const ERP_PHONE_COUNTRY = "VN"

export function normalizeMobile(raw) {
  const phone = parsePhoneNumberFromString(String(raw), ERP_PHONE_COUNTRY)
  const bookable = phone?.isValid() && phone.country === ERP_PHONE_COUNTRY && phone.getType() === "MOBILE"
  return bookable ? `0${phone.nationalNumber}` : undefined
}

export function normalizeName(raw) {
  const name = String(raw).trim().replace(/\s+/g, " ")
  return name.length >= 2 && name.length <= 100 ? name : undefined
}

export function startTimeOf(date, time) {
  return `${date}T${time}:00`
}

export function erpBookingRequest(draft, { source }) {
  return {
    branch_id: draft.branch_id,
    full_name: draft.full_name,
    mobile: draft.mobile,
    start_time: draft.start_time,
    guest_count: draft.guests,
    source,
    note: draft.note,
    items: Array.from({ length: draft.guests }, (_, index) => ({ service_id: draft.service_id, guest_no: index + 1 })),
  }
}

const MINUTE_MS = 60_000

function interval(start, end) {
  return { start: Date.parse(start), end: Date.parse(end) }
}

export function draftInterval({ start_time, duration_min }) {
  const start = Date.parse(start_time)
  return { start, end: start + duration_min * MINUTE_MS }
}

export function overlapsBooking(existing, wanted) {
  if (existing.status === "CANCELLED" || !existing.start_time || !existing.end_time) {
    return false
  }
  const booked = interval(existing.start_time, existing.end_time)
  return booked.start < wanted.end && wanted.start < booked.end
}

export function bookingReceipt(booking, { note } = {}) {
  const date = booking.start_time.slice(0, 10)
  const services = [...new Set((booking.booking_items ?? []).map((item) => item.service_name))]
  return {
    booking_code: booking.booking_code,
    booking_status: booking.status,
    service: services.join(", "),
    branch: booking.branch?.branch_name,
    branch_address: booking.branch?.branch_address,
    date,
    weekday: weekdayOf(date),
    time: booking.start_time.slice(11, 16),
    guests: booking.guest_count,
    note,
    full_name: booking.customer?.full_name,
    mobile: booking.customer?.mobile,
  }
}

export function createBookingDesk({ pendingTtlMs, resultTtlMs, now = Date.now }) {
  const pending = new Map()
  const results = new Map()
  const inflight = new Map()

  function sweep() {
    const time = now()
    for (const [code, entry] of pending) {
      if (entry.expiresAt <= time) {
        pending.delete(code)
      }
    }
    for (const [key, entry] of results) {
      if (entry.expiresAt <= time) {
        results.delete(key)
      }
    }
  }

  return {
    hold(draft) {
      sweep()
      pending.set(draft.mobile, { draft: { ...draft, key: randomUUID() }, expiresAt: now() + pendingTtlMs })
    },

    draftOf(mobile) {
      sweep()
      return pending.get(mobile)?.draft
    },

    async once(draft, create) {
      sweep()
      const done = results.get(draft.key)
      if (done) {
        return { ...done.value, repeated: true }
      }
      const running = inflight.get(draft.key)
      if (running) {
        return { ...(await running), repeated: true }
      }
      const task = create().then((value) => {
        if (value.status === "ok") {
          results.set(draft.key, { value, expiresAt: now() + resultTtlMs })
        }
        return value
      })
      inflight.set(draft.key, task)
      try {
        return await task
      } finally {
        inflight.delete(draft.key)
      }
    },
  }
}
