export function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), service: "erp-mcp", msg, ...fields })}\n`)
}
