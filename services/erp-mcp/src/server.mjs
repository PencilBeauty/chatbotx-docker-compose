import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { createConsentLedger } from "./consent.mjs"
import { createErpClient, ErpRejectedError, ErpUnavailableError } from "./erp.mjs"
import { toRanges, weekdayOf } from "./slots.mjs"
import { createBookingDesk } from "./booking.mjs"
import { createBookingService } from "./booking-service.mjs"
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

const booking = createBookingService({
  erp,
  desk: createBookingDesk(config),
  consents: createConsentLedger(config.consentLogPath),
  bookingSource: config.bookingSource,
  privacyPolicyUrl: config.privacyPolicyUrl,
})

const ERP_UNAVAILABLE = {
  status: "erp_unavailable",
  detail: "The salon system did not answer, so nothing is known about services, free times or bookings.",
}

const BOOKING_UNAVAILABLE = {
  status: "erp_unavailable",
  detail: "The salon system did not answer, so the booking is not confirmed. Calling create_booking again never creates a second booking.",
}

const PERSONAL_FIELDS = new Set(["full_name", "mobile"])

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env ${name}`)
  }
  return value
}

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: payload.status === "erp_unavailable" }
}

function redacted(args) {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [key, PERSONAL_FIELDS.has(key) ? "[redacted]" : value]),
  )
}

async function runTool(name, args, handler, unavailable = ERP_UNAVAILABLE) {
  const startedAt = Date.now()
  const logged = redacted(args)
  try {
    const payload = await handler(args)
    log("info", "tool_call", { tool: name, args: logged, status: payload.status, ms: Date.now() - startedAt })
    return result(payload.status === "erp_unavailable" ? unavailable : payload)
  } catch (error) {
    const status = error instanceof ErpUnavailableError ? "erp_unavailable" : "failed"
    log("warn", "tool_call", { tool: name, args: logged, status, ms: Date.now() - startedAt, error: error.message })
    return result(unavailable)
  }
}

function buildServer() {
  const server = new McpServer({ name: "pencil-erp", version: "1.3.1" })

  server.registerTool(
    "list_services",
    {
      description:
        "Bookable salon services with service_id and duration_min. No prices.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("list_services", args, async () => {
        const services = await erp.activeServices()
        return { status: "ok", services }
      }),
  )

  server.registerTool(
    "list_branches",
    {
      description:
        "Salon branches taking bookings, with branch_id, name, address, opening hours and phone. Guests often shorten branch names (street name only, missing accents).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("list_branches", args, async () => {
        const branches = await erp.activeBranches()
        return { status: "ok", branches }
      }),
  )

  server.registerTool(
    "check_free_slots",
    {
      description:
        "Free start times for one service at one branch on one date, as ranges of start times. status: ok = ranges has free start times; no_slots = nothing free that day; invalid = an id or the date was rejected, reason given.",
      inputSchema: {
        service_id: z.number().int().positive(),
        branch_id: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, salon local time"),
        guests: z.number().int().min(1).max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool("check_free_slots", args, async ({ service_id, branch_id, date, guests }) => {
        try {
          const slots = await erp.freeSlots({ serviceId: service_id, branchId: branch_id, date, guests })
          const ranges = toRanges(slots)
          return {
            status: ranges.length > 0 ? "ok" : "no_slots",
            service_id,
            branch_id,
            date,
            weekday: weekdayOf(date),
            guests,
            ranges,
          }
        } catch (error) {
          if (error instanceof ErpRejectedError) {
            return { status: "invalid", reason: error.message }
          }
          throw error
        }
      }),
  )

  server.registerTool(
    "prepare_booking",
    {
      description:
        "Step 1 of 2 to book. Re-checks that the start time is free and holds a booking summary for create_booking; it writes nothing to the salon system. Calling it again for the same mobile replaces the held summary. status: ready = summary held, details in summary; already_booked = this mobile already has an active booking at an overlapping time, details in booking; slot_taken = the time is not free, free_ranges has free start times; invalid_contact = the fields listed in invalid are not acceptable (only Vietnamese mobile numbers); invalid = an id or the date was rejected, reason given.",
      inputSchema: {
        service_id: z.number().int().positive(),
        branch_id: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, salon local time"),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("HH:MM start time"),
        guests: z.number().int().min(1).max(10),
        full_name: z.string().min(1).max(100),
        mobile: z.string().min(1).max(20),
        note: z
          .string()
          .max(300)
          .optional()
          .describe(
            "For salon staff: what the guest said in this chat that staff should know for this visit (nail condition, allergies, preferred staff or design, past problems), briefly, in the guest's language. Only what the guest said.",
          ),
        privacy_consent: z
          .literal(true)
          .describe(
            `true only if the guest agreed in this chat that the salon uses their name and phone number to make and manage bookings, after being given the privacy policy link ${config.privacyPolicyUrl}`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool("prepare_booking", args, booking.prepare),
  )

  server.registerTool(
    "create_booking",
    {
      description:
        "Step 2 of 2: creates in the salon system the booking held by the latest prepare_booking for this mobile. Repeat calls return the same booking and never create a second one. status: ok = booked, details in booking; slot_taken = the time was just taken, nothing booked; rejected = the salon system refused, nothing booked, reason given; expired = no summary held for this mobile (never prepared or older than 30 minutes).",
      inputSchema: {
        mobile: z.string().min(1).max(20),
        guest_confirmed: z.literal(true).describe("true only if the guest's latest message clearly agreed to the latest summary"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => runTool("create_booking", args, booking.create, BOOKING_UNAVAILABLE),
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
