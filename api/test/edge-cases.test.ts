import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome, type Share } from './helpers'

function pay(billId: string, shareId: string, key: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: { 'Idempotency-Key': key },
  })
}

describe('edge cases', () => {
  it('splits 2 cents between 3 members as 1, 1, 0', async () => {
    const { homeId } = await createHome(['A', 'B', 'C'])
    const bill = await createBill(homeId, 2)
    expect(bill.body.shares.map((s) => s.amountCents)).toEqual([1, 1, 0])
  })

  it('does not save a bill when the home has no members', async () => {
    const { homeId } = await createHome([])
    await createBill(homeId, 1000)
    const list = await call<{ bills: unknown[] }>('GET', `/api/homes/${homeId}/bills`)
    expect(list.body.bills).toEqual([])
  })

  it.each([Number.MAX_SAFE_INTEGER + 2, 1e21, Number.NaN, true, [], {}])(
    'rejects the amount %j',
    async (totalCents) => {
      const { homeId } = await createHome(['A'])
      const bill = await call('POST', `/api/homes/${homeId}/bills`, {
        body: { title: 'Rent', totalCents },
      })
      expect(bill.status).toBe(422)
    },
  )

  it('rejects a missing title and a malformed body with a JSON error', async () => {
    const { homeId } = await createHome(['A'])
    const noTitle = await call<{ error: string }>('POST', `/api/homes/${homeId}/bills`, {
      body: { totalCents: 100 },
    })
    expect(noTitle.status).toBe(422)
    expect(noTitle.body.error).toEqual(expect.any(String))

    const bad = await call<{ error: string }>('POST', '/api/homes', { body: 'not an object' })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toEqual(expect.any(String))
  })

  it('answers unknown routes with a JSON error', async () => {
    const missing = await call<{ error: string }>('GET', '/api/nope')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toEqual(expect.any(String))
  })

  it('returns 404 for a share that belongs to another bill', async () => {
    const { homeId } = await createHome(['A', 'B'])
    const first = await createBill(homeId, 100)
    const second = await createBill(homeId, 100)
    const share = first.body.shares[0]
    if (!share) throw new Error('no share')
    const paid = await pay(second.body.id, share.id, crypto.randomUUID())
    expect(paid.status).toBe(404)
  })

  it('lets only one of many concurrent payments with different keys win', async () => {
    const { homeId } = await createHome(['A', 'B'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const results = await Promise.all(
      Array.from({ length: 10 }, () => pay(bill.body.id, share.id, crypto.randomUUID())),
    )

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(9)
    const balances = await call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
    expect(balances.body.balances.map((b) => b.outstandingCents)).toEqual([0, 500])
  })

  it('answers every concurrent request with the same key the same way', async () => {
    const { billId, shareId } = await (async () => {
      const { homeId } = await createHome(['A', 'B'])
      const bill = await createBill(homeId, 1000)
      const share = bill.body.shares[0]
      if (!share) throw new Error('no share')
      return { billId: bill.body.id, shareId: share.id }
    })()
    const key = crypto.randomUUID()

    const results = await Promise.all(Array.from({ length: 5 }, () => pay(billId, shareId, key)))

    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(new Set(results.map((r) => r.body.paidAt)).size).toBe(1)
  })

  it('keeps member order when members are added at the same time', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', { body: { name: 'H' } })
    const added = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        call('POST', `/api/homes/${home.body.id}/members`, { body: { name } }),
      ),
    )
    // Each request either gets its own place in the order or a clean 409, never a 500.
    expect(added.every((r) => r.status === 201 || r.status === 409)).toBe(true)
    const list = await call<{ members: unknown[] }>('GET', `/api/homes/${home.body.id}/members`)
    expect(list.body.members.length).toBe(added.filter((r) => r.status === 201).length)
  })
})
