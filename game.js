export const SUITS = ["♦", "♠", "♥", "♣"];
export const RANKS = ["4", "5", "6", "7", "Q", "J", "K", "A", "2", "3"];
export const FIXED_MANILHAS = ["7♦", "A♠", "7♥", "4♣"];

export const DECK_SIZE = RANKS.length * SUITS.length;

// A mesa pode usar um ou dois baralhos. O `id` continua sendo a identidade da carta
// (força, manilha, desenho); o `uid` distingue as cópias entre si — sem ele, duas
// cartas iguais na mesma vaza seriam o mesmo objeto para a melada e para a animação.
export function makeDeck(copies = 1) {
  const decks = Math.max(1, Math.floor(Number(copies) || 1));
  return Array.from({ length: decks }, (_, copy) => RANKS.flatMap((rank) => SUITS.map((suit) => ({
    id: `${rank}${suit}`,
    uid: copy === 0 ? `${rank}${suit}` : `${rank}${suit}~${copy + 1}`,
    rank,
    suit,
  })))).flat();
}

export const cardId = (card) => card?.id ?? `${card?.rank}${card?.suit}`;
export const cardUid = (card) => card?.uid ?? cardId(card);

export function shuffle(deck, random = Math.random) {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function isManilha(card) {
  return FIXED_MANILHAS.includes(card?.id ?? `${card?.rank}${card?.suit}`);
}

export function cardStrength(card) {
  const manilha = FIXED_MANILHAS.indexOf(card?.id ?? `${card?.rank}${card?.suit}`);
  if (manilha >= 0) return 100 + manilha;
  return RANKS.indexOf(card.rank);
}

// Cartas do baralho que ainda podem estar com os oponentes (baralho − conhecidas).
// Com dois baralhos a conta é por quantidade: ver um 3♦ não elimina a outra cópia dele.
export function remainingDeck(known, copies = 1) {
  const seen = new Map();
  for (const card of known || []) {
    const id = cardId(card);
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  return makeDeck(copies).filter((card) => {
    const left = seen.get(card.id) || 0;
    if (left <= 0) return true;
    seen.set(card.id, left - 1);
    return false;
  });
}

// Fração das cartas desconhecidas que empatam/superam a carta (empate pesa metade,
// porque cartas de mesma força melam aos pares).
function lossFraction(card, unknown) {
  const total = unknown.length || 1;
  const strength = cardStrength(card);
  let loss = 0;
  for (const other of unknown) {
    const os = cardStrength(other);
    if (os > strength) loss += 1;
    else if (os === strength) loss += 0.5;
  }
  return loss / total;
}

// Prob. aproximada de uma carta ganhar a vaza contra N oponentes com cartas
// aleatórias — usada na APOSTA (antes de qualquer jogada/intenção conhecida).
export function cardWinProbability(card, unknown, opponents) {
  if (opponents <= 0) return 1;
  return Math.pow(Math.max(0, 1 - lossFraction(card, unknown)), opponents);
}

// Aposta sugerida: soma das probabilidades de cada carta ganhar sua vaza,
// escalando com o nº de oponentes. Corrige o 3 (não é imbatível) e valoriza manilhas.
export function suggestedBid(hand, difficulty, playerCount, copies = 1) {
  if (difficulty === "easy") return null;
  const opponents = Math.max(1, playerCount - 1);
  const unknown = remainingDeck(hand, copies);
  const expected = hand.reduce((sum, card) => sum + cardWinProbability(card, unknown, opponents), 0);
  return Math.min(hand.length, Math.round(expected));
}

const BOT_ID = "__bot__";

// Escolhe a carta do bot mirando ACERTAR a aposta, lendo a vaza e a intenção dos
// oponentes que jogam depois. `after` = [{ needsMore, cardsLeft }] desses oponentes;
// `unknown` = cartas que ainda podem estar com eles (com memória de mão, no difícil).
export function chooseBotPlay({ hand, bid = 0, wins = 0, table = [], after = [], unknown = [] }) {
  const cards = [...hand].sort((a, b) => cardStrength(a) - cardStrength(b)); // fraca → forte
  if (cards.length <= 1) return cards[0];
  const need = bid - wins;
  const cardsLeft = cards.length;
  const leading = table.length === 0;

  // Faminto (precisa ganhar) cobre cartas fortes; cheio (já se garantiu) larga baixo.
  const contestFactor = (opponent) => opponent.needsMore <= 0 ? 0.15
    : opponent.needsMore >= opponent.cardsLeft ? 0.95 : 0.55;
  const beatChance = (card, opponent) => {
    const holdsStronger = 1 - Math.pow(Math.max(0, 1 - lossFraction(card, unknown)), Math.max(1, opponent.cardsLeft));
    return contestFactor(opponent) * holdsStronger;
  };
  const surviveAfter = (card) => after.reduce((prob, opponent) => prob * (1 - beatChance(card, opponent)), 1);

  // Prob. de a carta ganhar a vaza: precisa liderar a mesa atual e sobreviver a quem falta.
  const winProb = (card) => {
    if (!leading && trickWinner([...table, { playerId: BOT_ID, card }])?.playerId !== BOT_ID) return 0;
    return surviveAfter(card);
  };
  const evald = cards.map((card) => ({ card, strength: cardStrength(card), prob: winProb(card) }));

  // Já bateu a meta → quer PERDER. Pega a menor prob de vitória; entre elas, larga a
  // carta mais forte que ainda assim não deve ganhar (livra-se do perigo com segurança).
  // Se todos os oponentes estão cheios, a menor prob costuma ser a carta mais fraca —
  // então joga baixo em vez de largar uma forte que passaria batido.
  if (need <= 0) {
    const minProb = Math.min(...evald.map((entry) => entry.prob));
    return evald.filter((entry) => entry.prob <= minProb + 0.02)
      .reduce((best, entry) => (entry.strength > best.strength ? entry : best)).card;
  }

  // Precisa ganhar TODAS as restantes → joga a de maior prob (desempate: mais forte).
  if (need >= cardsLeft) {
    return evald.reduce((best, entry) =>
      (entry.prob > best.prob || (entry.prob === best.prob && entry.strength > best.strength)) ? entry : best).card;
  }

  // Precisa de ALGUMAS vitórias → ganha com a mais fraca confiável (reserva as fortes,
  // menos previsível); sem vitória confiável, larga baixo e tenta depois.
  const reliable = evald.filter((entry) => entry.prob >= 0.45).sort((a, b) => a.strength - b.strength);
  if (reliable.length) return reliable[0].card;
  if (!leading) {
    const winners = evald.filter((entry) => entry.prob > 0).sort((a, b) => a.strength - b.strength);
    if (winners.length) return winners[0].card;
  }
  return cards[0];
}

// Cartas de força idêntica melam AOS PARES, na ordem em que foram jogadas.
// Grupo com quantidade par: todas melam. Ímpar: a última jogada sobrevive.
// Ex.: 3 cartas iguais → as 2 primeiras melam e a 3ª continua valendo.
// Entre as cartas que sobram, ganha a mais forte.
export function trickOutcome(plays) {
  const withStrength = plays.map((play, index) => ({ ...play, index, strength: cardStrength(play.card) }));
  const groups = new Map();
  for (const play of withStrength) {
    const group = groups.get(play.strength) || [];
    group.push(play);
    groups.set(play.strength, group);
  }
  const melada = [];
  const meladaPairs = []; // quem anulou quem, aos pares — usado para narrar a melada entre parceiros
  const survivors = [];
  for (const group of groups.values()) {
    const ordered = group.sort((a, b) => a.index - b.index);
    const canceled = ordered.length - (ordered.length % 2);
    for (let i = 0; i < canceled; i += 2) {
      melada.push(cardUid(ordered[i].card), cardUid(ordered[i + 1].card));
      meladaPairs.push({
        playerIds: [ordered[i].playerId, ordered[i + 1].playerId],
        cards: [ordered[i].card, ordered[i + 1].card],
      });
    }
    if (ordered.length % 2 === 1) survivors.push(ordered.at(-1));
  }
  const best = survivors.length ? survivors.reduce((top, play) => (play.strength > top.strength ? play : top)) : null;
  return {
    winner: best ? { playerId: best.playerId, card: best.card, strength: best.strength } : null,
    melada,
    meladaPairs,
  };
}

export function trickWinner(plays) {
  return trickOutcome(plays).winner;
}

// Distribui uma rodada considerando o "bolo" acumulado por rodadas que melaram inteiras.
// - Rodada com vencedor: ele leva 1 + bolo; o bolo zera; vira a referência de desempate.
// - Rodada melada: acumula 1 no bolo e a próxima vale mais.
// - Se a mão acabar (lastTrick) ainda melada, o bolo vai para quem venceu a última
//   rodada antes da melada (lastWinnerId). Sem ninguém antes, o bolo é descartado.
export function resolveTrickScore({ pot = 0, lastWinnerId = null }, winnerId, lastTrick) {
  if (winnerId) {
    const took = 1 + pot;
    return { credit: { playerId: winnerId, amount: took }, pot: 0, lastWinnerId: winnerId, took, potWinnerId: null, potAmount: 0 };
  }
  const accumulated = pot + 1;
  if (lastTrick && lastWinnerId) {
    return { credit: { playerId: lastWinnerId, amount: accumulated }, pot: 0, lastWinnerId, took: 0, potWinnerId: lastWinnerId, potAmount: accumulated };
  }
  return { credit: null, pot: lastTrick ? 0 : accumulated, lastWinnerId, took: 0, potWinnerId: null, potAmount: 0 };
}

export function nextHandSize(current, direction, activePlayers, deckSize = DECK_SIZE) {
  const maximum = Math.max(1, Math.floor(deckSize / activePlayers));
  if (direction === -1 && current <= 1) {
    return { handSize: Math.min(2, maximum), direction: 1 };
  }
  if (direction === 1 && current >= maximum) {
    return { handSize: Math.max(1, current - 1), direction: -1 };
  }
  return { handSize: current + direction, direction };
}

export function validBidOptions(handSize, previousBids, isLast) {
  const options = Array.from({ length: handSize + 1 }, (_, bid) => bid);
  if (!isLast) return options;
  const total = previousBids.reduce((sum, bid) => sum + bid, 0);
  return options.filter((bid) => total + bid !== handSize);
}

// Quantas partidas seguidas (contando a mais recente) o mesmo nome venceu.
export function winStreak(results, name) {
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === name; i -= 1) streak += 1;
  return streak;
}

// Ranking da sala: nomes ordenados por número de vitórias (desempate alfabético).
export function rankingFrom(results) {
  const wins = {};
  for (const name of results) wins[name] = (wins[name] || 0) + 1;
  return Object.entries(wins)
    .map(([name, count]) => ({ name, wins: count }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
}

// Classificação de UMA partida: quem sobrevive fica em primeiro; entre os
// eliminados, quem caiu por último fica acima. Empates na mesma mão usam as
// vidas restantes como desempate, para a tabela continuar legível.
export function finalStandingsFrom(players) {
  const seated = players.filter((player) => !player.spectator);
  const survivors = seated
    .filter((player) => !player.eliminated)
    .sort((a, b) => b.lives - a.lives || a.name.localeCompare(b.name, "pt-BR"));
  const eliminated = seated
    .filter((player) => player.eliminated)
    .sort((a, b) => (b.eliminatedAtRound ?? -1) - (a.eliminatedAtRound ?? -1)
      || b.lives - a.lives
      || a.name.localeCompare(b.name, "pt-BR"));

  return [...survivors, ...eliminated].map((player, index) => ({
    position: index + 1,
    id: player.id,
    name: player.name,
    lives: Math.max(0, player.lives),
    survived: !player.eliminated,
    eliminatedAtRound: player.eliminatedAtRound ?? null,
  }));
}

// ===== SE FODE JUNTO — DUPLAS =====
// A modalidade é só um rótulo na sala: as regras de força, melada, bolo e aposta
// continuam as mesmas. O que muda é de quem são as vidas (da dupla), como a meta
// é formada (soma das apostas dos parceiros) e quem é eliminado (os dois juntos).
export const GAME_MODES = { CLASSIC: "classic", DOUBLES: "doubles" };
export const TEAM_SIZE = 2;
export const DOUBLES_PLAYER_COUNTS = [4, 6, 8];
export const DOUBLES_SETUP_MESSAGE = "O modo em dupla precisa de 4, 6 ou 8 jogadores.";
export const DOUBLES_TEAMS_MESSAGE = "Cada dupla precisa de exatamente dois jogadores, e ninguém pode ficar de fora.";
// Cor + símbolo + nome: a dupla nunca é identificada só pela cor (acessibilidade).
export const TEAM_PALETTE = [
  { key: "vermelha", label: "VERMELHA", name: "DUPLA VERMELHA", color: "#e2564a", symbol: "🔴" },
  { key: "azul", label: "AZUL", name: "DUPLA AZUL", color: "#4b8ee0", symbol: "🔵" },
  { key: "verde", label: "VERDE", name: "DUPLA VERDE", color: "#46a878", symbol: "🟢" },
  { key: "amarela", label: "AMARELA", name: "DUPLA AMARELA", color: "#d7a531", symbol: "🟡" },
];

// Sala antiga, registro salvo antes desta versão ou payload sem modalidade: clássico.
export function normalizeGameMode(value) {
  return value === GAME_MODES.DOUBLES ? GAME_MODES.DOUBLES : GAME_MODES.CLASSIC;
}
export const isDoublesMode = (value) => normalizeGameMode(value) === GAME_MODES.DOUBLES;

// Mesa em dupla só fecha com 4, 6 ou 8: par, com no mínimo duas duplas completas.
export function doublesSetupError(playerCount) {
  return DOUBLES_PLAYER_COUNTS.includes(playerCount) ? null : DOUBLES_SETUP_MESSAGE;
}

export function randomTeamGroups(playerIds, random = Math.random) {
  const shuffled = shuffle(playerIds, random);
  const groups = [];
  for (let index = 0; index < shuffled.length; index += TEAM_SIZE) groups.push(shuffled.slice(index, index + TEAM_SIZE));
  return groups;
}

// Validação da escalação manual — a mesma roda no servidor, que é a autoridade:
// duplas completas, ninguém de fora, ninguém em duas duplas, ninguém inventado.
export function teamGroupsError(playerIds, groups) {
  if (!Array.isArray(groups) || groups.length !== playerIds.length / TEAM_SIZE) return DOUBLES_TEAMS_MESSAGE;
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== TEAM_SIZE) return DOUBLES_TEAMS_MESSAGE;
    for (const id of group) {
      if (!playerIds.includes(id) || seen.has(id)) return DOUBLES_TEAMS_MESSAGE;
      seen.add(id);
    }
  }
  return seen.size === playerIds.length ? null : DOUBLES_TEAMS_MESSAGE;
}

// A reserva da dupla é a soma do que dois jogadores teriam no clássico — a constante
// de vidas continua vindo de fora, para não existir um "10" solto no código.
export function createTeams(groups, startingLives) {
  return groups.map((playerIds, index) => ({
    ...TEAM_PALETTE[index % TEAM_PALETTE.length],
    id: `team-${index + 1}`,
    index,
    playerIds: [...playerIds],
    lives: startingLives * TEAM_SIZE,
    eliminated: false,
    eliminatedAtRound: null,
    position: null,
  }));
}

export function teamOf(teams, playerId) {
  return (teams || []).find((team) => team.playerIds.includes(playerId)) || null;
}

export function teamMembers(team, players) {
  return (team?.playerIds || []).map((id) => (players || []).find((player) => player.id === id)).filter(Boolean);
}

// Meta e resultado da dupla são DERIVADOS dos parceiros: nada é guardado em dobro.
export function teamTally(team, players) {
  const members = teamMembers(team, players);
  return {
    bid: members.reduce((sum, player) => sum + (player.bid ?? 0), 0),
    wins: members.reduce((sum, player) => sum + (player.wins || 0), 0),
    pending: members.filter((player) => player.bid == null && !player.eliminated && !player.spectator).map((player) => player.id),
    members,
  };
}

// Dano da mão: a diferença é da DUPLA, não de cada jogador. Vidas nunca ficam negativas.
export function teamHandOutcome(team, players) {
  const { bid, wins } = teamTally(team, players);
  const lost = Math.abs(bid - wins);
  const lives = Math.max(0, team.lives - lost);
  return { bid, wins, lost, lives, eliminated: team.lives - lost <= 0 };
}

export function teamLabel(team, players) {
  const names = teamMembers(team, players).map((player) => player.name);
  return names.length ? names.join(" + ") : team?.name || "Dupla";
}

// Parceiros se sentam alternados: a1, b1, c1, a2, b2, c2 — ninguém joga colado no
// próprio parceiro (nem no fecho da roda), em qualquer quantidade de duplas.
export function interleaveTeams(groups) {
  const order = [];
  for (let seat = 0; seat < TEAM_SIZE; seat += 1) {
    for (const group of groups) if (group[seat]) order.push(group[seat]);
  }
  return order;
}

// A dupla sai do jogo quando zera as vidas OU quando os dois integrantes já saíram
// (desistência de ambos). Enquanto sobrar um parceiro de pé, a dupla segue jogando.
export function teamIsOut(team, players) {
  if (team.eliminated) return true;
  const members = teamMembers(team, players);
  return members.length > 0 && members.every((player) => player.eliminated || player.spectator);
}

export function activeTeams(teams, players) {
  return (teams || []).filter((team) => !teamIsOut(team, players));
}

// Classificação por DUPLA, com o mesmo critério do clássico e sem depender da ordem
// de iteração: sobreviventes primeiro (mais vidas acima); entre as eliminadas, quem
// caiu por último fica acima; empate na mesma mão desempata por vidas e, por fim,
// pelo nome da dupla (estável e determinístico).
export function teamStandingsFrom(teams) {
  const survivors = (teams || []).filter((team) => !team.eliminated)
    .sort((a, b) => b.lives - a.lives || a.name.localeCompare(b.name, "pt-BR"));
  const eliminated = (teams || []).filter((team) => team.eliminated)
    .sort((a, b) => (b.eliminatedAtRound ?? -1) - (a.eliminatedAtRound ?? -1)
      || b.lives - a.lives
      || a.name.localeCompare(b.name, "pt-BR"));
  return [...survivors, ...eliminated].map((team, index) => ({ ...team, position: index + 1 }));
}

// Mesma forma de saída do finalStandingsFrom, para o resto do sistema (medalhas,
// histórico, pódio) não precisar saber se a partida foi em dupla: os dois parceiros
// recebem exatamente a mesma colocação.
export function doublesStandingsFrom(teams, players) {
  return teamStandingsFrom(teams).flatMap((team) => teamMembers(team, players)
    .filter((player) => !player.spectator)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((player) => ({
      position: team.position,
      id: player.id,
      name: player.name,
      lives: Math.max(0, team.lives),
      survived: !team.eliminated,
      eliminatedAtRound: team.eliminatedAtRound ?? null,
      teamId: team.id,
      teamName: team.name,
    })));
}

// Melada entre parceiros: só conta quando as duas cartas anuladas são da MESMA dupla.
export function partnerMeladas(meladaPairs, teams) {
  return (meladaPairs || [])
    .map((pair) => {
      const team = teamOf(teams, pair.playerIds[0]);
      return team && team.playerIds.includes(pair.playerIds[1]) ? { team, playerIds: pair.playerIds, cards: pair.cards } : null;
    })
    .filter(Boolean);
}

// ===== Ranking global por medalhas =====
// Só partidas com cinco ou mais contas humanas valem pódio. Bots não entram na
// contagem nem recebem medalha. A colocação já é calculada no fim da partida,
// portanto quem sair depois de ter ficado no top 3 mantém sua medalha.
export function medalForPosition(position, humanCount) {
  if (humanCount < 5 || !Number.isInteger(position)) return null;
  return ["gold", "silver", "bronze"][position - 1] || null;
}

// Mantém a regra de premiação em um único lugar para todos os modos online.
// `humanCount` pode ser a escalação inicial do torneio; nas partidas comuns é
// a quantidade de humanos que terminou a partida. Solo nunca distribui nada.
export function medalAwardsForStandings(standings, { online = false, humanCount = 0 } = {}) {
  const awards = new Map();
  if (!online) return awards;
  for (const entry of standings || []) {
    const medal = medalForPosition(entry.position, humanCount);
    if (medal && entry.id) awards.set(entry.id, medal);
  }
  return awards;
}

// A escalação humana do torneio não muda entre as partidas. Além de definir
// se o pódio é válido, ela permite recolocar quem saiu entre uma partida e a
// próxima na mesma vaga — sem zerar suas medalhas já conquistadas.
export function tournamentHumanCount(participants) {
  return Object.values(participants || {}).filter((participant) => participant?.userId).length;
}

export function tournamentParticipantIdForUser(playerIds, participants, userId) {
  if (!userId) return null;
  return (playerIds || []).find((playerId) => participants?.[playerId]?.userId === userId) || null;
}

// Queda não é desistência. Enquanto a pessoa ainda estiver viva e não tiver
// sido expulsa, ela pode reassumir sua cadeira e a mão que estava em curso.
export function canResumeAsPlayer(player) {
  return Boolean(player
    && !player.isBot
    && !player.connected
    && !player.expelled
    && !player.eliminated
    && !player.quit
    && player.lives > 0
    && player.resumeToken);
}

// Banners liberados pelas vitórias online. Recebe o catálogo (cada banner
// conquistável tem um limiar em `wins`); exclusivos/automáticos não entram.
export function unlockedBannerKeys(onlineWins, banners) {
  return (banners || []).filter((banner) => Number.isInteger(banner.wins) && onlineWins >= banner.wins).map((banner) => banner.key);
}

export function tournamentStandingsFrom(entries) {
  return [...entries]
    .sort((a, b) => (b.goldMedals || 0) - (a.goldMedals || 0)
      || (b.silverMedals || 0) - (a.silverMedals || 0)
      || (b.bronzeMedals || 0) - (a.bronzeMedals || 0)
      || (b.wins || 0) - (a.wins || 0)
      || (a.lastPosition ?? Infinity) - (b.lastPosition ?? Infinity)
      || a.name.localeCompare(b.name, "pt-BR"))
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}
