import test from "node:test";
import assert from "node:assert/strict";
import { makeDeck, manilhaRank, cardStrength, trickWinner, nextHandSize, validBidOptions } from "../game.js";

test("baralho de truco tem 40 cartas únicas", () => {
  const deck = makeDeck();
  assert.equal(deck.length, 40);
  assert.equal(new Set(deck.map((card) => card.id)).size, 40);
});

test("manilha é a próxima carta e dá a volta depois do 3", () => {
  assert.equal(manilhaRank({ rank: "7" }), "Q");
  assert.equal(manilhaRank({ rank: "3" }), "4");
});

test("naipes desempatem manilhas na ordem ouros, espadas, copas, paus", () => {
  const vira = { rank: "7", suit: "♦" };
  assert.ok(cardStrength({ rank: "Q", suit: "♣" }, vira) > cardStrength({ rank: "Q", suit: "♥" }, vira));
});

test("cartas iguais melam e a maior restante vence", () => {
  const vira = { rank: "4", suit: "♦" };
  const plays = [
    { playerId: "a", card: { rank: "3", suit: "♦" } },
    { playerId: "b", card: { rank: "3", suit: "♠" } },
    { playerId: "c", card: { rank: "4", suit: "♣" } },
  ];
  assert.equal(trickWinner(plays, vira).playerId, "c");
});

test("mão cresce até o limite e então diminui", () => {
  assert.deepEqual(nextHandSize(9, 1, 4), { handSize: 8, direction: -1 });
  assert.deepEqual(nextHandSize(5, -1, 4), { handSize: 4, direction: -1 });
  assert.deepEqual(nextHandSize(1, -1, 4), { handSize: 2, direction: 1 });
});

test("o último apostador nunca pode fechar a soma no número de vazas", () => {
  assert.deepEqual(validBidOptions(1, [1], true), [1]);
  assert.deepEqual(validBidOptions(3, [1, 0], true), [0, 1, 3]);
  assert.deepEqual(validBidOptions(1, [], false), [0, 1]);
});
