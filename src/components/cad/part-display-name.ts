function isLikelyUnreadableName(value: string): boolean {
  if (value.includes("\uFFFD")) return true;
  if (/[ÃÂÐÑ][\u0080-\u00BF]/u.test(value)) return true;
  if (/â[\u0080-\u00BF]/u.test(value)) return true;
  const alphaNumCount = (value.match(/[A-Za-z0-9]/g) ?? []).length;
  const symbolCount = (value.match(/[^A-Za-z0-9\s_.\-()[\]{}]/g) ?? []).length;
  return alphaNumCount === 0 && symbolCount > 0;
}

export function getSafePartDisplayName(
  raw: string | undefined,
  index: number,
): string {
  const fallback = `Part ${index + 1}`;
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .trim()
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  if (isLikelyUnreadableName(cleaned)) return fallback;
  return cleaned;
}
