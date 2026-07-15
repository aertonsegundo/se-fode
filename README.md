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


O projeto inclui um `render.yaml` pronto para criar gratuitamente um Web Service na região da Virgínia, com health check em `/health` e deploy automático a cada atualização da branch `main`.

## Regras adotadas

- Baralho de truco com 40 cartas; ordem `4 5 6 7 Q J K A 2 3`.
- As manilhas são fixas como no truco mineiro: `4♣ > 7♥ > A♠ > 7♦`.
- Uma **mão** é composta por várias **rodadas** — uma para cada carta distribuída.
- Cartas de mesma força melam aos pares, na ordem em que foram jogadas (3 iguais: as 2 primeiras melam, a 3ª sobrevive).
- Rodada que mela inteira acumula: a próxima vale por duas, e assim por diante, até alguém vencer e levar tudo. Se a mão acabar melada, o bolo vai para quem venceu a rodada antes da melada.
- O pé da mesa nunca pode fechar a soma das apostas no número de cartas, inclusive na mão de uma carta.
- Cada erro entre aposta e resultado custa uma vida. Todos começam com cinco.
- O número de cartas sobe até o limite do baralho, desce até uma e então inicia um novo ciclo.
