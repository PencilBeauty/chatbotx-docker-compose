import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { createConsentLedger } from "./consent.mjs"
import { createErpClient, ErpUnavailableError, ErpRejectedError, ErpSlotTakenError } from "./erp.mjs"
import { toRanges, weekdayOf } from "./slots.mjs"
import {
  bookingReceipt,
  createBookingDesk,
  erpBookingRequest,
  normalizeMobile,
  normalizeName,
  draftInterval,
  overlapsBooking,
  startTimeOf,
} from "./booking.mjs"
import { log } from "./log.mjs"

const config = {
  port: Number(process.env.PORT ?? 8080),
  token: requiredEnv("MCP_TOKEN"),
  erpBaseUrl: requiredEnv("ERP_BASE_URL"),
  erpTenantId: requiredEnv("ERP_TENANT_ID"),
  erpTimeoutMs: Number(process.env.ERP_TIMEOUT_MS ?? 10000),
  erpWriteTimeoutMs: Number(process.env.ERP_WRITE_TIMEOUT_MS ?? 20000),
  bookingSource: process.env.ERP_BOOKING_SOURCE ?? "messenger",
  privacyPolicyUrl: requiredEnv("PRIVACY_POLICY_URL"),
  consentLogPath: process.env.CONSENT_LOG_PATH ?? "/data/consents.jsonl",
  pendingTtlMs: Number(process.env.BOOKING_PENDING_TTL_MS ?? 1800000),
  resultTtlMs: Number(process.env.BOOKING_RESULT_TTL_MS ?? 86400000),
  catalogCacheMs: Number(process.env.CATALOG_CACHE_MS ?? 300000),
  maxBodyBytes: 64 * 1024,
}

const erp = createErpClient(config)

const desk = createBookingDesk(config)
const consents = createConsentLedger(config.consentLogPath)

const ERP_UNAVAILABLE_TEXT =
  "erp_unavailable: the salon system could not be reached. Tell the guest you cannot check this right now and offer to connect them with staff. Never say there are no free slots."

const BOOKING_UNAVAILABLE_TEXT =
  "erp_unavailable: the booking is NOT confirmed. The salon system did not answer, so do not say the booking is made. Tell the guest you could not confirm it right now; offer to try again in a moment (calling create_booking again never creates a duplicate) or to connect them with staff."

const PERSONAL_FIELDS = new Set(["full_name", "mobile"])

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env ${name}`)
  }
  return value
}

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

function unavailable(text = ERP_UNAVAILABLE_TEXT) {
  return { content: [{ type: "text", text }], isError: true }
}

function redacted(args) {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [key, PERSONAL_FIELDS.has(key) ? "[redacted]" : value]),
  )
}

async function runTool(name, args, handler, fallbackText) {
  const startedAt = Date.now()
  const logged = redacted(args)
  try {
    const output = await handler(args)
    const status = output.isError ? "error" : JSON.parse(output.content[0].text).status
    log("info", "tool_call", { tool: name, args: logged, status, ms: Date.now() - startedAt })
    return output
  } catch (error) {
    const status = error instanceof ErpUnavailableError ? "erp_unavailable" : "failed"
    log("warn", "tool_call", { tool: name, args: logged, status, ms: Date.now() - startedAt, error: error.message })
    return unavailable(fallbackText)
  }
}

async function prepareBooking({ service_id, branch_id, date, time, guests, full_name, mobile, note }) {
  const name = normalizeName(full_name)
  const phone = normalizeMobile(mobile)
  if (!name || !phone) {
    return result({
      status: "invalid_contact",
      invalid: [...(name ? [] : ["full_name"]), ...(phone ? [] : ["mobile"])],
      hint: "Ask the guest again for the invalid value. Only Vietnamese mobile numbers can be booked.",
    })
  }
  const [services, branches] = await Promise.all([erp.activeServices(), erp.activeBranches()])
  const service = services.find((candidate) => candidate.service_id === service_id)
  const branch = branches.find((candidate) => candidate.branch_id === branch_id)
  if (!service || !branch) {
    return result({ status: "invalid", reason: `${service ? "branch_id" : "service_id"} is not bookable; re-check with list_services / list_branches` })
  }
  let slots
  try {
    slots = await erp.freeSlots({ serviceId: service_id, branchId: branch_id, date, guests })
  } catch (error) {
    if (error instanceof ErpRejectedError) {
      return result({ status: "invalid", reason: error.message })
    }
    throw error
  }
  const weekday = weekdayOf(date)
  const start_time = startTimeOf(date, time)
  const existing = await erp.bookingsByMobile(phone)
  const wanted = draftInterval({ start_time, duration_min: service.duration_min })
  const booked = existing.find((booking) => overlapsBooking(booking, wanted))
  if (booked) {
    return result({
      status: "already_booked",
      booking: bookingReceipt(booked),
    })
  }
  if (!slots.some((slot) => slot.slice(11, 16) === time)) {
    return result({ status: "slot_taken", date, weekday, time, free_ranges: toRanges(slots) })
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
  return result({
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
  })
}

async function writeBooking(draft) {
  const request = erpBookingRequest(draft, { source: config.bookingSource })
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
      channel: config.bookingSource,
      purpose: "make and manage this booking",
      policy_url: config.privacyPolicyUrl,
    })
  } catch (error) {
    log("error", "consent_record_failed", { booking_code, error: error.message })
  }
}

async function createBooking({ mobile }) {
  const phone = normalizeMobile(mobile)
  const draft = phone && desk.draftOf(phone)
  if (!draft) {
    return result({
      status: "expired",
      hint: "No prepared booking for this phone number. Call prepare_booking again with the details, show the summary and get a fresh confirmation.",
    })
  }
  const outcome = await desk.once(draft, async () => {
    const written = await writeBooking(draft)
    if (written.status === "ok") {
      await recordConsent(draft, written.booking.booking_code)
    }
    return written
  })
  if (outcome.status === "erp_unavailable") {
    return unavailable(BOOKING_UNAVAILABLE_TEXT)
  }
  return result(outcome)
}

function buildServer() {
  const server = new McpServer({ name: "pencil-erp", version: "1.2.0" })

  server.registerTool(
    "list_services",
    {
      description:
        "Bookable salon services with service_id and duration in minutes. Call when the guest asks what services exist or how long one takes, and to find the service_id before check_free_slots. No prices here.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("list_services", args, async () => {
        const services = await erp.activeServices()
        return result({ status: "ok", services })
      }),
  )

  server.registerTool(
    "list_branches",
    {
      description:
        "Salon branches taking bookings, with branch_id (internal, never show it to the guest), address and opening hours. Call when the guest asks about branches, addresses, opening hours or the nearest branch, and to find the branch_id before check_free_slots. Guests often shorten branch names (street initials, missing accents).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("list_branches", args, async () => {
        const branches = await erp.activeBranches()
        return result({ status: "ok", branches })
      }),
  )

  server.registerTool(
    "check_free_slots",
    {
      description:
        "Free start times for one service at one branch on one date. Needs service_id (list_services), branch_id (list_branches), date as YYYY-MM-DD in salon local time, and the number of guests. Ask the guest only for what is missing; call again whenever any value changes. When replying, always state the date with its weekday (e.g. Sunday 29/11) so the guest can correct it, and never show service_id or branch_id. status: ok = offer the ranges (they are start times) and ask which suits the guest; no_slots = nothing free, suggest another day or branch; invalid = an id or the date was rejected, re-check them.",
      inputSchema: {
        service_id: z.number().int().positive(),
        branch_id: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        guests: z.number().int().min(1).max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("check_free_slots", args, async ({ service_id, branch_id, date, guests }) => {
        try {
          const slots = await erp.freeSlots({ serviceId: service_id, branchId: branch_id, date, guests })
          const ranges = toRanges(slots)
          return result({
            status: ranges.length > 0 ? "ok" : "no_slots",
            service_id,
            branch_id,
            date,
            weekday: weekdayOf(date),
            guests,
            ranges,
          })
        } catch (error) {
          if (error instanceof ErpRejectedError) {
            return result({ status: "invalid", reason: error.message })
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "prepare_booking",
    {
      description: `Step 1 of 2 to book. Checks the chosen start time is still free and returns a summary; it writes nothing. It checks free times itself, so check_free_slots is not needed first. Needs service_id, branch_id, date (YYYY-MM-DD, salon local time), time (HH:MM, one of the free start times), guests, and the guest's full name and mobile number. Optional note for the salon staff: a short summary, in the guest's language, of what the guest said anywhere in this chat that staff should know for this visit (nail condition, allergies, preferred staff or design, preferences, problems with a past visit); only what the guest actually said, never guesses. If the chat has nothing like that, ask once whether they want to add a note when you ask for name and phone; leave it empty if they say no. Ask only for what is missing. Before calling, ask the guest to agree that the salon uses their name and phone number to make and manage this booking, sharing the privacy policy link ${config.privacyPolicyUrl}; set privacy_consent to true only if the guest agreed in this chat, otherwise do not call and do not book. status: already_booked = this phone number already has a booking at an overlapping time, tell the guest its booking_code and details and do not book again; offer another time if they want a second booking; ready = send the guest every summary field (service, branch and address, weekday and date, time, number of guests, name, phone, and the note if any) and ask them to confirm; slot_taken = that time is no longer free, offer free_ranges; invalid_contact = ask again for the listed fields; invalid = re-check the ids. Call again whenever a detail changes; the latest summary is the one create_booking books. Never show ids.`,
      inputSchema: {
        service_id: z.number().int().positive(),
        branch_id: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        guests: z.number().int().min(1).max(10),
        full_name: z.string().min(1).max(100),
        mobile: z.string().min(1).max(20),
        note: z.string().max(300).optional(),
        privacy_consent: z.literal(true),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool("prepare_booking", args, prepareBooking),
  )

  server.registerTool(
    "create_booking",
    {
      description:
        "Step 2 of 2: creates the booking in the salon system. Call only after you sent the prepare_booking summary and the guest's latest message clearly says yes to it. If the guest declines or wants changes, do not call; ask what to change or how else you can help. Pass the guest's mobile number; it books the latest prepare_booking summary for that number, so do not look anything up again first. Calling it again never creates a second booking. status: ok = the booking exists; tell the guest the booking_code, service, branch, weekday, date and time, and that it is booked; slot_taken = the time was just taken, nothing was booked, offer to check other times; rejected = nothing was booked, explain briefly and offer staff; expired = run prepare_booking again and re-confirm. Say the booking is made only when status is ok.",
      inputSchema: {
        mobile: z.string().min(1).max(20),
        guest_confirmed: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => runTool("create_booking", args, createBooking, BOOKING_UNAVAILABLE_TEXT),
  )

  return server
}

function isAuthorized(header) {
  const expected = Buffer.from(`Bearer ${config.token}`)
  const actual = Buffer.from(header ?? "")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > config.maxBodyBytes) {
        reject(new Error("body_too_large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("invalid_json"))
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null })
    return
  }
  if (!isAuthorized(req.headers.authorization)) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: error.message }, id: null })
    return
  }
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on("close", () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname
  if (path === "/healthz") {
    sendJson(res, 200, { status: "ok" })
    return
  }
  if (path !== "/mcp") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  handleMcp(req, res).catch((error) => {
    log("error", "mcp_request_failed", { error: error.message })
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })
    }
  })
}).listen(config.port, () => log("info", "listening", { port: config.port }))
