# Se Fode

Jogo de cartas multiplayer em tempo real inspirado no “Fodinha”. Crie uma sala, compartilhe o código e jogue no navegador com 2 a 8 pessoas.

Também há um modo solo com escolha de **1 a 7 bots**, ideal para aprender as regras e testar uma partida completa.
Os bots podem jogar nos níveis **fácil**, **normal** ou **difícil**.
Partidas online recuperam automaticamente o jogador após uma queda ou recarga da página; se ele não voltar, o jogo assume seu turno para não travar a mesa.

## Rodar localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Para jogar entre aparelhos na mesma rede, abra o endereço IP do computador na porta 3000. Para jogar pela internet, publique o servidor Node em um serviço com suporte a WebSockets.

## Contas, ranking e dashboard (Supabase)

O login é **obrigatório** para jogar. As contas ficam no Supabase (e-mail + senha).

1. **Rode o schema.** No painel do Supabase, abra o **SQL Editor** e execute o conteúdo de [`supabase/schema.sql`](supabase/schema.sql). Isso cria a tabela `profiles`, o trigger que cria o perfil no cadastro, a função de stats (`record_game`) e o bucket público `avatars`.
2. **Ative o e-mail/senha.** Em *Authentication → Providers*, habilite **Email**. Para testar sem caixa de entrada, desative *Confirm email* em *Authentication → Sign In / Providers*.
3. **Configure as chaves.** Copie `.env.example` para `.env` e preencha `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` (em *Project Settings → API*). A `service_role` é **secreta** — nunca vai para o cliente.
4. **Vire admin.** Cadastre-se pelo jogo e depois rode no SQL Editor:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'voce@exemplo.com');
   ```
   Com o papel `admin`, aparece o botão **DASHBOARD** no menu (`/dashboard`).

**O que cada parte faz:**
- **Perfil** (menu → foto): o usuário escolhe entre os avatares prontos ou faz upload da própria foto (vai para o Storage). A foto aparece na cadeira da mesa.
- **Banner**: só o admin atribui, pelo dashboard. Novos usuários começam com o banner **Novato** (sem enfeite). Os banners aparecem na cadeira do jogador (veja o catálogo em [`design/banners-preview.png`](design/banners-preview.png)).
- **Ranking geral** (menu → 🏆 RANKING): placar global de vitórias de todas as contas. Partidas sem vencedor não contam.
- **Dashboard** (`/dashboard`, só admin): lista todos os usuários com e-mail, papel, vitórias, partidas, datas e o seletor de banner.

> Sem as chaves do Supabase no `.env`, o servidor sobe mas as contas ficam desativadas e a tela de login avisa disso.

## Hospedar no Render

No Render, adicione as três variáveis do Supabase em *Environment* (o `render.yaml` não as inclui por serem segredos).


O projeto inclui um `render.yaml` pronto para criar gratuitamente um Web Service na região da Virgínia, com health check em `/health` e deploy manual pelo painel do Render.

## Páginas públicas e SEO

Além do jogo, o servidor entrega três páginas de conteúdo estático, sem login e sem
JavaScript, para o Google indexar e para explicar o jogo a quem chega de fora:

| URL | Arquivo |
| --- | --- |
| `/fodinha-online` | [`public/fodinha-online.html`](public/fodinha-online.html) |
| `/como-jogar` | [`public/como-jogar.html`](public/como-jogar.html) |
| `/regras` | [`public/regras.html`](public/regras.html) |

Elas usam a folha própria [`public/pages.css`](public/pages.css) (a `styles.css` do jogo
não é carregada nelas). O `server.js` mantém uma URL canônica por página: `/index.html`,
`/regras.html` e `/regras/` respondem **301** para o endereço limpo.

Também ficam no `/public`: [`robots.txt`](public/robots.txt),
[`sitemap.xml`](public/sitemap.xml), [`site.webmanifest`](public/site.webmanifest) e a
imagem de compartilhamento `og-cover.png`.

> Ao criar uma página pública nova, adicione o slug em `PUBLIC_PAGES` (no `server.js`) e
> a URL no `public/sitemap.xml`.

Para regerar a imagem de compartilhamento depois de mexer em
[`design/og-cover.html`](design/og-cover.html):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=1200,630 --virtual-time-budget=8000 \
  --screenshot=public/og-cover.png design/og-cover.html
```

Os passos que só o dono do domínio pode executar (Search Console, DNS, `www`) estão em
[`GOOGLE_SEARCH_CONSOLE.md`](GOOGLE_SEARCH_CONSOLE.md).

## Regras adotadas

- Baralho de truco com 40 cartas; ordem `4 5 6 7 Q J K A 2 3`.
- As manilhas são fixas como no truco mineiro: `4♣ > 7♥ > A♠ > 7♦`.
- Uma **mão** é composta por várias **rodadas** — uma para cada carta distribuída.
- Cartas de mesma força melam aos pares, na ordem em que foram jogadas (3 iguais: as 2 primeiras melam, a 3ª sobrevive).
- Rodada que mela inteira acumula: a próxima vale por duas, e assim por diante, até alguém vencer e levar tudo. Se a mão acabar melada, o bolo vai para quem venceu a rodada antes da melada.
- O pé da mesa nunca pode fechar a soma das apostas no número de cartas, inclusive na mão de uma carta.
- Cada erro entre aposta e resultado custa uma vida. Todos começam com cinco.
- O número de cartas sobe até o limite do baralho, desce até uma e então inicia um novo ciclo.
- A sala pode usar **um ou dois baralhos** (40 ou 80 cartas). Com dois, as mãos ficam maiores e a melada vira rotina — cada cópia é uma carta própria, então duas iguais na mesma vaza se anulam.

## Se Fode Junto — duplas

> Porque, se for para se foder, que seja com um amigo.

Na criação da sala dá para trocar o modo **clássico** pelo **Se Fode Junto**. Salas e partidas antigas, sem modalidade gravada, continuam valendo como clássicas.

- A mesa fecha com **4, 6 ou 8 jogadores** — nunca em número ímpar nem com equipe incompleta.
- As duplas saem no **sorteio** ou na **organização manual** do dono da sala. O servidor valida a escalação: ninguém em duas duplas, ninguém de fora. Depois do início, ninguém troca de time.
- Parceiros sentam **alternados** na mesa e dividem cor, símbolo e nome da dupla.
- Cada um aposta e joga a sua vez normalmente, mas **as apostas e as rodadas vencidas somam**: a dupla apostou 3 e ganhou 3, cravou.
- As **vidas são da dupla** — o dobro do clássico, numa reserva só. Errou a meta da equipe, os dois pagam; zerou, os dois são eliminados juntos.
- A regra do pé continua olhando a soma **geral** da mesa, não a da dupla.
- Cartas de mesma força melam **inclusive entre parceiros**: dá para melar o próprio time.
- A partida acaba quando resta uma dupla. Os dois integrantes recebem a mesma colocação, e por isso a mesma medalha (o pódio continua exigindo 5+ humanos, ou seja, mesas de 6 ou 8).
- **Desempate de duplas eliminadas na mesma mão:** sobreviventes primeiro; depois quem caiu na mão mais recente; empatou, mais vidas restantes; empatou de novo, ordem alfabética do nome da dupla. Nunca a ordem de iteração das listas.
