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

// Cartas de força idêntica melam. Entre as que sobram, ganha a mais forte.
export function trickWinner(plays) {
  const withStrength = plays.map((play) => ({ ...play, strength: cardStrength(play.card) }));
  const counts = new Map();
  for (const play of withStrength) counts.set(play.strength, (counts.get(play.strength) || 0) + 1);
  const valid = withStrength.filter((play) => counts.get(play.strength) === 1);
  if (!valid.length) return null;
  return valid.reduce((best, play) => (play.strength > best.strength ? play : best));
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
