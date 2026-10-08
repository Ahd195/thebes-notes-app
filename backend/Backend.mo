/*
// notes-app backend — a starter canister on the Thebes substrate.
//
// Two surfaces, mirroring the classic hello template:
//
//  * greet(name)   — a query: read-only, answered locally, no consensus.
//  * increment()   — an update: ordered by consensus, executed on every
//    validator.
//  * get_count()   — the counter's query.
//
// UPGRADES KEEP YOUR STATE — because of one flag in thebes.toml.
//
// Thebes implements the classic upgrade contract: `thebes-deploy deploy
// --upgrade` runs pre_upgrade, carries the canister's STABLE memory to a
// fresh instance of the new module, and runs post_upgrade. Your thebes.toml
// builds this canister with `moc --legacy-persistence`, which compiles for
// exactly that contract — the compiler generates the hooks that serialise
// the `var`s below into stable memory and read them back. So `count`
// survives a code change. Verified end to end: a counter at 3 read 3 after
// an upgrade to a genuinely new build.
//
// moc's *default*, enhanced orthogonal persistence, keeps state in the
// wasm's MAIN memory and relies on the replica retaining that memory across
// an upgrade. This platform does not do that, so an EOP build comes back up
// blank — a counter at 3 reads 0. Leave `--legacy-persistence` in place.
// If you remove it, `deploy --upgrade` refuses rather than wiping you
// silently, and tells you how to put it back.
//
// One precondition, on the cluster rather than on your code: a 32-bit
// Motoko module is only admitted once the chain has passed its legacy-ABI
// activation height. `deploy` checks that for you before it uploads
// anything.

persistent actor Backend {
  var count : Nat = 0;

  public query func greet(name : Text) : async Text {
    "Greetings, " # name # " — from notes-app, live on Thebes."
  };

  public func increment() : async Nat {
    count += 1;
    count
  };

  public query func get_count() : async Nat {
    count
  };
};
*/

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Iter "mo:core/Iter";

persistent actor Backend {

  // the shape of one note
  public type Note = { id : Nat; title : Text; body : Text };

  // global counter for note ids
  var nextId : Nat = 0;

  // owner -> that owner's shelf of notes
  let shelves = Map.empty<Text, Map.Map<Nat, Note>>();

  // find the owner's shelf, or make an empty one
  func shelfOrNew(owner : Text) : Map.Map<Nat, Note> {
    switch (Map.get(shelves, Text.compare, owner)) {
      case (?s) { s };
      case null {
        let s = Map.empty<Nat, Note>();
        Map.add(shelves, Text.compare, owner, s);
        s
      };
    }
  };

  // CREATE → update. An empty owner means "not signed in": refuse.
  public func addNote(owner : Text, title : Text, body : Text) : async Nat {
    assert (owner != "");
    let id = nextId;
    nextId += 1;
    Map.add(shelfOrNew(owner), Nat.compare, id, { id; title; body });
    id
  };

  // LIST → query. An owner with no shelf has no notes (not an error).
  public query func listNotes(owner : Text) : async [Note] {
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { [] };
      case (?s) { Iter.toArray(Map.values(s)) };
    }
  };

  // EDIT → update. false if this owner has no note with that id
  // (including when the note exists but belongs to somebody else).
  public func editNote(owner : Text, id : Nat, title : Text, body : Text) : async Bool {
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { false };
      case (?s) {
        switch (Map.get(s, Nat.compare, id)) {
          case null { false };
          case (?_) {
            Map.add(s, Nat.compare, id, { id; title; body });
            true
          };
        }
      };
    }
  };

  // DELETE → update. Same rule: only from your own shelf.
  public func deleteNote(owner : Text, id : Nat) : async Bool {
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { false };
      case (?s) {
        switch (Map.get(s, Nat.compare, id)) {
          case null { false };
          case (?_) {
            ignore Map.remove(s, Nat.compare, id);
            true
          };
        }
      };
    }
  };
};