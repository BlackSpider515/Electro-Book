/** Сколько дней файлы проверенных работ хранятся в бакете. */
export const REVIEW_RETENTION_DAYS = 7

export const REVIEW_RETENTION_MS = REVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Граница, раньше которой проверенные работы считаются просроченными. */
export function retentionCutoff(now = Date.now()): number {
  return now - REVIEW_RETENTION_MS
}

export function isReviewRetentionExpired(
  reviewedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!reviewedAt) return false
  const time = new Date(reviewedAt).getTime()
  return !Number.isNaN(time) && time <= retentionCutoff(now)
}

/** Сколько дней осталось до удаления файла (0 — уже можно удалять). */
export function retentionDaysLeft(
  reviewedAt: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!reviewedAt) return null
  const time = new Date(reviewedAt).getTime()
  if (Number.isNaN(time)) return null
  return Math.max(0, Math.ceil((time + REVIEW_RETENTION_MS - now) / (24 * 60 * 60 * 1000)))
}
