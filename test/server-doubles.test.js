// Testes de ponta a ponta do servidor: sobem o server.js de verdade (com DEV_AUTH
// e os tempos da mesa encurtados) e jogam por Socket.IO, do lobby ao fim de jogo.
// É aqui que se verifica o que só existe no servidor: escalação das duplas, vidas
// compartilhadas, eliminação conjunta, bot da desconexão e eventos duplicados.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3197 + Number(process.env.TEST_PORT_OFFSET || 0);
const URL = `http://127.0.0.1:${PORT}`;
let server = null;
const open = [];

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      DEV_AUTH: "1",                 // usuários falsos pelo handshake (nunca ligado em produção)
      SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "",
      TRICK_REVEAL_MS: "80", NEXT_ROUND_MS: "120", FOREHEAD_MS: "40", RECONNECT_GRACE_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("servidor não subiu")), 15000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("rodando em")) { clearTimeout(timer); resolve(); }
    });
    server.on("exit", (code) => reject(new Error(`servidor saiu com ${code}`)));
  });
});

after(async () => {
  for (const socket of open) socket.disconnect();
  server?.kill("SIGKILL");
});

async function connect(name) {
  const socket = io(URL, { auth: { devUser: name }, transports: ["websocket"], forceNew: true });
  socket.notices = [];
  socket.states = [];
  socket.player = name;
  socket.on("notice", (text) => socket.notices.push(text));
  socket.on("state", (next) => { socket.last = next; socket.states.push(next); });
  await once(socket, "connect");
  open.push(socket);
  return socket;
}

// Espera o estado do servidor satisfazer uma condição (o cliente nunca inventa nada).
function until(socket, predicate, label, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const check = (next) => {
      if (!predicate(next)) return;
      clearTimeout(timer);
      socket.off("state", check);
      resolve(next);
    };
    const timer = setTimeout(() => {
      socket.off("state", check);
      reject(new Error(`tempo esgotado esperando: ${label} (fase ${socket.last?.phase})`));
    }, timeout);
    socket.on("state", check);
    if (socket.last && predicate(socket.last)) check(socket.last);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Joga sozinho e baixa a primeira carta da mão quando é a vez. A aposta segue a
// estratégia pedida: "alta" estoura a meta da dupla (queima vidas rápido) e "baixa"
// segura o jogo — assim a partida termina em segundos, com um lado se afundando.
function autopilot(socket, strategy = "high") {
  let acted = "";
  socket.on("state", (next) => {
    if (!next.me || next.turnId !== next.me.id) return;
    const key = `${next.round}-${next.phase}-${next.trick}-${next.turnId}`;
    if (key === acted) return;
    if (next.phase === "bidding" && next.allowedBids.length) {
      acted = key;
      const reckless = strategy === "high" || (strategy === "byTeam" && next.me.id && next.teams[1]?.playerIds.includes(next.me.id));
      socket.emit("bid", reckless ? Math.max(...next.allowedBids) : Math.min(...next.allowedBids));
    } else if (next.phase === "playing" && next.handSize > 1 && next.me.hand.length) {
      acted = key;
      socket.emit("play-card", next.me.hand[0].id);
    }
  });
}

async function makeRoom(names, options = {}) {
  const host = await connect(names[0]);
  host.emit("create-room", { name: names[0], roomName: `Mesa ${names[0]}`, ...options });
  const [session] = await once(host, "session");
  const sockets = [host];
  for (const name of names.slice(1)) {
    const guest = await connect(name);
    guest.emit("join-room", { name, code: session.code });
    await once(guest, "session");
    sockets.push(guest);
  }
  await until(host, (state) => state.players.length === names.length, "mesa completa");
  return { code: session.code, host, sockets };
}

const teamOfPlayer = (state, playerId) => (state.teams || []).find((team) => team.playerIds.includes(playerId));

// ===== Clássico e compatibilidade =====

test("sala clássica (payload sem modalidade) continua funcionando", async () => {
  const { host, sockets } = await makeRoom(["Ana", "Bento"]); // sem `mode`: registro antigo
  assert.equal(host.last.mode, "classic");
  assert.deepEqual(host.last.teams, []);
  assert.equal(host.last.deckCount, 1);
  host.emit("start-game");
  const started = await until(host, (state) => state.phase === "bidding", "clássico começou");
  assert.equal(started.players.length, 2);
  assert.ok(started.players.every((player) => player.teamId === null));
  sockets.forEach((socket) => socket.emit("leave-room"));
});

test("clássico não regrediu: quem chega no meio assiste e entra na próxima partida", async () => {
  const { host, sockets, code } = await makeRoom(["Duo1", "Duo2"]);
  sockets.forEach((socket) => autopilot(socket, "high"));
  host.emit("start-game");
  await until(host, (state) => state.phase === "bidding", "clássico rolando");
  const watcher = await connect("Tardio");
  watcher.emit("join-room", { name: "Tardio", code });
  await once(watcher, "session");
  const watching = await until(host, (state) => state.spectators.length === 1, "assistindo");
  assert.equal(watching.players.length, 2);

  const over = await until(host, (state) => state.phase === "game_over", "fim do clássico", 60000);
  assert.equal(over.players.length, 3);      // a arquibancada sobe para a mesa, como sempre
  assert.equal(over.spectators.length, 0);
  assert.ok(over.players.every((player) => player.teamId === null));
  [...sockets, watcher].forEach((socket) => socket.emit("leave-room"));
});

test("mesa em dupla recusa começar com 3 e aceita com 4", async () => {
  const { host, sockets, code } = await makeRoom(["Aerton", "Bia", "Dudu"], { mode: "doubles" });
  assert.equal(host.last.mode, "doubles");
  host.emit("start-game");
  await sleep(200);
  assert.equal(host.last.phase, "lobby"); // ímpar e com menos de 4: não começa
  assert.ok(host.notices.includes("O modo em dupla precisa de 4, 6 ou 8 jogadores."));

  const fourth = await connect("Caio");
  fourth.emit("join-room", { name: "Caio", code });
  await once(fourth, "session");
  await until(host, (state) => state.players.length === 4, "quatro na mesa");
  host.emit("start-game");
  const started = await until(host, (state) => state.phase === "bidding", "duplas começou");
  assert.equal(started.teams.length, 2);
  [...sockets, fourth].forEach((socket) => socket.emit("leave-room"));
});

test("mesa de 6 forma 3 duplas e a de 8 forma 4", async () => {
  for (const [count, teams] of [[6, 3], [8, 4]]) {
    const names = Array.from({ length: count }, (_, index) => `J${count}-${index}`);
    const { host, sockets } = await makeRoom(names, { mode: "doubles" });
    host.emit("start-game");
    const started = await until(host, (state) => state.phase === "bidding", `mesa de ${count}`);
    assert.equal(started.teams.length, teams);
    assert.ok(started.teams.every((team) => team.playerIds.length === 2));
    assert.equal(new Set(started.players.map((player) => player.teamId)).size, teams);
    sockets.forEach((socket) => socket.emit("leave-room"));
    await sleep(50);
  }
});

// ===== Escalação, estado e tempo real =====

test("duplas formadas: um teamId por jogador, cores próprias e parceiros alternados", async () => {
  const { host, sockets } = await makeRoom(["Aerton", "Bia", "Dudu", "Caio"], { mode: "doubles" });
  host.emit("start-game");
  const state = await until(host, (next) => next.phase === "bidding", "partida em dupla");

  assert.equal(state.teams.length, 2);
  for (const player of state.players) {
    const teams = state.teams.filter((team) => team.playerIds.includes(player.id));
    assert.equal(teams.length, 1);                 // ninguém em duas duplas
    assert.equal(player.teamId, teams[0].id);      // e ninguém sem dupla
  }
  const [first, second] = state.teams;
  assert.notEqual(first.color, second.color);
  assert.ok(first.symbol && first.label);          // não depende só de cor
  assert.equal(first.lives, 10);                   // 5 vidas × 2 jogadores
  assert.equal(second.lives, 10);
  // vidas espelhadas nos assentos: os dois parceiros veem o mesmo número
  for (const team of state.teams) {
    for (const id of team.playerIds) {
      assert.equal(state.players.find((player) => player.id === id).lives, team.lives);
    }
  }
  // parceiros alternados na mesa (a ordem dos assentos é a ordem das apostas)
  const order = state.players.map((player) => player.teamId);
  for (let seat = 0; seat < order.length; seat += 1) {
    assert.notEqual(order[seat], order[(seat + 1) % order.length]);
  }
  sockets.forEach((socket) => socket.emit("leave-room"));
});

test("apostas somam ao vivo na dupla e o dano da mão é da equipe", async () => {
  const { host, sockets } = await makeRoom(["Ana", "Bia", "Caio", "Duda"], { mode: "doubles" });
  sockets.forEach(autopilot);
  host.emit("start-game");
  await until(host, (state) => state.phase === "bidding", "apostas abertas");

  // A soma da dupla acompanha cada aposta individual, em tempo real.
  const partial = await until(host, (state) => state.teams.some((team) => team.pending.length === 1), "primeira aposta");
  const started = partial.teams.find((team) => team.pending.length === 1);
  const partnerBids = started.playerIds
    .map((id) => partial.players.find((player) => player.id === id)?.bid || 0)
    .reduce((sum, bid) => sum + bid, 0);
  assert.equal(started.bid, partnerBids);

  // A revelação da vaza carrega a melada entre parceiros (vazia quando não houve).
  const reveal = await until(host, (state) => state.phase === "trick_reveal", "vaza revelada");
  assert.ok(Array.isArray(reveal.trickResult.partnerMelada));
  assert.ok(Array.isArray(reveal.melada));

  const ended = await until(host, (state) => state.phase === "round_end", "fim da mão");
  assert.equal(ended.teamResults.length, 2);
  for (const result of ended.teamResults) {
    const team = ended.teams.find((item) => item.id === result.teamId);
    assert.equal(result.lost, Math.abs(result.bid - result.wins)); // dano = diferença da equipe
    assert.equal(team.lives, Math.max(0, 10 - result.lost));       // sai da reserva compartilhada
    assert.ok(team.lives >= 0);                                    // nunca negativa
    for (const id of team.playerIds) {
      assert.equal(ended.players.find((player) => player.id === id).lives, team.lives);
    }
  }
  const cravou = ended.teamResults.find((result) => result.lost === 0);
  if (cravou) assert.equal(ended.teams.find((team) => team.id === cravou.teamId).lives, 10);
  sockets.forEach((socket) => socket.emit("leave-room"));
});

test("partida completa: dupla eliminada junta, uma vencedora e colocação igual para os dois", async () => {
  const { host, sockets } = await makeRoom(["Ana", "Bia", "Caio", "Duda"], { mode: "doubles" });
  sockets.forEach((socket) => autopilot(socket, "byTeam")); // uma dupla aposta alto e afunda
  host.emit("start-game");
  await until(host, (state) => state.phase === "bidding", "partida rolando");
  const watcher = await connect("Zé"); // chega com a partida em andamento: vai para a arquibancada
  watcher.emit("join-room", { name: "Zé", code: host.last.code });
  await once(watcher, "session");
  const over = await until(host, (state) => state.phase === "game_over", "fim de jogo", 60000);

  const eliminated = over.teams.filter((team) => team.eliminated);
  const alive = over.teams.filter((team) => !team.eliminated);
  assert.ok(alive.length <= 1);                        // acaba assim que sobra uma dupla (ou nenhuma)
  assert.ok(eliminated.length >= 1);
  for (const team of eliminated) {
    for (const id of team.playerIds) {
      assert.equal(over.players.find((player) => player.id === id).eliminated, true); // os dois caem juntos
    }
    assert.equal(team.lives, 0);
  }

  // Classificação: os dois integrantes sempre com a mesma posição.
  const positions = new Map(over.matchStandings.map((entry) => [entry.id, entry.position]));
  for (const team of over.teams) {
    const [one, two] = team.playerIds.map((id) => positions.get(id));
    assert.equal(one, two);
  }
  if (alive.length === 1) { // campeãs: as duas em 1º
    assert.match(over.message, /A DUPLA .+ SOBREVIVEU/);
    assert.equal(over.lastResult.name, alive[0].members.map((member) => member.name).join(" + "));
    for (const id of alive[0].playerIds) assert.equal(positions.get(id), 1);
  } else { // as duas duplas caíram na mesma mão: ninguém vence e nada entra no ranking
    assert.match(over.message, /Todas as duplas se foderam/);
    assert.equal(over.lastResult, null);
  }
  assert.equal(over.medalMatch, false); // 4 humanos: sem medalhas, como no clássico

  // Quem chegou no meio fica na arquibancada: promover faria a mesa virar 5 e travar.
  assert.equal(over.players.length, 4);
  assert.equal(over.spectators.length, 1);

  host.emit("restart"); // recomeça com a mesma mesa válida de 4
  const again = await until(host, (state) => state.phase === "bidding", "segunda partida");
  assert.equal(again.teams.length, 2);
  assert.ok(again.teams.every((team) => team.lives === 10));
  [...sockets, watcher].forEach((socket) => socket.emit("leave-room"));
});

test("torneio em dupla premia os dois integrantes e não conta a partida duas vezes", async () => {
  const names = ["Ana", "Bia", "Caio", "Duda", "Enzo", "Fabi"];
  const { host, sockets } = await makeRoom(names, { mode: "doubles", isTournament: true, tournamentGames: 3 });
  sockets.forEach((socket) => autopilot(socket, "byTeam"));
  host.emit("start-game");
  const over = await until(host, (state) => state.phase === "game_over", "primeira partida do torneio", 90000);

  // Seis humanos: o pódio vale, e cada dupla leva a MESMA medalha nas duas cadeiras.
  assert.equal(over.medalMatch, true);
  assert.deepEqual(over.medalStandings.map((entry) => entry.position), [1, 1, 2, 2, 3, 3]);
  const medals = over.tournament.standings.map((entry) => `${entry.goldMedals}${entry.silverMedals}${entry.bronzeMedals}`);
  assert.deepEqual(medals.slice().sort(), ["100", "100", "010", "010", "001", "001"].sort());
  assert.equal(over.tournament.completedGames, 1);

  host.emit("next-tournament-game");
  host.emit("next-tournament-game"); // clique repetido não pula uma partida do torneio
  const next = await until(host, (state) => state.phase === "bidding", "segunda partida do torneio");
  assert.equal(next.tournament.completedGames, 1);
  assert.equal(next.tournament.totalGames, 3);
  assert.equal(next.teams.length, 3);
  sockets.forEach((socket) => socket.emit("leave-room"));
});

// ===== Organização manual =====

test("organização manual é validada no servidor e só o dono muda as duplas", async () => {
  const { host, sockets } = await makeRoom(["Ana", "Bia", "Caio", "Duda"], { mode: "doubles", teamSetup: "manual" });
  const ids = host.last.players.map((player) => player.id);

  host.emit("set-teams", { mode: "manual", groups: [[ids[0], ids[0]], [ids[1], ids[2]]] }); // repetido
  await sleep(120);
  assert.ok(host.notices.some((text) => text.startsWith("Escalação inválida")));

  host.emit("set-teams", { mode: "manual", groups: [[ids[0], ids[3]], [ids[1], ids[2]]] });
  const arranged = await until(host, (state) => state.teamSetup.groups.some((group) => group.length === 2), "duplas montadas");
  assert.equal(arranged.teamSetup.mode, "manual");
  assert.deepEqual(arranged.teamSetup.groups, [[ids[0], ids[3]], [ids[1], ids[2]]]);

  const guest = sockets[1];
  guest.emit("set-teams", { mode: "random" }); // não é o dono: ignorado
  await sleep(120);
  assert.deepEqual(host.last.teamSetup.groups, [[ids[0], ids[3]], [ids[1], ids[2]]]);

  host.emit("start-game");
  const started = await until(host, (state) => state.phase === "bidding", "partida com duplas escolhidas");
  const chosen = started.teams.map((team) => [...team.playerIds].sort());
  assert.deepEqual(chosen.map((group) => group.join("|")).sort(), [[ids[0], ids[3]].sort().join("|"), [ids[1], ids[2]].sort().join("|")].sort());
  sockets.forEach((socket) => socket.emit("leave-room"));
});

// ===== Desconexão, reconexão e eventos repetidos =====

test("bot da desconexão herda a dupla, e a reconexão não duplica jogador nem equipe", async () => {
  const { host, sockets, code } = await makeRoom(["Ana", "Bia", "Caio", "Duda"], { mode: "doubles" });
  sockets.slice(0, 3).forEach(autopilot); // o quarto vai cair no meio
  const faller = sockets[3];
  const session = faller.sessionData || null;
  host.emit("start-game");
  const started = await until(host, (state) => state.phase === "bidding", "partida rolando");
  const fallerId = started.players.find((player) => player.name === "Duda").id;
  const teamBefore = teamOfPlayer(started, fallerId);

  faller.disconnect();
  const withBot = await until(host, (state) => state.players.find((player) => player.id === fallerId)?.auto === true, "bot assumiu");
  const teamAfter = teamOfPlayer(withBot, fallerId);
  assert.equal(teamAfter.id, teamBefore.id);                       // mesma dupla
  assert.deepEqual(teamAfter.playerIds, teamBefore.playerIds);     // sem re-sorteio
  assert.equal(teamAfter.lives, teamBefore.lives);                 // vidas preservadas
  assert.equal(withBot.teams.length, started.teams.length);

  const back = await connect("Duda");
  back.emit("resume-session", session || { code, playerId: fallerId, resumeToken: null });
  back.emit("join-room", { name: "Duda", code }); // caminho normal de quem volta
  await sleep(400);
  const resumed = host.last;
  assert.equal(resumed.players.length, 4);                                     // ninguém duplicado
  assert.equal(resumed.players.filter((player) => player.id === fallerId).length, 1);
  assert.equal(resumed.teams.length, 2);                                       // nem equipe duplicada
  assert.deepEqual(teamOfPlayer(resumed, fallerId).playerIds, teamBefore.playerIds);
  assert.equal(new Set(resumed.teams.flatMap((team) => team.playerIds)).size, 4);
  [...sockets, back].forEach((socket) => socket.emit("leave-room"));
});

test("eventos repetidos não jogam duas vezes nem começam a partida de novo", async () => {
  const { host, sockets } = await makeRoom(["Ana", "Bia", "Caio", "Duda"], { mode: "doubles" });
  host.emit("start-game");
  const started = await until(host, (state) => state.phase === "bidding", "partida em dupla");
  // Cada cliente recebe o seu próprio estado: espera todos antes de escolher quem aposta.
  await Promise.all(sockets.map((socket) => until(socket, (state) => state.phase === "bidding", "todos apostando")));
  const first = sockets.find((socket) => socket.last.turnId === socket.last.me?.id);
  const bid = Math.max(...first.last.allowedBids);
  assert.ok(Number.isInteger(bid));

  first.emit("bid", bid);
  first.emit("bid", bid); // duplicado: o servidor só aceita o primeiro
  await sleep(200);
  const after = first.last;
  assert.equal(after.players.find((player) => player.id === started.turnId).bid, bid);
  assert.notEqual(after.turnId, started.turnId); // a vez andou uma só vez
  assert.ok(first.notices.includes("Não é sua vez de apostar."));

  host.emit("start-game"); // começar de novo no meio da partida
  await sleep(120);
  assert.ok(host.notices.includes("Essa partida já começou."));
  assert.equal(host.last.round, after.round);
  sockets.forEach((socket) => socket.emit("leave-room"));
});
