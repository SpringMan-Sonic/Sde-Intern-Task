// Money is always whole paise (the API calls them cents; 100 of them make 1 rupee). These helpers never use floating point for the amount.

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const rest = String(abs % 100).padStart(2, '0')
  return `${sign}₹${whole.toLocaleString('en-IN')}.${rest}`
}

// Rupees typed by the user, like "12", "12.5" or "12.50" are valid. "12.505", "-1", "1e3" and "" are not.
export function parseDollarsToCents(input: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null
}