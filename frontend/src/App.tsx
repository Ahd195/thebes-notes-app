import { useEffect, useState } from "react";
import { call, encodeArgs, encodeEmpty, query } from "./thebes";
import type { CandidValue } from "./thebes";
import { useTheme } from "./useTheme";
import { useMemphis } from "./useMemphis";
import MemphisGate from "./MemphisGate";

type Rec = { [field: string]: CandidValue };
type Note = { id: bigint; title: string; body: string };
type FeedItem = { noteId: bigint; owner: string; author: string; title: string; body: string };
type TipRec = {
  id: bigint; from: string; to: string; fromName: string; toName: string;
  amount: bigint; time: bigint;
};
type Seal = { members: bigint; circulation: bigint; expected: bigint; consistent: boolean };

function recs(v: CandidValue): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}
function toNotes(v: CandidValue): Note[] {
  return recs(v).map((r) => ({
    id: r.id as bigint, title: r.title as string, body: r.body as string,
  }));
}
function toFeed(v: CandidValue): FeedItem[] {
  return recs(v).map((r) => ({
    noteId: r.noteId as bigint, owner: r.owner as string, author: r.author as string,
    title: r.title as string, body: r.body as string,
  }));
}
function toTips(v: CandidValue): TipRec[] {
  return recs(v).map((r) => ({
    id: r.id as bigint, from: r.from as string, to: r.to as string,
    fromName: r.fromName as string, toName: r.toName as string,
    amount: r.amount as bigint, time: r.time as bigint,
  }));
}
function toSeal(v: CandidValue): Seal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Rec;
  return {
    members: r.members as bigint, circulation: r.circulation as bigint,
    expected: r.expected as bigint, consistent: r.consistent as boolean,
  };
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
// long hex names get shortened so the page stays readable
function short(s: string): string {
  return s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

export default function App() {
  const auth = useMemphis();
  const theme = useTheme();

  // Empty when signed out: no owner, no private notes, no tipping.
  const owner = auth.session?.anchor_id_hex ?? "";

  const [notes, setNotes] = useState<Note[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tips, setTips] = useState<TipRec[]>([]);
  const [seal, setSeal] = useState<Seal | null>(null);
  const [balance, setBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<bigint | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  // one tip amount per feed card, keyed by note id
  const [tipAmounts, setTipAmounts] = useState<Record<string, string>>({});

  // load everything: public data always, private data when signed in.
  // silent = background refresh (no "loading…", no error banner)
  async function refresh(who: string, silent = false) {
    if (!silent) setLoading(true);
    try {
      const [f, t, s, n, b] = await Promise.all([
        query("listFeed", encodeEmpty()),
        query("listTips", encodeEmpty()),
        query("ledgerSealView", encodeEmpty()),
        who ? query("listNotes", encodeArgs([who])) : Promise.resolve<CandidValue>([]),
        who ? query("myBalance", encodeArgs([who])) : Promise.resolve<CandidValue>(0n),
      ]);
      setFeed(toFeed(f));
      setTips(toTips(t));
      setSeal(toSeal(s));
      setNotes(toNotes(n));
      setBalance(typeof b === "bigint" ? b : 0n);
    } catch (e) {
      if (!silent) setError(msg(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Sign in -> join (the 100 points are granted once) -> load.
  // Sign out -> forget private state, keep the public feed.
  useEffect(() => {
    void (async () => {
      if (!owner) {
        setError(null);
        setTitle("");
        setBody("");
        setEditingId(null);
        await refresh("");
        return;
      }
      try {
        await call("join", encodeArgs([owner, auth.displayName]));
      } catch (e) {
        setError(msg(e));
      }
      await refresh(owner);
    })();
  }, [owner]);

  // so a tip someone sends you shows up without a manual refresh
  useEffect(() => {
    const t = setInterval(() => void refresh(owner, true), 8000);
    return () => clearInterval(t);
  }, [owner]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
      await refresh(owner);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  // the backend answers "" on success, or a message to show
  function must(reply: CandidValue) {
    if (typeof reply === "string" && reply !== "") throw new Error(reply);
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!owner || !title.trim()) return;
    await run(() => call("addNote", encodeArgs([owner, title.trim(), body])));
    setTitle("");
    setBody("");
  }

  function startEdit(n: Note) {
    setEditingId(n.id);
    setEditTitle(n.title);
    setEditBody(n.body);
  }

  async function onSave() {
    if (!owner || editingId === null || !editTitle.trim()) return;
    await run(() =>
      call("editNote", encodeArgs([owner, editingId, editTitle.trim(), editBody]))
    );
    setEditingId(null);
  }

  async function onDelete(id: bigint) {
    if (!owner || !window.confirm("Delete this note?")) return;
    await run(() => call("deleteNote", encodeArgs([owner, id])));
  }

  async function onShare(id: bigint) {
    await run(async () =>
      must(await call("shareNote", encodeArgs([owner, id, auth.displayName])))
    );
  }

  async function onUnshare(id: bigint) {
    await run(async () => must(await call("unshareNote", encodeArgs([owner, id]))));
  }

  async function onTip(item: FeedItem) {
    const key = item.noteId.toString();
    const n = Number.parseInt(tipAmounts[key] ?? "", 10);
    if (!Number.isInteger(n) || n < 1) {
      setError("Enter a whole number of points, 1 or more");
      return;
    }
    await run(async () =>
      must(
        await call("tip", encodeArgs([owner, item.owner, BigInt(n), auth.displayName]))
      )
    );
    setTipAmounts((m) => ({ ...m, [key]: "" }));
  }

  const sharedIds = new Set(
    feed.filter((f) => f.owner === owner).map((f) => f.noteId.toString())
  );

  return (
    <main className="shell">
      <header>
        <button
          className="theme-toggle"
          onClick={theme.toggle}
          aria-label={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
        >
          {theme.effective === "dark" ? "☀" : "☾"}
        </button>
        <div className="cartouche">𓊹</div>
        <h1>notes-app</h1>
        <p className="strap">a canister dapp, live on the Thebes substrate</p>
      </header>

      {/* sign-in gate: untouched */}
      <MemphisGate auth={auth} />

      {owner && (
        <section className="panel">
          <h2>Your balance</h2>
          <p className="balance">
            <strong>{balance.toString()}</strong> points
          </p>
        </section>
      )}

      {owner ? (
        <>
          <section className="panel">
            <h2>Add a note — update, ordered by consensus</h2>
            <form onSubmit={onAdd}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="title"
                aria-label="note title"
              />
              <input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="body"
                aria-label="note body"
              />
              <button type="submit" disabled={busy || !title.trim()}>
                {busy ? "saving…" : "Add"}
              </button>
            </form>
          </section>

          <section className="panel">
            <h2>Your notes — query, answered locally</h2>
            {loading && <p className="hint">loading…</p>}
            {!loading && notes.length === 0 && (
              <p className="hint">No notes yet. Add your first one above.</p>
            )}

            {[...notes].reverse().map((n) => {
              const shared = sharedIds.has(n.id.toString());
              return (
                <div key={n.id.toString()} className="card">
                  {editingId === n.id ? (
                    <>
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        aria-label="edit title"
                      />
                      <input
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        aria-label="edit body"
                      />
                      <div className="row">
                        <button onClick={() => void onSave()} disabled={busy || !editTitle.trim()}>
                          {busy ? "saving…" : "Save"}
                        </button>
                        <button
                          className="secondary"
                          onClick={() => setEditingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3 className="card-title">{n.title}</h3>
                      <p className="card-body">{n.body}</p>
                      {shared && <p className="card-tag">shared to feed</p>}
                      <div className="row">
                        <button onClick={() => startEdit(n)} disabled={busy}>
                          Edit
                        </button>
                        <button
                          className="secondary"
                          onClick={() => void onDelete(n.id)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                        {shared ? (
                          <button onClick={() => void onUnshare(n.id)} disabled={busy}>
                            Unshare
                          </button>
                        ) : (
                          <button onClick={() => void onShare(n.id)} disabled={busy}>
                            Share
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </section>
        </>
      ) : (
        <section className="panel">
          <p className="hint">Sign in with your passkey to see your notes and your points.</p>
        </section>
      )}

      {/* public feed: everyone can read it */}
      <section className="panel">
        <h2>Public feed — shared notes from everybody</h2>
        {feed.length === 0 && <p className="hint">Nothing shared yet.</p>}
        {[...feed].reverse().map((f) => {
          const key = f.noteId.toString();
          return (
            <div key={key} className="card">
              <h3 className="card-title">{f.title}</h3>
              <p className="card-body">{f.body}</p>
              <p className="card-by">by {short(f.author)}</p>
              {owner && f.owner !== owner && (
                <div className="tip-row">
                  <input
                    className="tip-input"
                    type="number"
                    min={1}
                    value={tipAmounts[key] ?? ""}
                    onChange={(e) =>
                      setTipAmounts((m) => ({ ...m, [key]: e.target.value }))
                    }
                    placeholder="pts"
                    aria-label="points to tip"
                  />
                  <button onClick={() => void onTip(f)} disabled={busy}>
                    {busy ? "sending…" : "Tip"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* public tip history */}
      <section className="panel">
        <h2>Tip history</h2>
        {tips.length === 0 && <p className="hint">No tips yet.</p>}
        {[...tips].reverse().map((t) => (
          <p key={t.id.toString()} className="history-line">
            {short(t.fromName)} → {short(t.toName)}: {t.amount.toString()}
          </p>
        ))}
      </section>

      {error && <p className="error">{error}</p>}

      <footer>
        served from the chain · Thebes
        {seal && (
          <>
            <br />
            ledger: {seal.circulation.toString()} / {seal.expected.toString()} ·{" "}
            {seal.consistent ? "consistent" : "INCONSISTENT"}
          </>
        )}
      </footer>
    </main>
  );
}