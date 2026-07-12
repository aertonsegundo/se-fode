const socket = io({ autoConnect: false });
const SESSION_KEY = "fode-session";
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
const iAmSpectator = () => Boolean(state?.me?.spectator);

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function join(kind) {
  const name = $("#name").value.trim();
  localStorage.setItem("fode-name", name);
  socket.emit(kind, {
    name,
    code: $("#code").value,
    botCount: Number($("#bot-count").value),
    botDifficulty: $("#bot-difficulty").value,
  });
}

const roomUrl = (code) => `${location.origin}/?sala=${code}`;

function leaveRoom() {
  socket.emit("leave-room");
  localStorage.removeItem(SESSION_KEY);
  state = null;
  stopTurnClock();
  setChatOpen(false);
  $("#chat-log").innerHTML = "";
  game.classList.add("hidden");
  home.classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
}

function confirmLeave() {
  const mid = state && !["lobby", "game_over"].includes(state.phase);
  if (mid && !confirm("Sair da partida? Um bot assume seu lugar.")) return;
  leaveRoom();
}

$("#name").value = localStorage.getItem("fode-name") || "";
$("#solo").onclick = () => join("solo-game");
$("#create").onclick = () => join("create-room");
$("#join").onclick = () => join("join-room");
$("#code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#rules-open").onclick = () => $("#rules").showModal();
$("#rules-close").onclick = () => $("#rules").close();
$("#copy-code").onclick = async () => { await navigator.clipboard.writeText(state.code); showToast("Código copiado!"); };
$("#leave").onclick = confirmLeave;
$(".mini-brand").addEventListener("click", (event) => { if (state) { event.preventDefault(); confirmLeave(); } });

// Link compartilhado: ?sala=CODIGO já preenche o campo de código.
const sharedCode = (new URLSearchParams(location.search).get("sala") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
if (sharedCode) {
  $("#code").value = sharedCode;
  setTimeout(() => $("#name").focus(), 0);
}

socket.on("connect", () => {
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    try { socket.emit("resume-session", JSON.parse(saved)); }
    catch { localStorage.removeItem(SESSION_KEY); }
  }
  if (connectedBefore) showToast("Conexão recuperada.");
  connectedBefore = true;
});
socket.on("disconnect", () => { if (state) showToast("Conexão perdida. Tentando voltar…"); });
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
});
socket.on("notice", showToast);
socket.on("state", (next) => {
  state = next;
  home.classList.add("hidden");
  game.classList.remove("hidden");
  render();
});
socket.connect();

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
// Cada emote tenta usar a imagem /emotes/<key>.png; se o arquivo não existir,
// cai automaticamente para o emoji Unicode correspondente.
const EMOTE_LIST = [
  { key: "joia", emoji: "👍", title: "Joia" },
  { key: "estiloso", emoji: "😎", title: "Estiloso" },
  { key: "raiva", emoji: "😡", title: "Raiva" },
  { key: "medo", emoji: "😨", title: "Medo" },
  { key: "choro", emoji: "😭", title: "Choro" },
  { key: "lingua", emoji: "😝", title: "Língua" },
  { key: "sorriso", emoji: "😁", title: "Sorrisão" },
  { key: "risada", emoji: "🤣", title: "Risada" },
  { key: "ideia", emoji: "💡", title: "Ideia" },
  { key: "fepe", emoji: "🍾", title: "Fepe" },
  { key: "victin", emoji: "😐", title: "Victin" },
  { key: "chico", emoji: "🤠", title: "Chico" },
  { key: "muriloejp", emoji: "👬", title: "Murilo e JP" },
  { key: "rtn", emoji: "🫡", title: "RTN" },
];
const EMOTE_EMOJI = Object.fromEntries(EMOTE_LIST.map((e) => [e.key, e.emoji]));
let emoteCooldown = 0;

function emoteMedia(key, emoji, cls) {
  const img = document.createElement("img");
  img.className = cls;
  img.src = `/emotes/${key}.png`;
  img.alt = emoji;
  img.onerror = () => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = emoji;
    img.replaceWith(span);
  };
  return img;
}

function buildEmoteBar() {
  const bar = $("#emote-bar");
  bar.innerHTML = "";
  for (const { key, emoji, title } of EMOTE_LIST) {
    const button = document.createElement("button");
    button.dataset.emote = key;
    button.title = title;
    button.appendChild(emoteMedia(key, emoji, "emote-btn-media"));
    button.onclick = () => {
      const now = performance.now();
      if (now - emoteCooldown < 400) return; // evita spam
      emoteCooldown = now;
      socket.emit("emote", key);
    };
    bar.appendChild(button);
  }
}
buildEmoteBar();

socket.on("emote", (payload) => spawnEmote(payload));

function spawnEmote({ key, emoji, name } = {}) {
  const face = emoji || EMOTE_EMOJI[key];
  if (!face && !key) return;
  const layer = $("#emote-layer");
  const fly = document.createElement("div");
  fly.className = "emote-fly";
  fly.style.left = `${8 + Math.random() * 78}%`;
  fly.style.setProperty("--drift", `${Math.random() * 90 - 45}px`);
  fly.style.setProperty("--rot", `${Math.random() * 34 - 17}deg`);
  fly.appendChild(emoteMedia(key, face || "❓", "emote-emoji"));
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

function matchStandingsHtml() {
  const standings = state.matchStandings || [];
  if (!standings.length) return "";
  const rows = standings.map((entry) => {
    const position = entry.survived && entry.position === 1 ? "🥇" : `${entry.position}º`;
    const detail = entry.survived
      ? `SOBREVIVEU · ${entry.lives} vida${entry.lives === 1 ? "" : "s"}`
      : `ELIMINADO NA MÃO ${entry.eliminatedAtRound}`;
    const mine = entry.id === state.me?.id;
    return `<div class="match-rank-row ${entry.survived ? "survivor" : ""} ${mine ? "mine" : ""}"><span class="match-rank-pos">${position}</span><span class="match-rank-name">${escapeHtml(entry.name)}</span><span class="match-rank-detail">${detail}</span></div>`;
  }).join("");
  return `<section class="match-ranking"><div class="match-rank-title">CLASSIFICAÇÃO DA PARTIDA</div>${rows}</section>`;
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

function render() {
  const shouldAnimateDeal = state.phase === "bidding" && state.round !== animatedRound;
  game.dataset.phase = state.phase;
  // Minha vez de decidir sem cartas para clicar (aposta, ou jogar carta única no escuro):
  // o painel vira um modal/bottom-sheet no mobile em vez de ficar lá embaixo.
  const actingNow = state.turnId === state.me?.id
    && (state.phase === "bidding" || (state.phase === "playing" && state.handSize === 1));
  game.dataset.acting = actingNow ? "1" : "";
  $("#copy-code").textContent = state.code;
  $("#round-label").textContent = state.phase === "lobby" ? "AQUECENDO A MESA" : `MÃO ${state.round} · ${state.handSize} CARTA${state.handSize > 1 ? "S" : ""}`;
  $("#status").textContent = state.message;
  $("#chat-toggle").classList.toggle("hidden", Boolean(state.solo));
  $("#emote-toggle").classList.remove("hidden"); // figurinhas valem também no solo (offline)
  renderAutoBar();
  renderSpectatorBar();
  renderWatchers();
  renderPot();
  renderSeats();
  renderAction();
  renderHand();
  maybeStartTurnClock();
  maybeCelebrate();
  if (shouldAnimateDeal) {
    animatedRound = state.round;
    requestAnimationFrame(animateDeal);
  }
}

function renderSeats() {
  $("#manilhas").innerHTML = `<span>MANILHAS FIXAS</span><b>4♣</b> › <b class="red-text">7♥</b> › <b>A♠</b> › <b class="red-text">7♦</b>`;
  const players = state.players;
  const total = Math.max(players.length, 1);
  const meIndex = Math.max(0, players.findIndex((player) => player.id === state.me?.id));
  // "Eu" fico embaixo; os demais preenchem a mesa no sentido horário (mesma direção do jogo).
  const ordered = [...players.slice(meIndex), ...players.slice(0, meIndex)];
  const forehead = state.handSize === 1 && state.phase !== "lobby";

  $("#seats").innerHTML = ordered.map((player, k) => {
    const angle = Math.PI / 2 + (k / total) * Math.PI * 2;
    const cos = Math.cos(angle).toFixed(4);
    const sin = Math.sin(angle).toFixed(4);
    const isMe = player.id === state.me?.id;
    const isTurn = state.turnId === player.id;
    const isDealer = state.dealerId === player.id;
    const wonTrick = state.phase === "trick_reveal" && state.trickResult?.winnerId === player.id;
    const fodeu = state.phase === "round_end" && player.roundLoss > 0;
    const play = state.table.find((item) => item.playerId === player.id);
    const foreheadCard = forehead && !isMe ? player.foreheadCard : null;
    const melada = play && (state.melada || []).includes(play.card.id);

    const cardZone = play
      ? `<div class="seat-card ${wonTrick ? "winning" : ""} ${melada ? "melada" : ""}">${melada ? '<span class="melada-tag">MELOU</span>' : ""}${cardHtml(play.card)}</div>`
      : foreheadCard
        ? `<div class="seat-card"><span class="forehead-tag">TESTA</span>${cardHtml(foreheadCard)}</div>`
        : "";

    const meta = player.bid == null
      ? (state.phase === "lobby" ? "na sala" : state.phase === "bidding" ? "apostando…" : "—")
      : `aposta ${player.bid} · fez ${player.wins}`;

    return `
      <div class="seat-card-slot" style="--cos:${cos};--sin:${sin}">${cardZone}</div>
      <div data-seat="${player.id}" class="seat ${isMe ? "me" : ""} ${isTurn ? "turn" : ""} ${player.eliminated ? "out" : ""} ${!player.connected ? "off" : ""} ${wonTrick ? "won" : ""} ${fodeu ? "fodeu" : ""}" style="--cos:${cos};--sin:${sin}">
        <div class="turn-flag">VEZ</div>
        <div class="seat-body">
          <div class="avatar">${escapeHtml((player.name[0] || "?").toUpperCase())}${isDealer ? '<span class="dealer" title="Distribui esta mão">D</span>' : ""}</div>
          <div class="seat-info">
            <b>${escapeHtml(player.name)}${isMe ? " (você)" : ""}${player.isBot ? '<span class="bot-chip">BOT</span>' : ""}</b>
            <div class="seat-meta">${meta}</div>
            <div class="hearts" title="${player.lives} vidas">${player.lives > 0 ? "♥".repeat(player.lives) : "×"}</div>
          </div>
        </div>
        ${wonTrick ? '<div class="seat-tag win">LEVOU</div>' : ""}
        ${fodeu ? `<div class="seat-tag lose">SE FODEU −${player.roundLoss}</div>` : ""}
        ${!player.connected ? (player.auto ? '<div class="seat-tag off">🤖 BOT NO LUGAR</div>' : '<div class="seat-tag off">RECONECTANDO</div>') : ""}
        ${player.auto && !player.isBot && player.connected && (state.phase === "bidding" || state.phase === "playing") ? '<div class="seat-tag auto">🤖 AUTO</div>' : ""}
      </div>`;
  }).join("");

  $("#empty-table").classList.toggle("hidden", state.phase === "lobby" || state.table.length > 0 || forehead);
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

function renderAction() {
  const panel = $("#action-panel");
  if (state.phase === "lobby") {
    const url = roomUrl(state.code);
    const waText = encodeURIComponent(`Bora jogar Se Fode! 🃏 Entra na minha sala (${state.code}): ${url}`);
    panel.innerHTML = `<div class="panel-title">SALA DE ESPERA</div><h3>${state.players.length < 2 ? "CHAME MAIS ALGUÉM" : "A MESA TÁ PRONTA"}</h3>
      <p>Convide a galera pelo link ou pelo código <b>${state.code}</b>.</p>
      <div class="share">
        <input id="share-url" readonly value="${escapeHtml(url)}" aria-label="Link da sala" />
        <div class="share-actions">
          <button id="copy-link" class="ghost">COPIAR LINK</button>
          <a id="wa-share" class="wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">WHATSAPP</a>
        </div>
      </div>
      ${isHost() ? `<button id="start" ${state.players.length < 2 ? "disabled" : ""}>COMEÇAR O CAOS</button>` : "<p>O dono da sala começa a partida.</p>"}
      ${rankingHtml()}`;
    $("#start")?.addEventListener("click", () => socket.emit("start-game"));
    $("#share-url").onclick = (event) => event.target.select();
    $("#copy-link").onclick = async () => { await navigator.clipboard.writeText(url); showToast("Link copiado!"); };
    return;
  }
  if (state.phase === "bidding" && state.turnId === state.me.id) {
    const isLast = state.bidOrder.at(-1) === state.me.id;
    // Quando o painel vira sheet no mobile, ele cobre a mão — então mostramos as
    // cartas aqui dentro para o jogador apostar vendo o que tem (só faz sentido com 2+).
    const handPreview = state.handSize > 1
      ? `<div class="bid-hand">${[...state.me.hand].sort((a, b) => cardStrength(a) - cardStrength(b)).map((card) => cardHtml(card)).join("")}</div>`
      : "";
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>QUANTAS VOCÊ LEVA?</h3><p>${isLast ? `Você é o pé: a soma não pode dar ${state.handSize}.` : "Escolha sua aposta. Errar custa vidas."}</p>${handPreview}<div class="bids">${Array.from({ length: state.handSize + 1 }, (_, bid) => `<button data-bid="${bid}" ${state.allowedBids.includes(bid) ? "" : "disabled"}>${bid}</button>`).join("")}</div>${turnClockHtml()}`;
    panel.querySelectorAll("[data-bid]").forEach((button) => button.onclick = () => socket.emit("bid", Number(button.dataset.bid)));
    return;
  }
  if (state.phase === "playing" && state.turnId === state.me.id) {
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>${state.handSize === 1 ? "JOGUE NO ESCURO" : "ESCOLHA UMA CARTA"}</h3><p>${state.handSize === 1 ? "Todo mundo sabe o que vem. Menos você." : "Clique numa carta da sua mão."}</p>${state.handSize === 1 ? '<button id="blind-play">JOGAR MINHA CARTA</button>' : ""}${turnClockHtml()}`;
    $("#blind-play")?.addEventListener("click", () => socket.emit("play-card", null));
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
    panel.innerHTML = `<div class="panel-title">RODADA ${result.trick ?? ""}</div><h3>${title}</h3><p>${text}</p>`;
    return;
  }
  if (state.phase === "round_end") {
    const losers = state.roundLosers || [];
    const list = losers.length
      ? `<div class="fodeu-list">${losers.map((loser) => `<div class="fodeu-item ${loser.eliminated ? "eliminated" : ""}"><b>${escapeHtml(loser.name)}</b><span>−${loser.lost} vida${loser.lost > 1 ? "s" : ""}${loser.eliminated ? " · ELIMINADO" : ""}</span></div>`).join("")}</div>`
      : '<p class="fodeu-none">Ninguém se fodeu — todo mundo cravou. 😤</p>';
    panel.innerHTML = `<div class="panel-title">FIM DA MÃO</div><h3>QUEM SE FODEU</h3>${list}${isHost() ? '<button id="next">PRÓXIMA MÃO</button>' : "<p>Esperando o dono da sala continuar.</p>"}`;
    $("#next")?.addEventListener("click", () => socket.emit("next-round"));
    return;
  }
  if (state.phase === "game_over") {
    // Bots e jogadores ausentes (que caíram ou saíram) que o dono pode tirar antes de recomeçar.
    // No modo solo (offline) não faz sentido tirar bots — só vale em salas online.
    const removable = (isHost() && !state.solo)
      ? state.players.filter((player) => player.id !== state.me?.id && (player.isBot || !player.connected || player.auto))
      : [];
    const kickHtml = removable.length
      ? `<div class="kick-list"><div class="kick-title">TIRAR DA MESA</div>${removable.map((player) => `<button class="kick-btn" data-kick="${player.id}">✕ ${escapeHtml(player.name)} <small>${player.isBot ? "bot" : "ausente"}</small></button>`).join("")}</div>`
      : "";
    const lr = state.lastResult;
    const championHtml = lr
      ? `<div class="champion"><span class="champion-name">🏆 ${escapeHtml(lr.name)}</span>${lr.streak >= 2 ? `<span class="champion-streak">🔥 venceu as últimas ${lr.streak} partidas</span>` : lr.wins >= 3 ? `<span class="champion-streak">👑 ${lr.wins} vitórias na sala</span>` : ""}</div>`
      : "";
    panel.innerHTML = `<div class="panel-title">FIM DE JOGO</div><h3>${escapeHtml(state.message)}</h3>${championHtml}${matchStandingsHtml()}${rankingHtml()}${kickHtml}${isHost() ? '<button id="restart">JOGAR DE NOVO</button>' : ""}<button id="leave2" class="ghost">SAIR DA SALA</button>`;
    panel.querySelectorAll("[data-kick]").forEach((button) => button.onclick = () => socket.emit("remove-player", button.dataset.kick));
    $("#restart")?.addEventListener("click", () => socket.emit("restart"));
    $("#leave2")?.addEventListener("click", leaveRoom);
    return;
  }
  const current = state.players.find((player) => player.id === state.turnId);
  panel.innerHTML = `<div class="panel-title">AGORA</div><h3>${current ? `VEZ DE ${escapeHtml(current.name)}` : "SEGURA AÍ"}</h3><p>${state.phase === "bidding" ? "A aposta está rodando a mesa." : "A carta vem aí."}</p>`;
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
