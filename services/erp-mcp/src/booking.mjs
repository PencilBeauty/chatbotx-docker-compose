import { createHash } from "node:crypto"

const MOBILE_PATTERN = /^0\d{9,10}$/

export function normalizeMobile(raw) {
  const digits = String(raw).replace(/[\s.\-()]/g, "")
  const local = digits.replace(/^\+?84(?=\d{9}$)/, "0")
  return MOBILE_PATTERN.test(local) ? local : undefined
}

export function normalizeName(raw) {
  const name = String(raw).trim().replace(/\s+/g, " ")
  return name.length >= 2 && name.length <= 100 ? name : undefined
}

export function startTimeOf(date, time) {
  return `${date}T${time}:00`
}

export function bookingKey({ branch_id, service_id, start_time, guests, mobile }) {
  const fingerprint = [branch_id, service_id, start_time, guests, mobile].join("|")
  return createHash("sha256").update(fingerprint).digest("hex")
}

export function erpBookingRequest(draft, { source, consentAt }) {
  return {
    branch_id: draft.branch_id,
    full_name: draft.full_name,
    mobile: draft.mobile,
    start_time: draft.start_time,
    guest_count: draft.guests,
    source,
    note: `Booked via Messenger chat. Personal data consent given at ${consentAt}.`,
    items: Array.from({ length: draft.guests }, (_, index) => ({ service_id: draft.service_id, guest_no: index + 1 })),
  }
}

export function sameBooking(existing, draft) {
  const items = existing.booking_items ?? []
  return (
    existing.status !== "CANCELLED" &&
    existing.start_time?.slice(0, 16) === draft.start_time.slice(0, 16) &&
    existing.branch?.branch_name === draft.branch_name &&
    items.some((item) => item.service_id === draft.service_id)
  )
}

export function bookingReceipt(booking, draft) {
  return {
    booking_code: booking.booking_code,
    booking_status: booking.status,
    service: draft.service_name,
    branch: booking.branch?.branch_name ?? draft.branch_name,
    branch_address: booking.branch?.branch_address ?? draft.branch_address,
    date: draft.date,
    weekday: draft.weekday,
    time: draft.time,
    guests: draft.guests,
    full_name: booking.customer?.full_name ?? draft.full_name,
    mobile: booking.customer?.mobile ?? draft.mobile,
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
      const key = bookingKey(draft)
      const code = key.slice(0, 8).toUpperCase()
      pending.set(code, { draft: { ...draft, key }, expiresAt: now() + pendingTtlMs })
      return code
    },

    draftOf(code) {
      sweep()
      return pending.get(String(code).trim().toUpperCase())?.draft
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
