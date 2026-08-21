// Arte do pódio para compartilhar: desenha a classificação final num canvas
// 1080x1350 (retrato, o formato que o WhatsApp e o Instagram mostram inteiro).
// Segue a identidade do jogo: fundo ink, tipografia pesada, faixa ácida e vermelha.

const W = 1080;
const H = 1350;
const INK = "#171713";
const PAPER = "#f1eddf";
const RED = "#ff3b30";
const ACID = "#d8ff45";
const MUTED = "#a9a599";

const HEAVY = '"Archivo Black","Arial Black",Impact,sans-serif';
const BODY = '"DM Sans",system-ui,sans-serif';

const MEDALS = [
  { fill: "#e8b93a", ring: "#8a6a10", label: "1" },
  { fill: "#cfcabc", ring: "#6f6b61", label: "2" },
  { fill: "#c8843f", ring: "#6d4419", label: "3" },
];

// Espaçamento entre letras só existe em canvas nos navegadores novos; onde não
// existir, o texto sai junto — não quebra nada.
function setTracking(ctx, value) {
  try { ctx.letterSpacing = value; } catch { /* navegador antigo */ }
}

// Diminui a fonte até o texto caber na largura pedida.
function fittedFont(ctx, text, maxWidth, size, family, weight = "") {
  let current = size;
  for (;;) {
    ctx.font = `${weight} ${current}px ${family}`.trim();
    if (ctx.measureText(text).width <= maxWidth || current <= 12) return current;
    current -= 2;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Carrega a foto do jogador. Avatares prontos são do próprio site; fotos de
// upload vêm do Storage do Supabase, por isso o crossOrigin — sem ele a imagem
// contamina o canvas e o toBlob() falha. Se der erro, o desenho usa a inicial.
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawNoise(ctx) {
  ctx.save();
  ctx.globalAlpha = 0.035;
  ctx.fillStyle = PAPER;
  for (let i = 0; i < 2600; i += 1) {
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  ctx.restore();
}

function drawBackground(ctx) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);

  // Naipe gigante ao fundo, como na home.
  ctx.save();
  ctx.translate(W * 0.82, H * 0.74);
  ctx.rotate((12 * Math.PI) / 180);
  ctx.fillStyle = "#211f1b";
  ctx.font = `760px ${HEAVY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("♣", 0, 0);
  ctx.restore();

  ctx.fillStyle = ACID;
  ctx.fillRect(0, 0, W, 16);
}

function drawHeader(ctx, data) {
  const x = 72;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  setTracking(ctx, "10px");
  ctx.font = `700 30px ${BODY}`;
  ctx.fillStyle = ACID;
  ctx.fillText("SE FODE", x, 110);
  setTracking(ctx, "0px");

  const maxWidth = W - x * 2;
  const size = fittedFont(ctx, data.title, maxWidth, 104, HEAVY);
  ctx.save();
  ctx.transform(1, 0, -0.09, 1, 0, 0); // leve skew, igual à logo
  ctx.font = `${size}px ${HEAVY}`;
  ctx.fillStyle = RED;
  ctx.fillText(data.title, x + 6, 214 + 6); // sombra dura
  ctx.fillStyle = PAPER;
  ctx.fillText(data.title, x, 214);
  ctx.restore();

  setTracking(ctx, "4px");
  ctx.font = `700 27px ${BODY}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(data.subtitle, x, 266);
  setTracking(ctx, "0px");
}

// A manchete: quem recebe o print no grupo não conhece ninguém e não estava na
// mesa. Uma classificação não diz nada a essa pessoa; "FULANO MELOU 6 VEZES" diz.
// Fica entre o cabeçalho e o pódio, onde nenhum pedestal chega.
function drawHeadline(ctx, headline) {
  if (!headline) return;
  const x = 72;
  const largura = W - x * 2;
  // A faixa vive na folga entre o subtítulo e o topo do avatar do 1º lugar (que
   // começa em y≈390 no layout com lista embaixo). Passar disso é cobrir o pódio.
  const topo = 288;
  const altura = 94;

  ctx.fillStyle = headline.kind === "champion" ? "#1f3326" : "#3a1613";
  ctx.fillRect(x, topo, largura, altura);
  ctx.fillStyle = headline.kind === "champion" ? ACID : RED;
  ctx.fillRect(x, topo, 8, altura); // tarja lateral, na linguagem da mesa

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const size = fittedFont(ctx, headline.label, largura - 60, 44, HEAVY);
  ctx.font = `${size}px ${HEAVY}`;
  ctx.fillStyle = PAPER;
  ctx.fillText(headline.label, x + 30, topo + 48);

  const linha = headline.detail ? `${headline.name} — ${headline.detail}` : headline.name;
  const sizeDetalhe = fittedFont(ctx, linha, largura - 60, 26, BODY, "700");
  ctx.font = `700 ${sizeDetalhe}px ${BODY}`;
  ctx.fillStyle = headline.kind === "champion" ? "#bfe08f" : "#ffb3ad";
  ctx.fillText(linha, x + 30, topo + 78);
}

// Pedestais: o 1º no centro e mais alto, 2º à esquerda, 3º à direita.
function drawPodium(ctx, entries, images, baseY, scale) {
  const gap = 26;
  const count = entries.length;
  const colWidth = Math.min(320, (W - 144 - gap * (count - 1)) / count);
  const totalWidth = colWidth * count + gap * (count - 1);
  const startX = (W - totalWidth) / 2;
  const heights = { 1: 340 * scale, 2: 280 * scale, 3: 240 * scale };
  const order = count === 3 ? [1, 0, 2] : count === 2 ? [1, 0] : [0];

  order.forEach((entryIndex, slot) => {
    const entry = entries[entryIndex];
    const x = startX + slot * (colWidth + gap);
    const height = heights[entry.position] || 180;
    const y = baseY - height;
    const medal = MEDALS[entry.position - 1] || MEDALS[2];
    const first = entry.position === 1;

    // Bloco do pedestal
    ctx.fillStyle = first ? "#443c19" : "#2b2922";
    roundRect(ctx, x, y, colWidth, height, 12);
    ctx.fill();
    if (first) {
      ctx.strokeStyle = ACID;
      ctx.lineWidth = 3;
      roundRect(ctx, x + 1.5, y + 1.5, colWidth - 3, height - 3, 12);
      ctx.stroke();
    }

    const cx = x + colWidth / 2;
    drawAvatar(ctx, images[entryIndex], entry, cx, y - 6, first ? 84 : 70);
    drawMedal(ctx, medal, cx + (first ? 62 : 52), y - 6 - (first ? 52 : 44), first ? 34 : 29);

    ctx.textAlign = "center";
    const nameSize = fittedFont(ctx, entry.name, colWidth - 26, first ? 40 : 34, HEAVY);
    ctx.font = `${nameSize}px ${HEAVY}`;
    ctx.fillStyle = PAPER;
    ctx.fillText(entry.name, cx, y + (first ? 130 : 112));

    const detailSize = fittedFont(ctx, entry.detail, colWidth - 26, 23, BODY, "700");
    ctx.font = `700 ${detailSize}px ${BODY}`;
    ctx.fillStyle = first ? ACID : MUTED;
    ctx.fillText(entry.detail, cx, y + (first ? 168 : 148));

    ctx.font = `${(first ? 80 : 62) * scale}px ${HEAVY}`;
    ctx.fillStyle = first ? "#00000040" : "#ffffff14";
    ctx.fillText(`${entry.position}º`, cx, baseY - 28);
  });

  ctx.fillStyle = "#3a382f";
  ctx.fillRect(startX - 18, baseY, totalWidth + 36, 8);
}

function drawAvatar(ctx, img, entry, cx, bottomY, radius) {
  const cy = bottomY - radius;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#302d22";
  ctx.fill();
  if (img) {
    ctx.clip();
    const side = Math.max(img.width, img.height);
    const scale = (radius * 2) / side;
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${radius}px ${HEAVY}`;
    ctx.fillStyle = PAPER;
    ctx.fillText((entry.name[0] || "?").toUpperCase(), cx, cy + 2);
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = entry.position === 1 ? ACID : "#4a4739";
  ctx.lineWidth = 5;
  ctx.stroke();
}

function drawMedal(ctx, medal, cx, cy, radius) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = medal.fill;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = medal.ring;
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${radius + 6}px ${HEAVY}`;
  ctx.fillStyle = "#241a05";
  ctx.fillText(medal.label, cx, cy + 2);
  ctx.textBaseline = "alphabetic";
}

// Quem ficou fora do pódio, em linhas enxutas.
function drawRest(ctx, rest, extraCount, yStart = 890) {
  if (!rest.length) return;
  const x = 72;
  let y = yStart;

  ctx.textAlign = "left";
  setTracking(ctx, "5px");
  ctx.font = `700 22px ${BODY}`;
  ctx.fillStyle = MUTED;
  ctx.fillText("RESTO DA MESA", x, y);
  setTracking(ctx, "0px");
  y += 26;

  rest.forEach((entry) => {
    ctx.fillStyle = "#22211b";
    roundRect(ctx, x, y, W - x * 2, 52, 8);
    ctx.fill();

    ctx.font = `26px ${HEAVY}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`${entry.position}º`, x + 18, y + 35);

    const nameSize = fittedFont(ctx, entry.name, 420, 27, BODY, "700");
    ctx.font = `700 ${nameSize}px ${BODY}`;
    ctx.fillStyle = PAPER;
    ctx.fillText(entry.name, x + 78, y + 35);

    ctx.textAlign = "right";
    ctx.font = `600 22px ${BODY}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(entry.detail, W - x - 18, y + 34);
    ctx.textAlign = "left";

    y += 60;
  });

  if (extraCount > 0) {
    ctx.font = `600 22px ${BODY}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`+ ${extraCount} jogador${extraCount === 1 ? "" : "es"}`, x + 4, y + 26);
  }
}

function drawFooter(ctx, footer) {
  ctx.fillStyle = RED;
  ctx.fillRect(0, H - 96, W, 96);
  ctx.textAlign = "center";
  setTracking(ctx, "6px");
  ctx.font = `700 30px ${BODY}`;
  ctx.fillStyle = "#fff";
  ctx.fillText(footer, W / 2, H - 38);
  setTracking(ctx, "0px");
}

// Monta a arte inteira. `data` vem do app.js já formatado.
export async function buildPodiumCard(data) {
  const podium = data.podium.slice(0, 3);
  const images = await Promise.all(podium.map((entry) => loadImage(entry.photo)));
  if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* segue com fallback */ } }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawHeader(ctx, data);
  drawHeadline(ctx, data.headline);
  const rest = data.rest.slice(0, 5);
  // O avatar do 1º lugar é ancorado pela base do círculo, então ele sobe bastante
  // acima do pedestal: com a faixa da manchete no topo, o pódio desce um degrau
  // para não passar por cima dela. Sem lista embaixo o pódio já nasce mais baixo.
  const folgaManchete = data.headline && rest.length ? 74 : 0;
  drawPodium(ctx, podium, images, (rest.length ? 820 : 1130) + folgaManchete, rest.length ? 1 : 1.62);
  drawRest(ctx, rest, Math.max(0, data.rest.length - 5), 890 + folgaManchete);
  drawFooter(ctx, data.footer);
  drawNoise(ctx);

  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas vazio"))), "image/png");
  });
}
