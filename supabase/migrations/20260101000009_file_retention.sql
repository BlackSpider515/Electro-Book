-- ============================================================
-- Удаление файлов проверенных работ через 7 дней.
--
-- После выставления оценки файл и все его прошлые версии хранятся
-- ещё 7 дней, затем удаляются из Storage. Строка работы, оценка,
-- замечания и метаданные файла (имя, размер) остаются.
--
-- Выполнить после 20260101000008_grade_types_deadlines.sql.
-- Миграция идемпотентна: её можно запускать повторно.
-- ============================================================

alter table public.submissions
  add column if not exists reviewed_at timestamptz;

alter table public.submissions
  add column if not exists file_deleted_at timestamptz;

alter table public.submission_versions
  add column if not exists file_deleted_at timestamptz;

-- После удаления объекта путь больше не существует.
alter table public.submission_versions
  alter column file_path drop not null;

-- Для работ, оценённых до этой миграции, срок отсчитывается от
-- последнего изменения: ближайшая дата, которую можно восстановить.
update public.submissions
set reviewed_at = coalesce(updated_at, submitted_at)
where grade is not null
  and reviewed_at is null;

create index if not exists submissions_retention_idx
  on public.submissions (reviewed_at)
  where grade is not null and file_deleted_at is null;

-- Преподаватель может пометить файлы версий удалёнными.
grant update on public.submission_versions to authenticated;

drop policy if exists versions_admin_update on public.submission_versions;
create policy versions_admin_update on public.submission_versions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
