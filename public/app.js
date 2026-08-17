import { createClient } from "/vendor/supabase.js";

// O callback é executado em CADA handshake/reconexão. Assim o Socket.IO nunca
// reaproveita um access token antigo depois de o Supabase renová-lo.
const socket = io({ autoConnect: false, auth: (callback) => callback({ token: accountToken || undefined }) });
const SESSION_KEY = "fode-session";
let supabase = null;
let accountProfile = null; // { id, email, displayName, role, isAdmin, photo, banner, ... }
let accountToken = null;
let bannerCatalog = [];    // [{ key, title }]
let state = null;
let animatedRound = 0;
let connectedBefore = false;
let myPlayerId = null;
let chatOpen = false;
let chatUnread = 0;
const $ = (selector) => document.querySelector(selector);
const home = $("#home");
const game = $("#game");
const toast = $("#toast");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
const isRed = (card) => card && ["♦", "♥"].includes(card.suit);
const HAND_RANKS = ["4", "5", "6", "7", "Q", "J", "K", "A", "2", "3"];
const cardStrength = (card) => {
  const manilha = (state?.manilhas || []).indexOf(card.id ?? `${card.rank}${card.suit}`);
  return manilha >= 0 ? 100 + manilha : HAND_RANKS.indexOf(card.rank);
};
const cardHtml = (card, extra = "") => card ? `<div class="card ${isRed(card) ? "red" : ""} ${state?.manilhas?.includes(card.id) ? "manilha" : ""} ${extra}"><span>${card.rank}${card.suit}</span><span class="big-suit">${card.suit}</span><span style="transform:rotate(180deg)">${card.rank}${card.suit}</span></div>` : "";
const me = () => state?.players.find((player) => player.id === state.me?.id);
const isHost = () => state?.hostId === state.me?.id;
// Começar, recomeçar e tirar gente da mesa é sempre do dono da sala.
const DOUBLES_COUNTS = [4, 6, 8];
const doublesReady = () => DOUBLES_COUNTS.includes(state.players.length);
function lobbyStartControl(tournament) {
  const label = tournament ? "COMEÇAR O TORNEIO" : "COMEÇAR O CAOS";
  const blocked = state.players.length < 2 || (isDoubles() && !doublesReady());
  return isHost()
    ? `<button id="start" ${blocked ? "disabled" : ""}>${label}</button>`
    : "<p>O dono da sala começa a partida.</p>";
}
function gameOverControl(tournament, tournamentFinished) {
  if (tournament) {
    return tournamentFinished
      ? (isHost() ? '<button id="restart">RECOMEÇAR TORNEIO</button>' : "<p>O dono recomeça o torneio.</p>")
      : (isHost() ? `<button id="next-tournament">PRÓXIMA PARTIDA · ${tournament.completedGames + 1}/${tournament.totalGames}</button>` : "<p>Esperando o dono iniciar a próxima partida.</p>");
  }
  return isHost() ? '<button id="restart">JOGAR DE NOVO</button>' : "<p>O dono da sala recomeça.</p>";
}
const iAmSpectator = () => Boolean(state?.me?.spectator);

// ===== SE FODE JUNTO — DUPLAS (o cliente só desenha o que o servidor manda) =====
const isDoubles = () => state?.mode === "doubles";
const teamById = (id) => (state?.teams || []).find((team) => team.id === id) || null;
const teamOfPlayer = (player) => teamById(player?.teamId);
const myTeam = () => teamOfPlayer(me());
const teamNames = (team) => (team?.members || []).map((member) => member.name);
const teamTitle = (team) => teamNames(team).join(" + ") || team?.name || "Dupla";
// A cor nunca fica sozinha: o nome da dupla vai junto em todo lugar.
const cardKey = (card) => card?.uid || card?.id;
// Títulos conquistados viram chip curto na cadeira; o nome completo fica no tooltip.
const BANNER_CHIPS = { pato: "🦆 Pato", coringa: "🃏 Coringa", manilha: "⭐ Manilha", zap: "⚡ Zap", maldito: "😈 Maldito", rei: "👑 Rei", campeao: "🏆 Campeão" };

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function join(kind, extra = {}) {
  // Atualiza o token antes de enfileirar a ação. Isso cobre o intervalo em que
  // a tela já abriu, mas o socket ainda está reconectando após um deploy.
  const { data } = supabase ? await supabase.auth.getSession() : { data: null };
  if (!data?.session?.access_token) {
    showToast("Sua sessão expirou. Entre de novo.");
    return logout();
  }
  accountToken = data.session.access_token;
  // O nome agora vem da conta (editável no perfil), não mais de um campo no menu.
  socket.emit(kind, {
    name: accountProfile?.displayName || "",
    code: $("#code").value,
    botCount: Number($("#bot-count").value),
    botDifficulty: $("#bot-difficulty").value,
    // Fallback para um socket que acabou de reconectar após deploy. O servidor
    // valida este token da mesma forma que valida as chamadas /api/me.
    token: accountToken,
    ...extra,
  });
}

const roomUrl = (code) => `${location.origin}/?sala=${code}`;

// ===== Efeitos sonoros (Web Audio: baixa latência, permite sobreposição) =====
const SFX_NAMES = ["card", "deal", "bid", "trick", "pot", "manilha", "zap", "zap-card", "melada", "lose", "eliminated", "turn", "win"];
const MAX_SFX_DUR = 1.8;   // corta QUALQUER áudio em ~1.8s (independente do arquivo/uso)
let sfxMuted = localStorage.getItem("sfxMuted") === "1";
let audioCtx = null;
const sfxBuffers = {};
const sfxLastAt = {};      // anti-spam: última vez que cada som tocou
async function loadSfx() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await Promise.all(SFX_NAMES.map(async (name) => {
      try {
        const buf = await (await fetch(`/sfx/${name}.mp3`)).arrayBuffer();
        sfxBuffers[name] = await audioCtx.decodeAudioData(buf);
      } catch {}
    }));
  } catch {}
}
// Toca um AudioBuffer com corte de duração (MAX_SFX_DUR) e anti-spam (gap mínimo por chave).
function playBuffer(buffer, { vol = 0.6, key = null, minGap = 60, maxDur = MAX_SFX_DUR } = {}) {
  if (sfxMuted || !audioCtx || !buffer) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = performance.now();
  if (key) {
    if (sfxLastAt[key] && now - sfxLastAt[key] < minGap) return; // anti-spam: mesmo som muito rápido
    sfxLastAt[key] = now;
  }
  const dur = Math.min(buffer.duration, maxDur);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const gain = audioCtx.createGain();
  const t0 = audioCtx.currentTime;
  gain.gain.setValueAtTime(vol, t0);
  if (buffer.duration > maxDur) { // fade curto no corte pra não estalar
    gain.gain.setValueAtTime(vol, t0 + dur - 0.08);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
  }
  src.connect(gain).connect(audioCtx.destination);
  src.start();
  src.stop(t0 + dur);
}
function playSfx(name, vol = 0.6) {
  playBuffer(sfxBuffers[name], { vol, key: name, minGap: 60 });
}
// Som do emote (escolhido no dashboard): carrega sob demanda de /emotes/sounds e toca
// com corte de duração + anti-spam (gap maior, pois emotes podem ser repetidos rápido).
const emoteSfxBuffers = {};
async function playEmoteSound(file) {
  if (sfxMuted || !audioCtx || !file) return;
  try {
    if (!emoteSfxBuffers[file]) {
      const buf = await (await fetch(`/emotes/sounds/${encodeURIComponent(file)}`)).arrayBuffer();
      emoteSfxBuffers[file] = await audioCtx.decodeAudioData(buf);
    }
    playBuffer(emoteSfxBuffers[file], { vol: 0.7, key: `emote:${file}`, minGap: 500 });
  } catch { /* ignora */ }
}
// O navegador bloqueia áudio até um gesto do usuário: retoma o contexto no 1º toque.
function unlockAudio() { if (audioCtx?.state === "suspended") audioCtx.resume(); }
document.addEventListener("pointerdown", unlockAudio, { once: false });
function updateSfxToggle() {
  const btn = document.getElementById("sfx-toggle");
  if (btn) { btn.textContent = sfxMuted ? "🔇" : "🔊"; btn.classList.toggle("muted", sfxMuted); }
}
document.getElementById("sfx-toggle")?.addEventListener("click", () => {
  sfxMuted = !sfxMuted;
  localStorage.setItem("sfxMuted", sfxMuted ? "1" : "0");
  updateSfxToggle();
  if (!sfxMuted) playSfx("bid", 0.4); // feedback ao religar
});
updateSfxToggle();
loadSfx();

// ===== Dinâmicas: narração da mesa + sequências (combos) =====
const nameOf = (id) => state?.players.find((p) => p.id === id)?.name || "Alguém";
// A mesa "narra" as jogadas num balão no centro do feltro (some sozinho).
let narrationTimer = null;
function narrate(text) {
  const el = document.getElementById("narration");
  if (!el || !text) return;
  el.textContent = text;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show"); // reinicia a animação
  clearTimeout(narrationTimer);
  narrationTimer = setTimeout(() => el.classList.remove("show"), 3400);
}
// Sequência de vazas seguidas do mesmo jogador dentro da mão (para badge + narração).
const comboTrack = { round: 0, lastWinnerId: null, streak: 0 };
let currentCombo = { winnerId: null, count: 0 }; // lido pelo renderSeats no trick_reveal
const playedSeen = new Set(); // cartas que já animaram a entrada (não repetir a cada re-render)

// Toca os SFX conforme o estado muda (detecta os eventos por diff do estado anterior).
const MANILHAS = ["4♣", "7♥", "A♠", "7♦"]; // zap = 4♣ (mais forte)
const sfxTrack = { round: 0, tableIds: "", trickKey: "", bidCount: 0, phase: "", myTurn: false };
function runSounds() {
  if (!state) return;
  // nova mão distribuída
  if (state.round !== sfxTrack.round && state.phase === "bidding" && state.round > 0 && sfxTrack.round > 0) playSfx("deal", 0.45);
  // carta nova na mesa (zap/manilha ganham som próprio + narração das jogadas de peso)
  const ids = (state.table || []).map((item) => item.card?.id).filter(Boolean);
  const idsKey = ids.join(",");
  if (idsKey !== sfxTrack.tableIds) {
    const prevLen = sfxTrack.tableIds ? sfxTrack.tableIds.split(",").length : 0;
    if (ids.length > prevLen) {
      const newId = ids[ids.length - 1];
      const who = nameOf((state.table || [])[state.table.length - 1]?.playerId);
      if (newId === "4♣") { playSfx("zap-card", 0.8); narrate(`⚡ ZAP! ${who} baixou o 4♣`); }
      else if (MANILHAS.includes(newId)) { playSfx("manilha", 0.65); narrate(`🔥 ${who} cravou manilha (${newId})`); }
      else playSfx("card", 0.5);
    }
    sfxTrack.tableIds = idsKey;
  }
  // resolução da vaza (melada / bolo acumulado / vaza normal) + atualiza combo e narra
  const tr = state.trickResult;
  const trickKey = tr ? `${state.round}-${state.trick}-${tr.winnerId || "melou"}` : "";
  if (trickKey && trickKey !== sfxTrack.trickKey) {
    if (comboTrack.round !== state.round) { comboTrack.round = state.round; comboTrack.lastWinnerId = null; comboTrack.streak = 0; }
    const melou = (state.melada || []).length > 0; // houve carta melada (pode ter vencedor mesmo assim)
    if (!tr.winnerId) {
      // sem vencedor de fato: aí sim ninguém levou a mão
      playSfx("melada", 0.6);
      comboTrack.lastWinnerId = null; comboTrack.streak = 0; // quebra a sequência
      currentCombo = { winnerId: null, count: 0 };
      narrate("🍯 MELOU! Ninguém levou");
    } else {
      comboTrack.streak = tr.winnerId === comboTrack.lastWinnerId ? comboTrack.streak + 1 : 1;
      comboTrack.lastWinnerId = tr.winnerId;
      currentCombo = { winnerId: tr.winnerId, count: comboTrack.streak };
      const w = nameOf(tr.winnerId);
      if (comboTrack.streak >= 2) { playSfx("pot", 0.7); narrate(`🔥 ${w} — ${comboTrack.streak} seguidas!`); }
      else if ((state.pot || 0) > 1) { playSfx("pot", 0.7); narrate(`💰 ${w} abocanhou o bolo ×${state.pot}`); }
      else if (melou) { playSfx("melada", 0.6); narrate(`🍯 Melou, mas ${w} levou a mão`); }
      else { playSfx("trick", 0.6); narrate(`${w} levou a mão`); }
    }
    // Parceiro que anula parceiro rouba a narração: é o momento mais cruel do modo.
    const ownGoal = (tr.partnerMelada || [])[0];
    if (ownGoal) narrate(`💥 ${ownGoal.names[0]} meleu o próprio parceiro. A dupla se fodeu junta.`);
    sfxTrack.trickKey = trickKey;
  }
  // apostas: toca quando entra uma aposta nova
  const bidCount = (state.players || []).filter((p) => p.bid != null && !p.spectator && !p.eliminated).length;
  if (state.phase === "bidding" && bidCount > sfxTrack.bidCount) playSfx("bid", 0.4);
  sfxTrack.bidCount = bidCount;
  // fim da mão: se fodeu / eliminado
  if (state.phase === "round_end" && sfxTrack.phase !== "round_end") {
    const losers = state.roundLosers || [];
    if (losers.some((l) => l.eliminated)) playSfx("eliminated", 0.7);
    else if (losers.length) playSfx("lose", 0.6);
    const fodidos = (state.players || []).filter((p) => p.roundLoss > 0);
    const caiu = fodidos.filter((p) => p.eliminated).map((p) => p.name);
    if (caiu.length) narrate(`💀 ${caiu.join(", ")} caiu fora!`);
    else if (fodidos.length) narrate(`😖 ${fodidos.map((p) => p.name).join(", ")} se fodeu`);
  }
  // fim de jogo
  if (state.phase === "game_over" && sfxTrack.phase !== "game_over") {
    playSfx("win", 0.6);
    if (state.lastResult?.name) narrate(`🏆 ${state.lastResult.name} venceu!`);
  }
  // virou a minha vez
  const myTurn = state.turnId === state.me?.id && (state.phase === "bidding" || state.phase === "playing");
  if (myTurn && !sfxTrack.myTurn) playSfx("turn", 0.5);
  sfxTrack.myTurn = myTurn;
  sfxTrack.phase = state.phase;
  sfxTrack.round = state.round;
}

// Nível de tensão da reta final (0 nenhum, 1 médio, 2 alto) — vira atributo no #game
// e o CSS acende um leve pulso vermelho no feltro. Robusto: não depende do índice da vaza.
function tensionLevel() {
  if (!state || !["playing", "trick_reveal"].includes(state.phase)) return 0;
  const alive = (state.players || []).filter((p) => !p.eliminated && (p.lives ?? 0) > 0);
  if (alive.length === 2) return 2;                 // finalíssima: só dois de pé
  if (state.handSize === 1) return 1;               // testa (1 carta): tenso por natureza
  if ((state.pot || 0) > 1) return 1;               // bolo acumulado em jogo
  return 0;
}

// ===== Chat de voz (WebRTC mesh, best-effort) =====
// Cada par vira uma RTCPeerConnection; a sinalização passa pelo servidor. Sem TURN
// (best-effort): funciona na maioria das redes; algumas NATs simétricas podem falhar.
const VOICE_ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
] };
let voiceOn = false;
let voiceMuted = false;
let voiceStream = null;              // meu microfone
let voiceAnalyser = null, voiceRaf = 0, voiceSpeakingLocal = false;
let voiceRejoinPending = false;      // reconstruir a malha após reconectar
const voicePeersMap = new Map();     // peerId -> { pc, audio, remoteStream }
const speaking = new Set();          // ids falando agora (anel verde no assento)
const voiceRoster = new Set();       // ids no chat de voz (badge de mic no assento)
const myId = () => state?.me?.id || null;

function updateVoiceUI() {
  const b = document.getElementById("voice-toggle");
  const m = document.getElementById("voice-mute");
  if (b) { b.textContent = voiceOn ? "🎙️" : "🎧"; b.classList.toggle("on", voiceOn); b.title = voiceOn ? "Sair do chat de voz" : "Entrar no chat de voz"; }
  if (m) { m.classList.toggle("hidden", !voiceOn); m.textContent = voiceMuted ? "🔇" : "🎤"; m.classList.toggle("muted", voiceMuted); m.title = voiceMuted ? "Ativar seu microfone" : "Silenciar seu microfone"; }
}
// Aplica os estados de voz nos assentos já renderizados (sem esperar um re-render completo).
function paintVoice() {
  document.querySelectorAll(".seat[data-seat]").forEach((el) => {
    const id = el.dataset.seat;
    el.classList.toggle("in-voice", voiceRoster.has(id));
    el.classList.toggle("speaking", speaking.has(id));
  });
}
function setSpeaking(id, on) {
  if (!id) return;
  if (on) speaking.add(id); else speaking.delete(id);
  document.querySelector(`.seat[data-seat="${id}"]`)?.classList.toggle("speaking", !!on);
}

async function joinVoice() {
  if (voiceOn) return;
  if (!state?.code) return showToast("Entre numa sala primeiro.");
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch {
    return showToast("Não consegui acessar o microfone. Libere a permissão no navegador.");
  }
  voiceOn = true; voiceMuted = false;
  voiceRoster.add(myId());
  startLocalSpeaking();
  socket.emit("voice-join");
  paintVoice(); updateVoiceUI();
  showToast("🎙️ Você entrou no chat de voz.");
}
function leaveVoice() {
  if (!voiceOn) return;
  voiceOn = false; voiceMuted = false; voiceRejoinPending = false;
  socket.emit("voice-leave");
  for (const id of [...voicePeersMap.keys()]) closePeer(id);
  stopLocalSpeaking();
  if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; }
  speaking.clear(); voiceRoster.clear();
  paintVoice(); updateVoiceUI();
}
function closePeer(id) {
  const p = voicePeersMap.get(id);
  if (p) {
    try { p.pc.ontrack = p.pc.onicecandidate = p.pc.onconnectionstatechange = null; p.pc.close(); } catch { /* já fechado */ }
    if (p.audio) { try { p.audio.srcObject = null; p.audio.remove(); } catch { /* ignora */ } }
    voicePeersMap.delete(id);
  }
  voiceRoster.delete(id); speaking.delete(id);
  paintVoice();
}
function createPeer(peerId, initiator) {
  if (voicePeersMap.has(peerId)) return voicePeersMap.get(peerId);
  const pc = new RTCPeerConnection(VOICE_ICE);
  const audio = document.createElement("audio");
  audio.autoplay = true; audio.playsInline = true; audio.dataset.voice = peerId;
  document.body.appendChild(audio);
  const entry = { pc, audio, remoteStream: new MediaStream() };
  voicePeersMap.set(peerId, entry);
  voiceRoster.add(peerId); paintVoice();
  if (voiceStream) for (const track of voiceStream.getTracks()) pc.addTrack(track, voiceStream);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("voice-signal", { to: peerId, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0] || entry.remoteStream;
    audio.play?.().catch(() => { /* autoplay pode exigir gesto; o clique de entrar já serve */ });
  };
  if (initiator) makeOffer(peerId);
  return entry;
}
async function makeOffer(peerId) {
  const entry = voicePeersMap.get(peerId);
  if (!entry) return;
  try {
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    socket.emit("voice-signal", { to: peerId, data: { sdp: entry.pc.localDescription } });
  } catch { /* best-effort */ }
}
// Detecção de fala local pelo nível do microfone (com histerese pra não piscar).
function startLocalSpeaking() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(voiceStream);
    voiceAnalyser = audioCtx.createAnalyser();
    voiceAnalyser.fftSize = 512;
    src.connect(voiceAnalyser); // NÃO conecta ao destino: evita eco
    const data = new Uint8Array(voiceAnalyser.frequencyBinCount);
    const tick = () => {
      if (!voiceOn || !voiceAnalyser) return;
      voiceAnalyser.getByteTimeDomainData(data);
      let sum = 0; for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / data.length);
      const talking = !voiceMuted && (voiceSpeakingLocal ? rms > 0.028 : rms > 0.05);
      if (talking !== voiceSpeakingLocal) {
        voiceSpeakingLocal = talking;
        setSpeaking(myId(), talking);
        socket.emit("voice-speaking", talking);
      }
      voiceRaf = requestAnimationFrame(tick);
    };
    voiceRaf = requestAnimationFrame(tick);
  } catch { /* sem analyser: segue sem indicador de fala */ }
}
function stopLocalSpeaking() {
  if (voiceRaf) cancelAnimationFrame(voiceRaf);
  voiceRaf = 0; voiceAnalyser = null; voiceSpeakingLocal = false;
}
function toggleVoiceMute() {
  if (!voiceOn) return;
  voiceMuted = !voiceMuted;
  if (voiceStream) voiceStream.getAudioTracks().forEach((t) => { t.enabled = !voiceMuted; });
  if (voiceMuted && voiceSpeakingLocal) { voiceSpeakingLocal = false; setSpeaking(myId(), false); socket.emit("voice-speaking", false); }
  updateVoiceUI();
}
// Reconstrói a malha após uma reconexão (o resume-session já religou o socket à sala).
function maybeRejoinVoice() {
  if (voiceOn && voiceRejoinPending && socket.connected && state?.code) {
    voiceRejoinPending = false;
    socket.emit("voice-join");
  }
}

socket.on("voice-peers", (list) => {
  // acabei de entrar: conecto com quem já estava (eu inicio se meu id for "menor")
  for (const peer of list || []) createPeer(peer.id, myId() < peer.id);
});
socket.on("voice-peer-joined", ({ id } = {}) => { if (id && voiceOn) createPeer(id, myId() < id); });
socket.on("voice-peer-left", ({ id } = {}) => closePeer(id));
socket.on("voice-signal", async ({ from, data } = {}) => {
  if (!voiceOn || !from || !data) return;
  const entry = voicePeersMap.get(from) || createPeer(from, false); // recebi de alguém novo: sou o não-iniciador
  const pc = entry.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("voice-signal", { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  } catch { /* best-effort */ }
});
socket.on("voice-speaking", ({ id, speaking: sp } = {}) => setSpeaking(id, sp));
socket.on("disconnect", () => {
  if (!voiceOn) return;
  for (const id of [...voicePeersMap.keys()]) closePeer(id); // conexões morreram
  voiceRejoinPending = true;
});

document.getElementById("voice-toggle")?.addEventListener("click", () => (voiceOn ? leaveVoice() : joinVoice()));
document.getElementById("voice-mute")?.addEventListener("click", toggleVoiceMute);
updateVoiceUI();

function leaveRoom() {
  leaveVoice(); // sair da sala também sai do chat de voz
  socket.emit("leave-room");
  localStorage.removeItem(SESSION_KEY);
  state = null;
  stopTurnClock();
  setChatOpen(false);
  $("#chat-log").innerHTML = "";
  game.classList.add("hidden");
  home.classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
  watchLobby(); // voltou pra home: reassina a lista de salas
}

function confirmLeave() {
  const activeHand = state && ["bidding", "playing", "trick_reveal"].includes(state.phase);
  const mid = state && !["lobby", "game_over"].includes(state.phase);
  const message = activeHand
    ? "Sair da partida? Um bot termina a mão atual por você e você deixa a mesa."
    : "Sair da partida?";
  if (mid && !confirm(message)) return;
  leaveRoom();
}

// Jogar sozinho abre um modal com as opções (bots/dificuldade) antes de começar.
$("#solo").onclick = () => $("#solo-modal").showModal();
$("#solo-close").onclick = () => $("#solo-modal").close();
$("#solo-start").onclick = () => { $("#solo-modal").close(); join("solo-game"); };
// Criar sala: um modal único (nome + senha opcional + torneio opcional).
function genRoomPassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
const createMode = () => document.querySelector('input[name="create-mode"]:checked')?.value || "classic";
const createDecks = () => Number(document.querySelector('input[name="create-decks"]:checked')?.value || 1);
// O modo em dupla mostra a explicação curta e a escolha de como formar as equipes.
function syncCreateMode() {
  const doubles = createMode() === "doubles";
  $("#create-mode-hint").classList.toggle("hidden", !doubles);
  $("#create-teams-row").classList.toggle("hidden", !doubles);
}
document.querySelectorAll('input[name="create-mode"]').forEach((radio) => radio.addEventListener("change", syncCreateMode));

$("#quick").onclick = () => join("quick-match");
$("#create").onclick = () => {
  $("#create-name").value = "";
  $("#create-private").checked = false;
  $("#create-password").value = "";
  $("#create-tourney").checked = false;
  $("#create-pass-row").classList.add("hidden");
  $("#create-tourney-row").classList.add("hidden");
  document.querySelector('input[name="create-mode"][value="classic"]').checked = true;
  document.querySelector('input[name="create-decks"][value="1"]').checked = true;
  $("#create-teams").value = "random";
  syncCreateMode();
  $("#create-modal").showModal();
};
$("#create-close").onclick = () => $("#create-modal").close();
$("#create-private").onchange = (e) => {
  $("#create-pass-row").classList.toggle("hidden", !e.target.checked);
  // Marcou privada com o campo vazio: já gera a senha — sala privada nunca fica sem senha.
  if (e.target.checked && !$("#create-password").value.trim()) $("#create-password").value = genRoomPassword();
};
$("#create-tourney").onchange = (e) => $("#create-tourney-row").classList.toggle("hidden", !e.target.checked);
$("#create-genpass").onclick = () => { $("#create-password").value = genRoomPassword(); };
$("#create-start").onclick = () => {
  const isPrivate = $("#create-private").checked;
  const isTournament = $("#create-tourney").checked;
  $("#create-modal").close();
  join("create-room", {
    roomName: $("#create-name").value,
    isPrivate,
    password: isPrivate ? $("#create-password").value : "",
    isTournament,
    tournamentGames: Number($("#create-games").value),
    mode: createMode(),
    deckCount: createDecks(),
    teamSetup: $("#create-teams").value,
  });
};

// Entrar por código/lista: se a sala for privada, o servidor pede senha (modal próprio).
let pendingJoin = null;
function joinRoomByCode(code) {
  code = (code || "").trim().toUpperCase();
  if (!code) return;
  pendingJoin = { code };
  join("join-room", { code });
}
$("#join").onclick = () => joinRoomByCode($("#code").value);

// Lista de salas ao vivo na home (canal "lobby").
function watchLobby() { if (socket.connected) socket.emit("watch-lobby"); }
socket.on("rooms", (list) => renderRoomList(list));
function renderRoomList(list) {
  const el = $("#room-list");
  if (!el) return;
  if (!list || !list.length) { el.innerHTML = '<div class="room-empty">Nenhuma sala aberta ainda. Crie a sua!</div>'; return; }
  el.innerHTML = list.map((r) => {
    const full = r.count >= r.max;
    return `
    <button type="button" class="room-row ${r.inProgress ? "in-progress" : ""} ${full ? "full" : ""}" data-code="${r.code}">
      <span class="room-row-main">
        <span class="room-row-name">${r.isPrivate ? '<span class="room-lock" title="Sala privada">🔒</span>' : ""}${escapeHtml(r.name)}${r.isTournament ? ' <span class="room-badge">⚡ TORNEIO</span>' : ""}${r.mode === "doubles" ? ' <span class="room-badge doubles">👥 DUPLAS</span>' : ""}${r.deckCount > 1 ? ' <span class="room-badge">🃏 2 BARALHOS</span>' : ""}</span>
        <span class="room-row-status">${full ? "mesa cheia · entre para assistir" : r.inProgress ? "em jogo · entre para assistir" : "aguardando jogadores"}</span>
      </span>
      <span class="room-row-count">${r.count}/${r.max}</span>
    </button>`;
  }).join("");
  el.querySelectorAll("[data-code]").forEach((btn) => { btn.onclick = () => joinRoomByCode(btn.dataset.code); });
}
$("#code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#rules-open").onclick = () => $("#rules").showModal();
$("#rules-close").onclick = () => $("#rules").close();
$("#copy-code").onclick = async () => {
  // Sala privada: copia o link de CONVITE (entra sem senha). Pública: link normal da sala.
  const url = roomUrl(state.code) + (state.isPrivate && state.inviteToken ? `&convite=${state.inviteToken}` : "");
  await navigator.clipboard.writeText(url);
  showToast(state.isPrivate ? "Link de convite copiado!" : "Link da sala copiado!");
};
$("#leave").onclick = confirmLeave;
$(".mini-brand").addEventListener("click", (event) => { if (state) { event.preventDefault(); confirmLeave(); } });

// Bloqueia o pinch-zoom no mobile (iOS ignora user-scalable=no). O scroll de 1 dedo continua.
document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });

// Link: ?sala=CODIGO preenche o código. Com &convite=TOKEN, entra direto (sem senha).
const linkParams = new URLSearchParams(location.search);
const sharedCode = (linkParams.get("sala") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const linkInvite = linkParams.get("convite") || "";
let pendingInvite = null;
if (sharedCode) {
  $("#code").value = sharedCode;
  if (linkInvite) pendingInvite = { code: sharedCode, invite: linkInvite };
  else setTimeout(() => $("#code").focus(), 0);
}
// Convite por link: assim que estiver logado (e fora de uma sala), entra direto.
function maybeAutoJoinInvite() {
  if (!pendingInvite || state || localStorage.getItem(SESSION_KEY)) return;
  const inv = pendingInvite; pendingInvite = null;
  join("join-room", { code: inv.code, invite: inv.invite });
}

let sessionTakenOver = false; // este aparelho foi substituído por outro (mesma conta)
socket.on("connect", () => {
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    try { socket.emit("resume-session", JSON.parse(saved)); }
    catch { localStorage.removeItem(SESSION_KEY); }
  } else if (!state) {
    socket.emit("find-my-game"); // logado sem sessão local: tem partida em aberto pra voltar?
  }
  if (connectedBefore) showToast("Conexão recuperada.");
  connectedBefore = true;
  if (!state) watchLobby(); // na home: assina a lista de salas ao vivo
});
socket.on("disconnect", () => {
  // Sessão assumida em outro aparelho: o servidor nos derrubou de propósito → reconecta
  // (agora sem sessão local) pra a home voltar a funcionar, sem o toast de "conexão perdida".
  if (sessionTakenOver) { sessionTakenOver = false; setTimeout(() => { if (!socket.connected) socket.connect(); }, 400); return; }
  if (state) showToast("Conexão perdida. Tentando voltar…");
});
socket.on("session", (session) => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  myPlayerId = session.playerId;
});
socket.on("session-expired", () => {
  localStorage.removeItem(SESSION_KEY);
  state = null;
  game.classList.add("hidden");
  home.classList.remove("hidden");
  showToast("A sala anterior não existe mais.");
  if (socket.connected) socket.emit("find-my-game"); // talvez a conta ainda esteja em outra mesa
});

// ===== Troca de dispositivo (mesma conta) =====
// Este aparelho foi substituído por outro: sai da mesa aqui, de forma limpa.
socket.on("session-taken-over", () => {
  sessionTakenOver = true;
  localStorage.removeItem(SESSION_KEY);
  leaveVoice();
  state = null;
  stopTurnClock();
  hideResumeBanner();
  game.classList.add("hidden");
  home.classList.remove("hidden");
  showToast("Você abriu o jogo em outro dispositivo. A sessão aqui foi encerrada.");
});

// Descobriu uma partida em aberto da conta (sem sessão local): oferece "voltar à mesa".
let resumeGame = null;
socket.on("my-game", (info) => {
  if (!info || state) return hideResumeBanner();
  resumeGame = info;
  const txt = $("#resume-banner .resume-text");
  if (txt) txt.textContent = info.spectator
    ? `👁️ Você está assistindo uma partida (sala ${info.code}). Voltar neste dispositivo?`
    : `🎮 Você tem uma partida em andamento (sala ${info.code}).`;
  $("#resume-banner")?.classList.remove("hidden");
});
function hideResumeBanner() { resumeGame = null; $("#resume-banner")?.classList.add("hidden"); }
$("#resume-btn")?.addEventListener("click", () => {
  if (!resumeGame) return;
  const code = resumeGame.code;
  hideResumeBanner();
  joinRoomByCode(code); // o servidor faz o takeover (dispensa senha: é o dono do assento)
});
$("#resume-dismiss")?.addEventListener("click", hideResumeBanner);
socket.on("notice", (text) => {
  // Entrou por código numa sala privada: o servidor recusou por senha → abre o modal próprio.
  if (text === "Senha incorreta." && pendingJoin) {
    if ($("#password-modal").open) {
      // já estava tentando: mostra o erro dentro do modal, sem fechá-lo
      $("#password-error").classList.remove("hidden");
      $("#password-input").select();
    } else {
      $("#password-input").value = "";
      $("#password-error").classList.add("hidden");
      $("#password-modal").showModal();
      setTimeout(() => $("#password-input").focus(), 60);
    }
    return; // não mostra o toast do sistema
  }
  if (text === "Você entrou na sala." || text?.startsWith("Partida em andamento")) {
    pendingJoin = null;
    if ($("#password-modal").open) $("#password-modal").close();
  }
  showToast(text);
});
// Modal de senha próprio (substitui o prompt do sistema) ao entrar numa sala privada.
$("#password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const password = $("#password-input").value.trim();
  if (!password || !pendingJoin) return;
  $("#password-error").classList.add("hidden");
  join("join-room", { code: pendingJoin.code, password });
});
$("#password-close").onclick = () => { pendingJoin = null; $("#password-modal").close(); };

// A pessoa saiu e um bot joga por ela: o servidor oferece voltar só pra assistir (o bot sai).
let rejoinCode = null;
socket.on("rejoin-spectate-offer", ({ code } = {}) => {
  rejoinCode = code;
  pendingJoin = null;
  $("#rejoin-modal").showModal();
});
$("#rejoin-close").onclick = () => { rejoinCode = null; $("#rejoin-modal").close(); };
$("#rejoin-spectate").onclick = () => {
  $("#rejoin-modal").close();
  if (rejoinCode) join("rejoin-spectate", { code: rejoinCode });
  rejoinCode = null;
};
socket.on("state", (next) => {
  state = next;
  home.classList.add("hidden");
  game.classList.remove("hidden");
  render();
});
socket.on("auth-required", () => {
  // O socket pode chegar antes de a renovação do token terminar. Não derruba a
  // conta por isso: confirma a sessão no Supabase e força um novo handshake.
  (async () => {
    const { data } = supabase ? await supabase.auth.getSession() : { data: null };
    if (data?.session?.access_token) {
      accountToken = data.session.access_token;
      socket.disconnect().connect();
      showToast("Conexão atualizada. Tente criar a sala novamente.");
      return;
    }
    showToast("Sua sessão expirou. Entre de novo.");
    logout();
  })();
});
socket.on("expelled", (message) => {
  showToast(message || "Você foi expulso da partida por inatividade.");
  leaveRoom();
});
// Indicativo de novo banner liberado por vitória online.
socket.on("banner-unlocked", async ({ title } = {}) => {
  showToast(`🎉 Novo banner liberado: ${title}! Escolha no seu perfil.`);
  try {
    const me = await api("/api/me");
    accountProfile = me.profile;
    bannerCatalog = me.banners || bannerCatalog;
    renderAccountBar();
    if ($("#profile")?.open) renderBannerChoices();
  } catch { /* ignora: atualiza no próximo login */ }
});

// ===== Contas (Supabase Auth) =====
const authScreen = $("#auth");

function setAuthError(text) {
  const box = $("#auth-error");
  box.textContent = text || "";
  box.classList.toggle("hidden", !text);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}), ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erro ${res.status}`);
  return res.json();
}

async function boot() {
  let cfg;
  try { cfg = await fetch("/api/config").then((r) => r.json()); }
  catch { cfg = { enabled: false }; }
  if (!cfg.enabled) {
    authScreen.classList.remove("hidden");
    home.classList.add("hidden");
    $("#auth-form").classList.add("hidden");
    $("#auth-toggle").classList.add("hidden");
    $("#auth-disabled").classList.remove("hidden");
    return;
  }
  supabase = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  supabase.auth.onAuthStateChange((_event, session) => applySession(session));
  const { data } = await supabase.auth.getSession();
  applySession(data.session);
}

let sessionReady = false;
async function applySession(session) {
  const token = session?.access_token || null;
  accountToken = token;
  if (!token) {
    accountProfile = null;
    showAuthScreen();
    return;
  }
  try {
    const me = await api("/api/me");
    accountProfile = me.profile;
    bannerCatalog = me.banners || [];
  } catch (err) {
    // Token válido mas o servidor não carregou o perfil (tipicamente 401 por
    // SUPABASE_SERVICE_ROLE_KEY errada no servidor). Mensagem genérica ao usuário;
    // o detalhe técnico fica só no console (para o dev/admin diagnosticar).
    accountProfile = null;
    showAuthScreen();
    setAuthError("Não foi possível carregar seu perfil. Feche esta aba e abra novamente em alguns instantes.");
    console.error("Falha ao carregar /api/me:", err);
    return;
  }
  showLoggedIn();
  if (!sessionReady) { sessionReady = true; socket.connect(); }
}

function showAuthScreen() {
  authScreen.classList.remove("hidden");
  home.classList.add("hidden");
  game.classList.add("hidden");
}

function showLoggedIn() {
  authScreen.classList.add("hidden");
  if (!state) home.classList.remove("hidden");
  renderAccountBar();
  if (!state) watchLobby();
  maybeAutoJoinInvite();
}

function renderAccountBar() {
  if (!accountProfile) return;
  $("#account-name").textContent = accountProfile.displayName;
  $("#account-photo").innerHTML = photoMarkup(accountProfile.photo, accountProfile.displayName);
  $("#account-wins").innerHTML = `🏆 <b>${accountProfile.wins}</b> vitória${accountProfile.wins === 1 ? "" : "s"}`;
  $("#dashboard-link").classList.toggle("hidden", !accountProfile.isAdmin);
}

// Monta a foto (avatar pronto, url de upload ou inicial) para um elemento.
function photoMarkup(photo, name) {
  const src = photoUrlFor(photo);
  return src ? `<img src="${src}" alt="${escapeHtml(name || "")}" />` : escapeHtml((name?.[0] || "?").toUpperCase());
}
function photoUrlFor(photo) {
  if (!photo) return null;
  if (/^https?:\/\//.test(photo)) return photo;
  return `/avatars/players/${encodeURIComponent(photo)}.webp`;
}

function profileStats(profile) {
  const games = Number(profile.gamesPlayed || 0);
  const wins = Number(profile.wins || 0);
  return { games, wins, rate: games ? Math.round((wins / games) * 100) : 0 };
}

function playerPhotoMarkup(profile) {
  return photoMarkup(profile.photo || null, profile.displayName || profile.name || "Jogador");
}

function recentGameLabel(game) {
  const date = game.played_at ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(game.played_at)) : "—";
  return `${date} · ${game.mode || "Partida"}`;
}

// Botão de tirar da mesa: só o dono vê, e nunca em si mesmo nem no modo solo.
function kickPlayerBtn(currentPlayer) {
  const can = currentPlayer && isHost() && !state?.solo && currentPlayer.id !== state?.me?.id;
  return can ? `<button id="kick-player" class="player-kick">🚪 Tirar ${escapeHtml(currentPlayer.name)} da sala</button>` : "";
}
function renderPlayerCard(profile, currentPlayer = null) {
  const body = $("#player-card-body");
  const stats = profileStats(profile);
  const banner = profile.banner && profile.banner !== "novato"
    ? `<span class="banner-pill banner-${escapeHtml(profile.banner)}">${escapeHtml(bannerTitle(profile.banner))}</span>` : "";
  // Em dupla as vidas são da equipe e moram só no placar da mesa: aqui entra a
  // dupla de quem se está olhando, sem repetir o número de vidas em outro canto.
  const currentTeam = teamOfPlayer(currentPlayer);
  const nowTitle = currentTeam
    ? `${currentTeam.symbol} ${escapeHtml(currentTeam.name)}`
    : `${currentPlayer?.lives} ${currentPlayer?.lives === 1 ? "vida" : "vidas"}`;
  const now = currentPlayer ? `<div class="player-card-now"><span>NA MESA</span><b>${nowTitle}</b><small>${currentPlayer.bid == null ? "Ainda não apostou" : `Apostou ${currentPlayer.bid} · fez ${currentPlayer.wins}`}</small></div>` : "";
  const games = (profile.recentGames || []).map((game) => `
    <li class="player-history-item ${game.won ? "won" : ""}">
      <span class="history-result">${game.won ? "🏆" : `${game.position}º`}</span>
      <span><b>${game.won ? "Vitória" : `${game.position}º lugar de ${game.player_count}`}</b><small>${escapeHtml(recentGameLabel(game))}</small></span>
    </li>`).join("");
  body.innerHTML = `
    <div class="kicker">PERFIL DE JOGADOR</div>
    <div class="player-card-head">
      <span class="player-card-photo ${photoUrlFor(profile.photo) ? "has-img" : ""}">${playerPhotoMarkup(profile)}</span>
      <div><h2>${escapeHtml(profile.displayName || profile.name || "Jogador")}</h2>${banner}</div>
    </div>
    ${now}
    <div class="player-stat-grid"><div><b>${stats.games}</b><span>PARTIDAS</span></div><div><b>${stats.wins}</b><span>VITÓRIAS</span></div><div><b>${stats.rate}%</b><span>APROVEITAMENTO</span></div></div>
    <div class="player-points-grid"><div><b>${profile.goldMedals || 0}</b><span>🥇 OURO</span></div><div><b>${profile.silverMedals || 0}</b><span>🥈 PRATA</span></div><div><b>${profile.bronzeMedals || 0}</b><span>🥉 BRONZE</span></div><div><b>${profile.tournamentTitles || 0}</b><span>🏆 TROFÉUS</span></div></div>
    <section class="player-history"><div class="player-history-title">HISTÓRICO RECENTE</div>${profile.historyAvailable === false ? '<p class="player-history-empty">O histórico começa a ser salvo nas próximas partidas.</p>' : games ? `<ul>${games}</ul>` : '<p class="player-history-empty">Ainda não terminou uma partida.</p>'}</section>
    ${kickPlayerBtn(currentPlayer)}`;
  $("#kick-player")?.addEventListener("click", () => {
    if (!confirm(`Tirar ${currentPlayer.name} da sala? Ele não volta nesta mesa.`)) return;
    socket.emit("remove-player", currentPlayer.id);
    $("#player-card").close();
  });
}

async function openPlayerCard(player) {
  const dialog = $("#player-card");
  const body = $("#player-card-body");
  dialog.showModal();
  body.innerHTML = '<p class="player-card-loading">Carregando perfil…</p>';
  if (!player.profileId) {
    renderPlayerCard({ displayName: player.name, photo: player.photoUrl || player.avatarKey || null, banner: player.banner, gamesPlayed: 0, wins: 0, recentGames: [] }, player);
    return;
  }
  try {
    const data = await api(`/api/players/${encodeURIComponent(player.profileId)}`);
    bannerCatalog = data.banners || bannerCatalog;
    renderPlayerCard(data.profile, player);
  } catch (err) {
    body.innerHTML = `<p class="player-card-loading">${escapeHtml(err.message || "Não foi possível abrir o perfil.")}</p>`;
  }
}

// --- Formulário de login/cadastro ---
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("#auth-title").textContent = signup ? "CRIAR CONTA" : "ENTRAR";
  $("#auth-sub").textContent = signup ? "Crie sua conta para jogar." : "Faça login para jogar.";
  $("#auth-submit").textContent = signup ? "CRIAR CONTA" : "ENTRAR";
  $("#auth-name-label").classList.toggle("hidden", !signup);
  $("#auth-name").classList.toggle("hidden", !signup);
  $("#auth-toggle").innerHTML = signup ? "Já tem conta? <b>Entrar</b>" : "Não tem conta? <b>Criar conta</b>";
  $("#auth-password").autocomplete = signup ? "new-password" : "current-password";
  setAuthError("");
}

$("#auth-toggle").onclick = () => setAuthMode(authMode === "login" ? "signup" : "login");
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthError("");
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const displayName = $("#auth-name").value.trim();
  if (!email || !password) return setAuthError("Preencha e-mail e senha.");
  if (authMode === "signup" && password.length < 6) return setAuthError("A senha precisa de pelo menos 6 caracteres.");
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName || email.split("@")[0] } } });
      if (error) throw error;
      if (!data.session) {
        // setAuthMode limpa mensagens anteriores, então ele precisa vir antes
        // do aviso de confirmação para a pessoa saber o próximo passo.
        setAuthMode("login");
        setAuthError("Conta criada! Confirme seu e-mail para entrar.");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setAuthError(err?.message || "Não foi possível autenticar.");
  } finally {
    submit.disabled = false;
  }
});

async function logout() {
  try { if (socket.connected) socket.emit("leave-room"); } catch {}
  localStorage.removeItem(SESSION_KEY);
  state = null;
  sessionReady = false;
  if (socket.connected) socket.disconnect();
  game.classList.add("hidden");
  home.classList.add("hidden");
  if (supabase) await supabase.auth.signOut();
  accountProfile = null; accountToken = null;
  showAuthScreen();
}

boot();

// ===== Perfil (foto) =====
$("#logout")?.addEventListener("click", logout);
$("#profile-open")?.addEventListener("click", openProfile);
$("#profile-close")?.addEventListener("click", () => $("#profile").close());
$("#player-card-close")?.addEventListener("click", () => $("#player-card").close());

function bannerTitle(key) {
  return bannerCatalog.find((banner) => banner.key === key)?.title || "Novato";
}

const AVATAR_OPTIONS = ["jogador-1", "jogador-2", "jogador-3", "jogador-4", "jogador-5"];
const PHOTO_RATIOS = { "1:1": 1, "4:5": 4 / 5, "16:9": 16 / 9 };
let pendingPhotoSource = null;
let selectedPhotoRatio = "1:1";

function openProfile() {
  if (!accountProfile) return;
  $("#profile-name").textContent = accountProfile.displayName;
  $("#profile-name-input").value = accountProfile.displayName || "";
  $("#profile-photo").innerHTML = photoMarkup(accountProfile.photo, accountProfile.displayName);
  $("#profile-banner-preview").innerHTML = `<span class="banner-pill banner-${accountProfile.banner}">${escapeHtml(bannerTitle(accountProfile.banner))}</span>`;
  renderBannerChoices();
  $("#profile").showModal();
}

// Grid de banners: a trilha conquistável por vitórias online. Banner concedido
// (exclusivo/campeão) aparece como cartão atual, não selecionável.
function renderBannerChoices() {
  const box = $("#banner-choices");
  const wins = accountProfile.onlineWins || 0;
  const current = accountProfile.banner;
  const currentMeta = bannerCatalog.find((banner) => banner.key === current);
  const granted = currentMeta && (currentMeta.exclusive || currentMeta.auto)
    ? `<div class="banner-choice banner-${current} active readonly"><span class="bc-title">${escapeHtml(currentMeta.title)}</span><span class="bc-status">${currentMeta.auto ? "👑 automático" : "concedido"}</span></div>`
    : "";
  const trail = bannerCatalog.filter((banner) => Number.isInteger(banner.wins)).map((banner) => {
    const unlocked = wins >= banner.wins;
    const active = current === banner.key;
    const need = banner.wins - wins;
    return `<button class="banner-choice banner-${banner.key} ${unlocked ? "" : "locked"} ${active ? "active" : ""}" data-banner="${banner.key}" ${unlocked && !active ? "" : "disabled"}>
      <span class="bc-title">${escapeHtml(banner.title)}</span>
      <span class="bc-status">${active ? "EM USO" : unlocked ? "Usar" : `🔒 ${need} vit.`}</span>
    </button>`;
  }).join("");
  box.innerHTML = granted + trail;
  box.querySelectorAll("[data-banner]").forEach((btn) => btn.onclick = () => saveBanner(btn.dataset.banner));
}

async function saveBanner(key) {
  if (key === accountProfile.banner) return;
  try {
    const res = await api("/api/me/banner", { method: "POST", body: JSON.stringify({ banner: key }) });
    accountProfile.banner = res.banner;
    $("#profile-banner-preview").innerHTML = `<span class="banner-pill banner-${accountProfile.banner}">${escapeHtml(bannerTitle(accountProfile.banner))}</span>`;
    renderBannerChoices();
    showToast("Banner atualizado!");
  } catch (err) {
    showToast(err.message || "Banner ainda não desbloqueado.");
  }
}

// --- Modal de foto (aberto ao tocar na foto) ---
$("#profile-photo-btn")?.addEventListener("click", openPhotoModal);
$("#photo-close")?.addEventListener("click", () => {
  clearPendingPhoto();
  $("#photo-modal").close();
});

function renderAvatarChoices() {
  $("#avatar-choices").innerHTML = AVATAR_OPTIONS.map((key) => {
    const active = accountProfile.photo === key ? "active" : "";
    return `<button class="avatar-choice ${active}" data-avatar="${key}"><img src="/avatars/players/${key}.webp" alt="${key}" /></button>`;
  }).join("");
  $("#avatar-choices").querySelectorAll("[data-avatar]").forEach((btn) => btn.onclick = () => {
    clearPendingPhoto();
    savePhoto({ avatarKey: btn.dataset.avatar });
  });
}
function openPhotoModal() {
  if (!accountProfile) return;
  clearPendingPhoto();
  renderAvatarChoices();
  $("#photo-modal").showModal();
}

async function saveName() {
  const name = $("#profile-name-input").value.trim();
  if (!name) return showToast("Escolha um nome.");
  if (name === accountProfile.displayName) return;
  const btn = $("#profile-name-save");
  btn.disabled = true;
  try {
    const res = await api("/api/me/name", { method: "POST", body: JSON.stringify({ name }) });
    accountProfile.displayName = res.displayName;
    $("#profile-name").textContent = res.displayName;
    renderAccountBar();
    showToast("Nome atualizado!");
  } catch (err) {
    showToast(err.message || "Não deu pra salvar o nome.");
  } finally {
    btn.disabled = false;
  }
}
$("#profile-name-save")?.addEventListener("click", saveName);
$("#profile-name-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveName(); } });

async function savePhoto(payload) {
  try {
    const res = await api("/api/me/photo", { method: "POST", body: JSON.stringify(payload) });
    accountProfile.photo = res.photo;
    $("#profile-photo").innerHTML = photoMarkup(accountProfile.photo, accountProfile.displayName);
    renderAccountBar();
    if ($("#photo-modal")?.open) renderAvatarChoices(); // atualiza o destaque do avatar escolhido
    showToast("Foto atualizada!");
    return true;
  } catch (err) {
    showToast(err.message || "Não deu pra salvar a foto.");
    return false;
  }
}

function clearPendingPhoto() {
  pendingPhotoSource = null;
  selectedPhotoRatio = "1:1";
  $("#photo-crop")?.classList.add("hidden");
  const preview = $("#photo-crop-preview");
  if (preview) preview.innerHTML = "";
  document.querySelectorAll(".photo-ratio-choice").forEach((button) => button.classList.toggle("active", button.dataset.photoRatio === selectedPhotoRatio));
}

function renderPendingPhoto() {
  const crop = $("#photo-crop");
  const preview = $("#photo-crop-preview");
  if (!crop || !preview || !pendingPhotoSource) return;
  crop.classList.remove("hidden");
  preview.style.aspectRatio = PHOTO_RATIOS[selectedPhotoRatio];
  preview.innerHTML = `<img src="${pendingPhotoSource}" alt="Prévia da foto" />`;
  document.querySelectorAll(".photo-ratio-choice").forEach((button) => button.classList.toggle("active", button.dataset.photoRatio === selectedPhotoRatio));
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Não foi possível abrir essa imagem."));
    image.src = source;
  });
}

async function cropPhotoToRatio(source, ratioKey) {
  const image = await loadImage(source);
  const ratio = PHOTO_RATIOS[ratioKey] || 1;
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  let cropWidth = image.naturalWidth;
  let cropHeight = image.naturalHeight;
  if (sourceRatio > ratio) cropWidth = Math.round(cropHeight * ratio);
  else cropHeight = Math.round(cropWidth / ratio);
  const sourceX = Math.round((image.naturalWidth - cropWidth) / 2);
  const sourceY = Math.round((image.naturalHeight - cropHeight) / 2);
  const maxDimension = 800;
  const targetWidth = ratio >= 1 ? maxDimension : Math.round(maxDimension * ratio);
  const targetHeight = ratio >= 1 ? Math.round(maxDimension / ratio) : maxDimension;
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.getContext("2d").drawImage(image, sourceX, sourceY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL("image/jpeg", 0.88);
}

$("#photo-upload")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 2_500_000) return showToast("Imagem muito grande (máx. ~2MB).");
  const reader = new FileReader();
  reader.onload = () => {
    pendingPhotoSource = reader.result;
    selectedPhotoRatio = "1:1";
    renderPendingPhoto();
  };
  reader.readAsDataURL(file);
});

document.querySelectorAll(".photo-ratio-choice").forEach((button) => button.addEventListener("click", () => {
  selectedPhotoRatio = button.dataset.photoRatio;
  renderPendingPhoto();
}));

$("#photo-upload-save")?.addEventListener("click", async () => {
  if (!pendingPhotoSource) return;
  const button = $("#photo-upload-save");
  button.disabled = true;
  try {
    const dataUrl = await cropPhotoToRatio(pendingPhotoSource, selectedPhotoRatio);
    if (await savePhoto({ dataUrl })) clearPendingPhoto();
  } catch (err) {
    showToast(err.message || "Não foi possível preparar essa imagem.");
  } finally {
    button.disabled = false;
  }
});

// ===== Quadro geral de medalhas =====
$("#ranking-open")?.addEventListener("click", openRanking);
$("#ranking-close")?.addEventListener("click", () => $("#ranking").close());
const RANKING_EMPTY = "Ainda não há jogadores no quadro.";

const RANKING_RULES = {
  medals: {
    title: "🏅 Quadro de Medalhas",
    intro: "O ranking mostra as medalhas conquistadas no pódio de cada partida.",
    base: "Só partidas com 5 ou mais jogadores humanos valem: 1º leva ouro, 2º prata e 3º bronze. O campeão de um torneio válido ganha um troféu.",
    examples: [],
  },
};

$("#ranking-rules-btn")?.addEventListener("click", () => openRulesModal("medals"));
$("#ranking-rules-close")?.addEventListener("click", () => $("#ranking-rules-modal").close());

function openRulesModal(mode) {
  const rules = RANKING_RULES[mode] || RANKING_RULES.medals;
  $("#rules-title").textContent = rules.title;
  const examples = (rules.examples || []).map((example) =>
    `<div class="rule-ex"><span class="rule-ex-label">${escapeHtml(example.label)}</span><span class="rule-ex-value">${escapeHtml(example.value)}</span></div>`).join("");
  $("#rules-body").innerHTML = `
    <p class="rules-intro">${escapeHtml(rules.intro)}</p>
    <div class="rules-base">${escapeHtml(rules.base)}</div>
    ${examples ? `<div class="rules-ex-title">EXEMPLOS</div>${examples}` : ""}`;
  $("#ranking-rules-modal").showModal();
}

async function openRanking() {
  $("#ranking").showModal();
  loadRanking();
}

async function loadRanking() {
  const body = $("#ranking-body");
  body.innerHTML = '<p class="ranking-loading">Carregando…</p>';
  try {
    const data = await api("/api/leaderboard");
    bannerCatalog = data.banners || bannerCatalog;
    const rows = data.leaderboard || [];
    if (!rows.length) {
      body.innerHTML = `<p class="ranking-loading">${RANKING_EMPTY}</p>`;
      return;
    }
    body.innerHTML = rows.map((user, index) => {
      const medal = ["🥇", "🥈", "🥉"][index] || `${index + 1}º`;
      const mine = user.id === data.meId ? "mine" : "";
      const bannerTag = user.banner && user.banner !== "novato"
        ? `<span class="banner-pill banner-${user.banner}">${escapeHtml(bannerTitle(user.banner))}</span>` : "";
      return `<div class="lb-row ${mine}">
        <span class="lb-pos">${medal}</span>
        <span class="lb-photo ${photoUrlFor(user.photo) ? "has-img" : ""}">${photoMarkup(user.photo, user.displayName)}</span>
        <span class="lb-name">${escapeHtml(user.displayName)}${bannerTag}</span>
        <span class="lb-stat gold"><b>${user.goldMedals || 0}</b><small>🥇 OURO</small></span>
        <span class="lb-stat silver"><b>${user.silverMedals || 0}</b><small>🥈 PRATA</small></span>
        <span class="lb-stat bronze"><b>${user.bronzeMedals || 0}</b><small>🥉 BRONZE</small></span>
        <span class="lb-stat trophies"><b>${user.tournamentTitles || 0}</b><small>🏆 TROFÉUS</small></span>
      </div>`;
    }).join("");
  } catch (err) {
    body.innerHTML = `<p class="ranking-loading">${escapeHtml(err.message || "Erro ao carregar.")}</p>`;
  }
}

// ===== Chat da sala =====
const chatLog = $("#chat-log");
const chatBadge = $("#chat-badge");

function appendChat(message) {
  const mine = message.playerId === myPlayerId;
  const row = document.createElement("div");
  row.className = `chat-msg ${mine ? "mine" : ""}`;
  row.innerHTML = `<span class="chat-name">${escapeHtml(mine ? "você" : message.name)}</span><span class="chat-text">${escapeHtml(message.text)}</span>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setChatOpen(open) {
  chatOpen = open;
  game.classList.toggle("chat-open", open);
  $("#chat").classList.toggle("hidden", !open);
  $("#chat-toggle").classList.toggle("active", open);
  if (open) {
    setEmoteOpen(false); // abre um de cada vez
    chatUnread = 0;
    chatBadge.classList.add("hidden");
    chatLog.scrollTop = chatLog.scrollHeight;
    $("#chat-input").focus();
  }
}

let emoteOpen = false;
function setEmoteOpen(open) {
  emoteOpen = open;
  $("#emote-bar").classList.toggle("hidden", !open);
  $("#emote-toggle").classList.toggle("active", open);
  if (open) setChatOpen(false); // abre um de cada vez
}

socket.on("chat-history", (list) => {
  chatLog.innerHTML = "";
  chatUnread = 0;
  chatBadge.classList.add("hidden");
  (list || []).forEach(appendChat);
});

socket.on("chat", (message) => {
  appendChat(message);
  if (!chatOpen && message.playerId !== myPlayerId) {
    chatUnread += 1;
    chatBadge.textContent = chatUnread > 9 ? "9+" : String(chatUnread);
    chatBadge.classList.remove("hidden");
  }
});

$("#chat-toggle").onclick = () => setChatOpen(!chatOpen);
$("#chat-close").onclick = () => setChatOpen(false);
$("#emote-toggle").onclick = () => setEmoteOpen(!emoteOpen);
$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat", text);
  input.value = "";
});

// ===== Emotes =====
// A lista de figurinhas vem do servidor (gerenciável no dashboard). Cada uma usa
// imageUrl (upload) OU cai para /emotes/<key>.png e, por fim, para o emoji.
let emoteList = [];
let emoteById = {};
let emoteCooldown = 0;

async function loadEmotes() {
  try {
    const data = await fetch("/api/emotes").then((r) => r.json());
    setEmotes(data.emotes || []);
  } catch { /* mantém o que já tiver */ }
}
function setEmotes(list) {
  emoteList = list;
  emoteById = Object.fromEntries(list.map((emote) => [emote.key, emote]));
  buildEmoteBar();
}

function emoteMedia(emote, cls) {
  const img = document.createElement("img");
  img.className = cls;
  img.src = emote.imageUrl || `/emotes/${emote.key}.png`;
  img.alt = emote.emoji || "";
  img.onerror = () => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = emote.emoji || "❓";
    img.replaceWith(span);
  };
  return img;
}

function buildEmoteBar() {
  const bar = $("#emote-bar");
  bar.innerHTML = "";
  for (const emote of emoteList) {
    const button = document.createElement("button");
    button.dataset.emote = emote.key;
    button.title = emote.title;
    button.appendChild(emoteMedia(emote, "emote-btn-media"));
    button.onclick = () => {
      const now = performance.now();
      if (now - emoteCooldown < 400) return; // evita spam
      emoteCooldown = now;
      socket.emit("emote", emote.key);
    };
    bar.appendChild(button);
  }
  const close = document.createElement("button");
  close.className = "emote-close";
  close.type = "button";
  close.title = "Fechar figurinhas";
  close.setAttribute("aria-label", "Fechar figurinhas");
  close.textContent = "×";
  close.onclick = () => setEmoteOpen(false);
  bar.appendChild(close);
}

socket.on("emotes", (list) => setEmotes(list || [])); // atualiza a barra ao vivo
socket.on("emote", (payload) => spawnEmote(payload));
loadEmotes();

function spawnEmote({ key, emoji, imageUrl, name, sound } = {}) {
  const emote = { key, emoji: emoji || emoteById[key]?.emoji || "❓", imageUrl: imageUrl ?? emoteById[key]?.imageUrl ?? null };
  playEmoteSound(sound ?? emoteById[key]?.sound); // toca o som configurado pra este emote
  if (!key && !emote.emoji) return;
  const layer = $("#emote-layer");
  const fly = document.createElement("div");
  fly.className = "emote-fly";
  fly.style.left = `${8 + Math.random() * 78}%`;
  fly.style.setProperty("--drift", `${Math.random() * 90 - 45}px`);
  fly.style.setProperty("--rot", `${Math.random() * 34 - 17}deg`);
  fly.appendChild(emoteMedia(emote, "emote-emoji"));
  const who = document.createElement("span");
  who.className = "emote-who";
  who.textContent = name || "";
  fly.appendChild(who);
  layer.appendChild(fly);
  fly.addEventListener("animationend", () => fly.remove());
}

const TURN_SECONDS = 20;
let turnClockTimer = null;
let turnClockKey = "";
let turnClockStart = 0;

function stopTurnClock() {
  if (turnClockTimer) { clearInterval(turnClockTimer); turnClockTimer = null; }
}

function tickTurnClock() {
  const bar = $("#turn-bar");
  if (!bar) return stopTurnClock();
  const remaining = Math.max(0, TURN_SECONDS - (Date.now() - turnClockStart) / 1000);
  bar.style.width = `${(remaining / TURN_SECONDS) * 100}%`;
  bar.classList.toggle("low", remaining <= 3);
  const secs = $("#turn-secs");
  if (secs) secs.textContent = Math.ceil(remaining);
  if (remaining <= 0.05) stopTurnClock();
}

// Só há relógio em partidas online, na minha vez e sem modo automático.
function turnClockActive() {
  return !state.solo && !me()?.auto && state.turnId === state.me?.id
    && (state.phase === "bidding" || state.phase === "playing");
}

function maybeStartTurnClock() {
  const key = `${state.phase}-${state.round}-${state.trick}-${state.turnId}`;
  if (!turnClockActive()) { turnClockKey = key; return stopTurnClock(); }
  if (key !== turnClockKey) { turnClockKey = key; turnClockStart = Date.now(); }
  stopTurnClock();
  tickTurnClock();
  turnClockTimer = setInterval(tickTurnClock, 150);
}

function renderPot() {
  const el = $("#pot");
  const show = state.pot > 0 && ["playing", "trick_reveal"].includes(state.phase);
  el.classList.toggle("hidden", !show);
  if (show) el.innerHTML = `🔥 ACUMULOU · A RODADA VALE ×${state.pot + 1}`;
}

function renderAutoBar() {
  const bar = $("#auto-bar");
  const active = me()?.auto && state.phase !== "lobby" && state.phase !== "game_over";
  bar.classList.toggle("hidden", !active);
  bar.innerHTML = active ? '<span>🤖 Modo automático ligado — um bot está jogando por você.</span><button id="take-control">ASSUMIR CONTROLE</button>' : "";
  $("#take-control")?.addEventListener("click", () => socket.emit("toggle-auto", false));
}

function rankingHtml() {
  const ranking = state.ranking || [];
  if (!ranking.length) return "";
  const rows = ranking.slice(0, 6).map((entry, index) => {
    const medal = ["🥇", "🥈", "🥉"][index] || `${index + 1}º`;
    const mine = entry.name === state.me?.name;
    return `<div class="rank-row ${mine ? "mine" : ""}"><span class="rank-pos">${medal}</span><span class="rank-name">${escapeHtml(entry.name)}</span><span class="rank-wins">${entry.wins}🏆</span></div>`;
  }).join("");
  return `<div class="ranking"><div class="rank-title">🏆 RANKING DA SALA</div>${rows}</div>`;
}

function tournamentStandingsHtml({ podium = false } = {}) {
  const tournament = state.tournament;
  if (!tournament?.standings?.length) return "";
  const rows = tournament.standings.map((entry) => {
    const medal = podium ? (["🥇", "🥈", "🥉"][entry.position - 1] || `${entry.position}º`) : `${entry.position}º`;
    const mine = entry.id === state.me?.id;
    return `<div class="tournament-row ${mine ? "mine" : ""}"><span>${medal}</span><b>${escapeHtml(entry.name)}</b><small>🥇 ${entry.goldMedals || 0} · 🥈 ${entry.silverMedals || 0} · 🥉 ${entry.bronzeMedals || 0}</small></div>`;
  }).join("");
  return `<section class="tournament-standings"><div>⚡ QUADRO DO TORNEIO</div>${rows}</section>`;
}

// Placar das duplas: coluna compacta na lateral direita, abaixo de "de quem é a vez".
// Vem inteiro do estado do servidor, então acompanha em tempo real cada aposta,
// rodada, perda de vidas, queda, bot assumindo e eliminação.
// "Falta fulano" não existe aqui: quem está sentado e conectado nunca some da mesa
// só porque ainda não apostou — a aposta pendente aparece como "—" na cadeira dele.
const PRESENCE_NOTE = { off: "Desconectado", bot: "Bot jogando" };
let teamScoreOpen = false; // no celular o placar abre e fecha; no desktop fica sempre aberto

function teamScoreHtml() {
  const teams = state.teams || [];
  if (!isDoubles() || !teams.length) return "";
  const rows = teams.map((team) => {
    const mine = team.id === me()?.teamId;
    const notes = (team.members || []).map((member) => {
      const note = PRESENCE_NOTE[state.players.find((player) => player.id === member.id)?.presence];
      return note ? `${escapeHtml(member.name)}: ${note}` : null;
    }).filter(Boolean);
    const note = team.eliminated ? "Eliminada" : notes.join(" · ");
    return `<div class="team-score-row ${mine ? "mine" : ""} ${team.eliminated ? "out" : ""}" style="--team:${team.color}">
      <div class="team-score-head"><i class="team-dot"></i>${escapeHtml(team.label)}</div>
      <div class="team-score-names">${escapeHtml(teamTitle(team))}</div>
      <div class="team-score-stats"><span title="Vidas da dupla">❤️ ${team.lives}</span><span>Meta <b>${team.bid}</b></span><span>Ganhas <b>${team.wins}</b></span></div>
      ${note ? `<div class="team-score-note ${team.eliminated ? "out" : ""}">${note}</div>` : ""}
    </div>`;
  }).join("");
  return `<section class="team-score ${teamScoreOpen ? "open" : ""}">
    <button type="button" id="team-score-toggle" class="team-score-toggle" aria-expanded="${teamScoreOpen}">DUPLAS<i aria-hidden="true">▾</i></button>
    ${rows}</section>`;
}

function bindTeamScore() {
  $("#team-score-toggle")?.addEventListener("click", () => {
    teamScoreOpen = !teamScoreOpen;
    render();
  });
}

function renderTournamentBar() {
  const bar = $("#tournament-bar");
  const tournament = state.tournament;
  bar.classList.toggle("hidden", !tournament);
  if (!tournament) { bar.innerHTML = ""; return; }
  const current = tournament.finished
    ? "FINAL"
    : state.phase === "game_over"
      ? `RESULTADO ${tournament.completedGames}/${tournament.totalGames}`
      : `${Math.min(tournament.completedGames + 1, tournament.totalGames)}/${tournament.totalGames}`;
  const leader = tournament.standings[0];
  bar.innerHTML = `<b>⚡ TORNEIO ${current}</b><span>${leader && tournament.completedGames ? `LÍDER: ${escapeHtml(leader.name)} · 🥇 ${leader.goldMedals || 0} · 🥈 ${leader.silverMedals || 0} · 🥉 ${leader.bronzeMedals || 0}` : "AS MEDALHAS COMEÇAM NA 1ª PARTIDA VÁLIDA"}</span>`;
}

function matchStandingsHtml() {
  const standings = state.matchStandings || [];
  if (!standings.length) return "";
  const rows = standings.map((entry) => {
    const position = entry.survived && entry.position === 1 ? "🥇" : `${entry.position}º`;
    const detail = entry.survived
      ? `SOBREVIVEU · ${entry.lives} vida${entry.lives === 1 ? "" : "s"}`
      : `ELIMINADO NA MÃO ${entry.eliminatedAtRound}`;
    const mine = entry.id === state.me?.id;
    const team = entry.teamName ? ` <small class="match-rank-team">${escapeHtml(entry.teamName)}</small>` : "";
    return `<div class="match-rank-row ${entry.survived ? "survivor" : ""} ${mine ? "mine" : ""}"><span class="match-rank-pos">${position}</span><span class="match-rank-name">${escapeHtml(entry.name)}${team}</span><span class="match-rank-detail">${detail}</span></div>`;
  }).join("");
  return `<section class="match-ranking"><div class="match-rank-title">CLASSIFICAÇÃO DA PARTIDA</div>${rows}</section>`;
}

function matchPodiumHtml() {
  if (!state.medalMatch) return '<p class="medal-note">Esta partida teve menos de 5 jogadores humanos e não distribuiu medalhas.</p>';
  // Em dupla o pódio é das equipes: uma linha por dupla, com as duas medalhas juntas.
  if (isDoubles()) {
    const teams = (state.teams || []).filter((team) => team.position && team.position <= 3).sort((a, b) => a.position - b.position);
    if (teams.length < 3) return "";
    return `<section class="match-podium"><div class="match-rank-title">PÓDIO DAS DUPLAS</div><div class="podium-places">${teams.map((team) => {
      const medal = ["🥇", "🥈", "🥉"][team.position - 1];
      const mine = team.id === me()?.teamId ? "mine" : "";
      return `<div class="podium-place place-${team.position} ${mine}"><span>${medal}</span><b>${escapeHtml(teamTitle(team))}</b><small>${team.symbol} ${escapeHtml(team.label)} · ${team.position}º lugar</small></div>`;
    }).join("")}</div></section>`;
  }
  const entries = (state.medalStandings || []).slice(0, 3);
  if (entries.length < 3) return "";
  return `<section class="match-podium"><div class="match-rank-title">PÓDIO DA PARTIDA</div><div class="podium-places">${entries.map((entry) => {
    const medal = ["🥇", "🥈", "🥉"][entry.position - 1];
    const mine = entry.id === state.me?.id ? "mine" : "";
    return `<div class="podium-place place-${entry.position} ${mine}"><span>${medal}</span><b>${escapeHtml(entry.name)}</b><small>${entry.position}º lugar</small></div>`;
  }).join("")}</div></section>`;
}

let celebratedKey = null;
function maybeCelebrate() {
  const result = state.lastResult;
  if (state.phase !== "game_over" || !result) { if (state.phase !== "game_over") celebratedKey = null; return; }
  const key = `${result.name}:${result.wins}`;
  if (key === celebratedKey) return;
  celebratedKey = key;
  showToast(result.streak >= 2 ? `🔥 ${result.name} venceu as últimas ${result.streak} partidas!` : `🏆 ${result.name} venceu!`);
  const layer = $("#emote-layer");
  const faces = ["🏆", "🎉", "👑", "✨", "🔥"];
  for (let i = 0; i < 12; i += 1) {
    const fly = document.createElement("div");
    fly.className = "emote-fly";
    fly.style.left = `${6 + Math.random() * 82}%`;
    fly.style.setProperty("--drift", `${Math.random() * 90 - 45}px`);
    fly.style.setProperty("--rot", `${Math.random() * 34 - 17}deg`);
    const span = document.createElement("span");
    span.className = "emote-emoji";
    span.textContent = faces[i % faces.length];
    fly.appendChild(span);
    layer.appendChild(fly);
    fly.addEventListener("animationend", () => fly.remove());
  }
}

function renderSpectatorBar() {
  const bar = $("#spectator-bar");
  const watching = iAmSpectator();
  bar.classList.toggle("hidden", !watching);
  bar.innerHTML = watching
    ? "<span>👁️ Você está assistindo — entra na mesa quando a próxima partida começar.</span>"
    : "";
}

function renderWatchers() {
  const el = $("#watchers");
  const list = (state.spectators || []).filter((watcher) => watcher.id !== state.me?.id);
  el.classList.toggle("hidden", list.length === 0);
  el.innerHTML = list.length
    ? `👁️ ${list.length} assistindo: ${list.map((watcher) => escapeHtml(watcher.name)).join(", ")}`
    : "";
}

// Ao virar a MINHA vez de apostar, fecha chat/figurinhas (o painel de aposta vira
// sheet no mobile e cobria tudo) e trava os botões por um instante — assim um toque
// que era pro chat/emote não vira um misclick de aposta.
let lastBidTurnKey = "";
let bidGuardUntil = 0;
function maybeGuardBid() {
  const myBid = state.phase === "bidding" && state.turnId === state.me?.id;
  if (!myBid) { lastBidTurnKey = ""; return; }
  const key = String(state.round);
  if (key === lastBidTurnKey) return;
  lastBidTurnKey = key;
  setChatOpen(false);
  setEmoteOpen(false);
  bidGuardUntil = Date.now() + 600;
  setTimeout(() => { if (state) render(); }, 640); // reabilita os botões depois do delay
}

function render() {
  const shouldAnimateDeal = state.phase === "bidding" && state.round !== animatedRound;
  game.dataset.phase = state.phase;
  game.classList.toggle("tournament-mode", Boolean(state.tournament));
  game.classList.toggle("spectating", Boolean(state.me?.spectator));
  // Minha vez de decidir sem cartas para clicar (aposta, ou jogar carta única no escuro):
  // o painel vira um modal/bottom-sheet no mobile em vez de ficar lá embaixo.
  const actingNow = state.turnId === state.me?.id
    && (state.phase === "bidding" || (state.phase === "playing" && state.handSize === 1));
  game.dataset.acting = actingNow ? "1" : "";
  game.dataset.tension = String(tensionLevel() || ""); // reta final acende o feltro
  $("#copy-code").textContent = state.code;
  $("#round-label").textContent = state.phase === "lobby" ? "AQUECENDO A MESA" : `MÃO ${state.round} · ${state.handSize} CARTA${state.handSize > 1 ? "S" : ""}`;
  $("#status").textContent = state.message;
  // Na sala de espera, os atalhos ganham botões dentro do painel para não
  // cobrir o "começar" no celular. Durante a partida, seguem flutuantes.
  const lobbyTools = state.phase === "lobby";
  $("#chat-toggle").classList.toggle("hidden", Boolean(state.solo) || lobbyTools);
  $("#emote-toggle").classList.toggle("hidden", lobbyTools); // figurinhas valem também no solo (offline)
  renderAutoBar();
  renderSpectatorBar();
  runSounds();
  renderWatchers();
  renderTournamentBar();
  renderPot();
  renderSeats();
  maybeGuardBid();
  renderAction();
  bindTeamScore();
  renderHand();
  maybeStartTurnClock();
  maybeCelebrate();
  maybeRejoinVoice();
  if (shouldAnimateDeal) {
    animatedRound = state.round;
    requestAnimationFrame(animateDeal);
  }
}

// Avatares reaproveitados entre renders: o mesmo <img> por jogador. Como o renderSeats
// reconstrói o innerHTML do #seats a cada estado (troca de vez etc.), recriar o <img>
// fazia a foto recarregar e "piscar". Aqui guardamos o elemento e só o remontamos.
const seatAvatars = new Map();
function mountSeatAvatars() {
  const seen = new Set();
  $("#seats").querySelectorAll(".avatar-mount").forEach((mount) => {
    const pid = mount.closest("[data-seat]")?.dataset.seat;
    if (!pid) return;
    seen.add(pid);
    let img = seatAvatars.get(pid);
    if (!img) { img = document.createElement("img"); seatAvatars.set(pid, img); }
    if (img.getAttribute("src") !== mount.dataset.src) img.setAttribute("src", mount.dataset.src);
    img.alt = `Avatar de ${mount.dataset.name || ""}`;
    mount.replaceWith(img); // reatacha o mesmo <img> já decodificado: não recarrega
  });
  for (const pid of seatAvatars.keys()) if (!seen.has(pid)) seatAvatars.delete(pid);
}

function renderSeats() {
  $("#manilhas").innerHTML = `<span>MANILHAS FIXAS</span><b>4♣</b> › <b class="red-text">7♥</b> › <b>A♠</b> › <b class="red-text">7♦</b>`;
  const players = state.players;
  const total = Math.max(players.length, 1);
  const meIndex = Math.max(0, players.findIndex((player) => player.id === state.me?.id));
  // "Eu" fico embaixo; os demais preenchem a mesa no sentido horário (mesma direção do jogo).
  const ordered = [...players.slice(meIndex), ...players.slice(0, meIndex)];
  const forehead = state.handSize === 1 && state.phase !== "lobby";
  if (!state.table || !state.table.length) playedSeen.clear(); // mesa vazia: pode reanimar a próxima vaza

  $("#seats").innerHTML = ordered.map((player, k) => {
    const angle = Math.PI / 2 + (k / total) * Math.PI * 2;
    const cos = Math.cos(angle).toFixed(4);
    const sin = Math.sin(angle).toFixed(4);
    const isMe = player.id === state.me?.id;
    const isTurn = state.turnId === player.id;
    const isDealer = state.dealerId === player.id;
    const isHostSeat = state.hostId === player.id;
    const wonTrick = state.phase === "trick_reveal" && state.trickResult?.winnerId === player.id;
    const fodeu = state.phase === "round_end" && player.roundLoss > 0;
    const play = state.table.find((item) => item.playerId === player.id);
    const foreheadCard = forehead && !isMe ? player.foreheadCard : null;
    // Com dois baralhos, duas cartas iguais são objetos diferentes: a melada é por cópia.
    const melada = play && (state.melada || []).includes(cardKey(play.card));
    // "just-played": anima a entrada só na 1ª vez que a carta aparece (ver playedSeen)
    const playKey = play ? `${state.round}-${state.trick}-${cardKey(play.card)}` : "";
    const freshPlay = play && !playedSeen.has(playKey);
    if (freshPlay) playedSeen.add(playKey);
    // combo: quantas vazas seguidas este jogador levou (>=2 vira badge no lugar do "LEVOU")
    const combo = wonTrick && currentCombo.winnerId === player.id && currentCombo.count >= 2 ? currentCombo.count : 0;

    // carta jogada fica exatamente na frente do jogador (slot a 24% do raio)
    const cardZone = play
      ? `<div class="seat-card ${freshPlay ? "just-played" : ""} ${wonTrick ? "winning" : ""} ${melada ? "melada" : ""}">${melada ? '<span class="melada-tag">MELOU</span>' : ""}${cardHtml(play.card)}</div>`
      : "";
    // no testa, a carta que todos veem fica colada na LATERAL do card do dono, pro lado de
    // fora da mesa (nunca sobre o feltro/texto): assentos à esquerda (cos<0) recebem a carta
    // à esquerda, os à direita (cos>0) à direita, e o assento oposto (topo, cos≈0) à esquerda.
    // Nos assentos das extremas laterais (cos≈±1) a carta lateral sairia da tela no mobile,
    // então lá ela vai pra cima do card (classe "edge", só tratada no CSS mobile).
    // Ao ser jogada, migra pra frente dele (na mesa) via cardZone.
    const foreheadSide = Number(cos) > 0 ? "right" : "left";
    const foreheadEdge = Math.abs(Number(cos)) > 0.9 ? "edge" : "";
    const foreheadOnSeat = foreheadCard && !play
      ? `<div class="forehead-card ${foreheadSide} ${foreheadEdge}">${cardHtml(foreheadCard)}</div>`
      : "";

    // Em dupla a cadeira mostra só o que é individual: aposta e rodadas ganhas.
    // Vidas são da equipe e ficam num lugar só, no placar da lateral.
    const meta = isDoubles()
      ? (state.phase === "lobby" ? "na sala" : `Aposta ${player.bid ?? "—"} · Ganhas ${player.wins}`)
      : player.bid == null
        // "apostando…" só pra quem está escolhendo AGORA (a vez dele); quem ainda vai apostar fica neutro.
        ? (state.phase === "lobby" ? "na sala" : state.phase === "bidding" ? (state.turnId === player.id ? "apostando…" : "—") : "—")
        : `aposta ${player.bid} · fez ${player.wins}`;
    const lives = player.lives > 0 ? player.lives : 0;
    const hearts = lives > 0 ? "♥".repeat(lives) : "×";
    const compactHearts = lives > 0 ? `♥ ×${lives}` : "×";
    const livesBlock = isDoubles()
      ? ""
      : `<div class="hearts" title="${lives} vidas"><span class="hearts-full">${hearts}</span><span class="hearts-compact">${compactHearts}</span></div>`;
    const isMaldito = player.name.trim().toLocaleLowerCase("pt-BR") === "maldito";
    const avatarSource = player.photoUrl
      ? player.photoUrl
      : isMaldito ? "/avatars/maldito.png"
      : player.avatarKey ? `/avatars/players/${encodeURIComponent(player.avatarKey)}.webp` : null;
    // "mount" preenchido depois do innerHTML com um <img> reaproveitado (ver mountSeatAvatars),
    // pra a foto não recarregar/piscar a cada re-render.
    const avatar = avatarSource
      ? `<span class="avatar-mount" data-src="${escapeHtml(avatarSource)}" data-name="${escapeHtml(player.name)}"></span>`
      : escapeHtml((player.name[0] || "?").toUpperCase());
    const banner = player.banner && player.banner !== "novato" ? player.banner : null;
    // Em dupla, o título vira um chip pequeno acima do nome (com o nome completo no
    // tooltip): a cadeira não pode competir com o destaque de quem está na vez.
    const bannerRibbon = banner && !isDoubles() ? `<div class="seat-banner">${escapeHtml(bannerTitle(banner))}</div>` : "";
    const bannerChip = banner && isDoubles()
      ? `<span class="seat-chip banner-${banner}" title="${escapeHtml(bannerTitle(banner))}">${BANNER_CHIPS[banner] || escapeHtml(bannerTitle(banner))}</span>`
      : "";
    // Dupla: o card inteiro veste a cor da equipe (fundo + faixa) e leva o nome dela.
    // Os nomes dos parceiros e as vidas ficam só no placar da lateral.
    const team = teamOfPlayer(player);
    const teamLine = team ? `<div class="seat-team">${team.symbol} ${escapeHtml(team.label)}</div>` : "";

    return `
      <div class="seat-card-slot" style="--cos:${cos};--sin:${sin}">${cardZone}</div>
      <button type="button" data-seat="${player.id}" class="seat ${isMe ? "me" : ""} ${isTurn ? "turn" : ""} ${player.eliminated ? "out" : ""} ${!player.connected ? "off" : ""} ${wonTrick ? "won" : ""} ${fodeu ? "fodeu" : ""} ${voiceRoster.has(player.id) ? "in-voice" : ""} ${speaking.has(player.id) ? "speaking" : ""} ${banner && !isDoubles() ? `has-banner banner-${banner}` : ""} ${team ? `in-team team-${team.key}` : ""}" style="--cos:${cos};--sin:${sin}${team ? `;--team:${team.color}` : ""}" aria-label="Abrir perfil de ${escapeHtml(player.name)}${team ? `, ${team.label}` : ""}">
        <div class="turn-flag">VEZ</div>
        <div class="voice-badge" title="No chat de voz">🎙️</div>
        ${foreheadOnSeat}
        ${isHostSeat ? '<div class="host-star" title="Dono da sala">★</div>' : ""}
        ${isDealer ? '<div class="dealer-chip" title="Dá as cartas — fala por último">D</div>' : ""}
        ${bannerRibbon}
        <div class="seat-body">
          <div class="avatar ${avatarSource ? "profile-photo" : ""}">${avatar}</div>
          <div class="seat-info">
            ${bannerChip}
            <b>${escapeHtml(player.name)}${isMe ? " (você)" : ""}${player.isBot ? '<span class="bot-chip">BOT</span>' : ""}</b>
            ${teamLine}
            <div class="seat-meta">${meta}</div>
            ${livesBlock}
          </div>
        </div>
        ${wonTrick ? (combo ? `<div class="seat-tag combo">🔥 ${combo} SEGUIDAS</div>` : '<div class="seat-tag win">LEVOU</div>') : ""}
        ${fodeu ? `<div class="seat-tag lose">SE FODEU −${player.roundLoss}</div>` : ""}
        ${!player.connected ? (player.auto ? '<div class="seat-tag off">🤖 BOT NO LUGAR</div>' : '<div class="seat-tag off">RECONECTANDO</div>') : ""}
        ${player.auto && !player.isBot && player.connected && (state.phase === "bidding" || state.phase === "playing") ? '<div class="seat-tag auto">🤖 AUTO</div>' : ""}
      </button>`;
  }).join("");

  mountSeatAvatars();

  $("#seats").querySelectorAll("[data-seat]").forEach((seat) => {
    seat.onclick = () => {
      const player = state?.players.find((item) => item.id === seat.dataset.seat);
      if (player) openPlayerCard(player);
    };
  });

  // O aviso só faz sentido no lobby vazio. Durante aposta/jogo ele confundia
  // quem assiste, pois aparecia sobre uma mesa que já está em andamento.
  const showEmptyTable = state.phase === "lobby" && players.length < 2 && !forehead;
  $("#empty-table").classList.toggle("hidden", !showEmptyTable);
}

function animateDeal() {
  const layer = $("#deal-animation");
  const felt = $(".felt")?.getBoundingClientRect();
  if (!felt) return;
  layer.innerHTML = "";
  const startX = felt.left + felt.width / 2 - 18;
  const startY = felt.top + felt.height / 2 - 26;
  const players = state.players.filter((player) => !player.eliminated);
  let sequence = 0;
  for (let card = 0; card < state.handSize; card += 1) {
    for (const player of players) {
      const index = state.players.findIndex((item) => item.id === player.id);
      const target = player.id === state.me.id ? $("#hand") : $(`[data-seat="${player.id}"]`);
      const rect = target?.getBoundingClientRect();
      if (!rect) continue;
      const element = document.createElement("i");
      element.className = "deal-card";
      element.style.left = `${startX}px`;
      element.style.top = `${startY}px`;
      element.style.setProperty("--dx", `${rect.left + rect.width / 2 - startX - 18}px`);
      element.style.setProperty("--dy", `${rect.top + rect.height / 2 - startY - 26}px`);
      element.style.setProperty("--delay", `${sequence * 110}ms`);
      element.style.setProperty("--rotate", `${(index % 2 ? 12 : -12) + card * 2}deg`);
      layer.appendChild(element);
      sequence += 1;
    }
  }
  setTimeout(() => { layer.innerHTML = ""; }, sequence * 110 + 850);
}

function turnClockHtml() {
  if (state.solo) return "";
  return `<div class="turn-timer"><i id="turn-bar"></i></div><small class="turn-hint">Modo automático em <b id="turn-secs">${TURN_SECONDS}</b>s se você não jogar</small>`;
}

// No mobile o painel da vez vira um sheet fixo que cobre a parte de baixo da
// mesa — justamente onde ficam os assentos com "aposta X · fez Y". Repetimos o
// placar aqui dentro (na ordem da aposta) pra ninguém ter que adivinhar o que a
// mesa já apostou na hora de escolher. No desktop o CSS esconde: os assentos
// estão todos visíveis.
function tableTallyHtml() {
  const order = (state.bidOrder?.length ? state.bidOrder : state.players.map((player) => player.id))
    .map((id) => state.players.find((player) => player.id === id))
    .filter((player) => player && !player.eliminated);
  if (order.length < 2) return "";
  const playing = state.phase === "playing";
  const total = order.reduce((sum, player) => sum + (player.bid ?? 0), 0);
  const items = order.map((player) => {
    const mine = player.id === state.me?.id;
    const value = player.bid == null ? "—" : playing ? `${player.wins}/${player.bid}` : String(player.bid);
    const team = teamOfPlayer(player);
    const classes = ["tally-item", player.bid == null ? "pending" : "", mine ? "me" : "", team && team.id === me()?.teamId ? "partner" : ""].filter(Boolean).join(" ");
    return `<span class="${classes}"><b>${team ? `${team.symbol} ` : ""}${escapeHtml(mine ? "você" : player.name)}</b><i>${value}</i></span>`;
  }).join("");
  const label = playing ? "FEZ/APOSTA · SOMA" : "SOMA";
  // Em dupla, a meta que vale é a da equipe — a soma da mesa continua sendo a regra do pé.
  const teamLine = isDoubles() && myTeam()
    ? `<span class="tally-team">SUA DUPLA <i>${myTeam().wins}/${myTeam().bid}</i></span>`
    : "";
  return `<div class="table-tally" aria-label="Apostas da mesa">${items}${teamLine}<span class="tally-sum">${label} <i>${total}</i>/${state.handSize}</span></div>`;
}

// ===== Duplas na sala de espera: prévia, sorteio e organização manual =====
// Nada disso decide a partida: o dono sugere e o SERVIDOR valida e guarda.
const lobbyTeamCount = () => Math.max(Math.ceil(state.players.length / 2), (state.teamSetup?.groups || []).length, 2);
const lobbyPalette = (index) => (state.teamPalette || [])[index % Math.max(1, (state.teamPalette || []).length)]
  || { symbol: "⚪", label: `DUPLA ${index + 1}`, color: "#8b8b82" };

function lobbyGroups() {
  const groups = state.teamSetup?.groups || [];
  return Array.from({ length: lobbyTeamCount() }, (_, index) => groups[index] || []);
}

function manualTeamPickerHtml(groups) {
  const rows = state.players.map((player) => {
    const current = groups.findIndex((group) => group.includes(player.id));
    const options = groups.map((group, index) => {
      const palette = lobbyPalette(index);
      const full = group.length >= 2 && index !== current;
      return `<option value="${index}" ${index === current ? "selected" : ""} ${full ? "disabled" : ""}>${escapeHtml(palette.label)}${full ? " (cheia)" : ""}</option>`;
    }).join("");
    return `<label class="team-pick"><span>${escapeHtml(player.name)}</span><select data-team-for="${player.id}" aria-label="Dupla de ${escapeHtml(player.name)}"><option value="-1" ${current < 0 ? "selected" : ""}>sem dupla</option>${options}</select></label>`;
  }).join("");
  return `<div class="team-picker">${rows}</div>`;
}

function doublesLobbyHtml() {
  if (!isDoubles()) return "";
  const setup = state.teamSetup || { mode: "random", groups: [] };
  const groups = lobbyGroups();
  const nameById = (id) => state.players.find((player) => player.id === id)?.name || "";
  const preview = groups.map((members, index) => {
    const palette = lobbyPalette(index);
    const names = members.map(nameById).filter(Boolean);
    const mine = members.includes(state.me?.id);
    return `<div class="lobby-team ${mine ? "mine" : ""}" style="--team:${palette.color}">
      <span class="team-badge"><i class="team-dot"></i>${escapeHtml(palette.label)}</span>
      <b>${names.length ? escapeHtml(names.join(" + ")) : "vaga livre"}</b>
      ${names.length === 1 ? "<small>falta 1</small>" : ""}
    </div>`;
  }).join("");
  const warn = doublesReady() ? "" : '<p class="lobby-warn">⚠️ O modo em dupla precisa de 4, 6 ou 8 jogadores.</p>';
  const controls = isHost() ? `<div class="team-controls">
      <button type="button" id="teams-random" class="ghost ${setup.mode === "random" ? "active" : ""}">🎲 SORTEAR</button>
      <button type="button" id="teams-manual" class="ghost ${setup.mode === "manual" ? "active" : ""}">✍️ ORGANIZAR NA MÃO</button>
    </div>${setup.mode === "manual" ? manualTeamPickerHtml(groups) : ""}` : "";
  return `<section class="lobby-teams">
    <div class="lobby-teams-title">👥 SE FODE JUNTO · ${state.players.length} na mesa</div>
    <p class="lobby-teams-hint">As apostas e rodadas vencidas são somadas. As vidas pertencem à dupla.</p>
    ${preview}${warn}${controls}</section>`;
}

function emitManualTeams(panel) {
  const groups = Array.from({ length: lobbyTeamCount() }, () => []);
  panel.querySelectorAll("[data-team-for]").forEach((select) => {
    const index = Number(select.value);
    if (index >= 0 && groups[index]) groups[index].push(select.dataset.teamFor);
  });
  socket.emit("set-teams", { mode: "manual", groups });
}

function bindTeamControls(panel) {
  $("#teams-random")?.addEventListener("click", () => socket.emit("set-teams", { mode: "random" }));
  $("#teams-manual")?.addEventListener("click", () => socket.emit("set-teams", { mode: "manual", groups: lobbyGroups() }));
  panel.querySelectorAll("[data-team-for]").forEach((select) => { select.onchange = () => emitManualTeams(panel); });
}

// Lista de expulsão do dono: todo mundo da sala menos ele — jogadores, bots e quem assiste.
// Numa mão em andamento, quem é tirado tem a mão terminada por um bot e some ao fim dela.
function kickListHtml() {
  if (!isHost() || state.solo) return "";
  const status = (player) => player.isBot ? "bot"
    : player.spectator ? "assistindo"
    : !player.connected ? "caiu"
    : player.auto ? "automático" : "na ativa";
  const targets = [...state.players, ...(state.spectators || [])].filter((player) => player.id !== state.me?.id);
  if (!targets.length) return "";
  const buttons = targets.map((player) => `<button class="kick-btn" data-kick="${player.id}" data-kick-name="${escapeHtml(player.name)}">✕ ${escapeHtml(player.name)} <small>${status(player)}</small></button>`).join("");
  return `<div class="kick-list"><div class="kick-title">TIRAR DA SALA</div>${buttons}</div>`;
}
function bindKickButtons(panel) {
  panel.querySelectorAll("[data-kick]").forEach((button) => button.onclick = () => {
    if (!confirm(`Tirar ${button.dataset.kickName} da sala? Não volta nesta mesa.`)) return;
    socket.emit("remove-player", button.dataset.kick);
  });
}

function renderAction() {
  const panel = $("#action-panel");
  if (state.phase === "lobby") {
    // Sala privada: o link compartilhado já leva o convite (entra sem digitar a senha).
    const url = roomUrl(state.code) + (state.isPrivate && state.inviteToken ? `&convite=${state.inviteToken}` : "");
    const waText = encodeURIComponent(`Bora jogar Se Fode! 🃏 Entra na minha sala (${state.code}): ${url}`);
    const tournament = state.tournament;
    const ready = isDoubles() ? doublesReady() : state.players.length >= 2;
    const deckNote = state.deckCount > 1 ? " Mesa com <b>2 baralhos</b> (80 cartas)." : "";
    panel.innerHTML = `<div class="panel-title">${tournament ? "TORNEIO DE MEDALHAS" : isDoubles() ? "SE FODE JUNTO — DUPLAS" : "SALA DE ESPERA"}</div><h3>${ready ? "A MESA TÁ PRONTA" : "CHAME MAIS ALGUÉM"}</h3>
      <p>${tournament ? `Serão ${tournament.totalGames} partidas na mesma mesa. Com 5 ou mais jogadores, cada pódio vale medalhas; o campeão leva um troféu.` : `Convide a galera pelo link ou pelo código <b>${state.code}</b>.`}${deckNote}</p>
      ${doublesLobbyHtml()}
      ${state.isPrivate ? `<div class="lobby-pass"><span class="lobby-pass-label">🔒 SALA PRIVADA · SENHA</span><span class="lobby-pass-value">${escapeHtml(state.password || "—")}</span><button id="copy-pass" type="button" class="ghost">COPIAR</button></div>` : ""}
      <div class="share">
        <input id="share-url" readonly value="${escapeHtml(url)}" aria-label="Link da sala" />
        <div class="share-actions">
          <button id="copy-link" class="ghost">COPIAR LINK</button>
          <a id="wa-share" class="wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">WHATSAPP</a>
        </div>
      </div>
      <div class="lobby-tools">
        <button id="lobby-emote-toggle" type="button" aria-label="Abrir figurinhas" title="Figurinhas">😄</button>
        ${state.solo ? "" : '<button id="lobby-chat-toggle" type="button" aria-label="Abrir chat da sala" title="Chat da sala">💬</button>'}
      </div>
      ${kickListHtml()}
      ${lobbyStartControl(tournament)}
      ${rankingHtml()}`;
    bindKickButtons(panel);
    bindTeamControls(panel);
    $("#start")?.addEventListener("click", () => socket.emit("start-game"));
    $("#share-url").onclick = (event) => event.target.select();
    $("#copy-link").onclick = async () => { await navigator.clipboard.writeText(url); showToast(state.isPrivate ? "Link de convite copiado!" : "Link copiado!"); };
    $("#copy-pass")?.addEventListener("click", async () => { await navigator.clipboard.writeText(state.password || ""); showToast("Senha copiada!"); });
    $("#lobby-emote-toggle").onclick = () => setEmoteOpen(!emoteOpen);
    $("#lobby-chat-toggle")?.addEventListener("click", () => setChatOpen(!chatOpen));
    return;
  }
  if (state.phase === "bidding" && state.turnId === state.me.id) {
    const isLast = state.bidOrder.at(-1) === state.me.id;
    // Quando o painel vira sheet no mobile, ele cobre a mão — então mostramos as
    // cartas aqui dentro para o jogador apostar vendo o que tem (só faz sentido com 2+).
    const handPreview = state.handSize > 1
      ? `<div class="bid-hand">${[...state.me.hand].sort((a, b) => cardStrength(a) - cardStrength(b)).map((card) => cardHtml(card)).join("")}</div>`
      : "";
    const guarded = Date.now() < bidGuardUntil; // trava breve pós-abertura (anti-misclick)
    const bidHint = isLast
      ? `Você é o pé: a soma não pode dar ${state.handSize}.`
      : isDoubles() ? "Sua aposta soma com a do parceiro. Errar custa vidas da dupla." : "Escolha sua aposta. Errar custa vidas.";
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>${isDoubles() ? "FAÇA SUA APOSTA" : "QUANTAS VOCÊ LEVA?"}</h3><p>${bidHint}</p>${teamScoreHtml()}${handPreview}${tableTallyHtml()}<div class="bids ${guarded ? "guarded" : ""}">${Array.from({ length: state.handSize + 1 }, (_, bid) => `<button data-bid="${bid}" ${state.allowedBids.includes(bid) && !guarded ? "" : "disabled"}>${bid}</button>`).join("")}</div>${turnClockHtml()}`;
    panel.querySelectorAll("[data-bid]").forEach((button) => button.onclick = () => socket.emit("bid", Number(button.dataset.bid)));
    return;
  }
  if (state.phase === "playing" && state.turnId === state.me.id) {
    if (state.handSize === 1) {
      // Rodada na testa: joga sozinha, sem botão (a carta está na testa).
      panel.innerHTML = `<div class="panel-title">RODADA NA TESTA</div><h3>JOGUE NO ESCURO</h3><p>Sua carta vai sozinha — todo mundo vê, menos você.</p>${teamScoreHtml()}${tableTallyHtml()}`;
      return;
    }
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>ESCOLHA UMA CARTA</h3><p>Clique numa carta da sua mão.</p>${teamScoreHtml()}${tableTallyHtml()}${turnClockHtml()}`;
    return;
  }
  if (state.phase === "trick_reveal") {
    const result = state.trickResult || {};
    let title, text;
    if (result.potWinnerName) {
      title = `${escapeHtml(result.potWinnerName.toUpperCase())} FICA COM AS RODADAS`;
      text = `Melou na última rodada — leva ${result.potAmount} rodada${result.potAmount > 1 ? "s" : ""} acumulada${result.potAmount > 1 ? "s" : ""} por ter vencido antes da melada.`;
    } else if (result.melou) {
      title = "MELOU GERAL";
      text = result.lastTrick ? "Melou tudo na última rodada." : `Ninguém levou — a próxima rodada vale por ${result.pot + 1}. Quem abriu a rodada reabre.`;
    } else if (result.took > 1) {
      title = `${escapeHtml((result.winnerName || "").toUpperCase())} LEVOU ×${result.took}`;
      text = `Levou ${result.took} rodadas acumuladas de uma vez!`;
    } else {
      title = `${escapeHtml(result.winnerName || "")} LEVOU`;
      text = result.lastTrick ? "Última carta da mão na mesa. Confere antes de fechar as contas." : "Todas as cartas na mesa. Já vem a próxima rodada.";
    }
    panel.innerHTML = `<div class="panel-title">RODADA ${result.trick ?? ""}</div><h3>${title}</h3><p>${text}</p>${teamScoreHtml()}`;
    return;
  }
  if (state.phase === "round_end") {
    const losers = state.roundLosers || [];
    // Em dupla o resumo é por equipe: quem cravou também aparece, com a conta fechada.
    const teamSummary = (state.teamResults || []).map((result) => `
      <div class="team-result ${result.lost ? "lost" : "clean"} ${result.eliminated ? "eliminated" : ""}" style="--team:${result.color}">
        <b>${result.symbol} ${escapeHtml(result.name)} ${result.lost ? "SE FODEU" : "CRAVOU"}</b>
        <span>Apostou ${result.bid} · Ganhou ${result.wins} · ${result.lost ? `Perdeu ${result.lost} vida${result.lost > 1 ? "s" : ""}` : "Nenhuma vida perdida"}${result.eliminated ? " · DUPLA ELIMINADA" : ""}</span>
        <small>${escapeHtml(result.names.join(" + "))} · ❤️ ${result.lives}</small>
      </div>`).join("");
    const list = isDoubles()
      ? `<div class="team-results">${teamSummary}</div>`
      : losers.length
        ? `<div class="fodeu-list">${losers.map((loser) => `<div class="fodeu-item ${loser.eliminated ? "eliminated" : ""}"><b>${escapeHtml(loser.name)}</b><span>−${loser.lost} vida${loser.lost > 1 ? "s" : ""}${loser.eliminated ? " · ELIMINADO" : ""}</span></div>`).join("")}</div>`
        : '<p class="fodeu-none">Ninguém se fodeu — todo mundo cravou. 😤</p>';
    const kickHtml = kickListHtml();
    // Sem host pra clicar: a próxima mão começa sozinha; qualquer um pode pular a espera.
    const nextControl = '<p class="auto-next">Próxima mão começando…</p><button id="next" class="ghost">PULAR ESPERA</button>';
    panel.innerHTML = `<div class="panel-title">FIM DA MÃO</div><h3>${isDoubles() ? "COMO FICOU CADA DUPLA" : "QUEM SE FODEU"}</h3>${list}${kickHtml}${nextControl}`;
    bindKickButtons(panel);
    $("#next")?.addEventListener("click", () => socket.emit("next-round"));
    return;
  }
  if (state.phase === "game_over") {
    const kickHtml = kickListHtml();
    const lr = state.lastResult;
    const championHtml = lr
      ? `<div class="champion"><span class="champion-name">🏆 ${escapeHtml(lr.name)}</span>${lr.streak >= 2 ? `<span class="champion-streak">🔥 venceu as últimas ${lr.streak} partidas</span>` : lr.wins >= 3 ? `<span class="champion-streak">👑 ${lr.wins} vitórias na sala</span>` : ""}</div>`
      : "";
    const tournament = state.tournament;
    const tournamentFinished = tournament?.finished;
    const tournamentControls = gameOverControl(tournament, tournamentFinished);
    const panelTitle = tournamentFinished ? "TORNEIO ENCERRADO" : "FIM DE JOGO";
    panel.innerHTML = `<div class="panel-title">${panelTitle}</div><h3>${escapeHtml(state.message)}</h3>${championHtml}${matchPodiumHtml()}${matchStandingsHtml()}${tournament ? tournamentStandingsHtml({ podium: tournamentFinished }) : ""}${rankingHtml()}${kickHtml}${tournamentControls}<button id="leave2" class="ghost">SAIR DA SALA</button>`;
    bindKickButtons(panel);
    $("#next-tournament")?.addEventListener("click", () => socket.emit("next-tournament-game"));
    $("#restart")?.addEventListener("click", () => socket.emit("restart"));
    $("#leave2")?.addEventListener("click", leaveRoom);
    return;
  }
  const current = state.players.find((player) => player.id === state.turnId);
  panel.innerHTML = `<div class="panel-title">AGORA</div><h3>${current ? `VEZ DE ${escapeHtml(current.name)}` : "SEGURA AÍ"}</h3><p>${state.phase === "bidding" ? "A aposta está rodando a mesa." : "A carta vem aí."}</p>${teamScoreHtml()}`;
}

function renderHand() {
  const hand = $("#hand");
  if (iAmSpectator() || state.phase === "lobby" || state.phase === "game_over") { hand.innerHTML = ""; return; }
  if (state.handSize === 1) {
    hand.innerHTML = `<div class="foreheads"><div class="forehead"><div class="card mystery-card">?</div></div></div>`;
    return;
  }
  // Mão organizada por força: mais fraca à esquerda, mais forte à direita.
  const sorted = [...state.me.hand].sort((a, b) => cardStrength(a) - cardStrength(b));
  hand.innerHTML = sorted.map((card) => cardHtml(card)).join("");
  hand.querySelectorAll(".card").forEach((element, index) => {
    element.onclick = () => {
      if (state.phase !== "playing" || state.turnId !== state.me.id) return showToast("Ainda não é sua vez.");
      socket.emit("play-card", sorted[index].id);
    };
  });
}
