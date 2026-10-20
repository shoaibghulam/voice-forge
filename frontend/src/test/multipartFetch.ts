/**
 * Vitest runs Node's fetch (undici) next to jsdom's FormData/File, and undici cannot
 * serialise a jsdom FormData: multipart requests die as network errors before MSW sees
 * them. Browsers do not have this problem. This wrapper encodes such a body as a real
 * multipart/form-data payload, so upload code runs unchanged in tests.
 */

const CRLF = '\r\n';

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('could not read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

async function encode(form: FormData, boundary: string): Promise<Uint8Array<ArrayBuffer>> {
  const text = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push(text.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
      continue;
    }
    const filename = value instanceof File ? value.name : 'blob';
    const head = `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}`
      + `Content-Type: ${value.type || 'application/octet-stream'}${CRLF}${CRLF}`;
    parts.push(text.encode(head), new Uint8Array(await readBlob(value)), text.encode(CRLF));
  }
  parts.push(text.encode(`--${boundary}--${CRLF}`));
  return concat(parts);
}

/** Wrap the current global fetch; returns the function that restores it. */
export function installMultipartFetch(): () => void {
  const inner = globalThis.fetch;
  let counter = 0;
  const wrapped: typeof fetch = async (input, init) => {
    const body = init?.body;
    if (!(typeof FormData !== 'undefined' && body instanceof FormData)) return inner(input, init);
    counter += 1;
    const boundary = `----vitest-multipart-${counter}`;
    const headers = new Headers(init?.headers);
    headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    return inner(input, { ...init, headers, body: await encode(body, boundary) });
  };
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = inner;
  };
}
