import { useEffect, useState } from "react";
import { call, encodeArgs, query } from "./thebes";
import type { CandidValue } from "./thebes";
import { useTheme } from "./useTheme";
import { useMemphis } from "./useMemphis";
import MemphisGate from "./MemphisGate";

// shape of one note (same as Note in the backend)
type Note = { id: bigint; title: string; body: string };

// turn the chain's reply into an array of Note
function toNotes(v: CandidValue): Note[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    const r = item as { [field: string]: CandidValue };
    return { id: r.id as bigint, title: r.title as string, body: r.body as string };
  });
}

export default function App() {
  const auth = useMemphis();
  const theme = useTheme();

  // The signed-in identity, as the backend knows it.
  // Empty when signed out, which is the whole gate: no owner, no notes.
  const owner = auth.session?.anchor_id_hex ?? "";

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // add form
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // edit: which note is being edited (null = none)
  const [editingId, setEditingId] = useState<bigint | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  // LIST = query (read) — only this owner's notes
  async function loadNotes(who: string) {
    setLoading(true);
    try {
      const v = await query("listNotes", encodeArgs([who]));
      setNotes(toNotes(v));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Sign in -> load that identity's notes.
  // Sign out -> forget them and drop anything half-typed.
  useEffect(() => {
    if (!owner) {
      setNotes([]);
      setError(null);
      setTitle("");
      setBody("");
      setEditingId(null);
      return;
    }
    void loadNotes(owner);
  }, [owner]);

  // any call (write): disable buttons, run it, then reload from the chain
  async function run(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
      await loadNotes(owner);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // CREATE = call
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

  // EDIT = call
  async function onSave() {
    if (!owner || editingId === null || !editTitle.trim()) return;
    await run(() =>
      call("editNote", encodeArgs([owner, editingId, editTitle.trim(), editBody]))
    );
    setEditingId(null);
  }

  // DELETE = call
  async function onDelete(id: bigint) {
    if (!owner || !window.confirm("Delete this note?")) return;
    await run(() => call("deleteNote", encodeArgs([owner, id])));
  }

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
        <p className="strap">
          {auth.signedIn
            ? `signed in as ${auth.displayName}`
            : "your private notes, stored on the Thebes chain"}
        </p>
      </header>

      {/* sign-in gate */}
      <MemphisGate auth={auth} />

      {owner ? (
        <>
          <section className="panel">
            <h2>New note</h2>
            <form onSubmit={onAdd}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                aria-label="note title"
              />
              <input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Body"
                aria-label="note body"
              />
              <button type="submit" disabled={busy || !title.trim()}>
                {busy ? "saving…" : "Add"}
              </button>
            </form>
          </section>

          <section className="panel">
            <h2>Your notes ({notes.length})</h2>
            {loading && <p className="hint">loading…</p>}
            {!loading && notes.length === 0 && (
              <p className="hint">No notes yet. Add your first one above.</p>
            )}

            {[...notes].reverse().map((n) => (
              <div key={n.id.toString()} style={{ marginBottom: "1rem" }}>
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
                    <h3>{n.title}</h3>
                    <p>{n.body}</p>
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
                    </div>
                  </>
                )}
              </div>
            ))}
          </section>
        </>
      ) : (
        <section className="panel">
          <p className="hint">Sign in with your passkey to see your notes.</p>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <footer>served from the chain · Thebes</footer>
    </main>
  );
}