import { ErpRejectedError, ErpSlotTakenError } from "./erp.mjs"
import {
  bookingReceipt,
  draftInterval,
  erpBookingRequest,
  normalizeMobile,
  normalizeName,
  overlapsBooking,
  startTimeOf,
} from "./booking.mjs"
import { log } from "./log.mjs"
import { toRanges, weekdayOf } from "./slots.mjs"

export function createBookingService({ erp, desk, consents, bookingSource, privacyPolicyUrl }) {
  async function prepare({ service_id, branch_id, date, time, guests, full_name, mobile, note }) {
    const name = normalizeName(full_name)
    const phone = normalizeMobile(mobile)
    if (!name || !phone) {
      return {
        status: "invalid_contact",
        invalid: [...(name ? [] : ["full_name"]), ...(phone ? [] : ["mobile"])],
      }
    }
    const [services, branches] = await Promise.all([erp.activeServices(), erp.activeBranches()])
    const service = services.find((candidate) => candidate.service_id === service_id)
    const branch = branches.find((candidate) => candidate.branch_id === branch_id)
    if (!service || !branch) {
      return { status: "invalid", reason: service ? "branch_id is not in list_branches" : "service_id is not in list_services" }
    }
    let slots
    try {
      slots = await erp.freeSlots({ serviceId: service_id, branchId: branch_id, date, guests })
    } catch (error) {
      if (error instanceof ErpRejectedError) {
        return { status: "invalid", reason: error.message }
      }
      throw error
    }
    const weekday = weekdayOf(date)
    const start_time = startTimeOf(date, time)
    const existing = await erp.bookingsByMobile(phone)
    const wanted = draftInterval({ start_time, duration_min: service.duration_min })
    const booked = existing.find((booking) => overlapsBooking(booking, wanted))
    if (booked) {
      return {
        status: "already_booked",
        booking: bookingReceipt(booked),
      }
    }
    if (!slots.some((slot) => slot.slice(11, 16) === time)) {
      return { status: "slot_taken", date, weekday, time, free_ranges: toRanges(slots) }
    }
    const draft = {
      service_id,
      service_name: service.name,
      duration_min: service.duration_min,
      branch_id,
      branch_name: branch.name,
      branch_address: branch.address,
      date,
      weekday,
      time,
      start_time,
      guests,
      note: note?.trim() || undefined,
      full_name: name,
      mobile: phone,
      consent_at: new Date().toISOString(),
      known_booking_codes: existing.map((booking) => booking.booking_code),
    }
    desk.hold(draft)
    return {
      status: "ready",
      summary: {
        service: service.name,
        duration_min: service.duration_min,
        branch: branch.name,
        address: branch.address,
        date,
        weekday,
        time,
        guests,
        note: draft.note,
        full_name: name,
        mobile: phone,
      },
    }
  }

  async function write(draft) {
    const request = erpBookingRequest(draft, { source: bookingSource })
    try {
      const booking = await erp.createBooking(request, draft.key)
      if (booking.status === "CANCELLED") {
        log("warn", "booking_returned_cancelled", { booking_code: booking.booking_code })
        return { status: "rejected", reason: "The salon system returned a cancelled booking; nothing new was booked." }
      }
      return { status: "ok", booking: bookingReceipt(booking, draft) }
    } catch (error) {
      if (error instanceof ErpSlotTakenError) {
        return { status: "slot_taken", reason: error.message }
      }
      if (error instanceof ErpRejectedError) {
        return { status: "rejected", reason: error.message }
      }
      const existing = await erp.bookingsByMobile(draft.mobile).catch(() => [])
      const wanted = draftInterval(draft)
      const match = existing.find((booking) => overlapsBooking(booking, wanted) && !draft.known_booking_codes.includes(booking.booking_code))
      if (match) {
        log("info", "booking_reconciled", { booking_code: match.booking_code })
        return { status: "ok", booking: bookingReceipt(match, draft) }
      }
      log("warn", "booking_unconfirmed", { error: error.message })
      return { status: "erp_unavailable" }
    }
  }

  async function recordConsent(draft, booking_code) {
    try {
      await consents.record({
        booking_code,
        full_name: draft.full_name,
        mobile: draft.mobile,
        consent_at: draft.consent_at,
        channel: bookingSource,
        purpose: "make and manage this booking",
        policy_url: privacyPolicyUrl,
      })
    } catch (error) {
      log("error", "consent_record_failed", { booking_code, error: error.message })
    }
  }

  async function create({ mobile }) {
    const phone = normalizeMobile(mobile)
    const draft = phone && desk.draftOf(phone)
    if (!draft) {
      return {
        status: "expired",
        reason: "no summary is held for this mobile; prepare_booking holds a new one",
      }
    }
    return desk.once(draft, async () => {
      const written = await write(draft)
      if (written.status === "ok") {
        await recordConsent(draft, written.booking.booking_code)
      }
      return written
    })
  }

  return { prepare, create }
}
