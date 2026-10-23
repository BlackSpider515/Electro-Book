import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BookOpenCheck,
  ChevronRight,
  Clock3,
  FileX,
  Filter,
  FolderOpen,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { ReviewDrawer } from '../components/ReviewDrawer'
import { EmptyState, ErrorBox, Spinner } from '../components/Feedback'
import { GradeBadge } from '../components/GradeBadge'
import { useToast } from '../context/ToastContext'
import { backend } from '../lib/api'
import { formatDateTime, formatSize, plural } from '../lib/format'
import { isOverdue } from '../lib/grades'
import type { Assignment, Group, Profile, WorkRow } from '../lib/types'

export function AdminAssignmentsPage() {
  const toast = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [groupName, setGroupName] = useState('')
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [students, setStudents] = useState<Profile[]>([])
  const [rows, setRows] = useState<WorkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [assignmentFilter, setAssignmentFilter] = useState('')
  const [studentFilter, setStudentFilter] = useState('')
  const [search, setSearch] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [review, setReview] = useState<WorkRow | null>(null)

  useEffect(() => {
    backend.groups
      .list()
      .then((list) => {
        setGroups(list)
        setGroupName((current) => {
          if (current && list.some((group) => group.name === current)) return current
          const saved = localStorage.getItem('diary_admin_group')
          if (saved && list.some((group) => group.name === saved)) return saved
          return list[0]?.name ?? ''
        })
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  useEffect(() => {
    if (groupName) localStorage.setItem('diary_admin_group', groupName)
  }, [groupName])

  const load = useCallback(async () => {
    if (!groupName) {
      setRows([])
      setAssignments([])
      setStudents([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      // Срок хранения истёкших файлов проверяем при открытии раздела:
      // отдельного серверного планировщика у статического GitHub Pages нет.
      await backend.submissions.cleanupReviewedFiles().catch(() => undefined)
      const [assignmentList, studentList, workRows] = await Promise.all([
        backend.assignments.list(groupName),
        backend.students(groupName),
        backend.submissions.list(groupName),
      ])
      setAssignments(assignmentList)
      setStudents(studentList)
      setRows(workRows)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [groupName])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useEffect(() => {
    setAssignmentFilter('')
    setStudentFilter('')
    setSearch('')
  }, [groupName])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (assignmentFilter && row.assignment.id !== assignmentFilter) return false
      if (studentFilter && row.student.id !== studentFilter) return false
      if (query) {
        const haystack = `${row.student.full_name} ${row.assignment.title} ${
          row.submission.original_name ?? ''
        }`.toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
  }, [rows, assignmentFilter, studentFilter, search])

  const reviewMeta = review
    ? {
        studentName: review.student.full_name,
        assignmentTitle: review.assignment.title,
        groupName,
        gradeType: review.assignment.grade_type,
      }
    : undefined

  return (
    <AppShell role="admin">
      <div className="page-head">
        <div>
          <span className="eyebrow">Проверка работ</span>
          <h1>Задания группы {groupName || '—'}</h1>
          <p>Ксения Андреевна · последние отправленные работы сверху</p>
        </div>
        <div className="page-head__actions">
          <label className="group-switch">
            <Users size={16} />
            <span>Группа</span>
            <select
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              disabled={!groups.length}
              data-testid="admin-works-group-select"
            >
              {!groups.length ? <option value="">Нет групп</option> : null}
              {groups.map((group) => (
                <option key={group.name} value={group.name}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'spin' : ''} size={16} /> Обновить
          </button>
          <Link to="/admin/journal" className="btn btn--primary btn--sm">
            <BookOpenCheck size={16} /> К журналу
          </Link>
        </div>
      </div>

      {!groups.length ? (
        <EmptyState
          icon={<Users size={30} />}
          title="Нет групп"
          text="Создайте группу — после этого студенты смогут регистрироваться и сдавать работы."
          action={
            <Link to="/admin/groups" className="btn btn--primary btn--sm">
              Создать группу
            </Link>
          }
        />
      ) : (
        <>
          <div className="works-stats">
            <div>
              <strong>{rows.length}</strong>
              <span>{plural(rows.length, ['работа', 'работы', 'работ'])}</span>
            </div>
            <div>
              <strong>{rows.filter((row) => row.submission.grade != null).length}</strong>
              <span>оценено</span>
            </div>
            <div>
              <strong>{assignments.length}</strong>
              <span>{plural(assignments.length, ['задание', 'задания', 'заданий'])}</span>
            </div>
            <div>
              <strong>{students.length}</strong>
              <span>{plural(students.length, ['студент', 'студента', 'студентов'])}</span>
            </div>
          </div>

          <div className="works-filter">
            <span className="works-filter__label">
              <Filter size={15} /> Фильтры
            </span>
            <label className="filter-field">
              <span>Задание</span>
              <select
                value={assignmentFilter}
                onChange={(event) => setAssignmentFilter(event.target.value)}
                data-testid="filter-assignment"
              >
                <option value="">Все задания</option>
                {assignments.map((assignment) => (
                  <option key={assignment.id} value={assignment.id}>
                    {assignment.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Студент</span>
              <select
                value={studentFilter}
                onChange={(event) => setStudentFilter(event.target.value)}
                data-testid="filter-student"
              >
                <option value="">Все студенты</option>
                {students.map((student) => (
                  <option key={student.id} value={student.id}>
                    {student.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field filter-field--search">
              <span>Поиск</span>
              <div className="input-with-icon">
                <Search size={15} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="ФИО или файл"
                />
              </div>
            </label>
          </div>

          {error ? <ErrorBox>{error}</ErrorBox> : null}

          {loading && !rows.length ? (
            <Spinner label="Загружаем сданные работы…" />
          ) : filtered.length ? (
            <div className="works-table-wrap">
              <table className="works-table">
                <thead>
                  <tr>
                    <th>Студент</th>
                    <th>Задание</th>
                    <th>Файл</th>
                    <th>Отправлено</th>
                    <th>Оценка</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr
                      key={row.submission.id}
                      onClick={() => setReview(row)}
                      className="is-clickable"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') setReview(row)
                      }}
                    >
                      <td>
                        <strong>{row.student.full_name}</strong>
                        <span className="muted">группа {row.student.group_name}</span>
                      </td>
                      <td>
                        <span>{row.assignment.title}</span>
                        <span className="muted">
                          выдано {row.assignment.assigned_date} · {row.assignment.lesson_number} пара
                        </span>
                        {row.assignment.due_at ? (
                          <span
                            className={`works-due ${
                              isOverdue(row.assignment.due_at) ? 'is-overdue' : ''
                            }`}
                          >
                            до {formatDateTime(row.assignment.due_at)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span
                          className={`works-file ${
                            row.submission.file_deleted_at ? 'works-file--deleted' : ''
                          }`}
                        >
                          {row.submission.file_deleted_at ? (
                            <FileX size={15} />
                          ) : (
                            <FolderOpen size={15} />
                          )}
                          {row.submission.original_name || 'без файла'}
                        </span>
                        <span className="muted">
                          {row.submission.file_deleted_at
                            ? 'удалён после проверки'
                            : formatSize(row.submission.size)}
                        </span>
                      </td>
                      <td>
                        <span>{formatDateTime(row.submission.submitted_at)}</span>
                        <span className="muted">версия {row.submission.version}</span>
                      </td>
                      <td>
                        {row.submission.grade != null ? (
                          <GradeBadge
                            grade={row.submission.grade}
                            type={row.assignment.grade_type}
                            size={14}
                          />
                        ) : (
                          <span className="status-pill status-pill--sent">
                            <Clock3 size={13} /> На проверке
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            setReview(row)
                          }}
                        >
                          Проверить <ChevronRight size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<BookOpenCheck size={30} />}
              title={rows.length ? 'Ничего не найдено' : 'Работ пока нет'}
              text={
                rows.length
                  ? 'Измените фильтр или поисковый запрос.'
                  : students.length
                    ? 'Студенты группы ещё не загрузили работы. Как только сдадут — они появятся здесь.'
                    : 'В группе пока нет студентов. Они появятся после регистрации с выбором этой группы.'
              }
              action={
                rows.length ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setAssignmentFilter('')
                      setStudentFilter('')
                      setSearch('')
                    }}
                  >
                    Сбросить фильтры
                  </button>
                ) : undefined
              }
            />
          )}
        </>
      )}

      <ReviewDrawer
        open={Boolean(review)}
        submissionId={review?.submission.id ?? null}
        mode="admin"
        meta={reviewMeta}
        onClose={() => setReview(null)}
        onChanged={() => {
          setRefreshKey((value) => value + 1)
          toast.notify('Данные работы обновлены')
        }}
      />
    </AppShell>
  )
}
