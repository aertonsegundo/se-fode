# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Turmas que já se conhecem — grupo de amigos, colegas de trabalho, família — de 2 a 8 pessoas
por mesa. A entrada normal é um link colado no WhatsApp: alguém cria a sala e joga o código no
grupo. Jogam pelo celular, quase sempre com uma chamada de voz aberta por fora (o jogo também
tem chat de voz próprio), muitas vezes falando por cima uns dos outros. Há um modo solo contra
1 a 7 bots, usado para aprender as regras e matar tempo.

O trabalho do jogador na mesa é decidir sob prazo: apostar quantas rodadas leva e escolher que
carta baixar, em 20 segundos, com consequência irreversível (errar a aposta custa vidas).

## Product Purpose

Levar o Fodinha (jogo de cartas de vazas com apostas, manilhas fixas e vidas) para o navegador,
em tempo real, sem instalar nada. Sucesso hoje é **gente nova chegando**: uma partida que
termina bem tem que render conversa e convite dentro do grupo — o fim de jogo é o momento em que
o produto se apresenta a quem ainda não jogou.

## Positioning

Fodinha online que se assume como jogo de zoeira, não como jogo de cartas genérico. A linguagem
da mesa é a da turma ("se fodeu", "melou", "cravou", "o pé"), e o produto tem modos que os
concorrentes de mesa não têm: rodada na testa, "Se Fode Junto" (duplas com vidas compartilhadas),
mesa de dois baralhos e Torneio de Medalhas.

## Operating Context

- Cria-se a sala no navegador, compartilha-se código ou link; sala privada gera senha.
- Partida ao vivo por Socket.IO; queda de conexão devolve o jogador à cadeira, e um bot assume
  o turno de quem não volta para a mesa não travar.
- Login é obrigatório (contas no Supabase); perfil com foto, banners atribuídos por admin,
  ranking global de vitórias e dashboard de administração.
- Deploy em Render; páginas públicas de conteúdo (`/fodinha-online`, `/como-jogar`, `/regras`)
  existem para o Google indexar e explicar o jogo a quem chega de fora.

## Capabilities and Constraints

- Modos: clássico, duplas, torneio de medalhas, solo com bots (fácil/normal/difícil), 1 ou 2 baralhos.
- Manilhas fixas na ordem `4♣ > 7♥ > A♠ > 7♦`; mão de 1 carta é jogada "na testa" (cada um vê as
  cartas dos outros, menos a sua).
- Turno tem 20 segundos; esgotado, um bot joga pelo jogador.
- Mesa de 2 a 8 lugares; em duplas fecha com 4, 6 ou 8.
- O fim de partida já entrega pódio e botão de compartilhar; **não existe nada para quem perde ou
  é eliminado no meio** — o jogador some em `opacity:.4` e a mesa segue.
- Sem `.env` local, contas ficam desativadas e o jogo não é acessível para desenvolvimento.

## Brand Commitments

O nome e o palavreado são vinculantes: "Se Fode", "se fodeu", "melou", "cravou" e a voz ácida da
mesa não devem ser suavizados em nenhuma tela. Identidade existente: preto/grafite, verde-limão
(`--acid #d8ff45`) para ação principal, vermelho (`--red #ff3b30`) para alerta e seleção, papel
quente (`--paper #f1eddf`) para texto, Archivo Black como display. Instagram `@sefodecom`.

## Evidence on Hand

Reais: regras e conteúdo em `README.md` e nas três páginas públicas; catálogo de banners em
`design/banners-preview.png`; avatares e emotes em `public/avatars` e `public/emotes`; pódio
compartilhável já implementado (`public/podium-art.js`); ranking e estatísticas reais no Supabase.
Não existem depoimentos, números de uso, imprensa ou casos — nada disso pode ser inventado em
tela alguma.

## Product Principles

1. A mesa é o produto. Nenhum painel deve custar a leitura da mesa no celular.
2. A derrota é conteúdo. Num jogo chamado Se Fode, quem se fodeu merece tanto desenho quanto quem ganhou.
3. O fim de partida é a porta de entrada: tem que se explicar sozinho para quem não estava jogando.
4. A voz da turma vale mais que a neutralidade — mas nunca às custas de o jogador entender a regra.
5. Ninguém trava a mesa: queda, ausência e desistência têm saída automática.

## Accessibility & Inclusion

Sem requisito formal estabelecido pelo dono. Estado atual conhecido e registrado como dívida: a
carta é uma `div` com `onclick` (sem teclado nem leitor de tela), o assento anuncia só "Abrir
perfil de X", `#status` não tem `aria-live` e o zoom está bloqueado por `user-scalable=no`.
