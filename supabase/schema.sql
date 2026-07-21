-- ============================================================================
-- Se Fode — schema do Supabase (contas, perfis, banners, stats).
-- Rode isto uma vez no SQL Editor do painel do Supabase.
-- ============================================================================

-- Tabela de perfis: 1:1 com auth.users.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  role          text not null default 'user',      -- 'user' | 'admin'
  photo         text,                                -- chave de avatar ('jogador-1') OU url do upload
  banner        text not null default 'novato',      -- chave do banner (novato/rei/maldito/pato/coringa/manilha/zap)
  wins          integer not null default 0,
  games_played  integer not null default 0,
  rank_points   integer not null default 0,
  tournament_titles integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Também cobre instalações que já tinham a tabela antes do ranking por pontos.
alter table public.profiles add column if not exists rank_points integer not null default 0;
alter table public.profiles add column if not exists tournament_titles integer not null default 0;
-- Sprint 1: dois bolsos de pontos separados (Partida Rápida × Torneio).
alter table public.profiles add column if not exists casual_points integer not null default 0;
alter table public.profiles add column if not exists tournament_points integer not null default 0;
-- Sprint 3: vitórias ONLINE (exclui solo) para desbloquear banners.
alter table public.profiles add column if not exists online_wins integer not null default 0;

-- ---------------------------------------------------------------------------
-- Row Level Security.
-- O servidor usa a service_role (ignora RLS) para tudo que é sensível
-- (listar usuários, atribuir banner, gravar stats). O cliente anon só precisa
-- conseguir LER o próprio perfil; nenhuma escrita direta pelo cliente.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Cria o perfil automaticamente quando um usuário se cadastra.
-- O display_name vem do metadata passado no signUp; senão, usa o prefixo do e-mail.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Registra o resultado de uma partida (chamado pelo servidor via RPC/service_role).
-- +1 games_played para todos os jogadores humanos; +1 win para o vencedor.
-- ---------------------------------------------------------------------------
create or replace function public.record_game(p_players uuid[], p_winner uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set games_played = games_played + 1
  where id = any(p_players);

  update public.profiles set wins = wins + 1
  where p_winner is not null and id = p_winner;
$$;

-- Atualização atômica da partida CASUAL. O servidor envia apenas ids de jogadores
-- humanos: bots nunca ganham partidas, pontos ou histórico global.
-- Os pontos vão para o bolso de Partida Rápida (casual_points).
-- p_online = true quando NÃO é solo (conta a vitória para desbloqueio de banners).
drop function if exists public.record_game_result(uuid[], uuid, jsonb);
create or replace function public.record_game_result(p_players uuid[], p_winner uuid, p_rank_points jsonb, p_online boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set games_played = games_played + 1
  where id = any(p_players);

  update public.profiles set wins = wins + 1
  where p_winner is not null and id = p_winner;

  update public.profiles set online_wins = online_wins + 1
  where p_online and p_winner is not null and id = p_winner;

  update public.profiles p
  set casual_points = p.casual_points + reward.points
  from (select key, value::integer as points from jsonb_each_text(coalesce(p_rank_points, '{}'::jsonb))) reward
  where p.id::text = reward.key;
end;
$$;

-- Resultado final do torneio: pontos vão para o bolso de Torneio (tournament_points)
-- e o campeão ganha +1 título.
create or replace function public.award_tournament_result(p_rewards jsonb, p_champion uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles p
  set tournament_points = p.tournament_points + reward.points
  from (select key, value::integer as points from jsonb_each_text(coalesce(p_rewards, '{}'::jsonb))) reward
  where p.id::text = reward.key;

  update public.profiles set tournament_titles = tournament_titles + 1
  where p_champion is not null and id = p_champion;
end;
$$;

-- Eventos de pontos para rankings por período. Só há eventos de contas humanas:
-- o servidor não insere bots nesta tabela.
create table if not exists public.ranking_events (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.profiles(id) on delete cascade,
  points      integer not null check (points > 0),
  kind        text not null,
  created_at  timestamptz not null default now()
);

-- Instalações antigas tinham um CHECK restrito em kind; removemos para aceitar
-- os tipos novos ('casual', 'tournament', 'tournament_champion').
alter table public.ranking_events drop constraint if exists ranking_events_kind_check;

create index if not exists ranking_events_weekly_idx
  on public.ranking_events (created_at desc, player_id);

alter table public.ranking_events enable row level security;

-- Ranking semanal COMBINADO (segunda-feira até agora): soma de pontos de todos os
-- modos + títulos de torneio conquistados na semana. Lido com service_role.
drop function if exists public.weekly_leaderboard(integer);
create or replace function public.weekly_leaderboard(p_limit integer default 50)
returns table (
  id uuid,
  display_name text,
  photo text,
  banner text,
  points bigint,
  scoring_games bigint,
  tournament_titles bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.display_name,
    p.photo,
    p.banner,
    coalesce(sum(e.points), 0)::bigint as points,
    count(*)::bigint as scoring_games,
    count(*) filter (where e.kind = 'tournament_champion')::bigint as tournament_titles
  from public.ranking_events e
  join public.profiles p on p.id = e.player_id
  where e.created_at >= date_trunc('week', now())
  group by p.id, p.display_name, p.photo, p.banner
  order by points desc, tournament_titles desc, scoring_games desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

-- Histórico enxuto por jogador. Guarda apenas o resultado final da partida;
-- não registra cartas, conversas nem e-mail.
create table if not exists public.game_history (
  id            bigint generated always as identity primary key,
  player_id     uuid not null references public.profiles(id) on delete cascade,
  played_at     timestamptz not null default now(),
  position      smallint not null check (position > 0),
  player_count  smallint not null check (player_count > 0),
  won           boolean not null default false,
  mode          text not null default 'Partida'
);

create index if not exists game_history_player_played_at_idx
  on public.game_history (player_id, played_at desc);

alter table public.game_history enable row level security;

-- Ranking por período: usa o histórico para partidas/vitórias e os eventos para
-- pontos. A semana começa na segunda-feira; o mês começa no primeiro dia.
drop function if exists public.ranking_period_leaderboard(text, integer);
create or replace function public.ranking_period_leaderboard(p_period text default 'weekly', p_limit integer default 50)
returns table (
  id uuid,
  display_name text,
  photo text,
  banner text,
  points bigint,
  games_played bigint,
  wins bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with period_start as (
    select case p_period
      when 'monthly' then date_trunc('month', now())
      else date_trunc('week', now())
    end as starts_at
  ), game_stats as (
    select h.player_id, count(*)::bigint as games_played,
      count(*) filter (where h.won)::bigint as wins
    from public.game_history h cross join period_start s
    where h.played_at >= s.starts_at
    group by h.player_id
  ), point_stats as (
    select e.player_id, coalesce(sum(e.points), 0)::bigint as points
    from public.ranking_events e cross join period_start s
    where e.created_at >= s.starts_at
    group by e.player_id
  )
  select p.id, p.display_name, p.photo, p.banner,
    coalesce(ps.points, 0)::bigint as points,
    coalesce(gs.games_played, 0)::bigint as games_played,
    coalesce(gs.wins, 0)::bigint as wins
  from public.profiles p
  join (select player_id from game_stats union select player_id from point_stats) active on active.player_id = p.id
  left join game_stats gs on gs.player_id = p.id
  left join point_stats ps on ps.player_id = p.id
  order by points desc, wins desc, games_played desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

-- ---------------------------------------------------------------------------
-- Figurinhas (emotes) gerenciáveis pelo admin no dashboard.
-- image_url null => usa a imagem estática /emotes/<key>.png (built-in) ou o emoji.
-- ---------------------------------------------------------------------------
create table if not exists public.emotes (
  key         text primary key,
  title       text not null default '',
  emoji       text not null default '❓',
  image_url   text,
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.emotes enable row level security;
-- Sem policies: o servidor lê/escreve com a service_role; o cliente nunca acessa direto.

-- ---------------------------------------------------------------------------
-- Bucket público para as fotos de upload (o servidor também tenta criar via API).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- ============================================================================
-- Para promover alguém a admin (dá acesso ao /dashboard), rode:
--   update public.profiles set role = 'admin' where id = (
--     select id from auth.users where email = 'voce@exemplo.com'
--   );
-- ============================================================================
