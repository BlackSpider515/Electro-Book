-- ============================================================
-- Назначение преподавателя (выполнить в SQL Editor ПОСЛЕ создания
-- пользователя в Dashboard → Authentication → Users).
-- Создайте пользователя с email ksenia@diary.local и паролем из
-- инструкции README, затем выполните этот файл.
-- Логин преподавателя будет ksenia (часть email до @).
-- ============================================================

-- Вариант 1: профиль уже существует (например, создан вручную)
-- update public.profiles
-- set role = 'admin', full_name = 'Ксения Андреевна'
-- where id = (select id from auth.users where email = 'ksenia@diary.local');

-- Вариант 2: профиля ещё нет — создаём его из auth.users
with target as (
  select id, email
  from auth.users
  where email = 'ksenia@diary.local'
)
insert into public.profiles (id, role, full_name, group_name, login)
select id, 'admin', 'Ксения Андреевна', null, split_part(email, '@', 1)
from target
on conflict (id) do update
  set role = 'admin',
      full_name = 'Ксения Андреевна',
      group_name = null;

-- Проверка:
-- select id, role, full_name, login from public.profiles where role = 'admin';
