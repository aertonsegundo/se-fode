// Camada de acesso ao Supabase (contas, perfis, banners, stats e fotos).
// Toda a autorização acontece no servidor: o browser só usa o Supabase para
// autenticar (login/cadastro) e nos manda o access_token; aqui a gente valida
// esse token e faz as leituras/escritas com a service_role (que ignora RLS).
import { createClient } from "@supabase/supabase-js";

// Normaliza a URL para a origem do projeto (https://xxxx.supabase.co), tolerando
// erros comuns de colar a URL do endpoint REST (.../rest/v1/) ou com barra final.
function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try { return new URL(value).origin; } catch { return value.replace(/\/+$/, ""); }
}

const url = normalizeUrl(process.env.SUPABASE_URL);
const anonKey = (process.env.SUPABASE_ANON_KEY || "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// Catálogo fixo de banners (a chave é o que fica salvo no perfil).
export const BANNERS = [
  { key: "novato", title: "Novato" },
  { key: "rei", title: "Rei do Baralho" },
  { key: "maldito", title: "O Maldito" },
  { key: "pato", title: "Pato do Baralho" },
  { key: "coringa", title: "O Coringa" },
  { key: "manilha", title: "Manilha" },
  { key: "zap", title: "O Zap" },
];
export const BANNER_KEYS = BANNERS.map((banner) => banner.key);

// Avatares prontos que o usuário pode escolher (arquivos em /avatars/players/<key>.webp).
export const AVATAR_KEYS = ["jogador-1", "jogador-2", "jogador-3", "jogador-4", "jogador-5"];

export const supabaseEnabled = Boolean(url && anonKey && serviceKey);

const admin = supabaseEnabled
  ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

if (!supabaseEnabled) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ausentes — contas desativadas.");
} else {
  // Valida as chaves no boot: a causa nº 1 de 401 no /api/me é a service_role
  // errada (ex.: anon key colada no lugar). Decodifica só role/ref (não é segredo).
  const claims = (jwt) => { try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64").toString()); } catch { return {}; } };
  const svc = claims(serviceKey);
  const an = claims(anonKey);
  const urlRef = (url.match(/https:\/\/([^.]+)\./) || [])[1];
  if (svc.role !== "service_role") console.warn(`[supabase] ⚠️ SUPABASE_SERVICE_ROLE_KEY ${svc.role ? `tem role="${svc.role}"` : "não parece ser um JWT válido"} (esperado "service_role"). Isso causa 401 no /api/me — use a chave 'service_role' (secret) do painel do Supabase.`);
  if (an.role && an.role !== "anon") console.warn(`[supabase] ⚠️ SUPABASE_ANON_KEY tem role="${an.role}" (esperado "anon").`);
  if (urlRef && svc.ref && svc.ref !== urlRef) console.warn(`[supabase] ⚠️ SUPABASE_SERVICE_ROLE_KEY é de outro projeto (ref="${svc.ref}") — não bate com a URL (ref="${urlRef}").`);
}

// Autoteste no boot: prova que a service_role realmente funciona (listUsers exige ela).
// Loga ✅/❌ claro para diagnóstico rápido em produção (ex.: nos logs do Render).
export async function selfTest() {
  if (!admin) return;
  try {
    const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) throw error;
    console.log("[supabase] ✅ conexão e service_role OK — contas ativas.");
  } catch (error) {
    console.error(`[supabase] ❌ service_role NÃO funciona (${error.message}). O login vai dar 401 no /api/me. Confira SUPABASE_SERVICE_ROLE_KEY (e SUPABASE_URL) no ambiente.`);
  }
}

const PHOTO_BUCKET = "avatars";
let bucketReady = false;

// Config pública que o browser precisa para se autenticar (a anon key é pública).
export function publicConfig() {
  return { enabled: supabaseEnabled, url: url || null, anonKey: anonKey || null };
}

const isUrl = (value) => typeof value === "string" && /^https?:\/\//.test(value);

function shapeProfile(profile, authUser) {
  if (!profile) return null;
  return {
    id: profile.id,
    email: authUser?.email ?? profile.email ?? null,
    displayName: profile.display_name || (authUser?.email || "").split("@")[0] || "Jogador",
    role: profile.role || "user",
    isAdmin: (profile.role || "user") === "admin",
    photo: profile.photo || null,
    banner: profile.banner || "novato",
    wins: profile.wins || 0,
    gamesPlayed: profile.games_played || 0,
    createdAt: profile.created_at || null,
    lastSignInAt: authUser?.last_sign_in_at ?? null,
  };
}

// Valida o access_token e devolve o auth.user do Supabase (ou null).
export async function verifyToken(token) {
  if (!admin || !token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function fetchProfileRow(id) {
  const { data } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
  return data || null;
}

// Garante que existe uma linha em profiles (o trigger normalmente já cria; isto é um fallback).
export async function ensureProfile(authUser) {
  if (!admin || !authUser) return null;
  let row = await fetchProfileRow(authUser.id);
  if (!row) {
    const displayName = authUser.user_metadata?.display_name || (authUser.email || "").split("@")[0] || "Jogador";
    await admin.from("profiles").insert({ id: authUser.id, display_name: displayName }).select().maybeSingle();
    row = await fetchProfileRow(authUser.id);
  }
  return shapeProfile(row, authUser);
}

// Autentica a partir de um token: devolve o perfil já no formato do jogo (ou null).
export async function profileFromToken(token) {
  const authUser = await verifyToken(token);
  if (!authUser) return null;
  return ensureProfile(authUser);
}

// Lista todos os usuários com os dados de perfil + e-mail/último login (para o dashboard admin).
export async function listUsers() {
  if (!admin) return [];
  const { data: rows } = await admin.from("profiles").select("*").order("created_at", { ascending: true });
  const authById = new Map();
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const user of data?.users || []) authById.set(user.id, user);
  } catch (error) {
    console.error("[supabase] listUsers auth admin falhou:", error.message);
  }
  return (rows || []).map((row) => shapeProfile(row, authById.get(row.id)));
}

// Ranking geral por vitórias (para o menu). Devolve os melhores, sem e-mail.
export async function leaderboard(limit = 50) {
  if (!admin) return [];
  const { data } = await admin
    .from("profiles")
    .select("id, display_name, role, photo, banner, wins, games_played")
    .order("wins", { ascending: false })
    .order("games_played", { ascending: false })
    .limit(limit);
  return (data || []).map((row) => ({
    id: row.id,
    displayName: row.display_name || "Jogador",
    photo: row.photo || null,
    banner: row.banner || "novato",
    wins: row.wins || 0,
    gamesPlayed: row.games_played || 0,
  }));
}

export async function setUserName(id, rawName) {
  if (!admin) return { ok: false, error: "Contas desativadas." };
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 18);
  if (!name) return { ok: false, error: "Escolha um nome." };
  const { error } = await admin.from("profiles").update({ display_name: name, updated_at: new Date().toISOString() }).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true, displayName: name };
}

export async function setUserBanner(id, banner) {
  if (!admin) return false;
  if (!BANNER_KEYS.includes(banner)) return false;
  const { error } = await admin.from("profiles").update({ banner, updated_at: new Date().toISOString() }).eq("id", id);
  return !error;
}

async function ensureBucket() {
  if (!admin || bucketReady) return;
  try {
    const { data } = await admin.storage.getBucket(PHOTO_BUCKET);
    if (!data) await admin.storage.createBucket(PHOTO_BUCKET, { public: true });
    bucketReady = true;
  } catch (error) {
    // createBucket lança se já existe: tudo bem.
    bucketReady = true;
  }
}

// Define a foto do usuário: ou uma chave de avatar pronta, ou um upload (data URL) -> Storage.
export async function setUserPhoto(id, { avatarKey, dataUrl } = {}) {
  if (!admin) return { ok: false, error: "Contas desativadas." };
  if (avatarKey) {
    if (!AVATAR_KEYS.includes(avatarKey)) return { ok: false, error: "Avatar inválido." };
    const { error } = await admin.from("profiles").update({ photo: avatarKey, updated_at: new Date().toISOString() }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true, photo: avatarKey };
  }
  if (dataUrl) {
    const match = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return { ok: false, error: "Imagem inválida." };
    const contentType = match[1];
    const buffer = Buffer.from(match[3], "base64");
    if (buffer.length > 2_500_000) return { ok: false, error: "Imagem muito grande (máx. ~2MB)." };
    await ensureBucket();
    const ext = contentType.split("/")[1].replace("jpeg", "jpg");
    const filePath = `${id}/avatar.${ext}`;
    const { error: upErr } = await admin.storage.from(PHOTO_BUCKET).upload(filePath, buffer, { contentType, upsert: true });
    if (upErr) return { ok: false, error: upErr.message };
    const { data } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(filePath);
    // cache-busting pra a foto nova aparecer na hora
    const publicUrl = `${data.publicUrl}?v=${Date.now()}`;
    const { error } = await admin.from("profiles").update({ photo: publicUrl, updated_at: new Date().toISOString() }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true, photo: publicUrl };
  }
  return { ok: false, error: "Nada para atualizar." };
}

// Registra o resultado de uma partida: +1 games_played para todos, +1 win para o vencedor.
export async function recordGame(playerIds, winnerId) {
  if (!admin || !playerIds?.length) return;
  try {
    await admin.rpc("record_game", { p_players: playerIds, p_winner: winnerId || null });
  } catch (error) {
    console.error("[supabase] recordGame falhou:", error.message);
  }
}

export { isUrl };
