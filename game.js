export const SUITS = ["♦", "♠", "♥", "♣"];
export const RANKS = ["4", "5", "6", "7", "Q", "J", "K", "A", "2", "3"];

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

export function manilhaRank(vira) {
  return RANKS[(RANKS.indexOf(vira.rank) + 1) % RANKS.length];
}

export function cardStrength(card, vira) {
  const manilha = manilhaRank(vira);
  if (card.rank === manilha) return 100 + SUITS.indexOf(card.suit);
  return RANKS.indexOf(card.rank);
}

// Cartas de força idêntica melam. Entre as que sobram, ganha a mais forte.
export function trickWinner(plays, vira) {
  const withStrength = plays.map((play) => ({ ...play, strength: cardStrength(play.card, vira) }));
  const counts = new Map();
  for (const play of withStrength) counts.set(play.strength, (counts.get(play.strength) || 0) + 1);
  const valid = withStrength.filter((play) => counts.get(play.strength) === 1);
  if (!valid.length) return null;
  return valid.reduce((best, play) => (play.strength > best.strength ? play : best));
}

export function nextHandSize(current, direction, activePlayers) {
  const maximum = Math.max(1, Math.floor(39 / activePlayers));
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
