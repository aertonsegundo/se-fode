import test from "node:test";
import assert from "node:assert/strict";
import { makeDeck, FIXED_MANILHAS, isManilha, cardStrength, trickWinner, trickOutcome, resolveTrickScore, nextHandSize, validBidOptions, suggestedBid, winStreak, rankingFrom, finalStandingsFrom, tournamentStandingsFrom, medalForPosition, medalAwardsForStandings, tournamentHumanCount, tournamentParticipantIdForUser, canResumeAsPlayer, unlockedBannerKeys, remainingDeck, cardWinProbability, chooseBotPlay, emptyMatchStats, matchTitles, matchHeadline } from "../game.js";

const C = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });

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

test("torneio usa o quadro de medalhas e desempata por vitórias", () => {
  assert.deepEqual(tournamentStandingsFrom([
    { name: "Bia", goldMedals: 1, silverMedals: 1, bronzeMedals: 0, wins: 1, lastPosition: 2 },
    { name: "Ana", goldMedals: 1, silverMedals: 1, bronzeMedals: 0, wins: 2, lastPosition: 3 },
    { name: "Caio", goldMedals: 1, silverMedals: 0, bronzeMedals: 3, wins: 3, lastPosition: 1 },
  ]).map(({ name, position }) => ({ name, position })), [
    { name: "Ana", position: 1 },
    { name: "Bia", position: 2 },
    { name: "Caio", position: 3 },
  ]);
});

test("streak conta só as vitórias seguidas mais recentes do mesmo nome", () => {
  assert.equal(winStreak(["Ana", "Ana", "Ana"], "Ana"), 3);
  assert.equal(winStreak(["Bia", "Ana", "Ana"], "Ana"), 2);
  assert.equal(winStreak(["Ana", "Ana", "Bia"], "Ana"), 0); // Bia venceu a última
  assert.equal(winStreak([], "Ana"), 0);
});

test("medalhas só valem no pódio de partidas com 5+ humanos", () => {
  assert.equal(medalForPosition(1, 5), "gold");
  assert.equal(medalForPosition(2, 5), "silver");
  assert.equal(medalForPosition(3, 8), "bronze");
  assert.equal(medalForPosition(4, 8), null);
  assert.equal(medalForPosition(1, 4), null);
  assert.equal(medalForPosition(3, 4), null);
});

test("todos os modos usam a mesma regra de medalhas", () => {
  const standings = ["ana", "bia", "caio", "duda", "enzo"].map((id, index) => ({ id, position: index + 1 }));
  const awarded = (options) => Object.fromEntries(medalAwardsForStandings(standings, options));

  // Solo, mesmo com cinco posições hipotéticas, não altera o quadro global.
  assert.deepEqual(awarded({ online: false, humanCount: 5 }), {});
  // Partida rápida, sala pública e sala privada são todas partidas online.
  assert.deepEqual(awarded({ online: true, humanCount: 5 }), { ana: "gold", bia: "silver", caio: "bronze" });
  // Mesa online abaixo do mínimo não premia ninguém.
  assert.deepEqual(awarded({ online: true, humanCount: 4 }), {});
  // No torneio, a escalação inicial válida continua definindo o pódio mesmo
  // que só quatro participantes cheguem à próxima partida.
  assert.deepEqual(awarded({ online: true, humanCount: 5 }), { ana: "gold", bia: "silver", caio: "bronze" });
});

test("torneio mantém a validade das medalhas pela escalação inicial", () => {
  const participants = {
    ana: { userId: "u-ana", name: "Ana" },
    bia: { userId: "u-bia", name: "Bia" },
    caio: { userId: "u-caio", name: "Caio" },
    duda: { userId: "u-duda", name: "Duda" },
    enzo: { userId: "u-enzo", name: "Enzo" },
  };
  // Mesmo que Enzo não esteja na segunda partida, o torneio ainda começou
  // válido com cinco humanos e o pódio dessa rodada continua valendo.
  assert.equal(tournamentHumanCount(participants), 5);
  assert.equal(medalForPosition(1, tournamentHumanCount(participants)), "gold");
  assert.equal(medalForPosition(2, tournamentHumanCount(participants)), "silver");
  assert.equal(medalForPosition(3, tournamentHumanCount(participants)), "bronze");
});

test("participante que volta entre partidas recupera a mesma vaga do torneio", () => {
  const playerIds = ["ana", "bia", "caio", "duda", "enzo"];
  const participants = Object.fromEntries(playerIds.map((id) => [id, { userId: `u-${id}`, name: id }]));
  // O id da vaga, e portanto o placar acumulado, não depende de a pessoa
  // ainda estar em room.players quando ela retorna entre duas partidas.
  assert.equal(tournamentParticipantIdForUser(playerIds, participants, "u-caio"), "caio");
  assert.equal(tournamentParticipantIdForUser(playerIds, participants, "u-fora"), null);
});

test("quem cai vivo e sem expulsão pode reassumir a própria cadeira", () => {
  const base = { isBot: false, connected: false, expelled: false, eliminated: false, quit: false, lives: 2, resumeToken: "token" };
  assert.equal(canResumeAsPlayer(base), true);
  assert.equal(canResumeAsPlayer({ ...base, lives: 0 }), false);
  assert.equal(canResumeAsPlayer({ ...base, expelled: true }), false);
  assert.equal(canResumeAsPlayer({ ...base, quit: true }), false);
  assert.equal(canResumeAsPlayer({ ...base, resumeToken: null }), false);
});

test("jogador que saiu após ser eliminado em terceiro mantém a medalha", () => {
  const standings = finalStandingsFrom([
    { id: "a", name: "Ana", lives: 2, eliminated: false },
    { id: "b", name: "Bia", lives: 0, eliminated: true, eliminatedAtRound: 5 },
    { id: "c", name: "Caio", lives: 0, eliminated: true, eliminatedAtRound: 4, quit: true },
    { id: "d", name: "Duda", lives: 0, eliminated: true, eliminatedAtRound: 3 },
    { id: "e", name: "Enzo", lives: 0, eliminated: true, eliminatedAtRound: 2 },
  ]);
  const caio = standings.find((entry) => entry.id === "c");
  assert.equal(caio.position, 3);
  assert.equal(medalForPosition(caio.position, standings.length), "bronze");
});

test("banners liberam por vitórias online; exclusivos/auto não entram", () => {
  const catalog = [
    { key: "novato", wins: 0 }, { key: "pato", wins: 2 }, { key: "coringa", wins: 5 },
    { key: "manilha", wins: 12 }, { key: "zap", wins: 25 },
    { key: "maldito", exclusive: true }, { key: "campeao", auto: true },
  ];
  assert.deepEqual(unlockedBannerKeys(0, catalog), ["novato"]);
  assert.deepEqual(unlockedBannerKeys(2, catalog), ["novato", "pato"]);
  assert.deepEqual(unlockedBannerKeys(12, catalog), ["novato", "pato", "coringa", "manilha"]);
  assert.deepEqual(unlockedBannerKeys(999, catalog), ["novato", "pato", "coringa", "manilha", "zap"]); // exclusivo/auto ficam de fora
});

test("bots espertos reconhecem o Zap como vitória", () => {
  const zap = [{ id: "4♣", rank: "4", suit: "♣" }];
  assert.equal(suggestedBid(zap, "normal", 4), 1);
  assert.equal(suggestedBid(zap, "hard", 8), 1);
  assert.equal(suggestedBid(zap, "easy", 4), null);
});

test("aposta probabilística: manilha vale, carta fraca quase nada, e o 3 não é garantido", () => {
  assert.equal(suggestedBid([C("4♣"), C("7♥")], "hard", 4), 2); // duas manilhas de topo
  assert.equal(suggestedBid([C("4♦"), C("5♦")], "hard", 8), 0); // duas fracas em mesa cheia
  assert.ok(suggestedBid([C("3♦"), C("4♦")], "hard", 8) <= 1);  // um 3 em mesa cheia não força alto
});

test("prob de carta: Zap sempre ganha; carta comum cai com mais oponentes", () => {
  assert.equal(cardWinProbability(C("4♣"), remainingDeck([C("4♣")]), 5), 1);
  const few = cardWinProbability(C("K♦"), remainingDeck([C("K♦")]), 1);
  const many = cardWinProbability(C("K♦"), remainingDeck([C("K♦")]), 7);
  assert.ok(few > many);
});

test("bot já garantido larga a carta forte que JÁ perdeu a vaza", () => {
  const hand = [C("5♦"), C("A♦")];
  const table = [{ playerId: "x", card: C("4♣") }]; // 4♣ na mesa: imbatível
  const chosen = chooseBotPlay({ hand, bid: 1, wins: 1, table, after: [], unknown: remainingDeck([...hand, C("4♣")]) });
  assert.equal(chosen.id, "A♦"); // vai perder de qualquer jeito → se livra da forte
});

test("bot garantido joga BAIXO quando os oponentes estão cheios (não entrega a forte)", () => {
  const hand = [C("5♦"), C("A♦")];
  const after = [{ needsMore: 0, cardsLeft: 2 }, { needsMore: -1, cardsLeft: 2 }]; // ninguém quer ganhar
  const chosen = chooseBotPlay({ hand, bid: 1, wins: 1, table: [], after, unknown: remainingDeck(hand) });
  assert.equal(chosen.id, "5♦"); // joga a mais fraca pra tentar perder
});

test("bot que precisa ganhar tudo joga a mais forte", () => {
  const hand = [C("5♦"), C("A♦")];
  const chosen = chooseBotPlay({ hand, bid: 2, wins: 0, table: [], after: [{ needsMore: 2, cardsLeft: 2 }], unknown: remainingDeck(hand) });
  assert.equal(chosen.id, "A♦");
});

// ===== Fim de partida: títulos da zoeira =====
const S = (over = {}) => ({ ...emptyMatchStats(), ...over });
const E = (id, name, stats, over = {}) => ({ id, name, stats: S(stats), eliminated: false, eliminatedAtRound: null, ...over });

test("título só sai com número que o justifique", () => {
  // Melou uma vez só não vira título; duas, sim.
  assert.equal(matchTitles([E("a", "Ana", { meladas: 1 })]).length, 0);
  const [titulo] = matchTitles([E("a", "Ana", { meladas: 2 })]);
  assert.equal(titulo.key, "melado");
  assert.equal(titulo.detail, "melou 2 vezes");
});

test("cada jogador leva no máximo um título, e vence a regra mais forte", () => {
  const titles = matchTitles([
    E("a", "Ana", { meladas: 4, dano: 9, maiorCombo: 5 }),
    E("b", "Bento", { meladas: 2, dano: 4 }),
  ]);
  const donos = titles.map((t) => t.playerId);
  assert.equal(new Set(donos).size, donos.length);
  assert.equal(titles.find((t) => t.key === "melado").playerId, "a"); // 4 > 2
  assert.equal(titles.find((t) => t.key === "olho-grande").playerId, "b"); // Ana já tinha título
});

test("'primeiro a cair' exige pelo menos dois eliminados", () => {
  const so_um = matchTitles([E("a", "Ana", {}, { eliminated: true, eliminatedAtRound: 3 })]);
  assert.equal(so_um.find((t) => t.key === "primeiro-a-cair"), undefined);
  const dois = matchTitles([
    E("a", "Ana", {}, { eliminated: true, eliminatedAtRound: 5 }),
    E("b", "Bento", {}, { eliminated: true, eliminatedAtRound: 2 }),
  ]);
  const primeiro = dois.find((t) => t.key === "primeiro-a-cair");
  assert.equal(primeiro.playerId, "b");
  assert.equal(primeiro.detail, "caiu na mão 2");
});

test("mão de alface exige partida inteira jogada, não vitória rápida", () => {
  assert.equal(matchTitles([E("a", "Ana", { maos: 2, vazas: 0 })]).length, 0); // saiu cedo demais
  const [alface] = matchTitles([E("a", "Ana", { maos: 6, vazas: 0 })]);
  assert.equal(alface.key, "alface");
  assert.equal(alface.detail, "não levou uma rodada sequer");
});

test("empate no mesmo número é resolvido de forma estável", () => {
  const entries = [E("a", "Ana", { meladas: 3 }), E("b", "Bento", { meladas: 3 })];
  assert.equal(matchTitles(entries)[0].playerId, "a");
  assert.equal(matchTitles(entries)[0].playerId, "a"); // duas rodadas, mesmo resultado
});

test("manchete prefere a zoeira; sem título nenhum, sobra o campeão", () => {
  const titles = matchTitles([
    E("a", "Ana", { manilhas: 4 }),
    E("b", "Bento", { meladas: 3 }),
  ]);
  const headline = matchHeadline(titles, "Ana");
  assert.equal(headline.kind, "title");
  assert.equal(headline.name, "Bento"); // melado ganha de manilheiro
  assert.deepEqual(matchHeadline([], "Ana"), { kind: "champion", name: "Ana", label: "GANHOU A PARADA", detail: "" });
  assert.equal(matchHeadline([], null), null);
});
