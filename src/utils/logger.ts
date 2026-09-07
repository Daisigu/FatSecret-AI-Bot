/* Minimal structured console logger - swap for pino/winston if you want more. */
function ts() {
  return new Date().toISOString();
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) {
    return ` ${meta.stack ?? meta.message}`;
  }
  try {
    return ` ${JSON.stringify(meta, null, 2)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) =>
    console.log(`[${ts()}] INFO  ${msg}${formatMeta(meta)}`),
  warn: (msg: string, meta?: unknown) =>
    console.warn(`[${ts()}] WARN  ${msg}${formatMeta(meta)}`),
  error: (msg: string, meta?: unknown) =>
    console.error(`[${ts()}] ERROR ${msg}${formatMeta(meta)}`),
};
