export const SUITS = ["♦", "♠", "♥", "♣"];
export const RANKS = ["4", "5", "6", "7", "Q", "J", "K", "A", "2", "3"];
export const FIXED_MANILHAS = ["7♦", "A♠", "7♥", "4♣"];

export function makeDeck() {
  return RANKS.flatMap((rank) => SUITS.map((suit) => ({
    id: `${rank}${suit}`,
    rank,
    suit,
  })));
}

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
export function remainingDeck(known) {
  const ids = new Set((known || []).map((card) => card.id ?? `${card.rank}${card.suit}`));
  return makeDeck().filter((card) => !ids.has(card.id));
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
export function suggestedBid(hand, difficulty, playerCount) {
  if (difficulty === "easy") return null;
  const opponents = Math.max(1, playerCount - 1);
  const unknown = remainingDeck(hand);
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
  const survivors = [];
  for (const group of groups.values()) {
    const ordered = group.sort((a, b) => a.index - b.index);
    const canceled = ordered.length - (ordered.length % 2);
    for (let i = 0; i < canceled; i += 1) melada.push(ordered[i].card.id);
    if (ordered.length % 2 === 1) survivors.push(ordered.at(-1));
  }
  const best = survivors.length ? survivors.reduce((top, play) => (play.strength > top.strength ? play : top)) : null;
  return {
    winner: best ? { playerId: best.playerId, card: best.card, strength: best.strength } : null,
    melada,
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

export function nextHandSize(current, direction, activePlayers) {
  const maximum = Math.max(1, Math.floor(40 / activePlayers));
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

// Pontos do Torneio Rankeado: a vitória vale um ponto extra, e ninguém sai
// de uma partida sem pontuar. Ex.: 4 jogadores → 5, 3, 2 e 1 ponto.
// (Usado só para decidir a classificação DENTRO do torneio.)
export function tournamentPoints(position, playerCount) {
  if (!Number.isInteger(position) || position < 1 || position > playerCount) return 0;
  return position === 1 ? playerCount + 1 : Math.max(1, playerCount - position + 1);
}

// ===== Pontos de ranking global (separados por modo, escalam com a mesa) =====
// Partida Rápida: só pontua com 3+ humanos; top 3 leva (nº humanos − posição + 1).
// Ex.: mesa de 3 → 3/2/1; mesa de 8 → 8/7/6.
export function casualPoints(position, humanCount) {
  if (humanCount < 3 || !Number.isInteger(position) || position > 3) return 0;
  return humanCount - position + 1;
}

// Torneio: pontua só a classificação final, com 3+ humanos; top 5 leva
// (nº humanos − posição + 1) × 3 (peso de torneio). Ex.: 3 jog → 9/6/3; 8 jog → 24/21/18/15/12.
export function tournamentRankPoints(position, humanCount) {
  if (humanCount < 3 || !Number.isInteger(position) || position > 5) return 0;
  return (humanCount - position + 1) * 3;
}

// Banners liberados pelas vitórias online. Recebe o catálogo (cada banner
// conquistável tem um limiar em `wins`); exclusivos/automáticos não entram.
export function unlockedBannerKeys(onlineWins, banners) {
  return (banners || []).filter((banner) => Number.isInteger(banner.wins) && onlineWins >= banner.wins).map((banner) => banner.key);
}

export function tournamentStandingsFrom(entries) {
  return [...entries]
    .sort((a, b) => b.points - a.points
      || b.wins - a.wins
      || (a.lastPosition ?? Infinity) - (b.lastPosition ?? Infinity)
      || a.name.localeCompare(b.name, "pt-BR"))
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}
