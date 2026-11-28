export class ErpUnavailableError extends Error {}

export class ErpRejectedError extends Error {}

export class ErpSlotTakenError extends Error {}

const RETRYABLE_STATUS = new Set([502, 503, 504])

const REJECTED_STATUS = new Set([400, 404, 409])

async function errorDetail(response) {
  const body = await response.json().catch(() => ({}))
  return body.message ?? body.error ?? `status ${response.status}`
}

export function createErpClient({ erpBaseUrl, erpTenantId, erpTimeoutMs, erpWriteTimeoutMs, catalogCacheMs }) {
  const baseUrl = erpBaseUrl.replace(/\/+$/, "")
  const cache = new Map()

  async function send(path, { method = "GET", body, headers = {}, timeoutMs = erpTimeoutMs } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-Tenant-ID": erpTenantId,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      return await response.json()
    }
    if (REJECTED_STATUS.has(response.status)) {
      throw new ErpRejectedError(`ERP rejected the request (${response.status}): ${await errorDetail(response)}`)
    }
    if (response.status === 422) {
      throw new ErpSlotTakenError(`ERP refused the time (${response.status}): ${await errorDetail(response)}`)
    }
    const error = new ErpUnavailableError(`ERP status ${response.status}`)
    error.retryable = RETRYABLE_STATUS.has(response.status)
    throw error
  }

  async function request(path) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await send(path)
      } catch (error) {
        if (error instanceof ErpRejectedError || error instanceof ErpSlotTakenError) {
          throw error
        }
        lastError = error instanceof ErpUnavailableError ? error : new ErpUnavailableError(error.message)
        if (lastError.retryable === false) {
          break
        }
      }
    }
    throw lastError
  }

  async function cached(key, load) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value
    }
    const value = await load()
    cache.set(key, { value, expiresAt: Date.now() + catalogCacheMs })
    return value
  }

  return {
    activeServices: () =>
      cached("services", async () => {
        const page = await request("/v1/public/services?size=100")
        return page.content
          .filter((service) => service.status === "ACTIVE")
          .map((service) => ({
            service_id: service.service_id,
            name: service.name,
            duration_min: service.duration_minutes,
            category: service.category ?? undefined,
          }))
      }),

    activeBranches: () =>
      cached("branches", async () => {
        const page = await request("/v1/public/branches")
        return page.content
          .filter((branch) => branch.status === "ACTIVE")
          .map((branch) => ({
            branch_id: branch.branch_id,
            name: branch.branch_name,
            address: branch.branch_address,
            open: branch.open_time?.slice(0, 5),
            close: branch.close_time?.slice(0, 5),
            phone: branch.phone ?? undefined,
          }))
      }),

    freeSlots: async ({ serviceId, branchId, date, guests }) => {
      const query = new URLSearchParams({
        branchId: String(branchId),
        serviceId: String(serviceId),
        date,
        guestCount: String(guests),
      })
      const body = await request(`/v1/public/bookings/availability/slots?${query}`)
      return body.slots ?? []
    },

    createBooking: async (booking, idempotencyKey) => {
      try {
        return await send("/v1/public/bookings", {
          method: "POST",
          body: booking,
          headers: { "X-Idempotency-Key": idempotencyKey },
          timeoutMs: erpWriteTimeoutMs,
        })
      } catch (error) {
        if (error instanceof ErpRejectedError || error instanceof ErpSlotTakenError || error instanceof ErpUnavailableError) {
          throw error
        }
        throw new ErpUnavailableError(error.message)
      }
    },

    bookingsByMobile: async (mobile) => {
      const page = await request(`/v1/public/bookings?${new URLSearchParams({ mobile, size: "20" })}`)
      return page.content ?? []
    },
  }
}
