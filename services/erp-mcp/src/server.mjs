import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { createErpClient, ErpUnavailableError, ErpRejectedError } from "./erp.mjs"
import { toRanges, weekdayOf } from "./slots.mjs"
import { log } from "./log.mjs"

const config = {
  port: Number(process.env.PORT ?? 8080),
  token: requiredEnv("MCP_TOKEN"),
  erpBaseUrl: requiredEnv("ERP_BASE_URL"),
  erpTenantId: requiredEnv("ERP_TENANT_ID"),
  erpTimeoutMs: Number(process.env.ERP_TIMEOUT_MS ?? 10000),
  catalogCacheMs: Number(process.env.CATALOG_CACHE_MS ?? 300000),
  maxBodyBytes: 64 * 1024,
}

const erp = createErpClient(config)

const ERP_UNAVAILABLE_TEXT =
  "erp_unavailable: the salon system could not be reached. Tell the guest you cannot check this right now and offer to connect them with staff. Never say there are no free slots."

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

function unavailable() {
  return { content: [{ type: "text", text: ERP_UNAVAILABLE_TEXT }], isError: true }
}

async function runTool(name, args, handler) {
  const startedAt = Date.now()
  try {
    const output = await handler(args)
    log("info", "tool_call", { tool: name, args, status: output.isError ? "error" : "ok", ms: Date.now() - startedAt })
    return output
  } catch (error) {
    const status = error instanceof ErpUnavailableError ? "erp_unavailable" : "failed"
    log("warn", "tool_call", { tool: name, args, status, ms: Date.now() - startedAt, error: error.message })
    return unavailable()
  }
}

function buildServer() {
  const server = new McpServer({ name: "pencil-erp", version: "1.0.0" })

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
