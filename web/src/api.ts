// Small typed client for the API. Every call has a timeout, and every failure becomes ApiError.

export type Home = { id: string; name: string }
export type Member = { id: string; homeId: string; name: string }
export type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
export type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  createdAt: string
  shares: Share[]
}
export type Balance = { memberId: string; name: string; outstandingCents: number }

export class ApiError extends Error {}

const TIMEOUT_MS = 10_000

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (timeout.aborted) throw new ApiError('The server took too long to answer. Try again.')
    throw new ApiError('Could not reach the server. Check your connection and try again.')
  }

  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // The body was empty or not JSON (for example a proxy error page). Handled below.
  }
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Something went wrong (error ${response.status}).`
    throw new ApiError(message)
  }
  if (data === null) throw new ApiError('The server sent an unexpected answer.')
  return data as T
}

export const api = {
  listHomes: (signal?: AbortSignal) => request<{ homes: Home[] }>('GET', '/api/homes', { signal }),
  createHome: (name: string) => request<Home>('POST', '/api/homes', { body: { name } }),
  listMembers: (homeId: string, signal?: AbortSignal) =>
    request<{ members: Member[] }>('GET', `/api/homes/${homeId}/members`, { signal }),
  addMember: (homeId: string, name: string) =>
    request<Member>('POST', `/api/homes/${homeId}/members`, { body: { name } }),
  listBills: (homeId: string, signal?: AbortSignal) =>
    request<{ bills: Bill[] }>('GET', `/api/homes/${homeId}/bills`, { signal }),
  createBill: (homeId: string, title: string, totalCents: number) =>
    request<unknown>('POST', `/api/homes/${homeId}/bills`, { body: { title, totalCents } }),
  balances: (homeId: string, signal?: AbortSignal) =>
    request<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`, { signal }),
  payShare: (billId: string, shareId: string, idempotencyKey: string) =>
    request<{ id: string; paidAt: string }>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
}
