// thebes.ts — minimal browser client for a Thebes backend canister.
//
// `arg` and `reply` are hex-encoded Candid bytes. This file hand-rolls
// the Candid subset the notes backend uses: text and nat arguments,
// and replies made of text, nat, bool, vec, record and opt.

export const BACKEND_CANISTER_ID = 246282851157127;

const BASE = "";

// ─── hex ─────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── LEB128 (unsigned + signed) ──────────────────────────────────────

function uleb(n: bigint): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function ulebDecode(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[off++];
    if (byte === undefined) throw new Error("candid: truncated uleb128");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, off];
    shift += 7n;
  }
}

function slebDecode(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[off++];
    if (byte === undefined) throw new Error("candid: truncated sleb128");
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) result -= 1n << shift; // sign-extend
      return [result, off];
    }
  }
}

// ─── Candid encode ───────────────────────────────────────────────────

const MAGIC = [0x44, 0x49, 0x44, 0x4c]; // "DIDL"
const TYPE_TEXT_SLEB = 0x71; // text
const TYPE_NAT_SLEB = 0x7d; // nat

/// Encode zero arguments: `()`.
export function encodeEmpty(): string {
  return bytesToHex(new Uint8Array([...MAGIC, 0, 0]));
}

/// Encode a single `(text)` argument.
export function encodeText(s: string): string {
  return encodeArgs([s]);
}

/// Encode any mix of text (string) and nat (bigint) arguments, in order.
/// Example: encodeArgs([5n, "title", "body"])  ->  (5 : nat, "title", "body")
export function encodeArgs(args: (string | bigint)[]): string {
  const types: number[] = [];
  const values: number[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      const utf8 = new TextEncoder().encode(a);
      types.push(TYPE_TEXT_SLEB);
      values.push(...uleb(BigInt(utf8.length)));
      for (const b of utf8) values.push(b);
    } else {
      types.push(TYPE_NAT_SLEB);
      values.push(...uleb(a));
    }
  }
  return bytesToHex(new Uint8Array([...MAGIC, 0, args.length, ...types, ...values]));
}

// ─── Candid decode (text, nat, bool, vec, record, opt) ───────────────

export type CandidValue =
  | string
  | bigint
  | boolean
  | null
  | CandidValue[]
  | { [field: string]: CandidValue };

// Candid identifies record fields by a hash of the name, not the name.
// We hash the names our backend uses so records come back as { id, title, body }.
function idlHash(name: string): string {
  let h = 0n;
  for (const b of new TextEncoder().encode(name)) {
    h = (h * 223n + BigInt(b)) % 4294967296n;
  }
  return h.toString();
}
const FIELD_NAMES = new Map<string, string>(
  [
    "id", "title", "body",
    "noteId", "owner", "author",
    "from", "to", "fromName", "toName", "amount", "time",
    "members", "circulation", "expected", "consistent",
  ].map((n): [string, string] => [idlHash(n), n])
);

type TypeDef =
  | { kind: "record"; fields: [bigint, bigint][] }
  | { kind: "vec"; inner: bigint }
  | { kind: "opt"; inner: bigint };

/// Decode a single-value Candid reply.
export function decodeReply(hex: string): CandidValue {
  const buf = hexToBytes(hex);
  if (buf.length < 6 || buf[0] !== 0x44 || buf[1] !== 0x49 || buf[2] !== 0x44 || buf[3] !== 0x4c) {
    throw new Error("candid: bad magic in reply");
  }
  let off = 4;
  const readU = (): bigint => {
    const [v, next] = ulebDecode(buf, off);
    off = next;
    return v;
  };
  const readS = (): bigint => {
    const [v, next] = slebDecode(buf, off);
    off = next;
    return v;
  };

  // 1) the type table
  const table: TypeDef[] = [];
  const tableCount = Number(readU());
  for (let i = 0; i < tableCount; i++) {
    const code = readS();
    if (code === -20n) {
      const n = Number(readU());
      const fields: [bigint, bigint][] = [];
      for (let j = 0; j < n; j++) {
        const h = readU();
        const t = readS();
        fields.push([h, t]);
      }
      table.push({ kind: "record", fields });
    } else if (code === -19n) {
      table.push({ kind: "vec", inner: readS() });
    } else if (code === -18n) {
      table.push({ kind: "opt", inner: readS() });
    } else {
      throw new Error(`candid: unsupported type code ${code}; extend thebes.ts`);
    }
  }

  // 2) the argument types
  const argCount = Number(readU());
  if (argCount === 0) return "";
  const argType = readS();

  // 3) the value
  const readValue = (ty: bigint): CandidValue => {
    if (ty < 0n) {
      switch (ty) {
        case -1n:
          return null;
        case -2n: {
          const b = buf[off++];
          return b !== 0;
        }
        case -3n:
          return readU();
        case -4n:
          return readS();
        case -8n: {
          let v = 0n;
          for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
          off += 8;
          return v;
        }
        case -15n: {
          const len = Number(readU());
          const s = new TextDecoder().decode(buf.slice(off, off + len));
          off += len;
          return s;
        }
        default:
          throw new Error(`candid: unsupported type ${ty}; extend thebes.ts`);
      }
    }
    const def = table[Number(ty)];
    if (!def) throw new Error("candid: bad type reference");
    if (def.kind === "vec") {
      const n = Number(readU());
      const items: CandidValue[] = [];
      for (let i = 0; i < n; i++) items.push(readValue(def.inner));
      return items;
    }
    if (def.kind === "opt") {
      const flag = buf[off++];
      return flag === 0 ? null : readValue(def.inner);
    }
    const rec: { [field: string]: CandidValue } = {};
    for (const [h, t] of def.fields) {
      const key = FIELD_NAMES.get(h.toString()) ?? h.toString();
      rec[key] = readValue(t);
    }
    return rec;
  };

  return readValue(argType);
}

// ─── sender identity (demo-grade) ────────────────────────────────────

function demoSender(): string {
  const KEY = `thebes-demo-sender:${BACKEND_CANISTER_ID}`;
  let s = localStorage.getItem(KEY);
  if (!s) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    s = bytesToHex(b);
    localStorage.setItem(KEY, s);
  }
  return s;
}

// ─── transient-tolerant fetch ─────────────────────────────────────────

const RETRIES = 3;

function isTransient(status: number, body: string): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /validator unreachable|no healthy validator|unhealthy/i.test(body)
  );
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      if (!r.ok && isTransient(r.status, text)) {
        lastErr = `HTTP ${r.status}: ${text.slice(0, 200)}`;
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`malformed reply: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`the network is briefly unreachable — please try again (${lastErr})`);
}

// ─── the three motions ───────────────────────────────────────────────

export async function query(method: string, argHex: string): Promise<CandidValue> {
  const j = await fetchWithRetry(`${BASE}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canister_id: BACKEND_CANISTER_ID,
      method,
      arg: argHex,
      sender: demoSender(),
    }),
  });
  if (j.status !== "success") throw new Error(j.error || "query failed");
  return decodeReply(j.reply || "");
}

async function submitCall(
  method: string,
  argHex: string,
  sender: string,
  nonce: number
): Promise<any> {
  const r = await fetch(`${BASE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canister_id: BACKEND_CANISTER_ID,
      method,
      arg: argHex,
      sender,
      nonce,
    }),
  });
  const text = await r.text();
  if (!r.ok && isTransient(r.status, text)) {
    throw new Error("the network is briefly unreachable — please try again");
  }
  return JSON.parse(text);
}

export async function call(method: string, argHex: string): Promise<CandidValue> {
  const sender = demoSender();
  const nj = await fetchWithRetry(`${BASE}/api/next_nonce?sender=${sender}`, {
    cache: "no-store",
  });
  if (typeof nj.next_nonce !== "number") throw new Error("malformed next_nonce reply");

  let j = await submitCall(method, argHex, sender, nj.next_nonce);

  if (!j.queued && typeof j.error === "string" && /nonce .* already used/i.test(j.error)) {
    const m = j.error.match(/last seen:\s*(\d+)/i);
    const recovered = m ? Number(m[1]) + 1 : nj.next_nonce + 1;
    j = await submitCall(method, argHex, sender, recovered);
  }

  if (!j.queued || !j.message_hash) throw new Error(j.error || "call rejected");
  return pollReceipt(j.message_hash);
}

async function pollReceipt(hashHex: string): Promise<CandidValue> {
  const deadline = Date.now() + 30_000;
  let transientPolls = 0;
  while (Date.now() < deadline) {
    try {
      const j = await fetchWithRetry(`${BASE}/api/receipt?hash=${hashHex}`);
      if (j.found) {
        if (j.status === "success") return decodeReply(j.reply || "");
        throw new Error(j.error || "call failed on chain");
      }
    } catch (e) {
      if (++transientPolls > 10) throw e;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("timed out waiting for the chain's receipt");
}