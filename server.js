import "./env.js"; // PRIMEIRO: carrega o .env antes de qualquer módulo que leia process.env
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { makeDeck, shuffle, FIXED_MANILHAS, DECK_SIZE, cardStrength, trickWinner, trickOutcome, resolveTrickScore, nextHandSize, validBidOptions, suggestedBid, winStreak, rankingFrom, finalStandingsFrom, tournamentStandingsFrom, medalAwardsForStandings, tournamentHumanCount, tournamentParticipantIdForUser, canResumeAsPlayer, unlockedBannerKeys, remainingDeck, chooseBotPlay, GAME_MODES, TEAM_SIZE, TEAM_PALETTE, DOUBLES_PLAYER_COUNTS, normalizeGameMode, isDoublesMode, doublesSetupError, teamGroupsError, randomTeamGroups, createTeams, teamOf, teamMembers, teamTally, teamHandOutcome, teamLabel, interleaveTeams, activeTeams, teamIsOut, teamStandingsFrom, doublesStandingsFrom, partnerMeladas } from "./game.js";
import { publicConfig, profileFromToken, gameProfileById, verifyToken, ensureProfile, listUsers, leaderboard, publicPlayerProfile, setUserName, setUserBanner, setUserPhoto, recordGame, awardTournamentTrophy, selfTest, listEmotes, createEmote, setEmoteActive, setEmoteSound, deleteEmote, seedEmotes, BANNERS, BANNER_KEYS, AVATAR_KEYS, BUILTIN_EMOTES } from "./supabase.js";

const app = express();
const server = createServer(app);
const io = new Server(server);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const STARTING_LIVES = 5;
const MAX_SEATS = 8;
const MAX_DECKS = 2; // a mesa pode usar um ou dois baralhos
const MAX_SPECTATORS = 32;
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
// A barra da mesa fica enxuta: mostra somente as oito primeiras ativas na ordem
// configurada no dashboard. As demais continuam cadastradas para trocar depois.
const activeEmotes = () => emoteList.filter((emote) => emote.active).slice(0, 8);
async function reloadAndBroadcastEmotes() {
  await loadEmotes();
  io.emit("emotes", activeEmotes()); // atualiza a barra de todo mundo na hora
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

// Quadro geral de medalhas — sem recortes semanal ou mensal.
app.get("/api/leaderboard", async (req, res) => {
  const profile = await authProfile(req);
  if (!profile) return res.status(401).json({ error: "Não autenticado." });
  res.json({ leaderboard: await leaderboard(), banners: BANNERS, meId: profile.id });
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

// Admin: lista os áudios disponíveis em public/emotes/sounds para escolher no dashboard.
app.get("/api/admin/emote-sounds", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  let sounds = [];
  try {
    sounds = fs.readdirSync(path.join(__dirname, "public", "emotes", "sounds"))
      .filter((file) => /\.(mp3|ogg|wav|m4a)$/i.test(file))
      .sort();
  } catch { /* pasta ausente */ }
  res.json({ sounds });
});

// Admin: define (ou limpa) o som de um emote.
app.post("/api/admin/emotes/:key/sound", async (req, res) => {
  const admin = await adminProfile(req, res);
  if (!admin) return;
  const result = await setEmoteSound(req.params.key, req.body?.sound || null);
  if (!result.ok) return res.status(400).json({ error: result.error || "Não foi possível salvar o som da figurinha." });
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
const cleanRoomName = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 28);
const cleanPassword = (value) => String(value || "").trim().slice(0, 24);
// Senha gerada legível (sem caracteres ambíguos como 0/O, 1/I).
const genPassword = () => {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};
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

// ===== SE FODE JUNTO — DUPLAS =====
// A sala guarda a modalidade e a escalação; as regras ficam em game.js. O estado
// decisivo (quem é de qual dupla, quantas vidas restam) é sempre daqui, do servidor:
// o cliente nunca escolhe equipe, dano, colocação nem vencedor.
const isDoubles = (room) => isDoublesMode(room?.mode);
const roomDeckSize = (room) => DECK_SIZE * (room?.deckCount || 1);
const playerTeam = (room, playerId) => teamOf(room.teams, playerId);

// As vidas são da DUPLA. Espelhar o valor em cada parceiro mantém assentos,
// classificação, reconexão e SFX funcionando sem criar uma segunda fonte da verdade.
function syncTeamLives(room) {
  if (!isDoubles(room)) return;
  for (const team of room.teams || []) {
    for (const player of teamMembers(team, room.players)) player.lives = team.lives;
  }
}

// Quantas cadeiras esta sala usa numa partida agora. Em dupla só valem mesas
// completas (4, 6 ou 8), então a arquibancada sobe de dois em dois.
function seatCapacity(room, available) {
  if (!isDoubles(room)) return Math.min(MAX_SEATS, available);
  const valid = DOUBLES_PLAYER_COUNTS.filter((count) => count <= Math.min(MAX_SEATS, available));
  return valid.length ? valid.at(-1) : 0;
}

// Dupla sem ninguém na mesa (os dois desistiram/foram tirados) sai da partida.
function closeEmptyTeams(room) {
  for (const team of room.teams || []) {
    if (team.eliminated || !teamIsOut(team, room.players)) continue;
    team.eliminated = true;
    team.eliminatedAtRound ??= room.round;
    team.lives = 0;
  }
}

// Desistência ou expulsão no meio da partida. No clássico, sair zera as vidas de
// quem saiu. Em dupla as vidas são da equipe: o parceiro segue jogando com a mesma
// reserva e a dupla só cai quando zera ou quando os dois abandonam a mesa.
function retirePlayer(room, player) {
  player.eliminated = true;
  player.eliminatedAtRound ??= room.round;
  if (!isDoubles(room)) {
    player.lives = 0;
    return;
  }
  closeEmptyTeams(room);
  syncTeamLives(room);
}

// A partida acaba quando sobra uma pessoa (clássico) ou uma dupla (em dupla).
function shouldEndGame(room) {
  return isDoubles(room)
    ? activeTeams(room.teams, room.players).length <= 1
    : activePlayers(room).length <= 1;
}

// Impede começar/recomeçar com mesa que não fecha em duplas.
function modeStartError(room, seatedCount) {
  return isDoubles(room) ? doublesSetupError(seatedCount) : null;
}

// Prévia da escalação no lobby. No sorteio, mantém o resultado estável entre os
// broadcasts e só re-sorteia quando a mesa muda. Na organização manual, respeita
// o que o dono montou (mesmo incompleto) — quem valida de fato é o início da partida.
function ensureTeamSetup(room) {
  if (!isDoubles(room)) return;
  const ids = seatedPlayers(room).map((player) => player.id);
  const current = (room.teamSetup.groups || []).map((group) => group.filter((id) => ids.includes(id)));
  if (room.teamSetup.mode === "manual") {
    room.teamSetup.groups = current.filter((group) => group.length);
    return;
  }
  if (doublesSetupError(ids.length)) { room.teamSetup.groups = []; return; }
  room.teamSetup.groups = teamGroupsError(ids, current) ? randomTeamGroups(ids) : current;
}

// Limpa uma escalação vinda do cliente: só ids de quem está sentado, no máximo
// dois por dupla e ninguém em duas duplas. Payload torto é recusado por inteiro.
function sanitizeTeamGroups(room, raw) {
  if (!Array.isArray(raw)) return null;
  const ids = seatedPlayers(room).map((player) => player.id);
  if (raw.length > Math.ceil(ids.length / TEAM_SIZE)) return null;
  const seen = new Set();
  const groups = [];
  for (const group of raw) {
    if (!Array.isArray(group) || group.length > TEAM_SIZE) return null;
    const clean = [];
    for (const value of group) {
      const id = String(value ?? "");
      if (!ids.includes(id) || seen.has(id)) return null;
      seen.add(id);
      clean.push(id);
    }
    groups.push(clean);
  }
  return groups;
}

// Escalação da partida: usa a organização manual enquanto ela continuar válida
// para os jogadores sentados; caso contrário, sorteia. Depois disso, ninguém troca
// de dupla até a partida acabar.
function assignTeams(room, playerIds) {
  const chosen = (room.teamSetup?.groups || []).map((group) => group.filter((id) => playerIds.includes(id)));
  const groups = teamGroupsError(playerIds, chosen) ? randomTeamGroups(playerIds) : chosen;
  room.teams = createTeams(groups, STARTING_LIVES);
  room.teamSetup.groups = room.teams.map((team) => [...team.playerIds]);
  for (const player of room.players) player.teamId = playerTeam(room, player.id)?.id || null;
  syncTeamLives(room);
  return room.teams;
}

// Parceiros alternados na mesa: a ordem dos assentos (e das apostas) segue
// room.players, então basta reordenar os sentados intercalando as duplas.
function seatTeamsAlternately(room) {
  const order = interleaveTeams(room.teams.map((team) => team.playerIds));
  const seated = order.map((id) => playerById(room, id)).filter(Boolean);
  const rest = room.players.filter((player) => !order.includes(player.id));
  room.players = [...seated, ...rest];
}

// A arquibancada pode ter mais pessoas que as oito cadeiras. Em sala comum,
// quem estiver aguardando sobe para uma vaga assim que ela existir, mantendo a
// ordem de chegada. Torneios têm escalação fechada e não promovem espectadores.
function promoteSpectators(room) {
  if (room.tournament) return;
  const waiting = room.players.filter((player) => player.spectator && !player.isBot && player.connected).length;
  const seated = seatedPlayers(room).length;
  let vacancies = Math.max(0, seatCapacity(room, seated + waiting) - seated);
  for (const player of room.players) {
    if (vacancies <= 0) break;
    if (player.spectator && !player.isBot && player.connected) {
      player.spectator = false;
      vacancies -= 1;
    }
  }
}

function tournamentStandings(room) {
  if (!room.tournament) return [];
  return tournamentStandingsFrom(room.tournament.playerIds
    .map((id) => {
      const player = playerById(room, id);
      const score = room.tournament.scores[id];
      // Quem quitou sai da mesa na partida seguinte, mas continua com as
      // medalhas já conquistadas no torneio e pode receber sua premiação final.
      const participant = player?.userId
        ? { userId: player.userId, name: player.name }
        : room.tournament.participants?.[id];
      // Bots continuam na mesa, mas nunca entram no ranking do torneio.
      return participant?.userId && score ? { id, userId: participant.userId, name: participant.name, ...score } : null;
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

// Entre partidas, um participante que saiu pode voltar à sua vaga original.
// Reutilizar o mesmo id mantém o placar e as medalhas já acumuladas no torneio.
function restoreTournamentPlayer(room, socket) {
  const tournament = room.tournament;
  const userId = socket.data.user?.id;
  if (!tournament || tournament.finished || !tournament.completedGames || room.phase !== "game_over") return null;
  const playerId = tournamentParticipantIdForUser(tournament.playerIds, tournament.participants, userId);
  if (!playerId) return null;

  const participant = tournament.participants[playerId];
  let player = playerById(room, playerId);
  if (player?.connected) return null;
  if (player) {
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.name = participant.name;
    player.spectator = false;
    player.quit = false;
    player.auto = false;
    applyProfile(player, socket.data.user);
  } else {
    player = createPlayer(socket, participant.name);
    player.id = playerId;
    room.players.push(player);
  }
  sendSession(socket, room, player);
  transferHost(room);
  notice(socket, "Você voltou ao torneio como jogador.");
  broadcast(room);
  return player;
}

// Quem caiu pode voltar até durante a partida: mantém cartas, vidas e posição.
// Saídas voluntárias zeram resumeToken/quit; expulsões também nunca passam aqui.
function restoreDisconnectedPlayer(room, socket, player) {
  if (!canResumeAsPlayer(player)) return null;
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  player.disconnectTimer = null;
  room.cleanupTimer = null;
  if (room.autoTurnId === player.id && room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.autoTurnId = null;
  }
  player.auto = false;
  applyProfile(player, socket.data.user);
  sendSession(socket, room, player);
  transferHost(room);
  notice(socket, "Você voltou para a mesa.");
  broadcast(room);
  return player;
}

// Troca de dispositivo: a MESMA conta abre em outro aparelho e assume a própria
// cadeira. Transfere a sessão para o novo socket e encerra a do aparelho antigo.
function takeoverSeat(room, socket, player) {
  const oldSocketId = player.socketId;
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) {
      oldSocket.data.roomCode = null;   // zera antes de derrubar: o handler de disconnect não mexe no assento
      oldSocket.data.playerId = null;
      oldSocket.emit("session-taken-over");
      oldSocket.disconnect(true);
    }
  }
  if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
  if (room.autoTurnId === player.id && room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.autoTurnId = null;
  }
  leaveVoice(room, player);           // a malha de voz do aparelho antigo caiu; recomeça no novo se quiser
  player.auto = false;
  player.resumeToken = randomUUID();  // invalida o token do aparelho antigo (não volta e rouba a cadeira)
  applyProfile(player, socket.data.user);
  sendSession(socket, room, player);
  transferHost(room);
  notice(socket, "Você assumiu a mesa neste dispositivo.");
  broadcast(room);
  return player;
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
  socket.leave("lobby"); // entrou numa sala: para de receber a lista da home
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
    // Classificação da partida é congelada no endGame (antes de promover espectadores).
    matchStandings: room.phase === "game_over" ? (room.matchStandings || []) : [],
    medalStandings: room.phase === "game_over" ? (room.medalStandings || []) : [],
    medalMatch: room.phase === "game_over" ? Boolean(room.medalMatch) : false,
    tournament: tournamentState(room),
    lastResult,
    code: room.code,
    roomName: room.name,
    isPrivate: room.isPrivate,
    // senha e convite só interessam a quem já está dentro (para convidar/compartilhar).
    password: room.password || null,
    inviteToken: room.inviteToken,
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
    mode: room.mode,
    deckCount: room.deckCount,
    // Duplas: o cliente só desenha o que vem daqui — meta, ganhas e vidas são calculadas
    // no servidor a cada broadcast, então o painel acompanha a mesa em tempo real.
    teams: isDoubles(room) ? room.teams.map((team) => {
      const tally = teamTally(team, room.players);
      return {
        id: team.id, key: team.key, name: team.name, label: team.label, color: team.color, symbol: team.symbol,
        playerIds: team.playerIds,
        members: teamMembers(team, room.players).map((player) => ({ id: player.id, name: player.name })),
        lives: team.lives,
        bid: tally.bid,
        wins: tally.wins,
        pending: tally.pending,
        eliminated: team.eliminated,
        position: team.position,
      };
    }) : [],
    teamSetup: isDoubles(room) ? { mode: room.teamSetup.mode, groups: room.teamSetup.groups } : null,
    teamPalette: isDoubles(room) ? TEAM_PALETTE : [], // cores/símbolos da prévia no lobby
    teamResults: isDoubles(room) && room.phase === "round_end" ? room.teamResults : [],
    players: seatedPlayers(room).map((player) => ({
      id: player.id,
      profileId: player.userId || null,
      teamId: player.teamId || null,
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
      banner: player.banner || "novato",
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
  if (room.phase === "lobby") ensureTeamSetup(room); // prévia das duplas antes de começar
  for (const player of room.players) {
    if (!player.isBot && player.connected && player.socketId) io.to(player.socketId).emit("state", publicState(room, player.id));
  }
  scheduleAutomaticTurn(room);
  broadcastRoomList();
}

// Lista de salas para a home (canal "lobby"). Nunca expõe a senha.
function roomListDTO() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.solo) continue; // partidas solo não aparecem
    const seated = room.players.filter((player) => !player.spectator);
    if (!seated.some((player) => !player.isBot)) continue; // sala sem humanos sentados não lista
    list.push({
      code: room.code,
      name: room.name || `Mesa ${room.code}`,
      isPrivate: Boolean(room.isPrivate),
      isTournament: Boolean(room.tournament),
      mode: room.mode,           // a pessoa vê que é uma mesa em dupla ANTES de entrar
      deckCount: room.deckCount, // e com quantos baralhos se joga
      count: seated.length,
      max: MAX_SEATS,
      inProgress: room.phase !== "lobby" && room.phase !== "game_over",
    });
  }
  // lobby primeiro, depois em andamento; dentro de cada grupo, mais cheias primeiro
  return list.sort((a, b) => Number(a.inProgress) - Number(b.inProgress) || b.count - a.count);
}
let lastRoomListSig = "";
function broadcastRoomList() {
  const list = roomListDTO();
  const sig = JSON.stringify(list);
  if (sig === lastRoomListSig) return; // só emite quando a lista muda de fato
  lastRoomListSig = sig;
  io.to("lobby").emit("rooms", list);
}

// ===== Chat de voz (WebRTC mesh, best-effort): o servidor só faz o relay da sinalização =====
// Quem já está no voz (menos o próprio), para o novato saber com quem se conectar.
function voicePeers(room, exceptId) {
  return room.players.filter((p) => p.voice && p.connected && p.socketId && !p.isBot && p.id !== exceptId);
}
function voiceEmit(room, playerId, event, payload) {
  const p = playerById(room, playerId);
  if (p && p.connected && p.socketId) io.to(p.socketId).emit(event, payload);
}
// Tira o jogador do voz e avisa os pares (usado no leave/disconnect também).
function leaveVoice(room, player) {
  if (!room || !player || !player.voice) return;
  player.voice = false;
  for (const peer of voicePeers(room, player.id)) io.to(peer.socketId).emit("voice-peer-left", { id: player.id });
}

function newRoom(code, host) {
  const room = {
    code,
    name: null,          // nome da sala (definido ao criar); cai pra "Mesa de <dono>" se vazio
    isPrivate: false,    // sala privada exige senha (ou convite) pra entrar
    password: null,      // senha da sala privada (nunca vai pro publicState de quem está fora)
    inviteToken: randomUUID(), // link de convite entra direto, sem senha
    quickMatch: false,   // sala pública de "partida rápida"
    mode: GAME_MODES.CLASSIC, // modalidade: clássico ou "se fode junto" (duplas)
    deckCount: 1,        // 1 ou 2 baralhos na mesa
    teams: [],           // duplas da partida em curso (vazio no clássico)
    teamSetup: { mode: "random", groups: [] }, // como as duplas são formadas + prévia do lobby
    teamResults: [],     // resumo da última mão por dupla (aposta, ganhas, vidas perdidas)
    hostId: host.id,
    banned: new Set(),   // userIds que o dono tirou da sala: não voltam nem pelo código
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
  const player = { id: randomUUID(), socketId: socket.id, resumeToken: randomUUID(), name, lives: STARTING_LIVES, bid: null, wins: 0, roundLoss: null, eliminated: false, eliminatedAtRound: null, connected: true, auto: false, quit: false, afkStrikes: 0, expelled: false, hand: [], teamId: null, userId: null, banner: "novato", photoUrl: null };
  applyProfile(player, socket.data.user);
  return player;
}

function createBot(code, index) {
  return { id: `bot-${code}-${index}`, name: BOT_NAMES[index], lives: STARTING_LIVES, bid: null, wins: 0, roundLoss: null, eliminated: false, eliminatedAtRound: null, connected: true, isBot: true, hand: [], teamId: null };
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
  const target = suggestedBid(bot.hand, room.botDifficulty, activePlayers(room).length, room.deckCount);
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
    unknown: remainingDeck(known, room.deckCount),
  });
}

// Tempos da mesa. Podem ser encurtados por variável de ambiente para os testes
// automatizados rodarem partidas inteiras em segundos; em produção valem os padrões.
const timing = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const HUMAN_TURN_MS = timing("HUMAN_TURN_MS", 20000); // tempo do jogador online antes do modo automático assumir
const RECONNECT_GRACE_MS = timing("RECONNECT_GRACE_MS", 15000); // tempo pra reconectar antes de um bot assumir a vaga de vez
const AFK_STRIKES_LIMIT = 3; // avisos de inatividade numa partida antes da expulsão
const FOREHEAD_MS = timing("FOREHEAD_MS", 900); // delay entre as cartas na rodada na testa (joga sozinha)
const NEXT_ROUND_MS = timing("NEXT_ROUND_MS", 4000); // tempo pra ver o resultado antes da próxima mão (mesa sem bots)

// Sem host pra clicar: entre as mãos a mesa sempre avança sozinha depois de um tempinho
// (o suficiente pra ver o resultado). Qualquer jogador pode pular a espera (next-round).
function maybeAutoAdvance(room) {
  if (room.phase !== "round_end") return;
  if (room.roundAdvanceTimer) return;
  room.roundAdvanceTimer = setTimeout(() => {
    room.roundAdvanceTimer = null;
    if (room.phase === "round_end") nextRound(room);
  }, NEXT_ROUND_MS);
}

// Ações do dono da mesa: começar, recomeçar e avançar o torneio.
function doStartGame(room) {
  room.players = room.players.filter((player) => player.isBot || player.connected);
  promoteSpectators(room);
  if (room.players.filter((p) => !p.spectator).length < 2) return "Chame pelo menos mais uma pessoa.";
  const modeError = modeStartError(room, seatedPlayers(room).length);
  if (modeError) return modeError;
  if (room.tournament && room.tournament.completedGames === 0) {
    room.tournament.playerIds = [];
    room.tournament.scores = {};
    room.tournament.participants = {};
    room.tournament.finished = false;
    room.tournament.trophyAwarded = false;
  }
  startGame(room);
  return null;
}
function doRestart(room) {
  if (seatedPlayers(room).length < 2) return "Chame pelo menos mais uma pessoa pra recomeçar.";
  const modeError = modeStartError(room, seatedPlayers(room).length);
  if (modeError) return modeError;
  if (room.tournament) {
    if (!room.tournament.finished) return "Use Próxima Partida para continuar o torneio.";
    room.tournament.completedGames = 0;
    room.tournament.finished = false;
    room.tournament.trophyAwarded = false;
    room.tournament.scores = Object.fromEntries(room.tournament.playerIds
      .map((id) => [id, { goldMedals: 0, silverMedals: 0, bronzeMedals: 0, wins: 0, lastPosition: null }]));
  }
  startGame(room);
  return null;
}
function doNextTournament(room) {
  if (!room.tournament) return "Sem torneio.";
  if (room.tournament.finished) return "O torneio já terminou.";
  const modeError = modeStartError(room, seatedPlayers(room).length);
  if (modeError) return modeError;
  startGame(room);
  return null;
}
// ===== Expulsão pelo dono da mesa =====
// O dono tira quem quiser: bot, ausente ou jogador na ativa. Se houver mão em andamento,
// um bot a termina por ele (pra não travar a rodada) e a saída vale no fim da mão; fora de
// mão ativa sai na hora. Quem é tirado não volta a esta sala, nem pelo código.
function kickFromRoom(room, target) {
  target.expelled = true;
  target.resumeToken = null;
  if (target.userId) room.banned.add(target.userId);
  if (target.disconnectTimer) { clearTimeout(target.disconnectTimer); target.disconnectTimer = null; }
  if (room.autoTurnId === target.id && room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.autoTurnId = null;
  }
  if (target.socketId) io.to(target.socketId).emit("expelled", "O dono da mesa tirou você da sala.");
  target.connected = false;
  target.socketId = null;
  const activeHand = ["bidding", "playing", "trick_reveal"].includes(room.phase);
  const inGame = !["lobby", "game_over"].includes(room.phase);
  if (inGame && !target.spectator) {
    // Mesma regra de quem sai por conta própria: a cadeira some só na próxima partida,
    // pra não furar a mão em curso nem sumir da classificação desta.
    target.quit = true;
    if (activeHand) {
      target.auto = true; // um bot fecha a mão por ele
    } else {
      retirePlayer(room, target);
    }
  } else {
    room.players = room.players.filter((item) => item.id !== target.id);
  }
  transferHost(room);
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
    room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); broadcastRoomList(); }, 5 * 60 * 1000);
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
  if (active.length <= 1 || shouldEndGame(room)) return endGame(room);
  room.round += 1;
  room.trick = 1;
  room.table = [];
  room.playedThisHand = []; // zera a memória de cartas a cada nova mão
  room.trickResult = null;
  room.roundLosers = [];
  room.pot = 0;
  room.lastWinnerId = null;
  const deck = shuffle(makeDeck(room.deckCount));
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
  // Expulsos e quem quitou já foram contabilizados na partida anterior, mas não
  // voltam para uma nova partida.
  room.players = room.players.filter((player) => !player.expelled && !player.quit);
  const entrants = seatedPlayers(room);
  if (room.tournament && room.tournament.playerIds.length === 0) {
    room.tournament.playerIds = entrants.map((player) => player.id);
    room.tournament.scores = Object.fromEntries(entrants.map((player) => [player.id, {
      goldMedals: 0, silverMedals: 0, bronzeMedals: 0, wins: 0, lastPosition: null,
    }]));
    room.tournament.participants = Object.fromEntries(entrants
      .filter((player) => player.userId)
      .map((player) => [player.id, { userId: player.userId, name: player.name }]));
  }
  const tournamentPlayers = room.tournament ? new Set(room.tournament.playerIds) : null;
  // Escalação desta partida: quem já estava sentado tem preferência e a arquibancada
  // sobe na ordem de chegada, até onde a mesa comporta. Em dupla, "onde comporta" é
  // 4, 6 ou 8 — o excedente continua assistindo em vez de travar o início com mesa ímpar.
  const alreadySeated = room.players.filter((player) => !player.spectator);
  const waiting = room.players.filter((player) => player.spectator);
  const capacity = seatCapacity(room, alreadySeated.length + waiting.length) || alreadySeated.length;
  const lineup = new Set([...alreadySeated, ...waiting].slice(0, capacity).map((player) => player.id));
  room.players.forEach((player) => Object.assign(player, {
    lives: STARTING_LIVES,
    eliminated: false,
    eliminatedAtRound: null,
    spectator: tournamentPlayers ? !tournamentPlayers.has(player.id) : !lineup.has(player.id),
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
  room.teamResults = [];
  // Modo em dupla: a escalação é fechada AQUI e não muda mais até a partida acabar.
  // A validação do servidor vale mesmo que a interface tenha deixado passar.
  if (isDoubles(room)) {
    const roster = activePlayers(room).map((player) => player.id);
    if (doublesSetupError(roster.length)) {
      room.phase = "lobby";
      room.dealerId = null;
      room.turnId = null;
      room.teams = [];
      for (const player of room.players) player.teamId = null;
      room.message = doublesSetupError(roster.length);
      return broadcast(room);
    }
    assignTeams(room, roster);
    seatTeamsAlternately(room);
  } else {
    room.teams = [];
    for (const player of room.players) player.teamId = null;
  }
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
      room.tournament.participants = {};
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

const TRICK_REVEAL_MS = timing("TRICK_REVEAL_MS", 2400);

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
  const resolved = trickOutcome(room.table);
  const winner = resolved.winner;
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
  // Cartas iguais melam mesmo entre parceiros — não existe proteção dentro da dupla.
  // Só narra assim quando as DUAS cartas anuladas são da mesma equipe.
  const ownGoals = partnerMeladas(resolved.meladaPairs, room.teams).map((hit) => {
    const names = hit.playerIds.map((id) => playerById(room, id)?.name || "Alguém");
    room.history.push({ type: "trick", text: `💥 ${names[0]} meleu o próprio parceiro. A dupla se fodeu junta.` });
    return { teamId: hit.team.id, teamName: hit.team.name, names };
  });
  room.turnId = null; // congela a mesa: nenhum bot joga durante a revelação
  room.phase = "trick_reveal";
  room.trickResult = {
    partnerMelada: ownGoals,
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

// Fim da mão no clássico: cada jogador paga a própria diferença.
function scoreRoundClassic(room) {
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
  return {
    results,
    losers,
    message: losers.length
      ? `Se fodeu: ${losers.map((loser) => `${loser.name} (−${loser.lost}${loser.eliminated ? ", eliminado" : ""})`).join(" · ")}`
      : "Ninguém se fodeu dessa vez — todo mundo cravou.",
  };
}

// Fim da mão em dupla: o dano é da EQUIPE (|meta − ganhas|), sai da reserva
// compartilhada e, se ela zerar, os dois integrantes caem juntos.
function scoreRoundDoubles(room) {
  const results = [];
  const losers = [];
  room.teamResults = [];
  for (const team of room.teams) {
    if (team.eliminated) continue;
    const outcome = teamHandOutcome(team, room.players);
    const members = teamMembers(team, room.players);
    team.lives = outcome.lives;
    for (const member of members) member.roundLoss = outcome.lost;
    if (outcome.eliminated) {
      team.eliminated = true;
      team.eliminatedAtRound = room.round;
      for (const member of members) {
        member.eliminated = true;
        member.eliminatedAtRound ??= room.round;
      }
    }
    room.teamResults.push({
      teamId: team.id, name: team.name, label: team.label, symbol: team.symbol, color: team.color,
      names: members.map((member) => member.name),
      bid: outcome.bid, wins: outcome.wins, lost: outcome.lost, lives: team.lives, eliminated: team.eliminated,
    });
    if (outcome.lost > 0) losers.push({ id: team.id, name: team.name, lost: outcome.lost, eliminated: team.eliminated });
    results.push(`${team.name} (${members.map((member) => member.name).join(" + ")}): apostou ${outcome.bid}, fez ${outcome.wins}${outcome.lost ? ` e perdeu ${outcome.lost} vida${outcome.lost > 1 ? "s" : ""}` : " — cravou"}`);
  }
  syncTeamLives(room);
  return {
    results,
    losers,
    message: losers.length
      ? `Se fodeu junto: ${losers.map((loser) => `${loser.name} (−${loser.lost}${loser.eliminated ? ", eliminada" : ""})`).join(" · ")}`
      : "Nenhuma dupla se fodeu dessa vez — todo mundo cravou.",
  };
}

function scoreRound(room) {
  const { results, losers, message } = isDoubles(room) ? scoreRoundDoubles(room) : scoreRoundClassic(room);
  room.roundLosers = losers;
  // Alguém morreu nesta mão → a próxima volta para 1 carta (na testa).
  room.resetHand = losers.some((loser) => loser.eliminated);
  room.history.push({ type: "round", text: results.join(" • ") });
  room.phase = "round_end";
  room.turnId = null;
  room.table = [];
  room.message = message;
  // Quem quitou deixa o bot fechar a mão, mas a saída vale como eliminação. A
  // pessoa continua na classificação desta partida para contabilizar jogo e medalha.
  // Em dupla, as vidas são da equipe: a desistência de um não mata o parceiro —
  // a dupla só sai quando zera as vidas ou quando os dois abandonam a mesa.
  for (const player of room.players.filter((item) => item.quit && !item.spectator)) retirePlayer(room, player);
  if (shouldEndGame(room)) return endGame(room);
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
    const next = nextHandSize(room.handSize, room.direction, active.length, roomDeckSize(room));
    room.handSize = next.handSize;
    room.direction = next.direction;
  }
  startRound(room);
}

function endGame(room) {
  room.phase = "game_over";
  room.turnId = null;
  const doubles = isDoubles(room);
  // Em dupla quem vence é a EQUIPE: os dois integrantes sobrevivem juntos e
  // entram no ranking da sala com o nome da dupla.
  const winningTeam = doubles ? activeTeams(room.teams, room.players)[0] || null : null;
  const winners = doubles
    ? (winningTeam ? teamMembers(winningTeam, room.players).filter((player) => !player.eliminated) : [])
    : [activePlayers(room)[0]].filter(Boolean);
  const winnerIds = new Set(winners.map((player) => player.id));
  const winnerLabel = doubles
    ? (winningTeam ? teamLabel(winningTeam, room.players) : null)
    : winners[0]?.name || null;
  if (winnerLabel) {
    // Só partidas COM vencedor entram no ranking da sala.
    room.results.push(winnerLabel);
    room.lastWinnerName = winnerLabel;
    const streak = winStreak(room.results, winnerLabel);
    const flair = streak >= 3
      ? ` 👑 ${streak} PARTIDAS SEGUIDAS!`
      : streak === 2
        ? " 🔥 Duas seguidas!"
        : "";
    room.message = doubles
      ? `🏆 A DUPLA ${winnerLabel.toUpperCase()} SOBREVIVEU. O resto se fodeu junto.${flair}`
      : `${winnerLabel} sobreviveu. O resto se fodeu.${flair}`;
  } else {
    room.lastWinnerName = null; // ninguém venceu: não conta pro ranking
    room.message = doubles ? "Todas as duplas se foderam. Impressionante." : "Todo mundo se fodeu. Impressionante.";
  }
  if (doubles) {
    // Colocação por equipe: os dois parceiros recebem exatamente a mesma.
    for (const entry of teamStandingsFrom(room.teams)) {
      const team = room.teams.find((item) => item.id === entry.id);
      if (team) team.position = entry.position;
    }
  }
  // Classificação da partida: em dupla, a posição é da equipe (mesma para os dois).
  const standingsOf = (players) => doubles ? doublesStandingsFrom(room.teams, players) : finalStandingsFrom(players);
  // Bots não contam: posição, medalhas e histórico usam apenas contas humanas.
  const isTournament = Boolean(room.tournament);
  // Quem quitou no meio da partida fica como eliminado na classificação: conta
  // jogo, derrota e a medalha correspondente à posição final.
  const humanStandings = standingsOf(seatedPlayers(room).filter((player) => player.userId));
  const humanCount = humanStandings.length;
  // Numa partida comum vale a mesa atual. No torneio, a regra dos cinco usa a
  // escalação original: uma desistência não invalida as medalhas das rodadas seguintes.
  const medalPlayerCount = isTournament ? tournamentHumanCount(room.tournament.participants) : humanCount;
  const positionById = new Map(humanStandings.map((entry) => [entry.id, entry.position]));
  const online = !room.solo; // solo (contra bots) não conta no quadro de medalhas
  const medalById = medalAwardsForStandings(humanStandings, { online, humanCount: medalPlayerCount });
  const humanPlayers = seatedPlayers(room)
    .filter((player) => player.userId)
    .map((player) => {
      const position = positionById.get(player.id) || humanCount;
      return {
        userId: player.userId,
        position,
        playerCount: humanCount,
        won: winnerIds.has(player.id),
        medal: medalById.get(player.id) || null,
      };
    });
  // A modalidade fica gravada no histórico (coluna `mode`, que já existia): dá para
  // auditar e, depois, separar estatísticas de dupla sem tocar nos registros antigos.
  const baseMode = isTournament ? "Torneio de Medalhas" : "Partida";
  if (humanPlayers.length) recordGame(humanPlayers, winners.map((player) => player.userId).filter(Boolean), doubles ? `${baseMode} em Duplas` : baseMode, online);
  // Vitória ONLINE (pode desbloquear banner) vale para quem sobreviveu — em dupla, os dois.
  if (online) {
    for (const champion of winners) {
      if (!champion.userId) continue;
      champion.onlineWins = (champion.onlineWins || 0) + 1;
      const unlocked = BANNERS.find((banner) => banner.wins === champion.onlineWins);
      if (unlocked && champion.socketId) io.to(champion.socketId).emit("banner-unlocked", { key: unlocked.key, title: unlocked.title });
    }
  }
  if (room.tournament) {
    for (const entry of humanStandings) {
      const score = room.tournament.scores[entry.id];
      if (!score) continue;
      const medal = medalById.get(entry.id) || null;
      if (medal === "gold") score.goldMedals += 1;
      if (medal === "silver") score.silverMedals += 1;
      if (medal === "bronze") score.bronzeMedals += 1;
      score.wins += entry.survived ? 1 : 0;
      score.lastPosition = entry.position;
    }
    room.tournament.completedGames += 1;
    room.tournament.finished = room.tournament.completedGames >= room.tournament.totalGames;
    const finalTournamentStandings = tournamentStandings(room);
    const leader = finalTournamentStandings[0];
    if (room.tournament.finished && finalTournamentStandings.length >= 5 && !room.tournament.trophyAwarded) {
      room.tournament.trophyAwarded = true;
      // Em dupla o título é da equipe do líder: os dois integrantes levam o troféu.
      const championTeam = doubles && leader ? teamOf(room.teams, leader.id) : null;
      const champions = championTeam
        ? teamMembers(championTeam, room.players).map((player) => player.userId).filter(Boolean)
        : [leader?.userId].filter(Boolean);
      for (const championId of champions) awardTournamentTrophy(championId);
    }
    room.message = room.tournament.finished
      ? `${leader?.name || "Alguém"} venceu o Torneio de Medalhas${finalTournamentStandings.length >= 5 ? " e ganhou um troféu!" : "!"}`
      : `Partida ${room.tournament.completedGames}/${room.tournament.totalGames} encerrada. ${leader?.name || "—"} lidera o torneio.`;
  }
  // Congela a classificação da partida ANTES de promover espectadores (senão eles entrariam
  // como "sobreviventes"). Depois, no fim de partida (não-torneio), quem assistia entra na
  // mesa: deixa de ser espectador e passa a poder votar/jogar a próxima partida.
  room.matchStandings = standingsOf(seatedPlayers(room));
  room.medalStandings = standingsOf(seatedPlayers(room).filter((player) => player.userId));
  room.medalMatch = !room.solo && medalPlayerCount >= 5;
  if (!room.tournament) {
    promoteSpectators(room);
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

// Login obrigatório para criar/entrar em salas. Em uma reconexão logo após um
// deploy o handshake pode chegar sem auth; nesse caso valida o token trazido
// pela própria ação em vez de derrubar a sessão já válida no navegador.
async function requireUser(socket, token) {
  if (socket.data.user) return true;
  if (token) {
    const user = await profileFromToken(token);
    if (user) {
      socket.data.user = user;
      return true;
    }
  }
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
  // Home aberta: assina a lista de salas ao vivo (sai do canal ao entrar numa sala).
  socket.on("watch-lobby", () => {
    socket.join("lobby");
    socket.emit("rooms", roomListDTO());
  });

  // Novo dispositivo/login sem sessão local: procura se a conta já está numa partida,
  // pra oferecer "voltar à mesa" (mesmo em sala privada, cujo código a pessoa nem tem).
  socket.on("find-my-game", () => {
    const uid = socket.data.user?.id;
    if (!uid) return socket.emit("my-game", null);
    for (const room of rooms.values()) {
      const seat = room.players.find((p) => !p.isBot && p.userId === uid && !p.eliminated && !p.quit && !p.expelled && p.socketId !== socket.id);
      if (seat) return socket.emit("my-game", { code: room.code, name: room.name, phase: room.phase, spectator: Boolean(seat.spectator) });
    }
    socket.emit("my-game", null);
  });

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

  socket.on("solo-game", async ({ name, botCount, botDifficulty, token } = {}) => {
    if (!await requireUser(socket, token)) return;
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

  // Criação unificada: nome da sala, privada (com senha ou gerada) e, opcionalmente, torneio.
  socket.on("create-room", async ({ name, roomName, isPrivate, password, isTournament, tournamentGames, mode, deckCount, teamSetup, token } = {}) => {
    if (!await requireUser(socket, token)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    if (!name) return notice(socket, "Digite seu nome.");
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.name = cleanRoomName(roomName) || `Mesa de ${name}`;
    // Modalidade e baralhos são escolhidos aqui e valem para a sala inteira. O
    // servidor normaliza: qualquer valor desconhecido cai no clássico com 1 baralho.
    room.mode = normalizeGameMode(mode);
    room.deckCount = Number(deckCount) === MAX_DECKS ? MAX_DECKS : 1;
    room.teamSetup = { mode: teamSetup === "manual" ? "manual" : "random", groups: [] };
    if (isDoubles(room)) {
      room.message = `Se Fode Junto — duplas${room.deckCount > 1 ? " · 2 baralhos" : ""}. Chame a turma: a mesa fecha com ${DOUBLES_PLAYER_COUNTS.join(", ")} jogadores.`;
    }
    if (isPrivate) {
      room.isPrivate = true;
      room.password = cleanPassword(password) || genPassword();
    }
    if (isTournament) {
      const totalGames = [3, 5].includes(Number(tournamentGames)) ? Number(tournamentGames) : 3;
      room.tournament = { totalGames, completedGames: 0, finished: false, playerIds: [], scores: {}, participants: {} };
      room.message = `Torneio de Medalhas${isDoubles(room) ? " em duplas" : ""} com ${totalGames} partidas. Chame a turma e comece quando a mesa estiver pronta.`;
    }
    rooms.set(code, room);
    sendSession(socket, room, player);
    broadcast(room);
  });

  // Partida rápida: joga o jogador numa sala pública aberta aleatória; se não houver, cria uma.
  socket.on("quick-match", async ({ name, token } = {}) => {
    if (!await requireUser(socket, token)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    if (!name) return notice(socket, "Digite seu nome.");
    // Salas públicas no lobby, com vaga, sem o nome já ocupado.
    // Partida rápida é sempre clássica: ninguém cai numa mesa em dupla sem escolher.
    const open = [...rooms.values()].filter((r) => !r.isPrivate && !r.solo && r.phase === "lobby"
      && !isDoubles(r)
      && seatedPlayers(r).length < 8
      && !r.banned.has(socket.data.user.id)
      && !r.players.some((p) => p.name.toLowerCase() === name.toLowerCase()));
    if (open.length) {
      const room = open[Math.floor(Math.random() * open.length)]; // sala aleatória
      const player = createPlayer(socket, name);
      assignRandomAvatar(room, player);
      room.players.push(player);
      sendSession(socket, room, player);
      transferHost(room);
      notice(socket, "Você entrou numa partida rápida. O dono da mesa começa.");
      broadcast(room);
      return;
    }
    // Nenhuma aberta: cria uma sala pública de partida rápida (aparece na lista e no botão).
    const code = roomCode();
    const player = createPlayer(socket, name);
    const room = newRoom(code, player);
    room.name = "Partida Rápida";
    room.quickMatch = true;
    rooms.set(code, room);
    sendSession(socket, room, player);
    notice(socket, "Criamos uma partida rápida. Chame a galera e comece quando quiser!");
    broadcast(room);
  });

  socket.on("join-room", async ({ name, code, password, invite, token } = {}) => {
    if (!await requireUser(socket, token)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    code = cleanCode(code);
    const room = rooms.get(code);
    if (!name) return notice(socket, "Digite seu nome.");
    if (!room) return notice(socket, "Sala não encontrada.");
    if (room.banned.has(socket.data.user.id)) return notice(socket, "O dono tirou você desta sala.");
    // Troca de dispositivo: a mesma conta já está sentada e CONECTADA aqui (outro
    // aparelho). Assume a cadeira neste dispositivo — dispensa senha (é o dono do assento).
    const mySeat = room.players.find((p) => !p.isBot && p.userId && p.userId === socket.data.user.id);
    if (mySeat && mySeat.connected && mySeat.socketId && mySeat.socketId !== socket.id) {
      return takeoverSeat(room, socket, mySeat);
    }
    // Sala privada: entra com o link de convite (token) OU com a senha certa.
    if (room.isPrivate) {
      const invited = invite && invite === room.inviteToken;
      if (!invited && cleanPassword(password) !== room.password) {
        return notice(socket, "Senha incorreta.");
      }
    }
    // O torneio conserva a escalação original até o fim. Quem sai depois de
    // uma partida pode retornar à sua vaga antes da próxima começar.
    if (restoreTournamentPlayer(room, socket)) return;
    // Queda durante uma partida não vira espectador: se ainda houver vidas e
    // não houve expulsão/desistência, a pessoa reassume a própria cadeira.
    const disconnectedPlayer = room.players.find((player) => player.userId === socket.data.user.id);
    if (restoreDisconnectedPlayer(room, socket, disconnectedPlayer)) return;
    // Mesmo nome na mesa: se for um "fantasma" desconectado que dá pra liberar (fora de mão
    // ativa, ou já eliminado/espectador), remove pra deixar a pessoa voltar. Se for alguém
    // conectado, um bot, ou um jogador sendo jogado por bot numa mão em andamento, bloqueia.
    const clash = room.players.find((player) => player.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      const activeHand = ["bidding", "playing", "trick_reveal"].includes(room.phase);
      const busy = clash.connected || clash.isBot || (activeHand && !clash.eliminated && !clash.spectator);
      if (busy) {
        // É a MESMA pessoa (mesmo login) que saiu e tem um bot jogando por ela? Não é conflito
        // de nome: ela só pode voltar pra assistir (e aí o bot sai). Oferece a opção.
        const sameUser = socket.data.user && clash.userId && clash.userId === socket.data.user.id;
        if (sameUser && !clash.connected && !clash.isBot) {
          return socket.emit("rejoin-spectate-offer", { code });
        }
        return notice(socket, "Esse nome já está na mesa.");
      }
      if (clash.disconnectTimer) { clearTimeout(clash.disconnectTimer); clash.disconnectTimer = null; }
      room.players = room.players.filter((player) => player.id !== clash.id);
    }
    const player = createPlayer(socket, name);
    const tableFull = seatedPlayers(room).length >= MAX_SEATS;
    const midGame = (room.phase !== "lobby" && room.phase !== "game_over") || Boolean(room.tournament && room.phase !== "lobby");
    const shouldSpectate = midGame || tableFull;
    const spectatorCount = room.players.filter((player) => player.spectator).length;
    if (shouldSpectate && spectatorCount >= MAX_SPECTATORS) {
      return notice(socket, "A arquibancada desta sala já está cheia.");
    }
    // Partida rolando OU mesa já completa: entra como espectador e vira jogador
    // na próxima partida. Espectadores não ocupam uma das oito cadeiras.
    // No lobby/fim de jogo com vaga, entra direto para a próxima partida.
    player.spectator = shouldSpectate;
    assignRandomAvatar(room, player);
    room.players.push(player);
    sendSession(socket, room, player);
    transferHost(room);
    notice(socket, player.spectator ? (tableFull
      ? "Mesa cheia — você entrou para assistir."
      : "Partida em andamento — você entrou como espectador e joga na próxima.") : "Você entrou na sala.");
    broadcast(room);
  });

  // A pessoa que saiu aceitou voltar pra assistir: o bot que jogava por ela sai (no fim da mão,
  // se houver mão em andamento) e ela entra como espectadora.
  socket.on("rejoin-spectate", async ({ name, code, token } = {}) => {
    if (!await requireUser(socket, token)) return;
    await refreshUser(socket);
    name = cleanName(name) || cleanName(socket.data.user.displayName);
    code = cleanCode(code);
    const room = rooms.get(code);
    if (!room) return notice(socket, "Sala não encontrada.");
    if (room.banned.has(socket.data.user.id)) return notice(socket, "O dono tirou você desta sala.");
    const ghost = room.players.find((p) => !p.isBot && !p.connected && p.userId && p.userId === socket.data.user.id);
    if (ghost) {
      if (["bidding", "playing", "trick_reveal"].includes(room.phase)) ghost.quit = true; // bot termina a mão, aí sai
      else room.players = room.players.filter((p) => p.id !== ghost.id);
    }
    const player = createPlayer(socket, name);
    player.spectator = true;
    assignRandomAvatar(room, player);
    room.players.push(player);
    sendSession(socket, room, player);
    transferHost(room);
    notice(socket, "Você voltou como espectador — o bot sai da mesa.");
    broadcast(room);
  });

  // Quem manda na mesa é o dono — em qualquer sala, pública ou privada.
  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (room.phase !== "lobby") return notice(socket, "Essa partida já começou.");
    const err = doStartGame(room);
    if (err) notice(socket, err);
  });

  // ===== Duplas: sorteio ou organização manual, sempre antes de começar =====
  // O cliente só sugere; quem monta, valida e guarda a escalação é o servidor.
  socket.on("set-teams", ({ mode, groups } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (!isDoubles(room)) return;
    if (room.phase !== "lobby") return notice(socket, "As duplas só mudam antes da partida começar.");
    const ids = seatedPlayers(room).map((player) => player.id);
    if (mode === "random") {
      const error = doublesSetupError(ids.length);
      if (error) return notice(socket, error);
      room.teamSetup = { mode: "random", groups: randomTeamGroups(ids) };
      return broadcast(room);
    }
    const clean = sanitizeTeamGroups(room, groups);
    if (!clean) return notice(socket, "Escalação inválida: cada jogador entra em uma única dupla.");
    room.teamSetup = { mode: "manual", groups: clean };
    broadcast(room);
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
    const payload = { playerId: player.id, name: player.name, key: emote.key, emoji: emote.emoji, imageUrl: emote.imageUrl, sound: emote.sound || null };
    for (const member of room.players) {
      if (!member.isBot && member.connected && member.socketId) io.to(member.socketId).emit("emote", payload);
    }
  });

  // ===== Chat de voz: entrar/sair, relay de oferta-resposta-ICE e "quem fala" =====
  socket.on("voice-join", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player || player.isBot) return;
    player.voice = true;
    // manda ao novato a lista de quem já está no voz…
    socket.emit("voice-peers", voicePeers(room, player.id).map((p) => ({ id: p.id, name: p.name })));
    // …e avisa os demais que ele entrou (cada lado decide quem inicia pela ordem do id)
    for (const peer of voicePeers(room, player.id)) io.to(peer.socketId).emit("voice-peer-joined", { id: player.id, name: player.name });
  });

  socket.on("voice-leave", () => {
    const room = rooms.get(socket.data.roomCode);
    leaveVoice(room, room && playerById(room, socket.data.playerId));
  });

  // Relay de sinalização (SDP/ICE) para um par específico da mesma sala.
  socket.on("voice-signal", ({ to, data } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player || !player.voice || !data) return;
    voiceEmit(room, String(to), "voice-signal", { from: player.id, data });
  });

  // "Quem está falando": o próprio cliente detecta pelo nível do mic e avisa os pares.
  socket.on("voice-speaking", (speaking) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerById(room, socket.data.playerId);
    if (!room || !player || !player.voice) return;
    for (const peer of voicePeers(room, player.id)) io.to(peer.socketId).emit("voice-speaking", { id: player.id, speaking: Boolean(speaking) });
  });

  // Entre as mãos avança sozinho; qualquer jogador pode pular a espera.
  socket.on("next-round", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "round_end") return;
    nextRound(room);
  });

  socket.on("next-tournament-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (!room.tournament || room.phase !== "game_over") return;
    const err = doNextTournament(room);
    if (err) notice(socket, err);
  });

  socket.on("restart", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (room.phase !== "game_over") return;
    const err = doRestart(room);
    if (err) notice(socket, err);
  });

  // O dono tira quem quiser da mesa: bot, ausente ou jogador na ativa, a qualquer momento.
  socket.on("remove-player", (targetId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    const target = playerById(room, String(targetId || ""));
    if (!target || target.id === room.hostId) return;
    kickFromRoom(room, target);
    // Tirado entre as mãos: pode acabar o jogo (sobrou 1) ou liberar o auto-avanço.
    if (room.phase === "round_end") {
      if (shouldEndGame(room)) return endGame(room);
      broadcast(room);
      return maybeAutoAdvance(room);
    }
    // Tirado no lobby/fim de jogo pode esvaziar a mesa de humanos: agenda a limpeza da sala.
    if (!room.players.some((item) => !item.isBot && item.connected)) {
      room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); broadcastRoomList(); }, 5 * 60 * 1000);
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
    leaveVoice(room, player); // saiu da sala → tira do chat de voz e avisa os pares
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    player.connected = false;
    player.socketId = null;
    player.resumeToken = null; // saiu de propósito: não reconecta mais nesta sala
    const activeHand = ["bidding", "playing", "trick_reveal"].includes(room.phase);
    const gameInProgress = !["lobby", "game_over"].includes(room.phase);
    if (!gameInProgress || player.spectator) {
      // Lobby, fim de jogo ou espectador: não há partida para registrar → sai na hora.
      room.players = room.players.filter((item) => item.id !== player.id);
    } else if (activeHand) {
      // Saiu no meio da mão: um bot a termina por ele. Ao fechar a mão, a saída
      // vira eliminação e a partida conta normalmente nas estatísticas.
      player.auto = true;
      player.quit = true;
    } else {
      // Entre mãos, não há bot para jogar: a desistência já é uma eliminação.
      player.quit = true;
      retirePlayer(room, player);
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
      broadcastRoomList();
      return;
    }
    if (!room.players.some((item) => !item.isBot && item.connected)) {
      room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); broadcastRoomList(); }, 5 * 60 * 1000);
    }
    if (gameInProgress && !activeHand && shouldEndGame(room)) return endGame(room);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = playerById(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;
    leaveVoice(room, player); // caiu → tira do chat de voz e avisa os pares
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
        if (!room.players.length) { rooms.delete(room.code); broadcastRoomList(); }
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
      room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); broadcastRoomList(); }, 5 * 60 * 1000);
    }
    broadcast(room);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", async () => {
  console.log(`Se Fode rodando em http://localhost:${port}`);
  selfTest();
  try { await seedEmotes(); await loadEmotes(); } catch (error) { console.error("[emotes] carga inicial falhou:", error.message); }
});
