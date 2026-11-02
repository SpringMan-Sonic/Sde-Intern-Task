import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type Balance, type Bill, type Home, type Member } from '../api'
import { formatCents, parseDollarsToCents } from '../money'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { home?: string } => ({
    home: typeof search.home === 'string' ? search.home : undefined,
  }),
  component: Page,
})

type Remote<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.'
}

// Loads data and reloads it when `reload` is called. Stale answers are ignored via AbortController.
function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are passed in on purpose
  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
    load(controller.signal).then(
      (data) => setState({ status: 'ready', data }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: messageOf(error) })
      },
    )
    return () => controller.abort()
  }, [...deps, tick])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  return [state, reload] as const
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error" role="alert">
      {message}{' '}
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

function Page() {
  const { home: homeId } = Route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const [homes, reloadHomes] = useRemote((signal) => api.listHomes(signal), [])
  const [newHome, setNewHome] = useState('')
  const [homeError, setHomeError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  async function createHome(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setHomeError(null)
    try {
      const home = await api.createHome(newHome)
      setNewHome('')
      reloadHomes()
      await navigate({ search: { home: home.id } })
    } catch (error) {
      setHomeError(messageOf(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <main>
      <h1>Bill Splitter</h1>
      <p className="muted">Split a bill between the members of a shared home.</p>

      <section className="card">
        <h2>Home</h2>
        {homes.status === 'loading' && <p className="muted">Loading homes…</p>}
        {homes.status === 'error' && <ErrorBox message={homes.message} onRetry={reloadHomes} />}
        {homes.status === 'ready' && homes.data.homes.length === 0 && (
          <p className="empty">No homes yet. Create your first one below.</p>
        )}
        {homes.status === 'ready' && homes.data.homes.length > 0 && (
          <select
            aria-label="Choose a home"
            value={homeId ?? ''}
            onChange={(event) => navigate({ search: { home: event.target.value || undefined } })}
          >
            <option value="">Choose a home…</option>
            {homes.data.homes.map((home: Home) => (
              <option key={home.id} value={home.id}>
                {home.name}
              </option>
            ))}
          </select>
        )}
        <form className="row" onSubmit={createHome} style={{ marginTop: 12 }}>
          <input
            aria-label="New home name"
            placeholder="New home name"
            value={newHome}
            onChange={(event) => setNewHome(event.target.value)}
          />
          <button type="submit" disabled={creating || newHome.trim() === ''}>
            {creating ? 'Creating…' : 'Create home'}
          </button>
        </form>
        {homeError && <ErrorBox message={homeError} />}
      </section>

      {homeId ? <HomeView key={homeId} homeId={homeId} /> : null}
    </main>
  )
}

function HomeView({ homeId }: { homeId: string }) {
  const [members, reloadMembers] = useRemote(
    async (s) => (await api.listMembers(homeId, s)).members,
    [homeId],
  )
  const [bills, reloadBills] = useRemote(
    async (s) => (await api.listBills(homeId, s)).bills,
    [homeId],
  )
  const [balances, reloadBalances] = useRemote(
    async (s) => (await api.balances(homeId, s)).balances,
    [homeId],
  )

  const refreshMoney = useCallback(() => {
    reloadBills()
    reloadBalances()
  }, [reloadBills, reloadBalances])

  const memberCount = members.status === 'ready' ? members.data.length : 0

  return (
    <>
      <MembersCard
        members={members}
        onChanged={() => {
          reloadMembers()
          reloadBalances()
        }}
        homeId={homeId}
      />
      <NewBillCard homeId={homeId} canSplit={memberCount > 0} onCreated={refreshMoney} />
      <BalancesCard balances={balances} onRetry={reloadBalances} />
      <BillsCard bills={bills} onRetry={reloadBills} onPaid={refreshMoney} />
    </>
  )
}

function MembersCard({
  homeId,
  members,
  onChanged,
}: {
  homeId: string
  members: Remote<Member[]>
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.addMember(homeId, name)
      setName('')
      onChanged()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Members</h2>
      {members.status === 'loading' && <p className="muted">Loading members…</p>}
      {members.status === 'error' && <ErrorBox message={members.message} onRetry={onChanged} />}
      {members.status === 'ready' && members.data.length === 0 && (
        <p className="empty">No members yet. Add at least one to split a bill.</p>
      )}
      {members.status === 'ready' && members.data.length > 0 && (
        <p>{members.data.map((member) => member.name).join(', ')}</p>
      )}
      <form className="row" onSubmit={submit}>
        <input
          aria-label="Member name"
          placeholder="Member name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={busy || name.trim() === ''}>
          {busy ? 'Adding…' : 'Add member'}
        </button>
      </form>
      {error && <ErrorBox message={error} />}
    </section>
  )
}

function NewBillCard({
  homeId,
  canSplit,
  onCreated,
}: {
  homeId: string
  canSplit: boolean
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const cents = parseDollarsToCents(amount)
    if (cents === null) {
      setError('Enter an amount in rupees above zero with at most 2 decimals, like 250.50.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.createBill(homeId, title, cents)
      setTitle('')
      setAmount('')
      onCreated()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>New bill</h2>
      {!canSplit && (
        <p className="muted">Add a member first. A bill needs someone to split it with.</p>
      )}
      <form className="row" onSubmit={submit}>
        <input
          aria-label="Bill title"
          placeholder="Title (Electricity)"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          aria-label="Bill amount in rupees"
          placeholder="Amount in ₹ (250.50)"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <button type="submit" disabled={busy || !canSplit || title.trim() === ''}>
          {busy ? 'Splitting…' : 'Split bill'}
        </button>
      </form>
      {error && <ErrorBox message={error} />}
    </section>
  )
}

function BalancesCard({ balances, onRetry }: { balances: Remote<Balance[]>; onRetry: () => void }) {
  return (
    <section className="card">
      <h2>Who owes what</h2>
      {balances.status === 'loading' && <p className="muted">Loading balances…</p>}
      {balances.status === 'error' && <ErrorBox message={balances.message} onRetry={onRetry} />}
      {balances.status === 'ready' && balances.data.length === 0 && (
        <p className="empty">No members yet.</p>
      )}
      {balances.status === 'ready' &&
        balances.data.map((balance) => (
          <div className="balance" key={balance.memberId}>
            <span>{balance.name}</span>
            <strong>{formatCents(balance.outstandingCents)}</strong>
          </div>
        ))}
    </section>
  )
}

function BillsCard({
  bills,
  onRetry,
  onPaid,
}: {
  bills: Remote<Bill[]>
  onRetry: () => void
  onPaid: () => void
}) {
  // One Idempotency-Key per share. A retry after a failure re-sends the same key, so a payment
  // that did go through but whose answer was lost is never charged twice.
  const keys = useRef(new Map<string, string>())
  const [paying, setPaying] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function pay(billId: string, shareId: string) {
    let key = keys.current.get(shareId)
    if (!key) {
      key = crypto.randomUUID()
      keys.current.set(shareId, key)
    }
    setPaying((previous) => new Set(previous).add(shareId))
    setErrors(({ [shareId]: _removed, ...rest }) => rest)
    try {
      await api.payShare(billId, shareId, key)
      keys.current.delete(shareId)
    } catch (error) {
      // A 4xx answer is final for this key. A network error or timeout keeps the key for the retry.
      setErrors((previous) => ({ ...previous, [shareId]: messageOf(error) }))
    } finally {
      setPaying((previous) => {
        const next = new Set(previous)
        next.delete(shareId)
        return next
      })
      onPaid() // reload, so the page shows what the server really has
    }
  }

  return (
    <section className="card">
      <h2>Bills</h2>
      {bills.status === 'loading' && <p className="muted">Loading bills…</p>}
      {bills.status === 'error' && <ErrorBox message={bills.message} onRetry={onRetry} />}
      {bills.status === 'ready' && bills.data.length === 0 && (
        <p className="empty">No bills yet. Add one above.</p>
      )}
      {bills.status === 'ready' && (
        <ul>
          {bills.data.map((bill) => (
            <li key={bill.id} style={{ marginTop: 16 }}>
              <div className="bill-head">
                <strong>{bill.title}</strong>
                <span>{formatCents(bill.totalCents)}</span>
              </div>
              {bill.shares.map((share) => (
                <div key={share.id}>
                  <div className="share">
                    <span>
                      {share.memberName} · {formatCents(share.amountCents)}
                    </span>
                    {share.paidAt ? (
                      <span className="paid">
                        Paid {new Date(share.paidAt).toLocaleDateString()}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={paying.has(share.id)}
                        onClick={() => pay(bill.id, share.id)}
                      >
                        {paying.has(share.id) ? 'Paying…' : errors[share.id] ? 'Try again' : 'Pay'}
                      </button>
                    )}
                  </div>
                  {errors[share.id] && <ErrorBox message={errors[share.id] ?? ''} />}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
