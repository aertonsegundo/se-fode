import test from "node:test";
import assert from "node:assert/strict";
import { makeDeck, FIXED_MANILHAS, isManilha, cardStrength, trickWinner, trickOutcome, resolveTrickScore, nextHandSize, validBidOptions, suggestedBid, winStreak, rankingFrom, finalStandingsFrom } from "../game.js";

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

test("melada é aos pares: com 3 cartas iguais só as 2 primeiras melam", () => {
  const plays = [
    { playerId: "a", card: { id: "3♦", rank: "3", suit: "♦" } },
    { playerId: "b", card: { id: "3♠", rank: "3", suit: "♠" } },
    { playerId: "c", card: { id: "3♥", rank: "3", suit: "♥" } },
    { playerId: "d", card: { id: "K♣", rank: "K", suit: "♣" } },
  ];
  const { winner, melada } = trickOutcome(plays);
  assert.deepEqual(melada, ["3♦", "3♠"]); // as duas primeiras jogadas
  assert.equal(winner.playerId, "c"); // o 3º três (força 8) sobrevive e vence o K (força 6)
});

test("quatro cartas iguais melam todas (dois pares)", () => {
  const plays = ["♦", "♠", "♥", "♣"].map((suit, i) => ({ playerId: `p${i}`, card: { id: `2${suit}`, rank: "2", suit } }));
  const { winner, melada } = trickOutcome(plays);
  assert.equal(melada.length, 4);
  assert.equal(winner, null);
});

test("rodada melada acumula e o próximo vencedor leva tudo", () => {
  // rodada normal: leva 1
  let s = resolveTrickScore({ pot: 0, lastWinnerId: null }, "a", false);
  assert.equal(s.credit.amount, 1);
  assert.equal(s.pot, 0);
  assert.equal(s.lastWinnerId, "a");

  // duas rodadas seguidas melam: bolo acumula, ninguém pontua
  let m1 = resolveTrickScore({ pot: 0, lastWinnerId: "a" }, null, false);
  assert.equal(m1.credit, null);
  assert.equal(m1.pot, 1);
  let m2 = resolveTrickScore({ pot: m1.pot, lastWinnerId: "a" }, null, false);
  assert.equal(m2.pot, 2);

  // alguém finalmente vence: leva 1 + 2 acumuladas = 3
  let win = resolveTrickScore({ pot: m2.pot, lastWinnerId: "a" }, "b", false);
  assert.equal(win.credit.playerId, "b");
  assert.equal(win.credit.amount, 3);
  assert.equal(win.took, 3);
  assert.equal(win.pot, 0);
});

test("mão que acaba melada: o bolo vai para quem venceu antes da melada", () => {
  // última rodada mela com bolo pendente e havia um vencedor anterior (c)
  const s = resolveTrickScore({ pot: 1, lastWinnerId: "c" }, null, true);
  assert.equal(s.credit.playerId, "c");
  assert.equal(s.credit.amount, 2); // 1 acumulada + esta = 2
  assert.equal(s.potWinnerId, "c");
  assert.equal(s.pot, 0);
});

test("mão inteira melada, sem vencedor anterior: bolo é descartado", () => {
  const s = resolveTrickScore({ pot: 2, lastWinnerId: null }, null, true);
  assert.equal(s.credit, null);
  assert.equal(s.pot, 0);
});

test("mão cresce até o limite e então diminui", () => {
  assert.deepEqual(nextHandSize(10, 1, 4), { handSize: 9, direction: -1 });
  assert.deepEqual(nextHandSize(5, -1, 4), { handSize: 4, direction: -1 });
  assert.deepEqual(nextHandSize(1, -1, 4), { handSize: 2, direction: 1 });
});

test("o último apostador nunca pode fechar a soma no número de rodadas", () => {
  assert.deepEqual(validBidOptions(1, [1], true), [1]);
  assert.deepEqual(validBidOptions(3, [1, 0], true), [0, 1, 3]);
  assert.deepEqual(validBidOptions(1, [], false), [0, 1]);
});

test("ranking conta vitórias por nome, da maior para a menor", () => {
  const results = ["Ana", "Bia", "Ana", "Ana", "Bia"];
  assert.deepEqual(rankingFrom(results), [
    { name: "Ana", wins: 3 },
    { name: "Bia", wins: 2 },
  ]);
  assert.deepEqual(rankingFrom([]), []);
});

test("classificação final põe sobrevivente primeiro e o último eliminado acima", () => {
  const standings = finalStandingsFrom([
    { id: "ana", name: "Ana", lives: 3, eliminated: false },
    { id: "bia", name: "Bia", lives: 0, eliminated: true, eliminatedAtRound: 2 },
    { id: "caio", name: "Caio", lives: 0, eliminated: true, eliminatedAtRound: 5 },
    { id: "duda", name: "Duda", lives: -1, eliminated: true, eliminatedAtRound: 3 },
  ]);
  assert.deepEqual(standings.map(({ name, position, survived, eliminatedAtRound }) => ({ name, position, survived, eliminatedAtRound })), [
    { name: "Ana", position: 1, survived: true, eliminatedAtRound: null },
    { name: "Caio", position: 2, survived: false, eliminatedAtRound: 5 },
    { name: "Duda", position: 3, survived: false, eliminatedAtRound: 3 },
    { name: "Bia", position: 4, survived: false, eliminatedAtRound: 2 },
  ]);
});

test("streak conta só as vitórias seguidas mais recentes do mesmo nome", () => {
  assert.equal(winStreak(["Ana", "Ana", "Ana"], "Ana"), 3);
  assert.equal(winStreak(["Bia", "Ana", "Ana"], "Ana"), 2);
  assert.equal(winStreak(["Ana", "Ana", "Bia"], "Ana"), 0); // Bia venceu a última
  assert.equal(winStreak([], "Ana"), 0);
});

test("bots espertos reconhecem o Zap como vitória", () => {
  const zap = [{ id: "4♣", rank: "4", suit: "♣" }];
  assert.equal(suggestedBid(zap, "normal", 4), 1);
  assert.equal(suggestedBid(zap, "hard", 8), 1);
  assert.equal(suggestedBid(zap, "easy", 4), null);
});
