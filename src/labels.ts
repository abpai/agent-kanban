export function normalizeLabels(input: unknown): string[] {
  const labels: string[] = []
  const seen = new Set<string>()

  collectLabels(input, labels, seen)

  return labels
}

export function parseStoredLabels(raw: unknown): string[] {
  if (typeof raw !== 'string') return normalizeLabels(raw)

  try {
    return normalizeLabels(JSON.parse(raw))
  } catch {
    return normalizeLabels(raw)
  }
}

function collectLabels(input: unknown, labels: string[], seen: Set<string>): void {
  if (Array.isArray(input)) {
    for (const item of input) collectLabels(item, labels, seen)
    return
  }

  if (typeof input !== 'string') return

  for (const part of input.split(',')) {
    const label = part.trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
}
