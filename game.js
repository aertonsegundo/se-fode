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

export function suggestedBid(hand, difficulty, playerCount) {
  if (difficulty === "easy") return null;
  const strengths = hand.map(cardStrength);
  if (difficulty === "normal") {
    return strengths.filter((strength) => strength >= 8).length;
  }
  const opponents = Math.max(1, playerCount - 1);
  const expected = strengths.reduce((sum, strength) => {
    if (strength === 103) return sum + 1;
    if (strength >= 100) return sum + ((strength - 99) / 4) ** opponents;
    return sum + ((strength + 1) / 10) ** opponents;
  }, 0);
  return Math.min(hand.length, Math.round(expected));
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
