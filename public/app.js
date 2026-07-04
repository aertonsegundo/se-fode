const socket = io();
let state = null;
const $ = (selector) => document.querySelector(selector);
const home = $("#home");
const game = $("#game");
const toast = $("#toast");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
const isRed = (card) => card && ["♦", "♥"].includes(card.suit);
const cardHtml = (card, extra = "") => card ? `<div class="card ${isRed(card) ? "red" : ""} ${state?.manilha === card.rank ? "manilha" : ""} ${extra}"><span>${card.rank}${card.suit}</span><span class="big-suit">${card.suit}</span><span style="transform:rotate(180deg)">${card.rank}${card.suit}</span></div>` : "";
const me = () => state?.players.find((player) => player.id === state.me?.id);
const isHost = () => state?.hostId === state.me?.id;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function join(kind) {
  const name = $("#name").value.trim();
  localStorage.setItem("fode-name", name);
  socket.emit(kind, { name, code: $("#code").value });
}

$("#name").value = localStorage.getItem("fode-name") || "";
$("#solo").onclick = () => join("solo-game");
$("#create").onclick = () => join("create-room");
$("#join").onclick = () => join("join-room");
$("#code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#rules-open").onclick = () => $("#rules").showModal();
$("#rules-close").onclick = () => $("#rules").close();
$("#copy-code").onclick = async () => { await navigator.clipboard.writeText(state.code); showToast("Código copiado!"); };

socket.on("notice", showToast);
socket.on("state", (next) => {
  state = next;
  home.classList.add("hidden");
  game.classList.remove("hidden");
  render();
});

function render() {
  $("#copy-code").textContent = state.code;
  $("#round-label").textContent = state.phase === "lobby" ? "AQUECENDO A MESA" : `RODADA ${state.round} · ${state.handSize} CARTA${state.handSize > 1 ? "S" : ""}`;
  $("#status").textContent = state.message;
  renderPlayers();
  renderTable();
  renderAction();
  renderHand();
}

function renderPlayers() {
  $("#scoreboard").innerHTML = `<div class="panel-title">NA MESA — ${state.players.length}/8</div>` + state.players.map((player) => `
    <div class="player-row ${state.turnId === player.id ? "active" : ""} ${player.eliminated ? "out" : ""}">
      <div class="avatar">${escapeHtml(player.name[0].toUpperCase())}</div>
      <div><b>${escapeHtml(player.name)}${player.id === state.me.id ? " (você)" : ""}${player.isBot ? '<span class="bot-chip">BOT</span>' : ""}</b><br><span class="bid-chip">${player.bid == null ? "—" : `apostou ${player.bid} · levou ${player.wins}`}</span></div>
      <div class="hearts" title="${player.lives} vidas">${player.lives > 0 ? "♥".repeat(player.lives) : "×"}</div>
    </div>`).join("");
}

function renderTable() {
  $("#vira").innerHTML = state.vira ? `VIRA${cardHtml(state.vira)}` : "";
  $("#table").innerHTML = state.table.map((play, index) => {
    const player = state.players.find((item) => item.id === play.playerId);
    const angle = (index / Math.max(state.players.length, 1)) * Math.PI * 2;
    return `<div class="played" style="--r:${index * 13 - 15}deg;--x:${Math.cos(angle) * 72}px;--y:${Math.sin(angle) * 55}px"><small>${escapeHtml(player?.name)}</small>${cardHtml(play.card)}</div>`;
  }).join("");
  $("#empty-table").classList.toggle("hidden", state.table.length > 0 || state.phase === "lobby");
}

function renderAction() {
  const panel = $("#action-panel");
  if (state.phase === "lobby") {
    panel.innerHTML = `<div class="panel-title">SALA DE ESPERA</div><h3>${state.players.length < 2 ? "CHAME MAIS ALGUÉM" : "A MESA TÁ PRONTA"}</h3><p>Compartilhe o código <b>${state.code}</b> com seus amigos.</p>${isHost() ? `<button id="start" ${state.players.length < 2 ? "disabled" : ""}>COMEÇAR O CAOS</button>` : "<p>O dono da sala começa a partida.</p>"}`;
    $("#start")?.addEventListener("click", () => socket.emit("start-game"));
    return;
  }
  if (state.phase === "bidding" && state.turnId === state.me.id) {
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>QUANTAS VOCÊ LEVA?</h3><p>Escolha sua aposta. Errar custa vidas.</p><div class="bids">${Array.from({ length: state.handSize + 1 }, (_, bid) => `<button data-bid="${bid}">${bid}</button>`).join("")}</div>`;
    panel.querySelectorAll("[data-bid]").forEach((button) => button.onclick = () => socket.emit("bid", Number(button.dataset.bid)));
    return;
  }
  if (state.phase === "playing" && state.turnId === state.me.id) {
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>${state.handSize === 1 ? "JOGUE NO ESCURO" : "ESCOLHA UMA CARTA"}</h3><p>${state.handSize === 1 ? "Todo mundo sabe o que vem. Menos você." : "Clique numa carta da sua mão."}</p>${state.handSize === 1 ? '<button id="blind-play">JOGAR MINHA CARTA</button>' : ""}`;
    $("#blind-play")?.addEventListener("click", () => socket.emit("play-card", null));
    return;
  }
  if (state.phase === "round_end") {
    panel.innerHTML = `<div class="panel-title">FIM DA RODADA</div><h3>FAÇAM AS CONTAS</h3>${isHost() ? '<button id="next">PRÓXIMA RODADA</button>' : "<p>Esperando o dono da sala continuar.</p>"}`;
    $("#next")?.addEventListener("click", () => socket.emit("next-round"));
    return;
  }
  if (state.phase === "game_over") {
    panel.innerHTML = `<div class="panel-title">FIM DE JOGO</div><h3>${escapeHtml(state.message)}</h3>${isHost() ? '<button id="restart">JOGAR DE NOVO</button>' : ""}`;
    $("#restart")?.addEventListener("click", () => socket.emit("restart"));
    return;
  }
  const current = state.players.find((player) => player.id === state.turnId);
  panel.innerHTML = `<div class="panel-title">AGORA</div><h3>${current ? `VEZ DE ${escapeHtml(current.name)}` : "SEGURA AÍ"}</h3><p>${state.phase === "bidding" ? "A aposta está rodando a mesa." : "A carta vem aí."}</p>`;
}

function renderHand() {
  const hand = $("#hand");
  if (state.phase === "lobby" || state.phase === "game_over") { hand.innerHTML = ""; return; }
  if (state.handSize === 1) {
    const visible = state.players.filter((player) => player.foreheadCard);
    hand.innerHTML = `<div class="foreheads">${visible.map((player) => `<div class="forehead">${cardHtml(player.foreheadCard)}<span>NA TESTA DE ${escapeHtml(player.name.toUpperCase())}</span></div>`).join("")}<div class="forehead"><div class="card" style="background:#27251f;color:#d8ff45;display:grid;place-items:center;font-size:2rem">?</div><span>SUA CARTA</span></div></div>`;
    return;
  }
  hand.innerHTML = state.me.hand.map((card) => cardHtml(card)).join("");
  hand.querySelectorAll(".card").forEach((element, index) => {
    element.onclick = () => {
      if (state.phase !== "playing" || state.turnId !== state.me.id) return showToast("Ainda não é sua vez.");
      socket.emit("play-card", state.me.hand[index].id);
    };
  });
}
