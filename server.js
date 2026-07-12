import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeDeck, shuffle, FIXED_MANILHAS, cardStrength, trickWinner, trickOutcome, resolveTrickScore, nextHandSize, validBidOptions, suggestedBid, winStreak, rankingFrom, finalStandingsFrom, tournamentPoints, tournamentStandingsFrom } from "./game.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const STARTING_LIVES = 5;
const BOT_NAMES = ["Bot Fodão", "Bot do Caos", "Bot Sem Freio", "Bot Pé Frio", "Bot Trambique", "Bot Carrasco", "Bot Zé Manilha"];
const EMOTES = { joia: "👍", estiloso: "😎", raiva: "😡", medo: "😨", choro: "😭", lingua: "😝", sorriso: "😁", risada: "🤣", ideia: "💡", fepe: "🍾", victin: "😐", chico: "🤠", muriloejp: "👬", rtn: "🫡" };

// Sem cache "esquecido": o navegador sempre revalida html/css/js, então um novo
// deploy nunca fica preso numa versao antiga em cache no cliente.
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
const cleanChat = (value) => String(value || "").replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const cleanCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const roomCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  while (rooms.has(code));
  return code;
};

function notice(socket, text) {
  socket.emit("notice", text);
}

function activePlayers(room) {
  return room.players.filter((player) => !player.eliminated && !player.spectator);
}

function seatedPlayers(room) {
  // Quem ocupa cadeira na mesa (jogadores da partida, inclusive eliminados) — exclui só espectadores.
  return room.players.filter((player) => !player.spectator);
}

function tournamentStandings(room) {
  if (!room.tournament) return [];
  return tournamentStandingsFrom(room.tournament.playerIds
    .map((id) => {
      const player = playerById(room, id);
      const score = room.tournament.scores[id];
      return player && score ? { id, name: player.name, ...score } : null;
    })
    .filter(Boolean));
}

function tournamentState(room) {
  if (!room.tournament) return null;
  return {
    totalGames: room.tournament.totalGames,
    completedGames: room.tournament.completedGames,
    finished: room.tournament.finished,
    standings: tournamentStandings(room),
  };
}

function playerById(room, id) {
  return room.players.find((player) => player.id === id);
}

function sendSession(socket, room, player) {
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  player.socketId = socket.id;
  player.connected = true;
  socket.emit("session", { code: room.code, playerId: player.id, resumeToken: player.resumeToken });
  socket.emit("chat-history", room.chat);
}

function transferHost(room) {
  const host = playerById(room, room.hostId);
  if (host?.connected) return;
  const replacement = room.players.find((player) => !player.isBot && player.connected && !player.spectator)
    || room.players.find((player) => !player.isBot && player.connected);
  if (replacement) room.hostId = replacement.id;
}

function orderedFrom(room, startId) {
  const active = activePlayers(room);
  const index = active.findIndex((player) => player.id === startId);
  return index < 0 ? active : [...active.slice(index), ...active.slice(0, index)];
}

function publicState(room, viewerId) {
  const viewer = playerById(room, viewerId);
  const forehead = room.handSize === 1;
  const ranking = rankingFrom(room.results);
  const lastResult = room.phase === "game_over" && room.lastWinnerName
    ? {
        name: room.lastWinnerName,
        streak: winStreak(room.results, room.lastWinnerName),
        wins: ranking.find((entry) => entry.name === room.lastWinnerName)?.wins || 1,
      }
    : null;
  return {
    ranking,
    matchStandings: room.phase === "game_over" ? finalStandingsFrom(seatedPlayers(room)) : [],
    tournament: tournamentState(room),
    lastResult,
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    dealerId: room.dealerId,
    turnId: room.turnId,
    handSize: room.handSize,
    round: room.round,
    trick: room.trick,
    manilhas: FIXED_MANILHAS,
    message: room.message,
    trickResult: room.trickResult,
    roundLosers: room.roundLosers,
    melada: trickOutcome(room.table).melada,
    pot: room.pot,
    botDifficulty: room.botDifficulty,
    solo: room.solo,
    players: seatedPlayers(room).map((player) => ({
      id: player.id,
      name: player.name,
      lives: player.lives,
      bid: player.bid,
      wins: player.wins,
      roundLoss: player.roundLoss ?? null,
      eliminated: player.eliminated,
      connected: player.connected,
      auto: Boolean(player.auto),
      isBot: Boolean(player.isBot),
      cardCount: player.hand.length,
      foreheadCard: forehead && player.id !== viewerId ? player.hand[0] : null,
    })),
    spectators: room.players.filter((player) => player.spectator).map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
    })),
    me: viewer ? {
      id: viewer.id,
      name: viewer.name,
      hand: forehead ? [] : viewer.hand,
      hasForeheadCard: forehead && viewer.hand.length === 1,
      spectator: Boolean(viewer.spectator),
    } : null,
    table: room.table,
    bidOrder: room.bidOrder,
    allowedBids: room.phase === "bidding" && room.turnId === viewerId ? validBids(room, viewerId) : [],
    history: room.history.slice(-5),
  };
}

function broadcast(room) {
  for (const player of room.players) {
    if (!player.isBot && player.connected && player.socketId) io.to(player.socketId).emit("state", publicState(room, player.id));
  }
  scheduleAutomaticTurn(room);
}

function newRoom(code, host) {
  return {
    code,
    hostId: host.id,
    players: [host],
    phase: "lobby",
    dealerId: null,
    turnId: null,
    bidOrder: [],
    handSize: 1,
    direction: 1,
    round: 0,
    trick: 0,
    table: [],
    history: [],
    chat: [],
    trickResult: null,
    roundLosers: [],
    pot: 0,
    lastWinnerId: null,
    resetHand: false,
    botDifficulty: "normal",
    solo: false,
    results: [], // nomes dos vencedores, em ordem (partidas sem vencedor não entram)
    lastWinnerName: null, // vencedor da última partida terminada (null se ninguém venceu)
    tournament: null,
    autoTurnId: null,
    cleanupTimer: null,
    revealTimer: null,
    message: "Esperando a turma chegar.",
  };
}

function createPlayer(socket, name) {
  return { id: randomUUID(), socketId: socket.id, resumeToken: randomUUID(), name, lives: STARTING_LIVES, bid: null, wins: 0, roundLoss: null, eliminated: false, eliminatedAtRound: null, connected: true, auto: false, hand: [] };
}

function createBot(code, index) {
  return { id: `bot-${code}-${index}`, name: BOT_NAMES[index], lives: STARTING_LIVES, bid: null, wins: 0, roundLoss: null, eliminated: false, eliminatedAtRound: null, connected: true, isBot: true, hand: [] };
}

function validBids(room, playerId) {
  const previousBids = activePlayers(room)
    .filter((player) => player.id !== playerId && player.bid != null)
    .map((player) => player.bid);
  return validBidOptions(room.handSize, previousBids, room.bidOrder.at(-1) === playerId);
}

function submitBid(room, playerId, rawBid) {
  if (!room || room.phase !== "bidding" || room.turnId !== playerId) return "Não é sua vez de apostar.";
  const bid = Number(rawBid);
  if (!Number.isInteger(bid) || !validBids(room, playerId).includes(bid)) {
    return room.bidOrder.at(-1) === playerId
      ? `Como pé da mesa, a soma não pode dar ${room.handSize}.`
      : "Aposta inválida.";
  }
  playerById(room, playerId).bid = bid;
  advanceBid(room);
  return null;
}

function submitPlay(room, playerId, cardId) {
  if (!room || room.phase !== "playing" || room.turnId !== playerId) return "Não é sua vez de jogar.";
  const player = playerById(room, playerId);
  const index = room.handSize === 1 ? 0 : player.hand.findIndex((card) => card.id === cardId);
  if (index < 0) return "Essa carta não está na sua mão.";
  const [card] = player.hand.splice(index, 1);
  room.table.push({ playerId: player.id, card });
  advancePlay(room);
  return null;
}

function chooseBotBid(room, bot) {
  const choices = validBids(room, bot.id);
  if (room.botDifficulty === "easy") return choices[Math.floor(Math.random() * choices.length)];
  const target = suggestedBid(bot.hand, room.botDifficulty, activePlayers(room).length);
  return choices.reduce((best, bid) => {
    const distance = Math.abs(bid - target);
    const bestDistance = Math.abs(best - target);
    return distance < bestDistance || (distance === bestDistance && bid > best) ? bid : best;
  });
}

function chooseBotCard(room, bot) {
  const cards = [...bot.hand].sort((a, b) => cardStrength(a) - cardStrength(b));
  if (room.botDifficulty === "easy") return cards[Math.floor(Math.random() * cards.length)];
  if (bot.wins >= bot.bid) return cards[0];
  if (room.botDifficulty === "hard" && room.table.length) {
    const winning = cards.find((card) => trickWinner([...room.table, { playerId: bot.id, card }])?.playerId === bot.id);
    if (winning) return winning;
  }
  return cards.at(-1);
}

const HUMAN_TURN_MS = 20000; // tempo do jogador online antes do modo automático assumir
const RECONNECT_GRACE_MS = 15000; // tempo pra reconectar antes de um bot assumir a vaga de vez

function playAutomatically(room, player) {
  if (room.turnId !== player.id || player.eliminated) return;
  if (room.phase === "bidding") return submitBid(room, player.id, chooseBotBid(room, player));
  if (room.phase === "playing") submitPlay(room, player.id, chooseBotCard(room, player)?.id);
}

function scheduleAutomaticTurn(room) {
  // Descarta um timer preso de um turno que já passou.
  if (room.botTimer && room.autoTurnId !== room.turnId) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.autoTurnId = null;
  }
  if (room.botTimer) return; // já agendado para o turno atual
  if (room.phase !== "bidding" && room.phase !== "playing") return;
  const player = playerById(room, room.turnId);
  if (!player || player.eliminated) return;

  const humanInControl = !player.isBot && player.connected && !player.auto;
  // No solo, o jogador humano joga sem limite de tempo.
  if (humanInControl && room.solo) return;

  const delay = player.isBot ? 700 : humanInControl ? HUMAN_TURN_MS : player.auto ? 900 : 8000;
  room.autoTurnId = player.id;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    room.autoTurnId = null;
    if (room.turnId !== player.id || player.eliminated) return;
    // Se o humano voltou ao controle nesse meio-tempo, não joga por ele.
    if (!player.isBot && player.connected && !player.auto && !humanInControl) return;
    // Estourou o tempo de um humano online: liga o modo automático até ele reassumir.
    if (humanInControl) {
      player.auto = true;
      if (player.socketId) io.to(player.socketId).emit("notice", "Tempo esgotado — modo automático ligado. Toque em \"assumir controle\" para voltar.");
    }
    playAutomatically(room, player);
  }, delay);
}

function startRound(room) {
  const active = activePlayers(room);
  if (active.length <= 1) return endGame(room);
  room.round += 1;
  room.trick = 1;
  room.table = [];
  room.trickResult = null;
  room.roundLosers = [];
  room.pot = 0;
  room.lastWinnerId = null;
  const deck = shuffle(makeDeck());
  for (const player of room.players) {
    player.hand = [];
    player.bid = null;
    player.wins = 0;
    player.roundLoss = null;
  }
  for (let card = 0; card < room.handSize; card += 1) {
    for (const player of active) player.hand.push(deck.pop());
  }
  const dealerIndex = active.findIndex((player) => player.id === room.dealerId);
  const first = active[(dealerIndex + 1) % active.length];
  room.bidOrder = orderedFrom(room, first.id).map((player) => player.id);
  room.turnId = room.bidOrder[0];
  room.phase = "bidding";
  room.message = room.handSize === 1
    ? "Carta na testa: você vê todas, menos a sua. Aposte 0 ou 1."
    : `Hora das apostas: quantas rodadas você leva com ${room.handSize} cartas?`;
  broadcast(room);
}

function startGame(room) {
  if (room.tournament && room.tournament.playerIds.length === 0) {
    const entrants = seatedPlayers(room);
    room.tournament.playerIds = entrants.map((player) => player.id);
    room.tournament.scores = Object.fromEntries(entrants.map((player) => [player.id, { points: 0, wins: 0, lastPosition: null }]));
  }
  const tournamentPlayers = room.tournament ? new Set(room.tournament.playerIds) : null;
  // Espectadores que estavam esperando entram como jogadores de verdade nesta partida.
  room.players.forEach((player) => Object.assign(player, {
    lives: STARTING_LIVES,
    eliminated: false,
    eliminatedAtRound: null,
    spectator: tournamentPlayers ? !tournamentPlayers.has(player.id) : false,
    hand: [],
    bid: null,
    wins: 0,
    roundLoss: null,
    auto: false,
  }));
  room.handSize = 1;
  room.direction = 1;
  room.round = 0;
  room.resetHand = false;
  room.lastWinnerName = null;
  room.history = [];
  const dealerPool = activePlayers(room);
  room.dealerId = dealerPool[Math.floor(Math.random() * dealerPool.length)].id;
  startRound(room);
}

function advanceBid(room) {
  const current = room.bidOrder.indexOf(room.turnId);
  if (current < room.bidOrder.length - 1) {
    room.turnId = room.bidOrder[current + 1];
    return broadcast(room);
  }
  room.phase = "playing";
  room.turnId = room.bidOrder[0];
  room.message = "Apostas fechadas. Agora segura esse jogo.";
  broadcast(room);
}

const TRICK_REVEAL_MS = 2400;

function advancePlay(room) {
  const order = orderedFrom(room, room.bidOrder[0]);
  if (room.table.length < order.length) {
    const current = order.findIndex((player) => player.id === room.turnId);
    room.turnId = order[(current + 1) % order.length].id;
    return broadcast(room);
  }
  // A última carta da rodada acabou de entrar: revela a mesa completa antes de resolver.
  revealTrick(room);
}

function revealTrick(room) {
  const winner = trickWinner(room.table);
  const lastTrick = activePlayers(room)[0].hand.length === 0;
  const outcome = resolveTrickScore({ pot: room.pot, lastWinnerId: room.lastWinnerId }, winner?.playerId || null, lastTrick);
  if (outcome.credit) playerById(room, outcome.credit.playerId).wins += outcome.credit.amount;
  room.pot = outcome.pot;
  room.lastWinnerId = outcome.lastWinnerId;
  const took = outcome.took;
  const potAmount = outcome.potAmount;
  const potWinnerName = outcome.potWinnerId ? playerById(room, outcome.potWinnerId).name : null;
  const name = winner ? playerById(room, winner.playerId).name : null;
  const text = winner
    ? (took > 1 ? `${name} levou ${took} rodadas acumuladas.` : `${name} levou a rodada ${room.trick}.`)
    : potWinnerName
      ? `Melou tudo — as ${potAmount} rodadas acumuladas vão para ${potWinnerName}.`
      : `A rodada ${room.trick} melou inteira.`;
  room.history.push({ type: "trick", text });
  room.turnId = null; // congela a mesa: nenhum bot joga durante a revelação
  room.phase = "trick_reveal";
  room.trickResult = {
    trick: room.trick,
    winnerId: winner?.playerId || null,
    winnerName: name,
    melou: !winner,
    took,
    pot: room.pot,
    potWinnerName,
    potAmount,
    lastTrick,
  };
  room.message = winner
    ? (took > 1 ? `${name} levou ${took} rodadas de uma vez!` : text)
    : potWinnerName
      ? `Melou na última — ${potWinnerName} fica com ${potAmount} rodada${potAmount > 1 ? "s" : ""} acumulada${potAmount > 1 ? "s" : ""}.`
      : `Melou tudo! A próxima rodada vale por ${room.pot + 1}.`;
  broadcast(room);
  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.revealTimer = setTimeout(() => {
    room.revealTimer = null;
    resolveTrick(room, winner, lastTrick);
  }, TRICK_REVEAL_MS);
}

function resolveTrick(room, winner, lastTrick) {
  if (room.phase !== "trick_reveal") return;
  room.trickResult = null;
  if (lastTrick) {
    room.pot = 0; // resíduo (mão inteira melada, sem vencedor anterior) é descartado
    return scoreRound(room);
  }
  room.phase = "playing";
  room.trick += 1;
  room.table = [];
  // Rodada melada: reabre com o MESMO jogador que começou a rodada (o líder original da melada).
  room.turnId = winner?.playerId || room.bidOrder[0];
  room.bidOrder = orderedFrom(room, room.turnId).map((player) => player.id);
  room.message = winner
    ? `${playerById(room, winner.playerId).name} abre a próxima.`
    : `Melou! O mesmo jogador reabre — a rodada agora vale por ${room.pot + 1}.`;
  broadcast(room);
}

function scoreRound(room) {
  const results = [];
  const losers = [];
  for (const player of activePlayers(room)) {
    const lost = Math.abs(player.bid - player.wins);
    player.lives -= lost;
    player.roundLoss = lost;
    if (player.lives <= 0) {
      player.eliminated = true;
      player.eliminatedAtRound = room.round;
    }
    if (lost > 0) losers.push({ id: player.id, name: player.name, lost, eliminated: player.eliminated });
    results.push(`${player.name}: apostou ${player.bid}, fez ${player.wins}${lost ? ` e perdeu ${lost} vida${lost > 1 ? "s" : ""}` : " — cravou"}`);
  }
  room.roundLosers = losers;
  // Alguém morreu nesta mão → a próxima volta para 1 carta (na testa).
  room.resetHand = losers.some((loser) => loser.eliminated);
  room.history.push({ type: "round", text: results.join(" • ") });
  room.phase = "round_end";
  room.turnId = null;
  room.table = [];
  room.message = losers.length
    ? `Se fodeu: ${losers.map((loser) => `${loser.name} (−${loser.lost}${loser.eliminated ? ", eliminado" : ""})`).join(" · ")}`
    : "Ninguém se fodeu dessa vez — todo mundo cravou.";
  if (activePlayers(room).length <= 1) return endGame(room);
  broadcast(room);
}

function nextRound(room) {
  const active = activePlayers(room);
  const oldDealer = room.players.findIndex((player) => player.id === room.dealerId);
  let nextDealer = null;
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const candidate = room.players[(oldDealer + offset) % room.players.length];
    if (!candidate.eliminated && !candidate.spectator) { nextDealer = candidate; break; }
  }
  room.dealerId = nextDealer?.id || active[0].id;
  if (room.resetHand) {
    // Depois de uma morte, reinicia o ciclo em 1 carta (rodada na testa).
    room.handSize = 1;
    room.direction = 1;
    room.resetHand = false;
  } else {
    const next = nextHandSize(room.handSize, room.direction, active.length);
    room.handSize = next.handSize;
    room.direction = next.direction;
  }
  startRound(room);
}

function endGame(room) {
  room.phase = "game_over";
  room.turnId = null;
  const winner = activePlayers(room)[0];
  if (winner) {
    // Só partidas COM vencedor entram no ranking da sala.
    room.results.push(winner.name);
    room.lastWinnerName = winner.name;
    const streak = winStreak(room.results, winner.name);
    const flair = streak >= 3
      ? ` 👑 ${streak} PARTIDAS SEGUIDAS!`
      : streak === 2
        ? " 🔥 Duas seguidas!"
        : "";
    room.message = `${winner.name} sobreviveu. O resto se fodeu.${flair}`;
  } else {
    room.lastWinnerName = null; // ninguém venceu: não conta pro ranking
    room.message = "Todo mundo se fodeu. Impressionante.";
  }
  if (room.tournament) {
    const matchStandings = finalStandingsFrom(seatedPlayers(room));
    const playersInMatch = matchStandings.length;
    for (const entry of matchStandings) {
      const score = room.tournament.scores[entry.id];
      if (!score) continue;
      score.points += tournamentPoints(entry.position, playersInMatch);
      score.wins += entry.survived ? 1 : 0;
      score.lastPosition = entry.position;
    }
    room.tournament.completedGames += 1;
    room.tournament.finished = room.tournament.completedGames >= room.tournament.totalGames;
    const leader = tournamentStandings(room)[0];
    room.message = room.tournament.finished
      ? `${leader?.name || "Alguém"} venceu o Torneio Relâmpago!`
      : `Partida ${room.tournament.completedGames}/${room.tournament.totalGames} encerrada. ${leader?.name || "—"} lidera o torneio.`;
  }
  broadcast(room);
}

io.on("connection", (socket) => {
  socket.on("resume-session", ({ code, playerId, resumeToken } = {}) => {
    const room = rooms.get(cleanCode(code));
    const player = room && playerById(room, String(playerId || ""));
    if (!room || !player || player.isBot || player.resumeToken !== resumeToken) {
      socket.emit("session-expired");
      return;
    }
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    player.disconnectTimer = null;
    room.cleanupTimer = null;
    if (room.autoTurnId === player.id && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
      room.autoTurnId = null;
    }
    player.auto = false; // voltou para a mesa: reassume o controle do bot
    sendSession(socket, room, player);
    transferHost(room);
    notice(socket, "Você voltou para a mesa.");
    broadcast(room);
  });

  socket.on("solo-game", ({ name, botCount, botDifficulty } = {}) => {
    name = cleanName(name);
    if (!name) return notice(socket, "Digite seu nome.");
    botCount = Math.min(7, Math.max(1, Number.isInteger(Number(botCount)) ? Number(botCount) : 3));
    botDifficulty = ["easy", "normal", "hard"].includes(botDifficulty) ? botDifficulty : "normal";
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.botDifficulty = botDifficulty;
    room.solo = true;
    room.players.push(...Array.from({ length: botCount }, (_, index) => createBot(code, index)));
    rooms.set(code, room);
    sendSession(socket, room, player);
    startGame(room);
  });

  socket.on("create-room", ({ name } = {}) => {
    name = cleanName(name);
    if (!name) return notice(socket, "Digite seu nome.");
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    rooms.set(code, room);
    sendSession(socket, room, player);
    broadcast(room);
  });

  socket.on("create-tournament", ({ name, tournamentGames } = {}) => {
    name = cleanName(name);
    if (!name) return notice(socket, "Digite seu nome.");
    const totalGames = [3, 5].includes(Number(tournamentGames)) ? Number(tournamentGames) : 3;
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.tournament = { totalGames, completedGames: 0, finished: false, playerIds: [], scores: {} };
    room.message = `Torneio Relâmpago de ${totalGames} partidas. Chame a turma e comece quando a mesa estiver pronta.`;
    rooms.set(code, room);
    sendSession(socket, room, player);
    broadcast(room);
  });

  socket.on("join-room", ({ name, code } = {}) => {
    name = cleanName(name);
    code = cleanCode(code);
    const room = rooms.get(code);
    if (!name) return notice(socket, "Digite seu nome.");
    if (!room) return notice(socket, "Sala não encontrada.");
    if (room.players.length >= 8) return notice(socket, "A sala já está cheia.");
    if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return notice(socket, "Esse nome já está na mesa.");
    const player = createPlayer(socket, name);
    // Partida rolando: entra como espectador e vira jogador na próxima partida.
    // No lobby ou no fim de jogo, entra direto para a próxima partida.
    const midGame = (room.phase !== "lobby" && room.phase !== "game_over") || Boolean(room.tournament && room.phase !== "lobby");
    player.spectator = midGame;
    room.players.push(player);
    sendSession(socket, room, player);
    transferHost(room);
    notice(socket, midGame ? "Partida em andamento — você entrou como espectador e joga na próxima." : "Você entrou na sala.");
    broadcast(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (room.phase !== "lobby") return notice(socket, "Essa partida já começou.");
    room.players = room.players.filter((player) => player.isBot || player.connected);
    if (room.players.length < 2) return notice(socket, "Chame pelo menos mais uma pessoa.");
    startGame(room);
  });

  socket.on("bid", (rawBid) => {
    const room = rooms.get(socket.data.roomCode);
    const error = submitBid(room, socket.data.playerId, rawBid);
    if (error) notice(socket, error);
  });

  socket.on("play-card", (cardId) => {
    const room = rooms.get(socket.data.roomCode);
    const error = submitPlay(room, socket.data.playerId, cardId);
    if (error) notice(socket, error);
  });

  socket.on("chat", (raw) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player) return;
    const text = cleanChat(raw);
    if (!text) return;
    const message = { id: randomUUID(), playerId: player.id, name: player.name, text };
    room.chat.push(message);
    if (room.chat.length > 60) room.chat.shift();
    for (const member of room.players) {
      if (!member.isBot && member.connected && member.socketId) io.to(member.socketId).emit("chat", message);
    }
  });

  socket.on("emote", (key) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player || !EMOTES[key]) return;
    const payload = { playerId: player.id, name: player.name, key, emoji: EMOTES[key] };
    for (const member of room.players) {
      if (!member.isBot && member.connected && member.socketId) io.to(member.socketId).emit("emote", payload);
    }
  });

  socket.on("next-round", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "round_end" || socket.data.playerId !== room.hostId) return;
    nextRound(room);
  });

  socket.on("next-tournament-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.tournament || room.phase !== "game_over" || socket.data.playerId !== room.hostId) return;
    if (room.tournament.finished) return notice(socket, "O torneio já terminou.");
    startGame(room);
  });

  socket.on("restart", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "game_over" || socket.data.playerId !== room.hostId) return;
    if (seatedPlayers(room).length < 2) return notice(socket, "Chame pelo menos mais uma pessoa pra recomeçar.");
    if (room.tournament) {
      if (!room.tournament.finished) return notice(socket, "Use Próxima Partida para continuar o torneio.");
      room.tournament.completedGames = 0;
      room.tournament.finished = false;
      room.tournament.scores = Object.fromEntries(room.tournament.playerIds
        .map((id) => [id, { points: 0, wins: 0, lastPosition: null }]));
    }
    startGame(room);
  });

  // O dono da sala pode tirar da mesa bots e jogadores ausentes (que caíram ou saíram)
  // ao fim da partida — antes disso não era possível e eles voltavam sozinhos no restart.
  socket.on("remove-player", (targetId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (room.tournament && room.phase !== "lobby") return notice(socket, "A escalação do torneio fica fechada até ele terminar.");
    if (room.phase !== "game_over" && room.phase !== "lobby") return notice(socket, "Só dá pra tirar bots fora da partida.");
    const target = playerById(room, String(targetId || ""));
    if (!target || target.id === room.hostId) return;
    if (!target.isBot && target.connected && !target.auto) return notice(socket, "Esse jogador ainda está na ativa.");
    if (target.disconnectTimer) { clearTimeout(target.disconnectTimer); target.disconnectTimer = null; }
    if (room.autoTurnId === target.id && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
      room.autoTurnId = null;
    }
    target.resumeToken = null; // removido de propósito: não reconecta mais nesta sala
    room.players = room.players.filter((item) => item.id !== target.id);
    transferHost(room);
    broadcast(room);
  });

  socket.on("toggle-auto", (value) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player) return;
    player.auto = Boolean(value);
    // Reassumiu o controle: cancela a jogada automática pendente e devolve o tempo dele.
    if (!player.auto && room.autoTurnId === player.id && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
      room.autoTurnId = null;
    }
    broadcast(room);
  });

  socket.on("leave-room", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    if (!room || !player) return;
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    player.connected = false;
    player.socketId = null;
    player.resumeToken = null; // saiu de propósito: não reconecta mais nesta sala
    if (room.phase === "lobby" || room.phase === "game_over" || player.spectator) {
      // Espectador (ou saída fora de partida) apenas some — não estava jogando.
      room.players = room.players.filter((item) => item.id !== player.id);
    } else {
      player.auto = true; // saiu no meio: um bot assume a vaga rapidamente
    }
    transferHost(room);
    if (room.autoTurnId === player.id && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
      room.autoTurnId = null;
    }
    if (!room.players.some((item) => !item.isBot)) {
      if (room.botTimer) clearTimeout(room.botTimer);
      if (room.revealTimer) clearTimeout(room.revealTimer);
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      rooms.delete(room.code);
      return;
    }
    if (!room.players.some((item) => !item.isBot && item.connected)) {
      room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 5 * 60 * 1000);
    }
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = playerById(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    transferHost(room);
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    if (room.phase === "lobby" || player.spectator) {
      player.disconnectTimer = setTimeout(() => {
        player.disconnectTimer = null;
        // Se reconectou, ou virou jogador ativo numa nova partida, mantém.
        if (player.connected || (room.phase !== "lobby" && !player.spectator)) return;
        room.players = room.players.filter((item) => item.id !== player.id);
        transferHost(room);
        if (!room.players.length) rooms.delete(room.code);
        else broadcast(room);
      }, 30000);
    } else if (room.phase !== "game_over") {
      // Caiu no meio da partida: dá um tempo pra reconectar; se não voltar, um bot assume
      // a vaga de vez (deixa de ficar "reconectando" pendurado para sempre).
      player.disconnectTimer = setTimeout(() => {
        player.disconnectTimer = null;
        if (player.connected || player.eliminated) return;
        player.auto = true;
        broadcast(room);
      }, RECONNECT_GRACE_MS);
    }
    if (!room.players.some((item) => !item.isBot && item.connected)) {
      room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 5 * 60 * 1000);
    }
    broadcast(room);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => console.log(`Se Fode rodando em http://localhost:${port}`));
