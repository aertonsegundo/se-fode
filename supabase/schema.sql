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
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

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
