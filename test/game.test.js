import test from "node:test";
import assert from "node:assert/strict";
import { makeDeck, FIXED_MANILHAS, isManilha, cardStrength, trickWinner, nextHandSize, validBidOptions, suggestedBid } from "../game.js";

test("baralho de truco tem 40 cartas únicas", () => {
  const deck = makeDeck();
  assert.equal(deck.length, 40);
  assert.equal(new Set(deck.map((card) => card.id)).size, 40);
});

test("manilhas mineiras são fixas e seguem a ordem correta", () => {
  assert.deepEqual(FIXED_MANILHAS, ["7♦", "A♠", "7♥", "4♣"]);
  assert.equal(isManilha({ rank: "4", suit: "♣" }), true);
  assert.ok(cardStrength({ rank: "4", suit: "♣" }) > cardStrength({ rank: "7", suit: "♥" }));
  assert.ok(cardStrength({ rank: "7", suit: "♥" }) > cardStrength({ rank: "A", suit: "♠" }));
  assert.ok(cardStrength({ rank: "A", suit: "♠" }) > cardStrength({ rank: "7", suit: "♦" }));
  assert.ok(cardStrength({ rank: "7", suit: "♦" }) > cardStrength({ rank: "3", suit: "♣" }));
});

test("cartas iguais melam e a maior restante vence", () => {
  const plays = [
    { playerId: "a", card: { rank: "3", suit: "♦" } },
    { playerId: "b", card: { rank: "3", suit: "♠" } },
    { playerId: "c", card: { rank: "4", suit: "♣" } },
  ];
  assert.equal(trickWinner(plays).playerId, "c");
});

test("mão cresce até o limite e então diminui", () => {
  assert.deepEqual(nextHandSize(10, 1, 4), { handSize: 9, direction: -1 });
  assert.deepEqual(nextHandSize(5, -1, 4), { handSize: 4, direction: -1 });
  assert.deepEqual(nextHandSize(1, -1, 4), { handSize: 2, direction: 1 });
});

test("o último apostador nunca pode fechar a soma no número de vazas", () => {
  assert.deepEqual(validBidOptions(1, [1], true), [1]);
  assert.deepEqual(validBidOptions(3, [1, 0], true), [0, 1, 3]);
  assert.deepEqual(validBidOptions(1, [], false), [0, 1]);
});

test("bots espertos reconhecem o Zap como vitória", () => {
  const zap = [{ id: "4♣", rank: "4", suit: "♣" }];
  assert.equal(suggestedBid(zap, "normal", 4), 1);
  assert.equal(suggestedBid(zap, "hard", 8), 1);
  assert.equal(suggestedBid(zap, "easy", 4), null);
});
