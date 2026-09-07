export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

async function readOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(url, res.status, body);
  }
  return res;
}

export async function fetchBuffer(url: string, init?: RequestInit): Promise<Buffer> {
  const res = await readOk(url, init);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await readOk(url, init);
  return res.text();
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await readOk(url, init);
  return (await res.json()) as T;
}
