---
target: a mesa em jogo
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-08-21T21-46-19Z
slug: public-index-html
---
Method: dual-agent (A: design review · B: detector + browser evidence)

## Design Health Score

| # | Heurística | Nota | Problema central |
|---|-----------|------|------------------|
| 1 | Visibilidade do estado | 2 | `.round-label{display:none}` no celular; o relógio de 20s vive dentro do painel que some durante `playing` |
| 2 | Sistema ↔ mundo real | 4 | Português do jogo, sem tecnês ("Apostas fechadas. Agora segura esse jogo.") |
| 3 | Controle e liberdade | 3 | SAIR com confirmação, ASSUMIR CONTROLE; aposta irreversível protegida só por 600ms |
| 4 | Consistência | 2 | `#action-panel` tem 4 comportamentos; `PULAR ESPERA` é `.ghost` mas renderiza como primário |
| 5 | Prevenção de erro | 2 | Carta jogável e não-jogável são idênticas; erro tratado por toast após o toque |
| 6 | Reconhecer > lembrar | 3 | Manilhas fixas e `aposta X · fez Y` no assento; mas a SOMA é o menor texto do painel |
| 7 | Flexibilidade | 2 | Nenhum atalho de teclado, nenhuma pré-seleção de aposta; `suggestedBid` existe e não é usado |
| 8 | Estético e minimalista | 2 | `.pot` cobre 2 assentos em todas as larguras; resultado da vaza fica atrás dos assentos em ≤375px |
| 9 | Recuperação de erro | 3 | Mensagens claras e tag RECONECTANDO nos outros; a própria queda é um toast de 2,6s |
| 10 | Ajuda | 1 | `#rules-open` mora na home: de dentro da partida não há acesso a ajuda |
| **Total** | | **24/40** | **Acceptable** — precisa de melhorias significativas |

## Veredito de especificidade

Autoral, com um miolo genérico enxertado. É deste produto e de nenhum outro: manilhas fixas
fixadas acima da mesa, MELOU girado na carta, SE FODEU −2 como rótulo de assento, pulso vermelho
no feltro na reta final, narração com voz própria, e a table-tally. É de qualquer produto:
`#action-panel` como cartão kicker+h3+p de landing page, `.bids` como teclado de calculadora,
FABs de Material Design pousados sobre um feltro de pôquer.

Scan determinístico: markup limpo (exit 0; 3 advisory de `em-dash-overuse`, nenhum no `#game`).
CSS: 10 `side-tab`, 1 `bounce-easing`, 1 `layout-transition`. Detector na página: 73 achados em
mobile contra 30 em desktop — 57 de `undersized-ui-text` e 3 de `low-contrast`, todos criados
pela media query de celular. Sem overlay visível: não há automação de browser nesta sessão.

## Priority Issues

**[P0] A ação central — jogar uma carta — é intocável por teclado e muda para leitor de tela.**
`cardHtml` gera `<div class="card">` com `onclick`; sem tabindex, role ou aria-label. Cada `.seat`
é um `<button aria-label="Abrir perfil de X">`, e o aria-label engole vez, aposta, vidas e
RECONECTANDO. `#status` não tem aria-live. E `index.html:5` traz `user-scalable=no` numa tela cujo
menor texto tem 8,6px. Fix: carta vira `<button>` com rótulo e `disabled` fora da vez; estado do
assento em `.sr-only`; aria-live no status; remover o bloqueio de zoom. → `/impeccable harden`

**[P1] Colisões de z-index e de altura destroem a mesa no celular.** `.pot` (z6) cobre 2 assentos
(z2) em 320/360/375/393/430/1280 — e só aparece quando saber quem apostou o quê mais importa. Em
≤375px o `.poker` transborda o `.table-stage` (320×568: 341px dentro de 221px) e o resultado da
vaza fica atrás dos assentos, sem rolagem de escape. O detector mediu ainda 4 pares de cadeiras
encavaladas com 8 jogadores no modo normal em 375×667 e 360×740, e 1 par com 7 jogadores no modo
testa em 375×667. → `/impeccable layout`

**[P1] O relógio de 20s que entrega seu turno a um bot é invisível no turno mais comum.**
`turnClockHtml()` vive dentro do `.action-panel`, e o painel tem `display:none` durante `playing`
quando `data-acting` não é "1" — ou seja, em toda mão de 2+ cartas no celular. O cronômetro roda a
150ms atualizando um elemento que ninguém vê, e aos 20s um bot joga sua carta. → `/impeccable clarify`

**[P1] A aposta é um muro de opções e o número que decide a aposta é o menor pixel da tela.**
`handSize + 1` botões: 21 na finalíssima de 1 baralho, 41 com 2 baralhos. A restrição do pé é
`opacity:.3` (~2,6:1 no dígito) e a SOMA é .58rem/#8d897e no fim de uma tally que quebra em 3
fileiras. O detector confirma o piso tipográfico: `.seat-meta` a 8,64px carrega aposta e vazas
feitas nos 8 assentos; `.turn-flag "VEZ"` a 9,28px; `.seat-banner` a 7,36px. → `/impeccable distill`

**[P2] Ser eliminado não tem tela.** Anúncio em terceira pessoa a .52rem, `renderSpectatorBar` não
dispara (eliminado ≠ espectador), doca de cartas vazia de 6,2rem pelo resto da partida, e o painel
segue dizendo "VEZ DE FULANO / A carta vem aí". O bug do "?" fantasma (mão e assento mostravam
carta virada para quem não tem carta) foi corrigido nesta rodada usando `me.hasForeheadCard`, que o
servidor já enviava e o cliente ignorava. O resto do estado continua em aberto. → `/impeccable shape`

## Persona red flags

**Casey (celular, distraída, entrou pelo link no meio da partida):** não sabe em que mão está
(`.round-label` escondida), não vê que está sendo cronometrada, e em 320×568 o sheet de aposta
deixa 3 dos 8 assentos visíveis com as cartas de testa cortadas. Salva pelo `bidGuardUntil` de
600ms, que impede aposta acidental.

**Sam (leitor de tela + teclado):** não consegue jogar. As cartas são `div` com `onclick`, a mesa é
muda por causa do aria-label dos assentos, nenhuma virada de estado é anunciada e o zoom está
bloqueado. Cor sozinha carrega significado em três lugares — o modo duplas já resolve isso com cor
+ símbolo + nome, e a regra não foi estendida ao resto.

**Jordan (nunca jogou Fodinha):** nenhuma ajuda alcançável de dentro da partida. "Você é o pé" nunca
é definido e a frase não diz qual número está proibido. A mão parece jogável o tempo todo. Salva
pela faixa de manilhas fixas e pelo tooltip da ficha de dealer.

## Observações menores

- `.status` come 67px de uma tela travada em 100dvh, repetindo o `<h3>` logo abaixo.
- `#toast` (z30) empata com o backdrop do round_end e cai sobre a última fileira de botões de aposta.
- As cartas jogadas não têm vínculo visual com o dono num anel de 8 lugares.
- `.tally-item.pending{opacity:.45}` apaga também a carta de testa de quem ainda não apostou — justo a que mais se precisa ler.
- Durante a rodada de testa (sempre `acting=1`) emotes e chat somem: o momento mais engraçado do jogo é o único sem reação.
- O servidor já calcula `presence` pronto e o cliente re-deriva na mão.
- `detect.mjs` roda degradado neste repo: faltam `htmlparser2`, `css-select`, `css-tree`, `domutils`; sem elas não há contraste computado nem custom properties.

## Falsos positivos

`em-dash-overuse` no alvo (os 12 travessões estão fora do `#game`); `side-tab` nas faixas de
`--team` (a borda é o identificador da dupla, é dado); `bounce-easing` no `card-drop` (carta
quicando na mesa é a metáfora certa); `text-overflow` nos nomes (há ellipsis, é truncagem, não
vazamento); `undersized-ui-text` nos índices de canto das cartas (baralho real é assim).

## Perguntas provocativas

1. E se a aposta nunca cobrisse a mesa? A table-tally é uma reconstrução pior da mesa que o sheet
   escondeu. Botões sobre o feltro — ou apostar tocando o próprio assento — matariam a tally e três
   dos cinco itens reprovados na carga cognitiva.
2. O que a mesa deveria fazer quando alguém morre? Há pódio com botão de compartilhar para a
   vitória e `opacity:.4` para a derrota — num jogo chamado Se Fode.
3. Por que a mão de 20 cartas usa a mesma interface da mão de 1?
