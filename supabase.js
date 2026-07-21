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

// Catálogo de banners:
//  - `wins`: liberado pelo nº de vitórias ONLINE (auto-selecionável no perfil).
//  - `exclusive: true`: só o admin concede (maldito, rei).
//  - `auto: true`: concedido pelo jogo (Campeão da Semana), não atribuível.
export const BANNERS = [
  { key: "novato", title: "Novato", wins: 0 },
  { key: "pato", title: "Pato do Baralho", wins: 2 },
  { key: "coringa", title: "O Coringa", wins: 5 },
  { key: "manilha", title: "Manilha", wins: 12 },
  { key: "zap", title: "O Zap", wins: 25 },
  { key: "maldito", title: "O Maldito", exclusive: true },
  { key: "rei", title: "Rei do Baralho", exclusive: true },
  { key: "campeao", title: "Campeão da Semana", auto: true },
];
// Atribuíveis manualmente pelo admin (tudo menos os automáticos).
export const BANNER_KEYS = BANNERS.filter((banner) => !banner.auto).map((banner) => banner.key);

// Avatares prontos que o usuário pode escolher (arquivos em /avatars/players/<key>.webp).
export const AVATAR_KEYS = ["jogador-1", "jogador-2", "jogador-3", "jogador-4", "jogador-5"];

// Figurinhas nativas (têm imagem estática em /emotes/<key>.png; image_url fica null).
// Servem de seed inicial da tabela emotes.
export const BUILTIN_EMOTES = [
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
    onlineWins: profile.online_wins || 0,
    gamesPlayed: profile.games_played || 0,
    rankPoints: profile.rank_points || 0,
    casualPoints: profile.casual_points || 0,
    tournamentPoints: profile.tournament_points || 0,
    tournamentTitles: profile.tournament_titles || 0,
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

// Relê o perfil pelo id (foto/banner/nome atuais) — usado para pegar mudanças
// feitas depois que o socket conectou (ex.: trocou a foto, admin deu um banner).
export async function gameProfileById(id) {
  if (!admin || !id) return null;
  return shapeProfile(await fetchProfileRow(id), null);
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

function leaderboardRow(row) {
  return {
    id: row.id,
    displayName: row.display_name || "Jogador",
    photo: row.photo || null,
    banner: row.banner || "novato",
    wins: row.wins || 0,
    gamesPlayed: row.games_played || 0,
    rankPoints: row.rank_points || 0,
    casualPoints: row.casual_points || 0,
    tournamentPoints: row.tournament_points || 0,
    tournamentTitles: row.tournament_titles || 0,
  };
}

// Geral = pontos acumulados das partidas rápidas e torneios. A ordenação pode
// ser por pontos, vitórias ou eficiência (pontos por partida). O semanal segue
// existindo para definir o Campeão da Semana dentro das salas.
export async function leaderboard(limit = 50, mode = "casual", sort = "points", period = "all") {
  if (!admin) return [];
  if (mode === "weekly") {
    const { data, error } = await admin.rpc("weekly_leaderboard", { p_limit: limit });
    if (error) {
      console.warn("[supabase] rode o schema.sql para ativar ranking semanal:", error.message);
      return [];
    }
    return (data || []).map((row) => ({
      id: row.id,
      displayName: row.display_name || "Jogador",
      photo: row.photo || null,
      banner: row.banner || "novato",
      points: Number(row.points) || 0,
      scoringGames: Number(row.scoring_games) || 0,
      tournamentTitles: Number(row.tournament_titles) || 0,
    }));
  }

  if (mode === "general") {
    if (period !== "all") {
      const { data, error } = await admin.rpc("ranking_period_leaderboard", { p_period: period, p_limit: limit });
      if (error) {
        console.warn("[supabase] rode o schema.sql para ativar ranking por período:", error.message);
        return [];
      }
      const rows = (data || []).map((row) => {
        const points = Number(row.points) || 0;
        const gamesPlayed = Number(row.games_played) || 0;
        return {
          id: row.id,
          displayName: row.display_name || "Jogador",
          photo: row.photo || null,
          banner: row.banner || "novato",
          points,
          wins: Number(row.wins) || 0,
          gamesPlayed,
          pointsPerGame: gamesPlayed ? points / gamesPlayed : 0,
        };
      });
      const compare = {
        points: (a, b) => b.points - a.points || b.wins - a.wins || b.gamesPlayed - a.gamesPlayed,
        wins: (a, b) => b.wins - a.wins || b.points - a.points || b.gamesPlayed - a.gamesPlayed,
        "points-per-game": (a, b) => b.pointsPerGame - a.pointsPerGame || b.points - a.points || b.wins - a.wins,
      }[sort] || ((a, b) => b.points - a.points || b.wins - a.wins);
      return rows.sort(compare).slice(0, limit);
    }
    const { data } = await admin
      .from("profiles")
      .select("id, display_name, photo, banner, wins, games_played, rank_points, casual_points, tournament_points, tournament_titles")
      .limit(1000);
    const rows = (data || []).map(leaderboardRow).map((row) => {
      const points = row.casualPoints + row.tournamentPoints;
      return { ...row, points, pointsPerGame: row.gamesPlayed ? points / row.gamesPlayed : 0 };
    });
    const compare = {
      points: (a, b) => b.points - a.points || b.wins - a.wins || b.gamesPlayed - a.gamesPlayed,
      wins: (a, b) => b.wins - a.wins || b.points - a.points || b.gamesPlayed - a.gamesPlayed,
      "points-per-game": (a, b) => b.pointsPerGame - a.pointsPerGame || b.points - a.points || b.wins - a.wins,
    }[sort] || ((a, b) => b.points - a.points || b.wins - a.wins);
    return rows.sort(compare).slice(0, limit);
  }

  // Ranking por bolso: Partida Rápida (casual_points) ou Torneio (tournament_points).
  const pointsColumn = mode === "tournament" ? "tournament_points" : "casual_points";
  const { data, error } = await admin
    .from("profiles")
    .select("id, display_name, role, photo, banner, wins, games_played, rank_points, casual_points, tournament_points, tournament_titles")
    .order(pointsColumn, { ascending: false })
    .order("tournament_titles", { ascending: false })
    .order("wins", { ascending: false })
    .order("games_played", { ascending: false })
    .limit(limit);
  // O deploy do servidor pode chegar antes de o admin rodar o schema (colunas novas).
  const rows = data || (error
    ? (await admin.from("profiles")
      .select("id, display_name, role, photo, banner, wins, games_played")
      .order("wins", { ascending: false })
      .order("games_played", { ascending: false })
      .limit(limit)).data || []
    : []);
  return rows.map(leaderboardRow).map((row) => ({ ...row, points: mode === "tournament" ? row.tournamentPoints : row.casualPoints }));
}

// Perfil público para abrir a partir da cadeira na mesa. Nunca devolve e-mail,
// role ou qualquer dado de autenticação.
export async function publicPlayerProfile(id) {
  if (!admin || !/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const { data, error: profileError } = await admin
    .from("profiles")
    .select("id, display_name, photo, banner, wins, games_played, rank_points, casual_points, tournament_points, tournament_titles, created_at")
    .eq("id", id)
    .maybeSingle();
  const row = data || (profileError
    ? (await admin.from("profiles")
      .select("id, display_name, photo, banner, wins, games_played, created_at")
      .eq("id", id)
      .maybeSingle()).data
    : null);
  if (!row) return null;

  // A tabela é criada pela atualização do schema. Enquanto ela ainda não foi
  // aplicada, o painel continua útil com os totais do perfil.
  const { data: matches, error } = await admin
    .from("game_history")
    .select("played_at, position, player_count, won, mode")
    .eq("player_id", id)
    .order("played_at", { ascending: false })
    .limit(8);

  return {
    id: row.id,
    displayName: row.display_name || "Jogador",
    photo: row.photo || null,
    banner: row.banner || "novato",
    wins: row.wins || 0,
    gamesPlayed: row.games_played || 0,
    rankPoints: row.rank_points || 0,
    casualPoints: row.casual_points || 0,
    tournamentPoints: row.tournament_points || 0,
    tournamentTitles: row.tournament_titles || 0,
    createdAt: row.created_at || null,
    historyAvailable: !error,
    recentGames: matches || [],
  };
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

// Sobe um data URL de imagem para o Storage e devolve a URL pública.
async function uploadDataUrl(dataUrl, pathNoExt) {
  const match = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) return { ok: false, error: "Imagem inválida." };
  const contentType = match[1];
  const buffer = Buffer.from(match[3], "base64");
  if (buffer.length > 2_500_000) return { ok: false, error: "Imagem muito grande (máx. ~2MB)." };
  await ensureBucket();
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const filePath = `${pathNoExt}.${ext}`;
  const { error } = await admin.storage.from(PHOTO_BUCKET).upload(filePath, buffer, { contentType, upsert: true });
  if (error) return { ok: false, error: error.message };
  const { data } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(filePath);
  return { ok: true, url: `${data.publicUrl}?v=${Date.now()}` };
}

const shapeEmote = (row) => ({ key: row.key, title: row.title, emoji: row.emoji, imageUrl: row.image_url || null, active: !!row.active, sort: row.sort ?? 0, builtin: BUILTIN_EMOTES.some((b) => b.key === row.key) });

const builtinEmoteList = () => BUILTIN_EMOTES.map((emote, index) => ({ ...emote, imageUrl: null, active: true, sort: index, builtin: true }));

// Garante que as figurinhas nativas existam na tabela (upsert que NÃO sobrescreve
// as já presentes — preserva desativações e as personalizadas como a "messi").
// Roda no boot; figurinhas nativas excluídas voltam no próximo start (são o conjunto base).
export async function seedEmotes() {
  if (!admin) return;
  const rows = BUILTIN_EMOTES.map((emote, index) => ({ key: emote.key, title: emote.title, emoji: emote.emoji, image_url: null, active: true, sort: index }));
  const { error } = await admin.from("emotes").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
  if (error) console.warn("[emotes] tabela ausente — rode supabase/schema.sql para gerenciar figurinhas.");
}

// Lista as figurinhas (ordenadas). Sem Supabase / sem a tabela, cai para as nativas.
export async function listEmotes(activeOnly = false) {
  if (!admin) return builtinEmoteList();
  let query = admin.from("emotes").select("*").order("sort", { ascending: true });
  if (activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) return builtinEmoteList(); // tabela ainda não criada
  return (data || []).map(shapeEmote);
}

// Cria uma figurinha nova (com upload opcional de imagem).
export async function createEmote({ key, title, emoji, dataUrl } = {}) {
  if (!admin) return { ok: false, error: "Contas desativadas." };
  key = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  if (!key) return { ok: false, error: "Chave inválida (use letras/números)." };
  title = String(title || "").trim().slice(0, 24) || key;
  emoji = String(emoji || "").trim().slice(0, 8) || "❓";
  const { data: exists } = await admin.from("emotes").select("key").eq("key", key).maybeSingle();
  if (exists) return { ok: false, error: "Já existe uma figurinha com essa chave." };
  let imageUrl = null;
  if (dataUrl) {
    const up = await uploadDataUrl(dataUrl, `emotes/${key}`);
    if (!up.ok) return up;
    imageUrl = up.url;
  }
  const { data: last } = await admin.from("emotes").select("sort").order("sort", { ascending: false }).limit(1).maybeSingle();
  const sort = (last?.sort ?? BUILTIN_EMOTES.length - 1) + 1;
  const { error } = await admin.from("emotes").insert({ key, title, emoji, image_url: imageUrl, active: true, sort });
  return error ? { ok: false, error: error.message } : { ok: true, key };
}

export async function setEmoteActive(key, active) {
  if (!admin) return false;
  const { error } = await admin.from("emotes").update({ active: Boolean(active) }).eq("key", String(key || ""));
  return !error;
}

export async function deleteEmote(key) {
  if (!admin) return false;
  const { error } = await admin.from("emotes").delete().eq("key", String(key || ""));
  return !error;
}

async function recordRankingEvents(events) {
  if (!events.length) return;
  const { error } = await admin.from("ranking_events").insert(events);
  if (error && !/does not exist|relation/i.test(error.message || "")) {
    console.error("[supabase] ranking_events falhou:", error.message);
  }
}

// Registra o resultado de uma partida: +1 games_played para todos, +1 win para o vencedor.
export async function recordGame(players, winnerId, mode = "Partida", online = false) {
  if (!admin || !players?.length) return;
  try {
    const playerIds = players.map((player) => typeof player === "string" ? player : player.userId).filter(Boolean);
    const rankPoints = Object.fromEntries(players
      .filter((player) => typeof player === "object" && player.userId)
      .map((player) => [player.userId, Math.max(0, Number(player.rankPoints) || 0)]));
    let { error: resultError } = await admin.rpc("record_game_result", {
      p_players: playerIds,
      p_winner: winnerId || null,
      p_rank_points: rankPoints,
      p_online: Boolean(online),
    });
    // Schema anterior (sem p_online): tenta a versão de 3 parâmetros — ainda dá
    // pontos casuais, só não conta a vitória online até rodar o schema novo.
    if (resultError) {
      ({ error: resultError } = await admin.rpc("record_game_result", { p_players: playerIds, p_winner: winnerId || null, p_rank_points: rankPoints }));
    }
    // Schema bem antigo: mantém ao menos vitórias/partidas.
    if (resultError) {
      const { error: fallbackError } = await admin.rpc("record_game", { p_players: playerIds, p_winner: winnerId || null });
      if (fallbackError) throw fallbackError;
      console.warn("[supabase] rode o schema.sql para ativar pontos/vitórias online:", resultError.message);
    }

    // Pontos por partida só existem no modo casual; kind 'casual' alimenta o semanal.
    await recordRankingEvents(players
      .filter((player) => typeof player === "object" && player.userId && player.rankPoints > 0)
      .map((player) => ({
        player_id: player.userId,
        points: player.rankPoints,
        kind: "casual",
      })));

    // O histórico é complementar às estatísticas. Se a migration ainda não
    // tiver sido executada, a partida continua contabilizando normalmente.
    const history = players
      .filter((player) => typeof player === "object" && player.userId)
      .map((player) => ({
        player_id: player.userId,
        position: player.position,
        player_count: player.playerCount,
        won: Boolean(player.won),
        mode,
      }));
    if (history.length) {
      const { error } = await admin.from("game_history").insert(history);
      if (error && !/does not exist|relation/i.test(error.message || "")) {
        console.error("[supabase] game_history falhou:", error.message);
      }
    }
  } catch (error) {
    console.error("[supabase] recordGame falhou:", error.message);
  }
}

// Bônus final do torneio. O servidor passa somente contas humanas.
export async function awardTournamentResult(entries) {
  if (!admin || !entries?.length) return;
  const champion = entries.find((entry) => entry.position === 1)?.userId || null;
  const rewards = Object.fromEntries(entries.map((entry) => [entry.userId, Math.max(0, Number(entry.rankPoints) || 0)]));
  const { error } = await admin.rpc("award_tournament_result", { p_rewards: rewards, p_champion: champion });
  if (error) console.warn("[supabase] rode o schema.sql para ativar bônus de torneio:", error.message);
  await recordRankingEvents(entries
    .filter((entry) => entry.rankPoints > 0)
    .map((entry) => ({
      player_id: entry.userId,
      points: entry.rankPoints,
      kind: entry.position === 1 ? "tournament_champion" : "tournament",
    })));
}

export { isUrl };
