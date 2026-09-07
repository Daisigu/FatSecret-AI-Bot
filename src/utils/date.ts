/**
 * FatSecret's diary API expects `date` as an integer number of days since
 * 1970-01-01 (i.e. Unix epoch days), evaluated in the user's local timezone.
 */
export function localParts(tz: string, at: Date = new Date()): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
  };
}

export function fatsecretDayInt(tz: string, at: Date = new Date()): number {
  const { year, month, day } = localParts(tz, at);
  // Date.UTC gives us a stable epoch-ms for a calendar date, independent of
  // the server's own local timezone.
  const utcMidnight = Date.UTC(year, month - 1, day);
  return Math.floor(utcMidnight / 86_400_000);
}

export type Meal = "breakfast" | "lunch" | "dinner" | "other";

export function guessMeal(tz: string, at: Date = new Date()): Meal {
  const { hour } = localParts(tz, at);
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "other";
}
