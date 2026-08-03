-- Se Fode — migração para quadro de medalhas
-- Cole todo este arquivo no SQL Editor do Supabase e clique em Run.

alter table public.profiles add column if not exists rank_points integer not null default 0;
alter table public.profiles add column if not exists casual_points integer not null default 0;
alter table public.profiles add column if not exists tournament_points integer not null default 0;
alter table public.profiles add column if not exists tournament_titles integer not null default 0;
alter table public.profiles add column if not exists online_wins integer not null default 0;
alter table public.profiles add column if not exists gold_medals integer not null default 0;
alter table public.profiles add column if not exists silver_medals integer not null default 0;
alter table public.profiles add column if not exists bronze_medals integer not null default 0;

create or replace function public.record_game_medals(p_players uuid[], p_winner uuid, p_medals jsonb, p_online boolean default false)
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
  set gold_medals = p.gold_medals + case when reward.medal = 'gold' then 1 else 0 end,
      silver_medals = p.silver_medals + case when reward.medal = 'silver' then 1 else 0 end,
      bronze_medals = p.bronze_medals + case when reward.medal = 'bronze' then 1 else 0 end
  from (select key, value as medal from jsonb_each_text(coalesce(p_medals, '{}'::jsonb))) reward
  where p.id::text = reward.key;
end;
$$;

create or replace function public.award_tournament_trophy(p_champion uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set tournament_titles = tournament_titles + 1
  where p_champion is not null and id = p_champion;
$$;

create table if not exists public.schema_migrations (
  key text primary key,
  applied_at timestamptz not null default now()
);

-- Zera os dados do ranking antigo somente na primeira execução desta migração.
do $$
begin
  if not exists (select 1 from public.schema_migrations where key = 'medal_ranking_v1') then
    update public.profiles
    set rank_points = 0,
        casual_points = 0,
        tournament_points = 0,
        tournament_titles = 0,
        gold_medals = 0,
        silver_medals = 0,
        bronze_medals = 0;
    update public.profiles set banner = 'novato' where banner = 'campeao';
    delete from public.ranking_events;
    insert into public.schema_migrations (key) values ('medal_ranking_v1');
  end if;
end;
$$;
