import test from "node:test";
import assert from "node:assert/strict";
import {
  GAME_MODES, TEAM_PALETTE, DOUBLES_SETUP_MESSAGE, DOUBLES_TEAMS_MESSAGE,
  normalizeGameMode, isDoublesMode, doublesSetupError, teamGroupsError, randomTeamGroups,
  createTeams, teamOf, teamMembers, teamTally, teamHandOutcome, teamLabel, interleaveTeams,
  teamIsOut, activeTeams, teamStandingsFrom, doublesStandingsFrom, partnerMeladas,
  makeDeck, remainingDeck, nextHandSize, cardStrength, trickOutcome, validBidOptions,
  medalAwardsForStandings, medalForPosition, DECK_SIZE,
} from "../game.js";

const STARTING_LIVES = 5; // mesma constante do servidor, passada de fora para as duplas
const P = (id, name, extra = {}) => ({ id, name, bid: null, wins: 0, eliminated: false, spectator: false, ...extra });
const four = () => [P("a", "Aerton"), P("b", "Bia"), P("d", "Dudu"), P("c", "Caio")];
const pairs = (...groups) => createTeams(groups, STARTING_LIVES);
// Sorteio determinístico para o teste não depender de Math.random.
const fakeRandom = (values) => { let i = 0; return () => values[i++ % values.length]; };

// ===== Modalidade e compatibilidade =====

test("sala sem modalidade (registro antigo) é sempre clássica", () => {
  for (const legacy of [undefined, null, "", "qualquer-coisa", 0]) {
    assert.equal(normalizeGameMode(legacy), GAME_MODES.CLASSIC);
    assert.equal(isDoublesMode(legacy), false);
  }
  assert.equal(normalizeGameMode("doubles"), GAME_MODES.DOUBLES);
  assert.equal(isDoublesMode("doubles"), true);
});

test("mesa em dupla só fecha com 4, 6 ou 8 jogadores", () => {
  assert.equal(doublesSetupError(4), null);
  assert.equal(doublesSetupError(6), null);
  assert.equal(doublesSetupError(8), null);
  for (const invalid of [0, 1, 2, 3, 5, 7, 9, 10]) {
    assert.equal(doublesSetupError(invalid), DOUBLES_SETUP_MESSAGE); // ímpar, pouca gente ou mesa estourada
  }
});

// ===== Formação das duplas =====

test("sorteio divide a mesa inteira em duplas completas", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const groups = randomTeamGroups(ids, fakeRandom([0.1, 0.9, 0.4, 0.7, 0.2]));
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.length === 2));
  assert.deepEqual([...groups.flat()].sort(), [...ids].sort()); // ninguém some nem se repete
  assert.equal(teamGroupsError(ids, groups), null);
});

test("organização manual recusa dupla incompleta, jogador repetido ou de fora", () => {
  const ids = ["a", "b", "c", "d"];
  assert.equal(teamGroupsError(ids, [["a", "b"], ["c", "d"]]), null);
  assert.equal(teamGroupsError(ids, [["a", "b"], ["c"]]), DOUBLES_TEAMS_MESSAGE);          // equipe incompleta
  assert.equal(teamGroupsError(ids, [["a", "b"], ["a", "c"]]), DOUBLES_TEAMS_MESSAGE);     // um jogador em duas duplas
  assert.equal(teamGroupsError(ids, [["a", "b"], ["c", "z"]]), DOUBLES_TEAMS_MESSAGE);     // id que não está na mesa
  assert.equal(teamGroupsError(ids, [["a", "b", "c"], ["d"]]), DOUBLES_TEAMS_MESSAGE);     // trio
  assert.equal(teamGroupsError(ids, [["a", "b"]]), DOUBLES_TEAMS_MESSAGE);                 // ficou gente sem equipe
  assert.equal(teamGroupsError(ids, "nada disso"), DOUBLES_TEAMS_MESSAGE);
});

test("cada jogador entra em uma única dupla, e parceiros dividem cor, símbolo e nome", () => {
  const players = four();
  const teams = pairs(["a", "b"], ["d", "c"]);
  for (const player of players) {
    const found = teams.filter((team) => team.playerIds.includes(player.id));
    assert.equal(found.length, 1); // um teamId por jogador, nunca dois
  }
  const [first, second] = teams;
  assert.equal(teamOf(teams, "a").id, teamOf(teams, "b").id);
  assert.equal(first.color, TEAM_PALETTE[0].color);
  assert.equal(second.color, TEAM_PALETTE[1].color);
  assert.notEqual(first.color, second.color);
  assert.ok(first.symbol && first.label && first.name); // cor nunca é a única identificação
  assert.equal(teamLabel(first, players), "Aerton + Bia");
});

test("a dupla começa com a soma das vidas de dois jogadores do clássico", () => {
  const [team] = pairs(["a", "b"]);
  assert.equal(team.lives, STARTING_LIVES * 2);
});

test("parceiros sentam alternados: ninguém joga colado no próprio parceiro", () => {
  for (const groups of [[["a1", "a2"], ["b1", "b2"]],
    [["a1", "a2"], ["b1", "b2"], ["c1", "c2"]],
    [["a1", "a2"], ["b1", "b2"], ["c1", "c2"], ["d1", "d2"]]]) {
    const order = interleaveTeams(groups);
    assert.equal(order.length, groups.length * 2);
    const teamOfId = (id) => groups.findIndex((group) => group.includes(id));
    for (let seat = 0; seat < order.length; seat += 1) {
      const next = order[(seat + 1) % order.length]; // a mesa é redonda: o último faz par com o primeiro
      assert.notEqual(teamOfId(order[seat]), teamOfId(next));
    }
  }
});

// ===== Apostas e rodadas =====

test("as apostas dos parceiros somam a meta da dupla e mostram quem falta apostar", () => {
  const players = four();
  const teams = pairs(["a", "d"], ["b", "c"]);
  players[0].bid = 1; // Aerton
  const before = teamTally(teams[0], players);
  assert.equal(before.bid, 1);
  assert.deepEqual(before.pending, ["d"]); // Dudu ainda não apostou
  players[2].bid = 2; // Dudu
  const after = teamTally(teams[0], players);
  assert.equal(after.bid, 3); // Aerton 1 + Dudu 2 = meta 3
  assert.deepEqual(after.pending, []);
});

test("o pé da mesa continua preso à soma GERAL das apostas, não à da dupla", () => {
  // Quatro jogadores, mão de 3 cartas: as apostas individuais de todos contam,
  // independentemente de quem é parceiro de quem.
  assert.deepEqual(validBidOptions(3, [1, 0, 1], true), [0, 2, 3]); // a mesa já apostou 2: o pé não pode apostar 1
  assert.deepEqual(validBidOptions(3, [1, 0, 1], false), [0, 1, 2, 3]);
});

test("as rodadas dos parceiros somam, e um cobre o erro do outro", () => {
  const players = four();
  const teams = pairs(["a", "d"], ["b", "c"]);
  Object.assign(players[0], { bid: 1, wins: 2 }); // Aerton apostou 1 e ganhou 2
  Object.assign(players[2], { bid: 2, wins: 1 }); // Dudu apostou 2 e ganhou 1
  const outcome = teamHandOutcome(teams[0], players);
  assert.equal(outcome.bid, 3);
  assert.equal(outcome.wins, 3);
  assert.equal(outcome.lost, 0); // no clássico os dois teriam perdido 1 vida cada
  assert.equal(outcome.lives, STARTING_LIVES * 2);
  assert.equal(outcome.eliminated, false);
});

test("dupla que erra perde a diferença da EQUIPE, e as vidas nunca ficam negativas", () => {
  const players = four();
  const teams = pairs(["a", "b"]);
  Object.assign(players[0], { bid: 3, wins: 1 });
  Object.assign(players[1], { bid: 1, wins: 1 });
  const outcome = teamHandOutcome(teams[0], players); // apostou 4, fez 2
  assert.equal(outcome.lost, 2);
  assert.equal(outcome.lives, STARTING_LIVES * 2 - 2);

  const dying = pairs(["a", "b"]);
  dying[0].lives = 1;
  Object.assign(players[0], { bid: 4, wins: 0 });
  Object.assign(players[1], { bid: 0, wins: 0 });
  const fatal = teamHandOutcome(dying[0], players);
  assert.equal(fatal.lost, 4);
  assert.equal(fatal.lives, 0); // 1 − 4 não vira −3
  assert.equal(fatal.eliminated, true);
});

// ===== Melada entre parceiros =====

test("cartas iguais de parceiros se anulam e viram narração de melada interna", () => {
  const teams = pairs(["a", "d"], ["b", "c"]);
  const plays = [
    { playerId: "a", card: { id: "A♦", rank: "A", suit: "♦" } },
    { playerId: "d", card: { id: "A♥", rank: "A", suit: "♥" } }, // mesmo parceiro, mesma força
    { playerId: "b", card: { id: "K♣", rank: "K", suit: "♣" } },
    { playerId: "c", card: { id: "5♣", rank: "5", suit: "♣" } },
  ];
  const { winner, melada, meladaPairs } = trickOutcome(plays);
  assert.deepEqual(melada, ["A♦", "A♥"]); // sem proteção entre parceiros
  assert.equal(winner.playerId, "b");     // sobra o K da outra dupla
  const ownGoals = partnerMeladas(meladaPairs, teams);
  assert.equal(ownGoals.length, 1);
  assert.deepEqual(ownGoals[0].playerIds, ["a", "d"]);
  assert.equal(ownGoals[0].team.id, teams[0].id);
});

test("melada entre adversários não é melada de parceiro", () => {
  const teams = pairs(["a", "d"], ["b", "c"]);
  const plays = [
    { playerId: "a", card: { id: "A♦", rank: "A", suit: "♦" } },
    { playerId: "b", card: { id: "A♥", rank: "A", suit: "♥" } },
  ];
  const { meladaPairs } = trickOutcome(plays);
  assert.equal(partnerMeladas(meladaPairs, teams).length, 0);
  assert.equal(partnerMeladas(meladaPairs, []).length, 0); // clássico não narra nada disso
});

test("manilhas mantêm a força de sempre no modo em dupla", () => {
  const teams = pairs(["a", "d"], ["b", "c"]);
  const plays = [
    { playerId: "a", card: { id: "3♦", rank: "3", suit: "♦" } },
    { playerId: "b", card: { id: "7♦", rank: "7", suit: "♦" } }, // manilha mais fraca
    { playerId: "d", card: { id: "4♣", rank: "4", suit: "♣" } }, // zap
    { playerId: "c", card: { id: "A♠", rank: "A", suit: "♠" } },
  ];
  const { winner } = trickOutcome(plays);
  assert.equal(winner.playerId, "d");
  assert.ok(cardStrength({ rank: "4", suit: "♣" }) > cardStrength({ rank: "3", suit: "♦" }));
  assert.equal(partnerMeladas(trickOutcome(plays).meladaPairs, teams).length, 0);
});

// ===== Eliminação, vitória e colocação =====

test("os dois parceiros caem juntos e a partida acaba quando resta uma dupla", () => {
  const players = four();
  const teams = pairs(["a", "b"], ["d", "c"]);
  assert.equal(activeTeams(teams, players).length, 2);
  // A dupla zerou: no servidor os dois integrantes são marcados juntos.
  teams[1].eliminated = true;
  teams[1].eliminatedAtRound = 4;
  teams[1].lives = 0;
  for (const member of teamMembers(teams[1], players)) member.eliminated = true;
  assert.ok(players.filter((player) => player.eliminated).length === 2);
  assert.equal(teamIsOut(teams[1], players), true);
  assert.equal(activeTeams(teams, players).length, 1); // sobrou uma dupla → fim de jogo
});

test("dupla continua viva enquanto sobrar um parceiro na mesa", () => {
  const players = four();
  const teams = pairs(["a", "b"], ["d", "c"]);
  players[0].eliminated = true; // Aerton desistiu no meio
  assert.equal(teamIsOut(teams[0], players), false);
  players[1].eliminated = true; // Bia também saiu: aí sim a dupla acabou
  assert.equal(teamIsOut(teams[0], players), true);
});

test("os dois integrantes recebem exatamente a mesma colocação", () => {
  const players = four();
  const teams = pairs(["a", "b"], ["d", "c"]);
  teams[1].eliminated = true;
  teams[1].eliminatedAtRound = 3;
  teams[1].lives = 0;
  const standings = doublesStandingsFrom(teams, players);
  assert.equal(standings.length, 4);
  const byId = Object.fromEntries(standings.map((entry) => [entry.id, entry]));
  assert.equal(byId.a.position, 1);
  assert.equal(byId.b.position, 1); // campeões empatados no 1º
  assert.equal(byId.d.position, 2);
  assert.equal(byId.c.position, 2);
  assert.equal(byId.a.survived, true);
  assert.equal(byId.d.survived, false);
  assert.equal(byId.d.eliminatedAtRound, 3);
});

test("eliminação simultânea usa critério determinístico, não a ordem do array", () => {
  const players = [P("a", "Ana"), P("b", "Bia"), P("c", "Caio"), P("d", "Duda"), P("e", "Enzo"), P("f", "Fabi")];
  const build = () => {
    const teams = createTeams([["a", "b"], ["c", "d"], ["e", "f"]], STARTING_LIVES);
    Object.assign(teams[1], { eliminated: true, eliminatedAtRound: 5, lives: 0 }); // caiu na mesma mão
    Object.assign(teams[2], { eliminated: true, eliminatedAtRound: 5, lives: 0 }); // que esta
    return teams;
  };
  const straight = teamStandingsFrom(build()).map((team) => team.name);
  const reversed = teamStandingsFrom([...build()].reverse()).map((team) => team.name);
  assert.deepEqual(straight, reversed); // mesma classificação, independente da iteração
  assert.equal(straight[0], "DUPLA VERMELHA");   // sobrevivente
  assert.deepEqual(straight.slice(1), ["DUPLA AZUL", "DUPLA VERDE"]); // desempate pelo nome da dupla
});

// ===== Medalhas =====

test("dupla com 4 humanos não premia; com 6 ou 8, os dois integrantes levam a mesma medalha", () => {
  const four4 = [P("a", "Ana"), P("b", "Bia"), P("c", "Caio"), P("d", "Duda")];
  const teams4 = createTeams([["a", "b"], ["c", "d"]], STARTING_LIVES);
  Object.assign(teams4[1], { eliminated: true, eliminatedAtRound: 2, lives: 0 });
  const standings4 = doublesStandingsFrom(teams4, four4);
  assert.equal(medalForPosition(1, standings4.length), null); // 4 humanos: sem pódio (regra atual)
  assert.equal(medalAwardsForStandings(standings4, { online: true, humanCount: 4 }).size, 0);

  const six = ["a", "b", "c", "d", "e", "f"].map((id) => P(id, id.toUpperCase()));
  const teams6 = createTeams([["a", "b"], ["c", "d"], ["e", "f"]], STARTING_LIVES);
  Object.assign(teams6[1], { eliminated: true, eliminatedAtRound: 7, lives: 0 });
  Object.assign(teams6[2], { eliminated: true, eliminatedAtRound: 3, lives: 0 });
  const standings6 = doublesStandingsFrom(teams6, six);
  const awards = medalAwardsForStandings(standings6, { online: true, humanCount: 6 });
  assert.deepEqual(Object.fromEntries(awards), {
    a: "gold", b: "gold",     // os dois campeões
    c: "silver", d: "silver", // a segunda dupla
    e: "bronze", f: "bronze", // a terceira
  });
  assert.equal(medalAwardsForStandings(standings6, { online: false, humanCount: 6 }).size, 0); // solo não premia
});

// ===== Dois baralhos =====

test("dois baralhos dobram as cartas sem confundir as cópias", () => {
  const single = makeDeck();
  assert.equal(single.length, DECK_SIZE);
  const double = makeDeck(2);
  assert.equal(double.length, DECK_SIZE * 2);
  assert.equal(new Set(double.map((card) => card.uid)).size, DECK_SIZE * 2); // cada cópia é única
  assert.equal(new Set(double.map((card) => card.id)).size, DECK_SIZE);      // mas a força é a mesma
  const zaps = double.filter((card) => card.id === "4♣");
  assert.equal(zaps.length, 2);
  assert.equal(cardStrength(zaps[0]), cardStrength(zaps[1]));
});

test("com dois baralhos, ver uma carta não elimina a outra cópia dela", () => {
  const known = [{ id: "3♦", rank: "3", suit: "♦" }];
  assert.equal(remainingDeck(known).filter((card) => card.id === "3♦").length, 0);
  assert.equal(remainingDeck(known, 2).filter((card) => card.id === "3♦").length, 1);
  assert.equal(remainingDeck([], 2).length, DECK_SIZE * 2);
});

test("o tamanho da mão acompanha o baralho escolhido", () => {
  assert.deepEqual(nextHandSize(10, 1, 4), { handSize: 9, direction: -1 });        // 40/4 = 10 é o teto
  assert.deepEqual(nextHandSize(10, 1, 4, DECK_SIZE * 2), { handSize: 11, direction: 1 }); // 80/4 = 20
  assert.deepEqual(nextHandSize(20, 1, 4, DECK_SIZE * 2), { handSize: 19, direction: -1 });
});

test("duas cartas idênticas na mesma vaza melam entre si", () => {
  const plays = [
    { playerId: "a", card: { id: "K♣", uid: "K♣", rank: "K", suit: "♣" } },
    { playerId: "b", card: { id: "K♣", uid: "K♣~2", rank: "K", suit: "♣" } }, // a cópia do 2º baralho
    { playerId: "c", card: { id: "Q♦", uid: "Q♦", rank: "Q", suit: "♦" } },
  ];
  const { winner, melada } = trickOutcome(plays);
  assert.deepEqual(melada, ["K♣", "K♣~2"]); // a melada aponta a CÓPIA, não só a face
  assert.equal(winner.playerId, "c");
});
