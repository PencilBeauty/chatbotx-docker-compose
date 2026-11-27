export class ErpUnavailableError extends Error {}

export class ErpRejectedError extends Error {}

const RETRYABLE_STATUS = new Set([502, 503, 504])

export function createErpClient({ erpBaseUrl, erpTenantId, erpTimeoutMs, catalogCacheMs }) {
  const baseUrl = erpBaseUrl.replace(/\/+$/, "")
  const cache = new Map()

  async function request(path) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { "X-Tenant-ID": erpTenantId, Accept: "application/json" },
          signal: AbortSignal.timeout(erpTimeoutMs),
        })
        if (response.ok) {
          return await response.json()
        }
        if (response.status === 400 || response.status === 404) {
          throw new ErpRejectedError(`ERP rejected the request (${response.status})`)
        }
        lastError = new ErpUnavailableError(`ERP status ${response.status}`)
        if (!RETRYABLE_STATUS.has(response.status)) {
          break
        }
      } catch (error) {
        if (error instanceof ErpRejectedError) {
          throw error
        }
        lastError = new ErpUnavailableError(error.message)
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
  }
}
