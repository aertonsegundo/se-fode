import { createClient } from "/vendor/supabase.js";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
let supabase = null;
let token = null;
let banners = [];

function gate(message, showLogin = false) {
  const el = $("#dash-gate");
  el.classList.remove("hidden");
  $("#dash-content").classList.add("hidden");
  el.innerHTML = `${escapeHtml(message)}${showLogin ? ' <a href="/" class="dash-back">Ir para o login</a>' : ""}`;
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
}

const photoUrlFor = (photo) => {
  if (!photo) return null;
  if (/^https?:\/\//.test(photo)) return photo;
  return `/avatars/players/${encodeURIComponent(photo)}.webp`;
};
const photoCell = (photo, name) => {
  const src = photoUrlFor(photo);
  return src ? `<img class="dash-photo" src="${src}" alt="" />` : `<span class="dash-photo dash-photo-txt">${escapeHtml((name?.[0] || "?").toUpperCase())}</span>`;
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }); }
  catch { return "—"; }
};

async function boot() {
  let cfg;
  try { cfg = await fetch("/api/config").then((r) => r.json()); }
  catch { cfg = { enabled: false }; }
  if (!cfg.enabled) return gate("Contas desativadas no servidor.");
  supabase = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await supabase.auth.getSession();
  token = data.session?.access_token || null;
  if (!token) return leave(); // não logado: não entra no dashboard
  loadUsers();
}

// Manda de volta pro jogo quem não pode estar aqui (não logado ou não-admin).
function leave() { location.replace("/"); }
const bearer = () => ({ Authorization: `Bearer ${token}` });
const jsonBearer = () => ({ "Content-Type": "application/json", ...bearer() });

async function loadUsers() {
  try {
    const res = await fetch("/api/admin/users", { headers: bearer() });
    if (res.status === 401 || res.status === 403) return leave(); // não-admin não entra
    if (!res.ok) throw new Error("Falha ao carregar usuários.");
    const data = await res.json();
    banners = data.banners || [];
    render(data.users || []);
    loadEmotes();
  } catch (err) {
    gate(err.message || "Erro ao carregar.");
  }
}

function render(users) {
  $("#dash-gate").classList.add("hidden");
  $("#dash-content").classList.remove("hidden");

  const totalWins = users.reduce((sum, user) => sum + (user.wins || 0), 0);
  const totalGames = users.reduce((sum, user) => sum + (user.gamesPlayed || 0), 0);
  const admins = users.filter((user) => user.isAdmin).length;
  $("#dash-stats").innerHTML = [
    ["USUÁRIOS", users.length],
    ["ADMINS", admins],
    ["VITÓRIAS TOTAIS", totalWins],
    ["PARTIDAS", totalGames],
  ].map(([label, value]) => `<div class="dash-stat"><b>${value}</b><span>${label}</span></div>`).join("");

  $("#dash-rows").innerHTML = users.map((user) => {
    const bannerOptions = banners.map((banner) =>
      `<option value="${banner.key}" ${user.banner === banner.key ? "selected" : ""}>${escapeHtml(banner.title)}</option>`).join("");
    return `<tr>
      <td class="dash-user">${photoCell(user.photo, user.displayName)}<span>${escapeHtml(user.displayName)}</span></td>
      <td class="dash-email">${escapeHtml(user.email || "—")}</td>
      <td>${user.isAdmin ? '<span class="role-chip admin">admin</span>' : '<span class="role-chip">user</span>'}</td>
      <td class="dash-num">${user.wins}</td>
      <td class="dash-num">${user.gamesPlayed}</td>
      <td class="dash-date">${fmtDate(user.createdAt)}</td>
      <td class="dash-date">${fmtDate(user.lastSignInAt)}</td>
      <td><select class="banner-select banner-${user.banner}" data-user="${user.id}">${bannerOptions}</select></td>
    </tr>`;
  }).join("");

  $("#dash-rows").querySelectorAll(".banner-select").forEach((select) => {
    select.onchange = () => setBanner(select.dataset.user, select.value, select);
  });
}

async function setBanner(userId, banner, select) {
  select.disabled = true;
  try {
    const res = await fetch(`/api/admin/user/${userId}/banner`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ banner }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erro ao salvar.");
    select.className = `banner-select banner-${banner}`;
    toast("Banner atualizado!");
  } catch (err) {
    toast(err.message || "Não deu pra salvar.");
    loadUsers();
  } finally {
    select.disabled = false;
  }
}

// ===== Figurinhas =====
async function loadEmotes() {
  try {
    const res = await fetch("/api/admin/emotes", { headers: bearer() });
    if (!res.ok) return;
    const data = await res.json();
    renderEmotes(data.emotes || []);
  } catch { /* silencioso */ }
}

function renderEmotes(list) {
  const grid = $("#emote-grid");
  grid.innerHTML = "";
  if (!list.length) {
    grid.innerHTML = '<p class="dash-hint">Nenhuma figurinha. Reinicie o servidor para restaurar as nativas ou adicione uma acima.</p>';
    return;
  }
  for (const emote of list) {
    const card = document.createElement("div");
    card.className = "emote-card" + (emote.active ? "" : " off");

    const media = document.createElement("div");
    media.className = "emote-media";
    const img = document.createElement("img");
    img.src = emote.imageUrl || `/emotes/${emote.key}.png`;
    img.alt = "";
    img.onerror = () => { media.innerHTML = ""; const span = document.createElement("span"); span.className = "emote-emoji-fallback"; span.textContent = emote.emoji || "❓"; media.appendChild(span); };
    media.appendChild(img);
    card.appendChild(media);

    const info = document.createElement("div");
    info.className = "emote-info";
    info.innerHTML = `<b>${escapeHtml(emote.title || emote.key)}</b><span>:${escapeHtml(emote.key)}:${emote.builtin ? " · nativa" : ""}${emote.active ? "" : " · inativa"}</span>`;
    card.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "emote-actions";
    const toggle = document.createElement("button");
    toggle.className = "emote-toggle-btn";
    toggle.textContent = emote.active ? "Desativar" : "Ativar";
    toggle.onclick = () => setEmoteActive(emote.key, !emote.active);
    const del = document.createElement("button");
    del.className = "emote-del-btn";
    del.textContent = "Excluir";
    del.onclick = () => removeEmote(emote.key, emote.title || emote.key);
    actions.append(toggle, del);
    card.appendChild(actions);

    grid.appendChild(card);
  }
}

async function setEmoteActive(key, active) {
  try {
    const res = await fetch(`/api/admin/emotes/${encodeURIComponent(key)}/active`, { method: "POST", headers: jsonBearer(), body: JSON.stringify({ active }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erro.");
    toast(active ? "Figurinha ativada." : "Figurinha desativada.");
    loadEmotes();
  } catch (err) { toast(err.message || "Não deu pra atualizar."); }
}

async function removeEmote(key, title) {
  if (!confirm(`Excluir a figurinha "${title}"?`)) return;
  try {
    const res = await fetch(`/api/admin/emotes/${encodeURIComponent(key)}`, { method: "DELETE", headers: bearer() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erro.");
    toast("Figurinha excluída.");
    loadEmotes();
  } catch (err) { toast(err.message || "Não deu pra excluir."); }
}

const emoteMsg = (text) => { $("#emote-form-msg").textContent = text || ""; };

$("#emote-add").onclick = () => {
  const key = $("#emote-key").value.trim();
  const title = $("#emote-title").value.trim();
  const emoji = $("#emote-emoji").value.trim();
  const file = $("#emote-image").files?.[0];
  emoteMsg("");
  if (!key) return emoteMsg("Informe a chave (letras/números).");
  if (!emoji && !file) return emoteMsg("Ponha um emoji ou envie uma imagem.");
  if (file && file.size > 2_500_000) return emoteMsg("Imagem muito grande (máx. ~2MB).");
  if (file) {
    const reader = new FileReader();
    reader.onload = () => createEmoteReq({ key, title, emoji, dataUrl: reader.result });
    reader.readAsDataURL(file);
  } else {
    createEmoteReq({ key, title, emoji });
  }
};

async function createEmoteReq(body) {
  const btn = $("#emote-add");
  btn.disabled = true;
  try {
    const res = await fetch("/api/admin/emotes", { method: "POST", headers: jsonBearer(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erro.");
    toast("Figurinha adicionada!");
    $("#emote-key").value = ""; $("#emote-title").value = ""; $("#emote-emoji").value = ""; $("#emote-image").value = "";
    loadEmotes();
  } catch (err) { emoteMsg(err.message || "Não deu pra adicionar."); }
  finally { btn.disabled = false; }
}

boot();
