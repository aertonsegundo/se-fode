import "./env.js"; // PRIMEIRO: carrega o .env antes de qualquer módulo que leia process.env
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeDeck, shuffle, FIXED_MANILHAS, cardStrength, trickWinner, trickOutcome, resolveTrickScore, nextHandSize, validBidOptions, suggestedBid, winStreak, rankingFrom, finalStandingsFrom, tournamentPoints, tournamentStandingsFrom, casualPoints, tournamentRankPoints, unlockedBannerKeys, remainingDeck, chooseBotPlay } from "./game.js";
import { publicConfig, profileFromToken, gameProfileById, verifyToken, ensureProfile, listUsers, leaderboard, publicPlayerProfile, setUserName, setUserBanner, setUserPhoto, recordGame, awardTournamentResult, selfTest, listEmotes, createEmote, setEmoteActive, deleteEmote, seedEmotes, supabaseEnabled, BANNERS, BANNER_KEYS, AVATAR_KEYS, BUILTIN_EMOTES } from "./supabase.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const STARTING_LIVES = 5;
const BOT_NAMES = ["Bot Fodão", "Bot do Caos", "Bot Sem Freio", "Bot Pé Frio", "Bot Trambique", "Bot Carrasco", "Bot Zé Manilha"];
const RANDOM_AVATAR_KEYS = ["jogador-1", "jogador-2", "jogador-3", "jogador-4", "jogador-5"];
// Figurinhas dinâmicas (gerenciadas no dashboard). Cache em memória, semeado com
// as nativas e recarregado quando o admin altera algo.
let emoteList = BUILTIN_EMOTES.map((emote, index) => ({ ...emote, imageUrl: null, active: true, sort: index, builtin: true }));
let emoteMap = Object.fromEntries(emoteList.map((emote) => [emote.key, emote]));
async function loadEmotes() {
  emoteList = await listEmotes(false);
  emoteMap = Object.fromEntries(emoteList.map((emote) => [emote.key, emote]));
}
const activeEmotes = () => emoteList.filter((emote) => emote.active);
async function reloadAndBroadcastEmotes() {
  await loadEmotes();
  io.emit("emotes", activeEmotes()); // atualiza a barra de todo mundo na hora
}

// Campeão da Semana: o 1º do ranking semanal (dinâmico) usa um banner especial na
// mesa. Recarregado periodicamente; quando muda, reemite o estado das salas.
let weeklyChampionId = null;
async function refreshWeeklyChampion() {
  if (!supabaseEnabled) return;
  try {
    const top = await leaderboard(1, "weekly");
    const next = top[0]?.points > 0 ? top[0].id : null;
    if (next === weeklyChampionId) return;
    weeklyChampionId = next;
    for (const room of rooms.values()) broadcast(room); // atualiza os banners na mesa
  } catch { /* mantém o campeão atual */ }
}

// Sem cache "esquecido": o navegador sempre revalida html/css/js, então um novo
// deploy nunca fica preso numa versao antiga em cache no cliente.
app.use(express.json({ limit: "3mb" }));

// Mantém a URL oficial única. O health check do Render fica acessível para que
// o serviço antigo continue saudável enquanto encaminha os visitantes.
app.use((req, res, next) => {
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  if (host === "se-fode-online.onrender.com" && req.path !== "/health") {
    return res.redirect(308, `https://sefode.com${req.originalUrl}`);
  }
  next();
});

// Sem cache "esquecido": o navegador sempre revalida html/css/js, então um novo
// deploy nunca fica preso numa versao antiga em cache no cliente.
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ===== Contas / API =====
// Config pública para o browser se autenticar no Supabase (anon key é pública).
app.get("/api/config", (_req, res) => res.json(publicConfig()));

// Extrai o perfil a partir do header Authorization: Bearer <access_token>.
async function authProfile(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  return profileFromToken(token);
}

// Perfil do usuário logado (+ catálogos de banner/avatar para a UI de perfil).
app.get("/api/me", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  res.json({ profile, banners: BANNERS, avatars: AVATAR_KEYS });
});

// Usuário troca o próprio nome de exibição.
app.post("/api/me/name", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  const result = await setUserName(profile.id, req.body?.name);
  if (!result.ok) return res.status(400).json({ error: result.error });
  updateLiveProfile(profile.id, { displayName: result.displayName });
  res.json({ ok: true, displayName: result.displayName });
});

// Usuário troca a própria foto (avatar pronto ou upload).
app.post("/api/me/photo", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  const result = await setUserPhoto(profile.id, { avatarKey: req.body?.avatarKey, dataUrl: req.body?.dataUrl });
  if (!result.ok) return res.status(400).json({ error: result.error });
  updateLiveProfile(profile.id, { photo: result.photo });
  res.json({ ok: true, photo: result.photo });
});

// Usuário escolhe o próprio banner — só entre os liberados pelas vitórias online.
// Exclusivos (maldito/rei) e o automático (campeao) não passam por aqui.
app.post("/api/me/banner", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  const banner = String(req.body?.banner || "");
  if (!unlockedBannerKeys(profile.onlineWins, BANNERS).includes(banner)) {
    return res.status(403).json({ error: "Banner ainda não desbloqueado." });
  }
  const ok = await setUserBanner(profile.id, banner);
  if (!ok) return res.status(400).json({ error: "Não foi possível trocar o banner." });
  updateLiveProfile(profile.id, { banner });
  res.json({ ok: true, banner });
});

// Ranking geral por pontos, vitórias ou pontos por partida — qualquer usuário logado vê.
app.get("/api/leaderboard", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  const sort = ["points", "wins", "points-per-game"].includes(req.query.sort) ? req.query.sort : "points";
  const period = ["weekly", "monthly", "all"].includes(req.query.period) ? req.query.period : "all";
  res.json({ leaderboard: await leaderboard(50, "general", sort, period), sort, period, banners: BANNERS, meId: profile.id });
});

// Perfil público que abre ao clicar em alguém na mesa. O perfil autenticado
// controla a autorização; a resposta não contém e-mail nem dados privados.
app.get("/api/players/:id", async (req, res) => {
  const viewer = await authProfile(req);
  if (!viewer) return res.status(401).json({ error: "Não autenticado." });
  const profile = await publicPlayerProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: "Perfil não encontrado." });
  res.json({ profile, banners: BANNERS });
});

// Só admin.
async function adminProfile(req, res) {
  const profile = await authProfile(req);
  if (!profile) { res.status(401).json({ error: "Não autenticado." }); return null; }
  if (!profile.isAdmin) { res.status(403).json({ error: "Acesso restrito a administradores." }); return null; }
  return profile;
}

// Dashboard admin: lista usuários com seus dados.
app.get("/api/admin/users", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  res.json({ users: await listUsers(), banners: BANNERS });
});

// Admin atribui um banner a um usuário.
app.post("/api/admin/user/:id/banner", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  const banner = String(req.body?.banner || "");
  if (!BANNER_KEYS.includes(banner)) return res.status(400).json({ error: "Banner inválido." });
  const ok = await setUserBanner(req.params.id, banner);
  if (!ok) return res.status(400).json({ error: "Não foi possível atribuir o banner." });
  updateLiveProfile(req.params.id, { banner });
  res.json({ ok: true });
});

// Figurinhas ativas para a barra do jogo (público — usadas depois do login).
app.get("/api/emotes", (_req, res) => res.json({ emotes: activeEmotes() }));

// Admin: lista todas as figurinhas (inclusive inativas).
app.get("/api/admin/emotes", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  res.json({ emotes: emoteList });
});

// Admin: cria uma figurinha nova (emoji e/ou upload de imagem).
app.post("/api/admin/emotes", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  const result = await createEmote({ key: req.body?.key, title: req.body?.title, emoji: req.body?.emoji, dataUrl: req.body?.dataUrl });
  if (!result.ok) return res.status(400).json({ error: result.error });
  await reloadAndBroadcastEmotes();
  res.json({ ok: true });
});

// Admin: ativa/desativa uma figurinha.
app.post("/api/admin/emotes/:key/active", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  const ok = await setEmoteActive(req.params.key, req.body?.active);
  if (!ok) return res.status(400).json({ error: "Não foi possível atualizar a figurinha." });
  await reloadAndBroadcastEmotes();
  res.json({ ok: true });
});

// Admin: exclui uma figurinha.
app.delete("/api/admin/emotes/:key", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  const ok = await deleteEmote(req.params.key);
  if (!ok) return res.status(400).json({ error: "Não foi possível excluir a figurinha." });
  await reloadAndBroadcastEmotes();
  res.json({ ok: true });
});

app.get("/dashboard", (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

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
      // Bots continuam na mesa, mas nunca entram no ranking do torneio.
      return player?.userId && score ? { id, userId: player.userId, name: player.name, ...score } : null;
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

function assignRandomAvatar(room, player) {
  if (player.avatarKey || player.photoUrl) return; // já tem foto escolhida no perfil
  const unused = RANDOM_AVATAR_KEYS.filter((avatarKey) => !room.players.some((other) => other.avatarKey === avatarKey));
  const choices = unused.length ? unused : RANDOM_AVATAR_KEYS;
  player.avatarKey = choices[Math.floor(Math.random() * choices.length)];
}

// Aplica os dados do perfil autenticado (foto e banner) ao jogador/assento.
function applyProfile(player, user) {
  if (!user) return;
  player.userId = user.id;
  player.banner = user.banner || "novato";
  player.onlineWins = user.onlineWins || 0; // base para detectar desbloqueio de banner
  player.photoUrl = null;
  if (user.photo) {
    if (/^https?:\/\//.test(user.photo)) { player.photoUrl = user.photo; player.avatarKey = null; }
    else player.avatarKey = user.photo;
  }
}

// Propaga foto/banner/nome para o assento AO VIVO, mesmo com o jogador já sentado
// (ex.: trocou a foto no perfil ou o admin deu um banner durante a partida).
function updateLiveProfile(userId, { photo, banner, displayName } = {}) {
  if (!userId) return;
  for (const room of rooms.values()) {
    const player = room.players.find((item) => item.userId === userId);
    if (!player) continue;
    if (banner !== undefined) player.banner = banner || "novato";
    if (photo !== undefined) {
      player.photoUrl = null;
      player.avatarKey = null;
      if (photo) {
        if (/^https?:\/\//.test(photo)) player.photoUrl = photo;
        else player.avatarKey = photo;
      }
      assignRandomAvatar(room, player); // se ficou sem foto, sorteia uma
    }
    if (displayName && !room.players.some((other) => other !== player && other.name.toLowerCase() === displayName.toLowerCase())) {
      player.name = displayName;
    }
    broadcast(room);
  }
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
      profileId: player.userId || null,
      name: player.name,
      lives: player.lives,
      bid: player.bid,
      wins: player.wins,
      roundLoss: player.roundLoss ?? null,
      eliminated: player.eliminated,
      connected: player.connected,
      auto: Boolean(player.auto),
      isBot: Boolean(player.isBot),
      avatarKey: player.avatarKey || null,
      photoUrl: player.photoUrl || null,
      // O Campeão da Semana (líder do ranking semanal) usa o banner especial na mesa.
      banner: player.userId && player.userId === weeklyChampionId ? "campeao" : (player.banner || "novato"),
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
  const room = {
    code,
    hostId: host.id,
    players: [],
    phase: "lobby",
    dealerId: null,
    turnId: null,
    bidOrder: [],
    handSize: 1,
    direction: 1,
    round: 0,
    trick: 0,
    table: [],
    playedThisHand: [],
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
  assignRandomAvatar(room, host);
  room.players.push(host);
  return room;
}

function createPlayer(socket, name) {
  const player = { id: randomUUID(), socketId: socket.id, resumeToken: randomUUID(), name, lives: STARTING_LIVES, bid: null, wins: 0, roundLoss: null, eliminated: false, eliminatedAtRound: null, connected: true, auto: false, quit: false, afkStrikes: 0, expelled: false, hand: [], userId: null, banner: "novato", photoUrl: null };
  applyProfile(player, socket.data.user);
  return player;
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
  (room.playedThisHand ||= []).push(card); // memória de cartas da mão (bot difícil)
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
  if (bot.hand.length === 1) return bot.hand[0];
  // Oponentes que ainda vão jogar NESTA vaza (depois do bot) e a intenção de cada um.
  const played = new Set(room.table.map((play) => play.playerId));
  const after = activePlayers(room)
    .filter((player) => player.id !== bot.id && !played.has(player.id))
    .map((player) => ({ needsMore: (player.bid ?? 0) - player.wins, cardsLeft: player.hand.length }));
  // Difícil tem memória: desconta as cartas já jogadas na mão inteira; normal só a vaza atual.
  const known = room.botDifficulty === "hard"
    ? [...bot.hand, ...(room.playedThisHand || [])]
    : [...bot.hand, ...room.table.map((play) => play.card)];
  return chooseBotPlay({
    hand: bot.hand,
    bid: bot.bid,
    wins: bot.wins,
    table: room.table,
    after,
    unknown: remainingDeck(known),
  });
}

const HUMAN_TURN_MS = 20000; // tempo do jogador online antes do modo automático assumir
const RECONNECT_GRACE_MS = 15000; // tempo pra reconectar antes de um bot assumir a vaga de vez
const AFK_STRIKES_LIMIT = 3; // avisos de inatividade numa partida antes da expulsão
const FOREHEAD_MS = 900; // delay entre as cartas na rodada na testa (joga sozinha)
const NEXT_ROUND_MS = 4000; // tempo pra ver o resultado antes da próxima mão (mesa sem bots)

// Só avança sozinho quando TODOS os jogadores ativos são humanos conectados e no
// controle. Havendo bot, alguém no automático (AFK) ou caído, o dono decide a hora.
function maybeAutoAdvance(room) {
  if (room.phase !== "round_end") return;
  const allEngaged = activePlayers(room).every((player) => !player.isBot && player.connected && !player.auto);
  if (!allEngaged) return;
  if (room.roundAdvanceTimer) return;
  room.roundAdvanceTimer = setTimeout(() => {
    room.roundAdvanceTimer = null;
    if (room.phase === "round_end") nextRound(room);
  }, NEXT_ROUND_MS);
}

// Expulsa um jogador da partida por inatividade repetida: um bot termina a mão dele
// (pra não quebrar a rodada), ele volta ao menu e não reconecta nesta sala.
function expelPlayer(room, player) {
  if (player.socketId) io.to(player.socketId).emit("expelled", "Você levou 3 avisos de inatividade e saiu da partida.");
  player.connected = false;
  player.socketId = null;
  player.resumeToken = null;
  player.auto = true;
  player.expelled = true;
  if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
  transferHost(room);
  if (!room.players.some((item) => !item.isBot && item.connected)) {
    room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 5 * 60 * 1000);
  }
}

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

  // Rodada na testa (1 carta): joga sozinha, em ordem, com um pequeno delay —
  // ninguém escolhe (a carta está na testa), inclusive no solo.
  if (room.phase === "playing" && room.handSize === 1) {
    room.autoTurnId = player.id;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      room.autoTurnId = null;
      if (room.turnId !== player.id || player.eliminated) return;
      submitPlay(room, player.id, player.hand[0]?.id);
    }, FOREHEAD_MS);
    return;
  }

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
    // Estourou o tempo de um humano online: liga o automático e conta o aviso.
    if (humanInControl) {
      player.auto = true;
      player.afkStrikes = (player.afkStrikes || 0) + 1;
      const expel = player.afkStrikes >= AFK_STRIKES_LIMIT;
      if (player.socketId) io.to(player.socketId).emit("notice", expel
        ? "3ª inatividade — você foi expulso da partida."
        : `Inatividade ${player.afkStrikes}/${AFK_STRIKES_LIMIT} — automático ligado. Toque em "assumir controle" pra voltar (na 3ª você sai).`);
      if (expel) {
        playAutomatically(room, player); // faz a jogada desta vez
        expelPlayer(room, player);
        return broadcast(room);
      }
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
  room.playedThisHand = []; // zera a memória de cartas a cada nova mão
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
  refreshWeeklyChampion(); // mantém o banner de campeão fresco quando um jogo começa
  room.players = room.players.filter((player) => !player.expelled); // expulsos não voltam
  const entrants = seatedPlayers(room);
  if (room.tournament && room.tournament.playerIds.length === 0) {
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
    afkStrikes: 0,
  }));
  room.handSize = 1;
  room.direction = 1;
  room.round = 0;
  room.resetHand = false;
  room.lastWinnerName = null;
  room.history = [];
  const dealerPool = activePlayers(room);
  if (dealerPool.length < 2) {
    room.phase = "lobby";
    room.dealerId = null;
    room.turnId = null;
    room.message = "Faltam jogadores para começar. Chame pelo menos mais uma pessoa.";
    if (room.tournament) {
      // A escalação ficou incompleta (por exemplo, após saídas). Libera uma
      // nova inscrição no lobby em vez de deixar o torneio preso ou derrubar
      // o servidor ao tentar escolher um dealer inexistente.
      room.tournament.playerIds = [];
      room.tournament.scores = {};
      room.tournament.completedGames = 0;
      room.tournament.finished = false;
    }
    return broadcast(room);
  }
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
  // Quem saiu de propósito no meio da mão: o bot terminou a mão, agora o jogador sai de vez.
  if (room.players.some((player) => player.quit)) {
    room.players = room.players.filter((player) => !player.quit);
    transferHost(room);
  }
  if (activePlayers(room).length <= 1) return endGame(room);
  broadcast(room);
  maybeAutoAdvance(room); // mesa sem bots: próxima mão começa sozinha
}

function nextRound(room) {
  if (room.roundAdvanceTimer) { clearTimeout(room.roundAdvanceTimer); room.roundAdvanceTimer = null; }
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
  // Bots não contam: posição, pontos e histórico usam apenas contas humanas.
  const isTournament = Boolean(room.tournament);
  const humanStandings = finalStandingsFrom(seatedPlayers(room).filter((player) => player.userId));
  const humanCount = humanStandings.length;
  const positionById = new Map(humanStandings.map((entry) => [entry.id, entry.position]));
  const humanPlayers = seatedPlayers(room)
    .filter((player) => player.userId)
    .map((player) => {
      const position = positionById.get(player.id) || humanCount;
      return {
        userId: player.userId,
        position,
        playerCount: humanCount,
        won: player.id === winner?.id,
        // Partida Rápida: top 3 pontua (3/2/1) só com 3+ humanos. Torneio não pontua
        // por jogo — os pontos vêm só da classificação final do torneio.
        rankPoints: isTournament ? 0 : casualPoints(position, humanCount),
      };
    });
  const online = !room.solo; // solo (contra bots) não conta vitória online
  if (humanPlayers.length) recordGame(humanPlayers, winner?.userId || null, isTournament ? "Torneio rankeado" : "Partida", online);
  // Só o vencedor de partida ONLINE ganha vitória online — pode desbloquear banner.
  if (online && winner?.userId) {
    winner.onlineWins = (winner.onlineWins || 0) + 1;
    const unlocked = BANNERS.find((banner) => banner.wins === winner.onlineWins);
    if (unlocked && winner.socketId) io.to(winner.socketId).emit("banner-unlocked", { key: unlocked.key, title: unlocked.title });
  }
  if (room.tournament) {
    for (const entry of humanStandings) {
      const score = room.tournament.scores[entry.id];
      if (!score) continue;
      // Classificação interna do torneio = pontos de posição + vidas restantes ao
      // fim do jogo (premia vitórias mais folgadas). Não afeta os pontos de ranking.
      score.points += tournamentPoints(entry.position, humanCount) + entry.lives;
      score.wins += entry.survived ? 1 : 0;
      score.lastPosition = entry.position;
    }
    room.tournament.completedGames += 1;
    room.tournament.finished = room.tournament.completedGames >= room.tournament.totalGames;
    const leader = tournamentStandings(room)[0];
    // Pontos de ranking do torneio: só na classificação final, top 5 (10/6/4/2/1),
    // com 3+ humanos. Bots não participam nem do cálculo.
    if (room.tournament.finished && humanCount >= 3 && !room.tournament.rankingAwarded) {
      room.tournament.rankingAwarded = true;
      awardTournamentResult(tournamentStandings(room).map((entry) => ({
        userId: entry.userId,
        position: entry.position,
        rankPoints: tournamentRankPoints(entry.position, humanCount),
      })));
    }
    room.message = room.tournament.finished
      ? `${leader?.name || "Alguém"} venceu o Torneio Rankeado!`
      : `Partida ${room.tournament.completedGames}/${room.tournament.totalGames} encerrada. ${leader?.name || "—"} lidera o torneio.`;
  }
  broadcast(room);
}

// Autentica o socket no handshake: quem não estiver logado não entra em salas.
io.use(async (socket, next) => {
  try {
    if (process.env.DEV_AUTH === "1") {
      // Somente para testes locais (nunca ligado em produção): usuário fake pelo handshake.
      const name = socket.handshake.auth?.devUser;
      socket.data.user = name ? { id: `dev-${name}`, displayName: String(name), banner: "novato", onlineWins: 0, photo: null } : null;
    } else {
      socket.data.user = supabaseEnabled ? await profileFromToken(socket.handshake.auth?.token) : null;
    }
  } catch {
    socket.data.user = null;
  }
  next();
});

// Login obrigatório para criar/entrar em salas.
function requireUser(socket) {
  if (socket.data.user) return true;
  socket.emit("auth-required");
  notice(socket, "Faça login para entrar em uma sala.");
  return false;
}

// Relê o perfil (foto/banner/nome) do usuário logado, pegando mudanças feitas
// depois que o socket conectou — senão a mesa mostraria o perfil antigo.
async function refreshUser(socket) {
  if (!socket.data.user) return;
  const fresh = await gameProfileById(socket.data.user.id);
  if (fresh) socket.data.user = fresh;
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
    // Sem vidas (eliminado) ou já removido da mão: não dá pra jogar — volta como espectador.
    if (player.eliminated) player.spectator = true;
    applyProfile(player, socket.data.user); // atualiza foto/banner se mudaram enquanto esteve fora
    sendSession(socket, room, player);
    transferHost(room);
    notice(socket, player.spectator ? "Você voltou como espectador." : "Você voltou para a mesa.");
    broadcast(room);
  });

  socket.on("solo-game", async ({ name, botCount, botDifficulty } = {}) => {
    if (!requireUser(socket)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    if (!name) return notice(socket, "Digite seu nome.");
    botCount = Math.min(7, Math.max(1, Number.isInteger(Number(botCount)) ? Number(botCount) : 3));
    botDifficulty = ["easy", "normal", "hard"].includes(botDifficulty) ? botDifficulty : "normal";
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.botDifficulty = botDifficulty;
    room.solo = true;
    const bots = Array.from({ length: botCount }, (_, index) => createBot(code, index));
    bots.forEach((bot) => assignRandomAvatar(room, bot));
    room.players.push(...bots);
    rooms.set(code, room);
    sendSession(socket, room, player);
    startGame(room);
  });

  socket.on("create-room", async ({ name } = {}) => {
    if (!requireUser(socket)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    if (!name) return notice(socket, "Digite seu nome.");
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    rooms.set(code, room);
    sendSession(socket, room, player);
    broadcast(room);
  });

  socket.on("create-tournament", async ({ name, tournamentGames } = {}) => {
    if (!requireUser(socket)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    if (!name) return notice(socket, "Digite seu nome.");
    const totalGames = [3, 5].includes(Number(tournamentGames)) ? Number(tournamentGames) : 3;
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.tournament = { totalGames, completedGames: 0, finished: false, playerIds: [], scores: {} };
    room.message = `Torneio Rankeado de ${totalGames} partidas. Chame a turma e comece quando a mesa estiver pronta.`;
    rooms.set(code, room);
    sendSession(socket, room, player);
    broadcast(room);
  });

  socket.on("join-room", async ({ name, code } = {}) => {
    if (!requireUser(socket)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    code = cleanCode(code);
    const room = rooms.get(code);
    if (!name) return notice(socket, "Digite seu nome.");
    if (!room) return notice(socket, "Sala não encontrada.");
    if (room.players.length >= 8) return notice(socket, "A sala já está cheia.");
    // Mesmo nome na mesa: se for um "fantasma" desconectado que dá pra liberar (fora de mão
    // ativa, ou já eliminado/espectador), remove pra deixar a pessoa voltar. Se for alguém
    // conectado, um bot, ou um jogador sendo jogado por bot numa mão em andamento, bloqueia.
    const clash = room.players.find((player) => player.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      const activeHand = ["bidding", "playing", "trick_reveal"].includes(room.phase);
      const busy = clash.connected || clash.isBot || (activeHand && !clash.eliminated && !clash.spectator);
      if (busy) return notice(socket, "Esse nome já está na mesa.");
      if (clash.disconnectTimer) { clearTimeout(clash.disconnectTimer); clash.disconnectTimer = null; }
      room.players = room.players.filter((player) => player.id !== clash.id);
    }
    const player = createPlayer(socket, name);
    // Partida rolando: entra como espectador e vira jogador na próxima partida.
    // No lobby ou no fim de jogo, entra direto para a próxima partida.
    const midGame = (room.phase !== "lobby" && room.phase !== "game_over") || Boolean(room.tournament && room.phase !== "lobby");
    player.spectator = midGame;
    assignRandomAvatar(room, player);
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
    if (room.tournament && room.tournament.completedGames === 0) {
      room.tournament.playerIds = [];
      room.tournament.scores = {};
      room.tournament.finished = false;
      room.tournament.rankingAwarded = false;
    }
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
    const emote = emoteMap[String(key)];
    if (!room || !player || !emote || !emote.active) return;
    const payload = { playerId: player.id, name: player.name, key: emote.key, emoji: emote.emoji, imageUrl: emote.imageUrl };
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
      room.tournament.rankingAwarded = false;
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
    if (!["game_over", "lobby", "round_end"].includes(room.phase)) return notice(socket, "Só dá pra tirar jogador fora da partida ou entre as mãos.");
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
    // Removido entre as mãos: pode acabar o jogo (sobrou 1) ou liberar o auto-avanço.
    if (room.phase === "round_end") {
      if (activePlayers(room).length <= 1) return endGame(room);
      broadcast(room);
      return maybeAutoAdvance(room);
    }
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
    const activeHand = ["bidding", "playing", "trick_reveal"].includes(room.phase);
    if (!activeHand || player.spectator) {
      // Lobby, entre-mãos, fim de jogo ou espectador: não há mão em andamento → sai na hora.
      room.players = room.players.filter((item) => item.id !== player.id);
    } else {
      // Saiu no meio da mão: um bot só TERMINA a mão atual por ele; ao fim dela (scoreRound)
      // o jogador é removido de vez — não vira bot permanente.
      player.auto = true;
      player.quit = true;
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
server.listen(port, "0.0.0.0", async () => {
  console.log(`Se Fode rodando em http://localhost:${port}`);
  selfTest();
  try { await seedEmotes(); await loadEmotes(); } catch (error) { console.error("[emotes] carga inicial falhou:", error.message); }
  refreshWeeklyChampion();
  setInterval(refreshWeeklyChampion, 2 * 60 * 1000); // reavalia o campeão da semana a cada 2 min
});
