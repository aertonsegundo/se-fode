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
  if (!token) return gate("Você precisa entrar com uma conta admin.", true);
  loadUsers();
}

async function loadUsers() {
  try {
    const res = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return gate("Sessão expirada. Entre novamente.", true);
    if (res.status === 403) return gate("Acesso restrito a administradores.");
    if (!res.ok) throw new Error("Falha ao carregar usuários.");
    const data = await res.json();
    banners = data.banners || [];
    render(data.users || []);
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

boot();
