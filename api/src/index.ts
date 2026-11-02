import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

const MAX_NAME_LENGTH = 100
const MAX_TITLE_LENGTH = 200
const MAX_KEY_LENGTH = 255

type App = { Bindings: Env }

class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message)
  }
}

type Member = { id: string; homeId: string; name: string }
type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }

const app = new Hono<App>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Every error is JSON: { "error": "message" }. Unknown errors never leak details.
app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
  console.error(error)
  return c.json({ error: 'Internal server error' }, 500)
})
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// ---------- input helpers ----------

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(422, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requireText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(422, `${field} must be a non-empty string`)
  }
  const text = value.trim()
  if (text.length > maxLength) {
    throw new HttpError(422, `${field} must be at most ${maxLength} characters`)
  }
  return text
}

// Money is a positive whole number of cents. Strings, decimals, 0, negatives and NaN are rejected.
function requireCents(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(422, `${field} must be a positive whole number of cents`)
  }
  return value
}

async function requireHome(db: D1Database, homeId: string): Promise<{ id: string; name: string }> {
  const home = await db
    .prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string; name: string }>()
  if (!home) throw new HttpError(404, 'Home not found')
  return home
}

// ---------- homes and members ----------

app.post('/api/homes', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const name = requireText(body, 'name', MAX_NAME_LENGTH)
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.get('/api/homes', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY created_at DESC, rowid DESC LIMIT 100',
  ).all<{ id: string; name: string }>()
  return c.json({ homes: results })
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  await requireHome(c.env.DB, homeId)
  const body = await readJsonObject(c.req.raw)
  const name = requireText(body, 'name', MAX_NAME_LENGTH)
  const id = crypto.randomUUID()
  // The position is computed inside the INSERT, so it is one atomic statement. If two requests
  // pick the same position, the UNIQUE (home_id, position) constraint rejects the second one.
  try {
    await c.env.DB.prepare(
      `INSERT INTO members (id, home_id, name, position)
       SELECT ?1, ?2, ?3, COALESCE(MAX(position), 0) + 1 FROM members WHERE home_id = ?2`,
    )
      .bind(id, homeId, name)
      .run()
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('members_home_position_unique')) {
      throw new HttpError(409, 'Another member was added at the same time. Try again.')
    }
    if (message.includes('FOREIGN KEY')) throw new HttpError(404, 'Home not found')
    throw error
  }
  return c.json({ id, homeId, name } satisfies Member, 201)
})

app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  await requireHome(c.env.DB, homeId)
  const { results } = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, name FROM members WHERE home_id = ? ORDER BY position',
  )
    .bind(homeId)
    .all<Member>()
  return c.json({ members: results })
})

// ---------- bills ----------

app.post('/api/homes/:homeId/bills', async (c) => {
  const db = c.env.DB
  const homeId = c.req.param('homeId')
  await requireHome(db, homeId)
  const body = await readJsonObject(c.req.raw)
  const title = requireText(body, 'title', MAX_TITLE_LENGTH)
  const totalCents = requireCents(body, 'totalCents')

  const members = await db
    .prepare('SELECT COUNT(*) AS count FROM members WHERE home_id = ?')
    .bind(homeId)
    .first<{ count: number }>()
  if (!members || members.count === 0) {
    throw new HttpError(422, 'Home has no members to split the bill between')
  }

  const billId = crypto.randomUUID()
  // One batch is one transaction: the bill and all its shares are saved together or not at all.
  // Each member gets floor(total / count) cents. The first (total % count) members, in the order
  // they joined, get 1 extra cent. So the shares always add up to totalCents.
  const [, , shares] = await db.batch([
    db
      .prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind(billId, homeId, title, totalCents),
    db
      .prepare(
        `INSERT INTO shares (id, bill_id, member_id, amount_cents)
         -- D1 sends JS numbers as floats, so CAST to keep this integer division.
         SELECT lower(hex(randomblob(16))), ?1, id,
                CAST(?2 AS INTEGER) / count
                  + CASE WHEN rank <= CAST(?2 AS INTEGER) % count THEN 1 ELSE 0 END
         FROM (
           SELECT id,
                  ROW_NUMBER() OVER (ORDER BY position) AS rank,
                  COUNT(*) OVER () AS count
           FROM members WHERE home_id = ?3
         )`,
      )
      .bind(billId, totalCents, homeId),
    db
      .prepare(
        `SELECT s.id, s.member_id AS memberId, s.amount_cents AS amountCents, s.paid_at AS paidAt
         FROM shares s JOIN members m ON m.id = s.member_id
         WHERE s.bill_id = ? ORDER BY m.position`,
      )
      .bind(billId),
  ])

  return c.json(
    { id: billId, homeId, title, totalCents, shares: shares?.results as Share[] | undefined },
    201,
  )
})

type ShareRow = Share & { billId: string; memberName: string }

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  await requireHome(c.env.DB, homeId)
  const [bills, shares] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, home_id AS homeId, title, total_cents AS totalCents, created_at AS createdAt
       FROM bills WHERE home_id = ? ORDER BY created_at DESC, rowid DESC`,
    ).bind(homeId),
    c.env.DB.prepare(
      `SELECT s.id, s.bill_id AS billId, s.member_id AS memberId, m.name AS memberName,
              s.amount_cents AS amountCents, s.paid_at AS paidAt
       FROM shares s
       JOIN members m ON m.id = s.member_id
       JOIN bills b ON b.id = s.bill_id
       WHERE b.home_id = ? ORDER BY m.position`,
    ).bind(homeId),
  ])
  const sharesByBill = new Map<string, Omit<ShareRow, 'billId'>[]>()
  for (const row of (shares?.results ?? []) as ShareRow[]) {
    const { billId, ...share } = row
    sharesByBill.set(billId, [...(sharesByBill.get(billId) ?? []), share])
  }
  const list = (bills?.results ?? []) as { id: string }[]
  return c.json({
    bills: list.map((bill) => ({ ...bill, shares: sharesByBill.get(bill.id) ?? [] })),
  })
})

// ---------- payments ----------

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const db = c.env.DB
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) throw new HttpError(400, 'Idempotency-Key header is required')
  if (key.length > MAX_KEY_LENGTH) {
    throw new HttpError(400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`)
  }

  // Compare-and-set. The WHERE paid_at IS NULL makes this one atomic statement: when two requests
  // pay the same share at the same time, the database lets exactly one of them change the row.
  const paidAt = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE shares SET paid_at = ?, payment_key = ?
       WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
    )
    .bind(paidAt, key, shareId, billId)
    .run()

  const share = await db
    .prepare(
      `SELECT id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt,
              payment_key AS paymentKey
       FROM shares WHERE id = ? AND bill_id = ?`,
    )
    .bind(shareId, billId)
    .first<Share & { paymentKey: string | null }>()
  if (!share) throw new HttpError(404, 'Bill or share not found')

  // Our update lost (or the share was paid before): only the same key may see a success.
  if (result.meta.changes === 0 && share.paymentKey !== key) {
    throw new HttpError(409, 'Share is already paid with a different Idempotency-Key')
  }
  return c.json({
    id: share.id,
    memberId: share.memberId,
    amountCents: share.amountCents,
    paidAt: share.paidAt,
  })
})

// ---------- balances ----------

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  await requireHome(c.env.DB, homeId)
  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS memberId, m.name AS name, COALESCE(SUM(s.amount_cents), 0) AS outstandingCents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.position
     ORDER BY m.position`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()
  return c.json({ balances: results })
})

export default app
