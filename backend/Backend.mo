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
import Time "mo:core/Time";

persistent actor Backend {

  // ───────────── Task 2: notes (shelves) ─────────────

  public type Note = { id : Nat; title : Text; body : Text };

  var nextId : Nat = 0;
  let shelves = Map.empty<Text, Map.Map<Nat, Note>>();

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

  // ───────────── Task 3: feed + ledger ─────────────

  public type FeedItem = {
    noteId : Nat; owner : Text; author : Text; title : Text; body : Text
  };
  public type Tip = {
    id : Nat; from : Text; to : Text; fromName : Text; toName : Text;
    amount : Nat; time : Int
  };
  public type Seal = {
    members : Nat; circulation : Nat; expected : Nat; consistent : Bool
  };

  let STARTING_POINTS : Nat = 100;

  // noteId -> owner, for every shared note
  let feed = Map.empty<Nat, Text>();
  // owner -> points
  let balances = Map.empty<Text, Nat>();
  // who already got their 100 (never check balance == 0 for this)
  let joined = Map.empty<Text, Bool>();
  // owner -> readable name
  let names = Map.empty<Text, Text>();
  var nextTipId : Nat = 0;
  let tips = Map.empty<Nat, Tip>();

  func balanceOf(owner : Text) : Nat {
    switch (Map.get(balances, Text.compare, owner)) {
      case (?b) { b };
      case null { 0 };
    }
  };

  func nameOf(owner : Text) : Text {
    switch (Map.get(names, Text.compare, owner)) {
      case (?n) { if (n == "") owner else n };
      case null { owner };
    }
  };

  // Grants the 100 points exactly once per owner.
  func ensureJoined(owner : Text, name : Text) {
    switch (Map.get(joined, Text.compare, owner)) {
      case (?_) {
        if (name != "") { Map.add(names, Text.compare, owner, name) };
      };
      case null {
        Map.add(joined, Text.compare, owner, true);
        Map.add(balances, Text.compare, owner, STARTING_POINTS);
        Map.add(names, Text.compare, owner, name);
      };
    }
  };

  // ───────────── notes: create / list / edit / delete ─────────────

  public func addNote(owner : Text, title : Text, body : Text) : async Nat {
    assert (owner != "");
    let id = nextId;
    nextId += 1;
    Map.add(shelfOrNew(owner), Nat.compare, id, { id; title; body });
    id
  };

  public query func listNotes(owner : Text) : async [Note] {
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { [] };
      case (?s) { Iter.toArray(Map.values(s)) };
    }
  };

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

  // deleting a note also removes it from the public feed
  public func deleteNote(owner : Text, id : Nat) : async Bool {
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { false };
      case (?s) {
        switch (Map.get(s, Nat.compare, id)) {
          case null { false };
          case (?_) {
            ignore Map.remove(s, Nat.compare, id);
            ignore Map.remove(feed, Nat.compare, id);
            true
          };
        }
      };
    }
  };

  // ───────────── membership + balance ─────────────

  // Call after sign-in. Safe to call many times: the 100 is granted once.
  public func join(owner : Text, name : Text) : async Nat {
    assert (owner != "");
    ensureJoined(owner, name);
    balanceOf(owner)
  };

  public query func myBalance(owner : Text) : async Nat {
    balanceOf(owner)
  };

  // ───────────── share / unshare ─────────────
  // Return "" on success, or an error message.

  public func shareNote(owner : Text, id : Nat, name : Text) : async Text {
    if (owner == "") { return "Sign in first" };
    switch (Map.get(shelves, Text.compare, owner)) {
      case null { "Note not found" };
      case (?s) {
        switch (Map.get(s, Nat.compare, id)) {
          case null { "Note not found" };
          case (?_) {
            ensureJoined(owner, name);
            Map.add(feed, Nat.compare, id, owner);
            ""
          };
        }
      };
    }
  };

  public func unshareNote(owner : Text, id : Nat) : async Text {
    switch (Map.get(feed, Nat.compare, id)) {
      case null { "" };
      case (?o) {
        if (o != owner) { "Not your note" } else {
          ignore Map.remove(feed, Nat.compare, id);
          ""
        }
      };
    }
  };

  // PUBLIC → query. Every shared note from every user, with its author.
  public query func listFeed() : async [FeedItem] {
    let out = Map.empty<Nat, FeedItem>();
    for ((noteId, owner) in Map.entries(feed)) {
      switch (Map.get(shelves, Text.compare, owner)) {
        case null {};
        case (?s) {
          switch (Map.get(s, Nat.compare, noteId)) {
            case null {};
            case (?n) {
              Map.add(out, Nat.compare, noteId, {
                noteId; owner; author = nameOf(owner);
                title = n.title; body = n.body
              });
            };
          }
        };
      }
    };
    Iter.toArray(Map.values(out))
  };

  // ───────────── the tip ─────────────
  // "" = success, otherwise the error. Every check runs BEFORE anything moves.

  public func tip(from : Text, to : Text, amount : Nat, name : Text) : async Text {
    if (from == "") { return "Sign in again" };
    ensureJoined(from, name);
    if (from == to) { return "You cannot tip yourself" };
    if (amount == 0) { return "Tip at least 1 point" };
    switch (Map.get(joined, Text.compare, to)) {
      case null { return "That author is not a member yet" };
      case (?_) {};
    };
    let fromBalance = balanceOf(from);
    if (fromBalance < amount) { return "Not enough points" };

    Map.add(balances, Text.compare, from, fromBalance - amount);
    Map.add(balances, Text.compare, to, balanceOf(to) + amount);

    let id = nextTipId;
    nextTipId += 1;
    Map.add(tips, Nat.compare, id, {
      id; from; to; fromName = nameOf(from); toName = nameOf(to);
      amount; time = Time.now()
    });
    ""
  };

  // PUBLIC history, oldest first.
  public query func listTips() : async [Tip] {
    Iter.toArray(Map.values(tips))
  };

  // THE LAW: sum of all balances = 100 × members
  public query func ledgerSealView() : async Seal {
    var circulation : Nat = 0;
    for ((_, b) in Map.entries(balances)) {
      circulation += b
    };
    let members = Map.size(joined);
    let expected = members * STARTING_POINTS;
    { members; circulation; expected; consistent = (circulation == expected) }
  };
};