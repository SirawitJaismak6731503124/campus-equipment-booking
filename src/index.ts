import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

type Bindings = { DB: D1Database }

// ---- Error handling -------------------------------------------------------
// Thrown on purpose for client mistakes; anything else becomes a generic 500.
class HttpError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

const app = new Hono<{ Bindings: Bindings }>().basePath('/api')

app.use('*', bodyLimit({
  maxSize: 10 * 1024, // 10 KB is plenty; stops oversized payload abuse
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
}))

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
  console.error(err) // full detail stays in server log only
  return c.json({ error: 'Internal server error' }, 500) // no stack trace to client
})

app.notFound((c) => c.json({ error: 'Route not found' }, 404))

// ---- Validation helpers ---------------------------------------------------
type BookingInput = {
  equipmentId: string
  borrowerName: string
  startAt: string
  endAt: string
  purpose: string
}

// Strict ISO-8601 UTC, e.g. 2026-10-20T09:00:00.000Z (milliseconds optional)
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function parseTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    throw new HttpError(400, `${field} must be an ISO 8601 UTC string, e.g. 2026-10-20T09:00:00.000Z`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid date`)
  // Normalise so every stored value has the same fixed-width format.
  // Same width + same format => string comparison equals time comparison in SQL.
  return d.toISOString()
}

function parseString(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`)
  const v = value.trim()
  if (required && v.length === 0) throw new HttpError(400, `${field} must not be empty`)
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`)
  return v
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

// Validates a COMPLETE booking (used by POST directly and by PATCH after merging)
function validateBooking(raw: Record<string, unknown>): BookingInput {
  const equipmentId = parseString(raw.equipmentId, 'equipmentId', 64, true)
  const borrowerName = parseString(raw.borrowerName, 'borrowerName', 100, true)
  const purpose = parseString(raw.purpose, 'purpose', 200, false)
  const startAt = parseTime(raw.startAt, 'startAt')
  const endAt = parseTime(raw.endAt, 'endAt')
  if (startAt >= endAt) throw new HttpError(400, 'startAt must be before endAt')
  return { equipmentId, borrowerName, startAt, endAt, purpose }
}

// ---- DB helpers (every query uses prepare().bind(); no string concatenation) --
type BookingRow = {
  id: string; equipment_id: string; borrower_name: string
  start_at: string; end_at: string; purpose: string; created_at: string
}

const toBooking = (r: BookingRow) => ({
  id: r.id,
  equipmentId: r.equipment_id,
  borrowerName: r.borrower_name,
  startAt: r.start_at,
  endAt: r.end_at,
  purpose: r.purpose,
  createdAt: r.created_at,
})

const findBooking = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>()

async function assertEquipmentExists(db: D1Database, equipmentId: string) {
  const row = await db.prepare('SELECT id FROM equipment WHERE id = ?').bind(equipmentId).first()
  // Bad reference inside the BODY => 400 (404 is reserved for the URL resource)
  if (!row) throw new HttpError(400, `equipmentId "${equipmentId}" does not exist`)
}

const CONFLICT_MSG = 'This equipment is already booked for an overlapping time'

// ---- Routes ---------------------------------------------------------------
app.get('/equipment', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT id, name, location FROM equipment ORDER BY id')
    .all()
  return c.json(results, 200)
})

app.get('/bookings', async (c) => {
  const equipmentId = c.req.query('equipmentId') // optional filter
  const stmt = equipmentId
    ? c.env.DB.prepare('SELECT * FROM bookings WHERE equipment_id = ? ORDER BY start_at').bind(equipmentId)
    : c.env.DB.prepare('SELECT * FROM bookings ORDER BY start_at')
  const { results } = await stmt.all<BookingRow>()
  return c.json(results.map(toBooking), 200)
})

app.get('/bookings/:id', async (c) => {
  const row = await findBooking(c.env.DB, c.req.param('id'))
  if (!row) throw new HttpError(404, 'Booking not found')
  return c.json(toBooking(row), 200)
})

app.post('/bookings', async (c) => {
  const input = validateBooking(await readJsonObject(c))
  await assertEquipmentExists(c.env.DB, input.equipmentId)

  const id = crypto.randomUUID()
  // Check-and-insert in ONE statement: INSERT only happens if no overlap exists.
  // Overlap rule (half-open intervals): existing.start < new.end AND existing.end > new.start
  // Doing it atomically avoids a race between a separate SELECT and INSERT.
  const result = await c.env.DB.prepare(
    `INSERT INTO bookings (id, equipment_id, borrower_name, start_at, end_at, purpose)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings WHERE equipment_id = ? AND start_at < ? AND end_at > ?
     )`
  ).bind(
    id, input.equipmentId, input.borrowerName, input.startAt, input.endAt, input.purpose,
    input.equipmentId, input.endAt, input.startAt,
  ).run()

  if (result.meta.changes === 0) throw new HttpError(409, CONFLICT_MSG)

  const row = await findBooking(c.env.DB, id)
  return c.json(toBooking(row!), 201)
})

app.patch('/bookings/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await findBooking(c.env.DB, id)
  if (!existing) throw new HttpError(404, 'Booking not found')

  const patch = await readJsonObject(c)
  const allowed = ['equipmentId', 'borrowerName', 'startAt', 'endAt', 'purpose']
  if (!allowed.some((k) => k in patch)) {
    throw new HttpError(400, `Provide at least one of: ${allowed.join(', ')}`)
  }

  // Merge old + new, then validate the WHOLE result. This stops someone from
  // changing only startAt/endAt to bypass the start<end or overlap checks.
  const input = validateBooking({
    equipmentId: existing.equipment_id,
    borrowerName: existing.borrower_name,
    startAt: existing.start_at,
    endAt: existing.end_at,
    purpose: existing.purpose,
    ...Object.fromEntries(allowed.filter((k) => k in patch).map((k) => [k, patch[k]])),
  })
  await assertEquipmentExists(c.env.DB, input.equipmentId)

  // Same atomic pattern; `id != ?` stops the booking from conflicting with itself.
  const result = await c.env.DB.prepare(
    `UPDATE bookings
        SET equipment_id = ?, borrower_name = ?, start_at = ?, end_at = ?, purpose = ?
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM bookings
           WHERE equipment_id = ? AND id != ? AND start_at < ? AND end_at > ?
        )`
  ).bind(
    input.equipmentId, input.borrowerName, input.startAt, input.endAt, input.purpose, id,
    input.equipmentId, id, input.endAt, input.startAt,
  ).run()

  if (result.meta.changes === 0) throw new HttpError(409, CONFLICT_MSG)

  const row = await findBooking(c.env.DB, id)
  return c.json(toBooking(row!), 200)
})

app.delete('/bookings/:id', async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) throw new HttpError(404, 'Booking not found')
  return c.body(null, 204)
})

export default app
