import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeDeck, shuffle, FIXED_MANILHAS, cardStrength, trickWinner, nextHandSize, validBidOptions, suggestedBid } from "./game.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const STARTING_LIVES = 5;
const BOT_NAMES = ["Bot Fodão", "Bot do Caos", "Bot Sem Freio", "Bot Pé Frio", "Bot Trambique", "Bot Carrasco", "Bot Zé Manilha"];

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
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
  return room.players.filter((player) => !player.eliminated);
}

function playerById(room, id) {
  return room.players.find((player) => player.id === id);
}

function orderedFrom(room, startId) {
  const active = activePlayers(room);
  const index = active.findIndex((player) => player.id === startId);
  return index < 0 ? active : [...active.slice(index), ...active.slice(0, index)];
}

function publicState(room, viewerId) {
  const viewer = playerById(room, viewerId);
  const forehead = room.handSize === 1;
  return {
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
    botDifficulty: room.botDifficulty,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      lives: player.lives,
      bid: player.bid,
      wins: player.wins,
      eliminated: player.eliminated,
      connected: player.connected,
      isBot: Boolean(player.isBot),
      cardCount: player.hand.length,
      foreheadCard: forehead && player.id !== viewerId ? player.hand[0] : null,
    })),
    me: viewer ? {
      id: viewer.id,
      name: viewer.name,
      hand: forehead ? [] : viewer.hand,
      hasForeheadCard: forehead && viewer.hand.length === 1,
    } : null,
    table: room.table,
    bidOrder: room.bidOrder,
    allowedBids: room.phase === "bidding" && room.turnId === viewerId ? validBids(room, viewerId) : [],
    history: room.history.slice(-5),
  };
}

function broadcast(room) {
  for (const player of room.players) {
    if (!player.isBot) io.to(player.id).emit("state", publicState(room, player.id));
  }
  scheduleBot(room);
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
    botDifficulty: "normal",
    message: "Esperando a turma chegar.",
  };
}

function createPlayer(socket, name) {
  return { id: socket.id, name, lives: STARTING_LIVES, bid: null, wins: 0, eliminated: false, connected: true, hand: [] };
}

function createBot(code, index) {
  return { id: `bot-${code}-${index}`, name: BOT_NAMES[index], lives: STARTING_LIVES, bid: null, wins: 0, eliminated: false, connected: true, isBot: true, hand: [] };
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

function scheduleBot(room) {
  const bot = playerById(room, room.turnId);
  if (!bot?.isBot || room.botTimer) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.turnId !== bot.id || bot.eliminated) return;
    if (room.phase === "bidding") {
      submitBid(room, bot.id, chooseBotBid(room, bot));
      return;
    }
    if (room.phase === "playing") {
      const card = chooseBotCard(room, bot);
      submitPlay(room, bot.id, card?.id);
    }
  }, 700);
}

function startRound(room) {
  const active = activePlayers(room);
  if (active.length <= 1) return endGame(room);
  room.round += 1;
  room.trick = 1;
  room.table = [];
  const deck = shuffle(makeDeck());
  for (const player of room.players) {
    player.hand = [];
    player.bid = null;
    player.wins = 0;
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
    : `Hora das apostas: quantas vazas você leva com ${room.handSize} cartas?`;
  broadcast(room);
}

function startGame(room) {
  room.players.forEach((player) => Object.assign(player, { lives: STARTING_LIVES, eliminated: false, hand: [], bid: null, wins: 0 }));
  room.handSize = 1;
  room.direction = 1;
  room.round = 0;
  room.history = [];
  room.dealerId = room.players[Math.floor(Math.random() * room.players.length)].id;
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

function advancePlay(room) {
  const order = orderedFrom(room, room.bidOrder[0]);
  if (room.table.length < order.length) {
    const current = order.findIndex((player) => player.id === room.turnId);
    room.turnId = order[(current + 1) % order.length].id;
    return broadcast(room);
  }

  const winner = trickWinner(room.table);
  if (winner) playerById(room, winner.playerId).wins += 1;
  room.history.push({
    type: "trick",
    text: winner ? `${playerById(room, winner.playerId).name} levou a vaza ${room.trick}.` : `A vaza ${room.trick} melou inteira.`,
  });

  if (activePlayers(room)[0].hand.length === 0) return scoreRound(room);
  room.trick += 1;
  room.table = [];
  room.turnId = winner?.playerId || room.bidOrder[0];
  room.bidOrder = orderedFrom(room, room.turnId).map((player) => player.id);
  room.message = winner ? `${playerById(room, winner.playerId).name} abre a próxima.` : "Melou tudo. O primeiro da vaza abre de novo.";
  broadcast(room);
}

function scoreRound(room) {
  const results = [];
  for (const player of activePlayers(room)) {
    const lost = Math.abs(player.bid - player.wins);
    player.lives -= lost;
    if (player.lives <= 0) player.eliminated = true;
    results.push(`${player.name}: apostou ${player.bid}, fez ${player.wins}${lost ? ` e perdeu ${lost} vida${lost > 1 ? "s" : ""}` : " — cravou"}`);
  }
  room.history.push({ type: "round", text: results.join(" • ") });
  room.phase = "round_end";
  room.turnId = null;
  room.table = [];
  room.message = results.join(" · ");
  if (activePlayers(room).length <= 1) return endGame(room);
  broadcast(room);
}

function nextRound(room) {
  const active = activePlayers(room);
  const oldDealer = room.players.findIndex((player) => player.id === room.dealerId);
  let nextDealer = null;
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const candidate = room.players[(oldDealer + offset) % room.players.length];
    if (!candidate.eliminated) { nextDealer = candidate; break; }
  }
  room.dealerId = nextDealer?.id || active[0].id;
  const next = nextHandSize(room.handSize, room.direction, active.length);
  room.handSize = next.handSize;
  room.direction = next.direction;
  startRound(room);
}

function endGame(room) {
  room.phase = "game_over";
  room.turnId = null;
  const winner = activePlayers(room)[0];
  room.message = winner ? `${winner.name} sobreviveu. O resto se fodeu.` : "Todo mundo se fodeu. Impressionante.";
  broadcast(room);
}

io.on("connection", (socket) => {
  socket.on("solo-game", ({ name, botCount, botDifficulty } = {}) => {
    name = cleanName(name);
    if (!name) return notice(socket, "Digite seu nome.");
    botCount = Math.min(7, Math.max(1, Number.isInteger(Number(botCount)) ? Number(botCount) : 3));
    botDifficulty = ["easy", "normal", "hard"].includes(botDifficulty) ? botDifficulty : "normal";
    const code = roomCode();
    const room = newRoom(code, createPlayer(socket, name));
    room.botDifficulty = botDifficulty;
    room.players.push(...Array.from({ length: botCount }, (_, index) => createBot(code, index)));
    rooms.set(code, room);
    socket.data.roomCode = code;
    startGame(room);
  });

  socket.on("create-room", ({ name } = {}) => {
    name = cleanName(name);
    if (!name) return notice(socket, "Digite seu nome.");
    const code = roomCode();
    const room = newRoom(code, createPlayer(socket, name));
    rooms.set(code, room);
    socket.data.roomCode = code;
    broadcast(room);
  });

  socket.on("join-room", ({ name, code } = {}) => {
    name = cleanName(name);
    code = cleanCode(code);
    const room = rooms.get(code);
    if (!name) return notice(socket, "Digite seu nome.");
    if (!room) return notice(socket, "Sala não encontrada.");
    if (room.phase !== "lobby") return notice(socket, "Essa partida já começou.");
    if (room.players.length >= 8) return notice(socket, "A sala já está cheia.");
    if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return notice(socket, "Esse nome já está na mesa.");
    room.players.push(createPlayer(socket, name));
    socket.data.roomCode = code;
    broadcast(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.length < 2) return notice(socket, "Chame pelo menos mais uma pessoa.");
    startGame(room);
  });

  socket.on("bid", (rawBid) => {
    const room = rooms.get(socket.data.roomCode);
    const error = submitBid(room, socket.id, rawBid);
    if (error) notice(socket, error);
  });

  socket.on("play-card", (cardId) => {
    const room = rooms.get(socket.data.roomCode);
    const error = submitPlay(room, socket.id, cardId);
    if (error) notice(socket, error);
  });

  socket.on("next-round", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "round_end" || socket.id !== room.hostId) return;
    nextRound(room);
  });

  socket.on("restart", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "game_over" || socket.id !== room.hostId) return;
    startGame(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = playerById(room, socket.id);
    if (player) player.connected = false;
    if (room.phase === "lobby") {
      room.players = room.players.filter((item) => item.id !== socket.id);
      if (room.hostId === socket.id) room.hostId = room.players[0]?.id;
    }
    if (!room.players.length) rooms.delete(room.code);
    else broadcast(room);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => console.log(`Se Fode rodando em http://localhost:${port}`));
