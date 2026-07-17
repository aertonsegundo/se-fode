import { createClient } from "/vendor/supabase.js";

const socket = io({ autoConnect: false });
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
const iAmSpectator = () => Boolean(state?.me?.spectator);

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function join(kind) {
  // O nome agora vem da conta (editável no perfil), não mais de um campo no menu.
  socket.emit(kind, {
    name: accountProfile?.displayName || "",
    code: $("#code").value,
    botCount: Number($("#bot-count").value),
    botDifficulty: $("#bot-difficulty").value,
    tournamentGames: Number($("#tournament-games").value),
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
$("#create").onclick = () => join("create-room");
$("#tournament").onclick = () => join("create-tournament");
$("#join").onclick = () => join("join-room");
$("#code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#rules-open").onclick = () => $("#rules").showModal();
$("#rules-close").onclick = () => $("#rules").close();
$("#copy-code").onclick = async () => { await navigator.clipboard.writeText(state.code); showToast("Código copiado!"); };
$("#leave").onclick = confirmLeave;
$(".mini-brand").addEventListener("click", (event) => { if (state) { event.preventDefault(); confirmLeave(); } });

// Bloqueia o pinch-zoom no mobile (iOS ignora user-scalable=no). O scroll de 1 dedo continua.
document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });

// Link compartilhado: ?sala=CODIGO já preenche o campo de código.
const sharedCode = (new URLSearchParams(location.search).get("sala") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
if (sharedCode) {
  $("#code").value = sharedCode;
  setTimeout(() => $("#code").focus(), 0);
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
socket.on("auth-required", () => {
  showToast("Sua sessão expirou. Entre de novo.");
  logout();
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
  socket.auth = { token }; // toda reconexão do socket usa o token atual
  try {
    const me = await api("/api/me");
    accountProfile = me.profile;
    bannerCatalog = me.banners || [];
  } catch (err) {
    // Token válido mas o servidor não carregou o perfil (tipicamente 401 por
    // SUPABASE_SERVICE_ROLE_KEY errada no servidor). Mostra o motivo em vez de
    // voltar em silêncio — assim não parece que "nada aconteceu" após o cadastro.
    accountProfile = null;
    showAuthScreen();
    setAuthError("Entrou, mas o servidor não carregou seu perfil (" + (err?.message || "erro") + "). Se você administra o jogo, confira a SUPABASE_SERVICE_ROLE_KEY no servidor.");
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

function renderPlayerCard(profile, currentPlayer = null) {
  const body = $("#player-card-body");
  const stats = profileStats(profile);
  const banner = profile.banner && profile.banner !== "novato"
    ? `<span class="banner-pill banner-${escapeHtml(profile.banner)}">${escapeHtml(bannerTitle(profile.banner))}</span>` : "";
  const now = currentPlayer ? `<div class="player-card-now"><span>NA MESA</span><b>${currentPlayer.lives} ${currentPlayer.lives === 1 ? "vida" : "vidas"}</b><small>${currentPlayer.bid == null ? "Ainda não apostou" : `Apostou ${currentPlayer.bid} · fez ${currentPlayer.wins}`}</small></div>` : "";
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
    <div class="player-points-grid"><div><b>${profile.casualPoints || 0}</b><span>🏆 PARTIDA RÁPIDA</span></div><div><b>${profile.tournamentPoints || 0}</b><span>⚡ TORNEIO</span></div><div><b>${profile.tournamentTitles || 0}</b><span>TÍTULOS</span></div></div>
    <section class="player-history"><div class="player-history-title">HISTÓRICO RECENTE</div>${profile.historyAvailable === false ? '<p class="player-history-empty">O histórico começa a ser salvo nas próximas partidas.</p>' : games ? `<ul>${games}</ul>` : '<p class="player-history-empty">Ainda não terminou uma partida.</p>'}</section>`;
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
$("#photo-close")?.addEventListener("click", () => $("#photo-modal").close());

function renderAvatarChoices() {
  $("#avatar-choices").innerHTML = AVATAR_OPTIONS.map((key) => {
    const active = accountProfile.photo === key ? "active" : "";
    return `<button class="avatar-choice ${active}" data-avatar="${key}"><img src="/avatars/players/${key}.webp" alt="${key}" /></button>`;
  }).join("");
  $("#avatar-choices").querySelectorAll("[data-avatar]").forEach((btn) => btn.onclick = () => savePhoto({ avatarKey: btn.dataset.avatar }));
}
function openPhotoModal() {
  if (!accountProfile) return;
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
  } catch (err) {
    showToast(err.message || "Não deu pra salvar a foto.");
  }
}

$("#photo-upload")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 2_500_000) return showToast("Imagem muito grande (máx. ~2MB).");
  const reader = new FileReader();
  reader.onload = () => savePhoto({ dataUrl: reader.result });
  reader.readAsDataURL(file);
});

// ===== Ranking geral =====
$("#ranking-open")?.addEventListener("click", openRanking);
$("#ranking-close")?.addEventListener("click", () => $("#ranking").close());
let rankingMode = "casual";
const RANKING_EMPTY = {
  casual: "Ninguém pontuou em partida rápida ainda. Chame 3+ pra valer ponto. 🏆",
  tournament: "Nenhum torneio pontuado ainda. Complete um com 3+ jogadores. ⚡",
  weekly: "Ainda não há pontos nesta semana.",
};

// Regras completas por aba (abrem no modal da lâmpada) — copy humanizada + exemplos.
const RANKING_RULES = {
  casual: {
    title: "🏆 Partida Rápida",
    intro: "Terminou no pódio de uma partida com gente de verdade? Levou ponto. E quanto mais cheia a mesa, mais doce a vitória — ganhar entre muitos vale mais do que ganhar entre poucos.",
    base: "Pontua o pódio (1º, 2º e 3º). O valor acompanha o tamanho da mesa: numa mesa de N pessoas, o campeão leva N, o vice N−1 e o terceiro N−2.",
    examples: [
      { label: "Solo ou menos de 3 pessoas", value: "Não vale ponto — farmar contra bot não cola. 🙂" },
      { label: "Mesa pequena · 3 pessoas", value: "3 · 2 · 1 para 1º, 2º e 3º" },
      { label: "Mesa cheia · 8 pessoas", value: "8 · 7 · 6 para 1º, 2º e 3º" },
    ],
  },
  tournament: {
    title: "⚡ Torneio",
    intro: "No torneio o que conta é como você termina no geral. Só a classificação final rende pontos — e eles pesam bem mais que os da partida rápida.",
    base: "Pontua o top 5 da classificação final, escalando com o número de jogadores (cerca de 3× a partida rápida). Dentro do torneio, vencer cada jogo com mais vidas na mão te empurra pra cima na tabela.",
    examples: [
      { label: "Torneio com menos de 3 pessoas", value: "Não rende ponto de ranking." },
      { label: "Torneio pequeno · 3 pessoas", value: "9 · 6 · 3 para 1º, 2º e 3º" },
      { label: "Torneio cheio · 8 pessoas", value: "24 · 21 · 18 · 15 · 12 do 1º ao 5º" },
    ],
  },
  weekly: {
    title: "🔥 Semanal",
    intro: "A foto de quem está voando alto AGORA. Junta tudo que você conquistou — partida rápida e torneio — desde a última segunda-feira.",
    base: "Cada ponto ganho na semana entra aqui. Zera toda segunda. Quem termina em 1º vira o Campeão da Semana e desfila com o banner dourado na mesa.",
    examples: [
      { label: "Venceu 2 rápidas numa mesa de 4", value: "+4 e +4 na semana (8 pontos)" },
      { label: "Ficou em 2º num torneio de 6", value: "+15 na semana" },
      { label: "Total da semana", value: "8 + 15 = 23 pontos somados aqui" },
    ],
  },
};

$("#ranking-tabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ranking-mode]");
  if (button) loadRanking(button.dataset.rankingMode);
});

// Lâmpada: abre o modal com a regra completa da aba atual.
$("#ranking-rules-btn")?.addEventListener("click", () => openRulesModal(rankingMode));
$("#ranking-rules-close")?.addEventListener("click", () => $("#ranking-rules-modal").close());

function openRulesModal(mode) {
  const rules = RANKING_RULES[mode] || RANKING_RULES.casual;
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
  loadRanking("casual");
}

async function loadRanking(mode) {
  rankingMode = ["casual", "tournament", "weekly"].includes(mode) ? mode : "casual";
  const body = $("#ranking-body");
  $("#ranking-tabs").querySelectorAll("[data-ranking-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.rankingMode === rankingMode);
    button.setAttribute("aria-selected", String(button.dataset.rankingMode === rankingMode));
  });
  body.innerHTML = '<p class="ranking-loading">Carregando…</p>';
  try {
    const data = await api(`/api/leaderboard?mode=${rankingMode}`);
    bannerCatalog = data.banners || bannerCatalog;
    const rows = (data.leaderboard || []).filter((user) => (user.points || 0) > 0 || (user.wins || 0) > 0 || (user.tournamentTitles || 0) > 0 || (user.gamesPlayed || 0) > 0);
    if (!rows.length) {
      body.innerHTML = `<p class="ranking-loading">${RANKING_EMPTY[rankingMode]}</p>`;
      return;
    }
    body.innerHTML = rows.map((user, index) => {
      const medal = ["🥇", "🥈", "🥉"][index] || `${index + 1}º`;
      const mine = user.id === data.meId ? "mine" : "";
      // O líder do ranking semanal é o Campeão da Semana (usa o banner especial).
      const bannerTag = rankingMode === "weekly" && index === 0
        ? `<span class="banner-pill banner-campeao">👑 Campeão da Semana</span>`
        : user.banner && user.banner !== "novato"
          ? `<span class="banner-pill banner-${user.banner}">${escapeHtml(bannerTitle(user.banner))}</span>` : "";
      // Coluna principal + duas secundárias, por modo.
      const main = user.points || 0;
      const mainLabel = rankingMode === "weekly" ? "PTS SEM" : "PTS";
      const secondary = rankingMode === "tournament"
        ? [[user.tournamentTitles || 0, "TÍT"], [user.wins || 0, "VIT"]]
        : rankingMode === "weekly"
          ? [[user.scoringGames || 0, "JOGOS"], [user.tournamentTitles || 0, "TÍT"]]
          : [[user.wins || 0, "VIT"], [user.tournamentTitles || 0, "TÍT"]];
      return `<div class="lb-row ${mine}">
        <span class="lb-pos">${medal}</span>
        <span class="lb-photo ${photoUrlFor(user.photo) ? "has-img" : ""}">${photoMarkup(user.photo, user.displayName)}</span>
        <span class="lb-name">${escapeHtml(user.displayName)}${bannerTag}</span>
        <span class="lb-stat points"><b>${main}</b><small>${mainLabel}</small></span>
        <span class="lb-stat"><b>${secondary[0][0]}</b><small>${secondary[0][1]}</small></span>
        <span class="lb-stat titles"><b>${secondary[1][0]}</b><small>${secondary[1][1]}</small></span>
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
}

socket.on("emotes", (list) => setEmotes(list || [])); // atualiza a barra ao vivo
socket.on("emote", (payload) => spawnEmote(payload));
loadEmotes();

function spawnEmote({ key, emoji, imageUrl, name } = {}) {
  const emote = { key, emoji: emoji || emoteById[key]?.emoji || "❓", imageUrl: imageUrl ?? emoteById[key]?.imageUrl ?? null };
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
    return `<div class="tournament-row ${mine ? "mine" : ""}"><span>${medal}</span><b>${escapeHtml(entry.name)}</b><small>${entry.points} pts · ${entry.wins} vitória${entry.wins === 1 ? "" : "s"}</small></div>`;
  }).join("");
  return `<section class="tournament-standings"><div>⚡ PLACAR DO TORNEIO</div>${rows}</section>`;
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
  bar.innerHTML = `<b>⚡ TORNEIO ${current}</b><span>${leader && tournament.completedGames ? `LÍDER: ${escapeHtml(leader.name)} · ${leader.points} PTS` : "A PONTUAÇÃO COMEÇA NA 1ª PARTIDA"}</span>`;
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
  renderTournamentBar();
  renderPot();
  renderSeats();
  maybeGuardBid();
  renderAction();
  renderHand();
  maybeStartTurnClock();
  maybeCelebrate();
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
    const melada = play && (state.melada || []).includes(play.card.id);

    // carta jogada fica exatamente na frente do jogador (slot a 24% do raio)
    const cardZone = play
      ? `<div class="seat-card ${wonTrick ? "winning" : ""} ${melada ? "melada" : ""}">${melada ? '<span class="melada-tag">MELOU</span>' : ""}${cardHtml(play.card)}</div>`
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

    const meta = player.bid == null
      ? (state.phase === "lobby" ? "na sala" : state.phase === "bidding" ? "apostando…" : "—")
      : `aposta ${player.bid} · fez ${player.wins}`;
    const lives = player.lives > 0 ? player.lives : 0;
    const hearts = lives > 0 ? "♥".repeat(lives) : "×";
    const compactHearts = lives > 0 ? `♥ ×${lives}` : "×";
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
    const bannerRibbon = banner ? `<div class="seat-banner">${escapeHtml(bannerTitle(banner))}</div>` : "";

    return `
      <div class="seat-card-slot" style="--cos:${cos};--sin:${sin}">${cardZone}</div>
      <button type="button" data-seat="${player.id}" class="seat ${isMe ? "me" : ""} ${isTurn ? "turn" : ""} ${player.eliminated ? "out" : ""} ${!player.connected ? "off" : ""} ${wonTrick ? "won" : ""} ${fodeu ? "fodeu" : ""} ${banner ? `has-banner banner-${banner}` : ""}" style="--cos:${cos};--sin:${sin}" aria-label="Abrir perfil de ${escapeHtml(player.name)}">
        <div class="turn-flag">VEZ</div>
        ${foreheadOnSeat}
        ${isHostSeat ? '<div class="host-star" title="Dono da sala">★</div>' : ""}
        ${bannerRibbon}
        <div class="seat-body">
          <div class="avatar ${avatarSource ? "profile-photo" : ""}">${avatar}${isDealer ? '<span class="dealer" title="Distribui esta mão">D</span>' : ""}</div>
          <div class="seat-info">
            <b>${escapeHtml(player.name)}${isMe ? " (você)" : ""}${player.isBot ? '<span class="bot-chip">BOT</span>' : ""}</b>
            <div class="seat-meta">${meta}</div>
            <div class="hearts" title="${lives} vidas"><span class="hearts-full">${hearts}</span><span class="hearts-compact">${compactHearts}</span></div>
          </div>
        </div>
        ${wonTrick ? '<div class="seat-tag win">LEVOU</div>' : ""}
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
    const tournament = state.tournament;
    panel.innerHTML = `<div class="panel-title">${tournament ? "TORNEIO RANKEADO" : "SALA DE ESPERA"}</div><h3>${state.players.length < 2 ? "CHAME MAIS ALGUÉM" : "A MESA TÁ PRONTA"}</h3>
      <p>${tournament ? `Serão ${tournament.totalGames} partidas na mesma mesa. A classificação de cada uma vale pontos.` : `Convide a galera pelo link ou pelo código <b>${state.code}</b>.`}</p>
      <div class="share">
        <input id="share-url" readonly value="${escapeHtml(url)}" aria-label="Link da sala" />
        <div class="share-actions">
          <button id="copy-link" class="ghost">COPIAR LINK</button>
          <a id="wa-share" class="wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">WHATSAPP</a>
        </div>
      </div>
      ${isHost() ? `<button id="start" ${state.players.length < 2 ? "disabled" : ""}>${tournament ? "COMEÇAR O TORNEIO" : "COMEÇAR O CAOS"}</button>` : "<p>O dono da sala começa a partida.</p>"}
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
    const guarded = Date.now() < bidGuardUntil; // trava breve pós-abertura (anti-misclick)
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>QUANTAS VOCÊ LEVA?</h3><p>${isLast ? `Você é o pé: a soma não pode dar ${state.handSize}.` : "Escolha sua aposta. Errar custa vidas."}</p>${handPreview}<div class="bids ${guarded ? "guarded" : ""}">${Array.from({ length: state.handSize + 1 }, (_, bid) => `<button data-bid="${bid}" ${state.allowedBids.includes(bid) && !guarded ? "" : "disabled"}>${bid}</button>`).join("")}</div>${turnClockHtml()}`;
    panel.querySelectorAll("[data-bid]").forEach((button) => button.onclick = () => socket.emit("bid", Number(button.dataset.bid)));
    return;
  }
  if (state.phase === "playing" && state.turnId === state.me.id) {
    if (state.handSize === 1) {
      // Rodada na testa: joga sozinha, sem botão (a carta está na testa).
      panel.innerHTML = `<div class="panel-title">RODADA NA TESTA</div><h3>JOGUE NO ESCURO</h3><p>Sua carta vai sozinha — todo mundo vê, menos você.</p>`;
      return;
    }
    panel.innerHTML = `<div class="panel-title">SUA VEZ</div><h3>ESCOLHA UMA CARTA</h3><p>Clique numa carta da sua mão.</p>${turnClockHtml()}`;
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
    // Havendo bot, alguém no automático (AFK) ou caído entre os ativos, o dono decide;
    // só começa sozinho quando todos os ativos são humanos conectados no controle.
    const needsHost = state.players.some((player) => !player.eliminated && (player.isBot || !player.connected || player.auto));
    // Dono pode tirar da mesa quem está no automático (bot ativo) ou caiu.
    const removable = (isHost() && !state.solo && !state.tournament)
      ? state.players.filter((player) => player.id !== state.hostId && (player.isBot || !player.connected || player.auto))
      : [];
    const kickHtml = removable.length
      ? `<div class="kick-list"><div class="kick-title">TIRAR DA MESA</div>${removable.map((player) => `<button class="kick-btn" data-kick="${player.id}">✕ ${escapeHtml(player.name)} <small>${player.isBot ? "bot" : !player.connected ? "caiu" : "automático"}</small></button>`).join("")}</div>`
      : "";
    const nextControl = needsHost
      ? (isHost() ? '<button id="next">PRÓXIMA MÃO</button>' : "<p>Esperando o dono da sala continuar.</p>")
      : '<p class="auto-next">Próxima mão começando…</p>';
    panel.innerHTML = `<div class="panel-title">FIM DA MÃO</div><h3>QUEM SE FODEU</h3>${list}${kickHtml}${nextControl}`;
    panel.querySelectorAll("[data-kick]").forEach((button) => button.onclick = () => socket.emit("remove-player", button.dataset.kick));
    $("#next")?.addEventListener("click", () => socket.emit("next-round"));
    return;
  }
  if (state.phase === "game_over") {
    // Bots e jogadores ausentes (que caíram ou saíram) que o dono pode tirar antes de recomeçar.
    // No modo solo (offline) não faz sentido tirar bots — só vale em salas online.
    const removable = (isHost() && !state.solo && !state.tournament)
      ? state.players.filter((player) => player.id !== state.me?.id && (player.isBot || !player.connected || player.auto))
      : [];
    const kickHtml = removable.length
      ? `<div class="kick-list"><div class="kick-title">TIRAR DA MESA</div>${removable.map((player) => `<button class="kick-btn" data-kick="${player.id}">✕ ${escapeHtml(player.name)} <small>${player.isBot ? "bot" : "ausente"}</small></button>`).join("")}</div>`
      : "";
    const lr = state.lastResult;
    const championHtml = lr
      ? `<div class="champion"><span class="champion-name">🏆 ${escapeHtml(lr.name)}</span>${lr.streak >= 2 ? `<span class="champion-streak">🔥 venceu as últimas ${lr.streak} partidas</span>` : lr.wins >= 3 ? `<span class="champion-streak">👑 ${lr.wins} vitórias na sala</span>` : ""}</div>`
      : "";
    const tournament = state.tournament;
    const tournamentFinished = tournament?.finished;
    const tournamentControls = tournament
      ? (tournamentFinished
        ? (isHost() ? '<button id="restart">RECOMEÇAR TORNEIO</button>' : "")
        : (isHost() ? `<button id="next-tournament">PRÓXIMA PARTIDA · ${tournament.completedGames + 1}/${tournament.totalGames}</button>` : "<p>Esperando o dono da sala iniciar a próxima partida.</p>"))
      : (isHost() ? '<button id="restart">JOGAR DE NOVO</button>' : "");
    const panelTitle = tournamentFinished ? "TORNEIO ENCERRADO" : "FIM DE JOGO";
    panel.innerHTML = `<div class="panel-title">${panelTitle}</div><h3>${escapeHtml(state.message)}</h3>${championHtml}${matchStandingsHtml()}${tournament ? tournamentStandingsHtml({ podium: tournamentFinished }) : ""}${rankingHtml()}${kickHtml}${tournamentControls}<button id="leave2" class="ghost">SAIR DA SALA</button>`;
    panel.querySelectorAll("[data-kick]").forEach((button) => button.onclick = () => socket.emit("remove-player", button.dataset.kick));
    $("#next-tournament")?.addEventListener("click", () => socket.emit("next-tournament-game"));
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
