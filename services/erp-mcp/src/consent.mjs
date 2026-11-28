import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export function createConsentLedger(path) {
  const ready = mkdir(dirname(path), { recursive: true })
  return {
    async record(entry) {
      await ready
      await appendFile(path, `${JSON.stringify({ recorded_at: new Date().toISOString(), ...entry })}\n`)
    },
  }
}
