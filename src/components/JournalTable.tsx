import { useMemo, useState } from 'react'
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarDays,
  Clock3,
  Pencil,
  Plus,
  Trash2,
  Trophy,
  UserRoundPlus,
} from 'lucide-react'
import type { Assignment, JournalData, JournalEntry, Profile } from '../lib/types'
import { defaultSubject } from '../lib/supabase'
import { formatDate, formatDateShort, formatDateTime } from '../lib/format'
import { gradeLabel, gradeRatio, isOverdue } from '../lib/grades'
import { GradeBadge } from './GradeBadge'

type SortMode = 'name-asc' | 'name-desc' | 'performance'

interface JournalTableProps {
  data: JournalData
  groupName: string
  mode: 'student' | 'admin'
  currentStudentId?: string
  onOpenSubmission?: (submissionId: string) => void
  onSubmitAssignment?: (assignment: Assignment) => void
  onCellClick?: (student: Profile, assignment: Assignment, entry: JournalEntry | null) => void
  onEditAssignment?: (assignment: Assignment) => void
  onDeleteAssignment?: (assignment: Assignment) => void
  actions?: React.ReactNode
}

function splitName(fullName: string): { surname: string; rest: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { surname: fullName, rest: '' }
  return {
    surname: parts[0],
    rest: parts
      .slice(1)
      .map((part) => `${part[0]}.`)
      .join(' '),
  }
}

function entryKey(assignmentId: string, studentId: string): string {
  return `${assignmentId}:${studentId}`
}

export function JournalTable({
  data,
  groupName,
  mode,
  currentStudentId,
  onOpenSubmission,
  onSubmitAssignment,
  onCellClick,
  onEditAssignment,
  onDeleteAssignment,
  actions,
}: JournalTableProps) {
  const [sortMode, setSortMode] = useState<SortMode>('name-asc')

  const entryMap = useMemo(() => {
    const map = new Map<string, JournalEntry>()
    for (const entry of data.entries) {
      map.set(entryKey(entry.assignment_id, entry.student_id), entry)
    }
    return map
  }, [data.entries])

  const assignmentMap = useMemo(() => {
    const map = new Map<string, Assignment>()
    for (const assignment of data.assignments) map.set(assignment.id, assignment)
    return map
  }, [data.assignments])

  const statsByStudent = useMemo(() => {
    const map = new Map<string, { submitted: number; graded: number; sum: number }>()
    for (const student of data.students) {
      map.set(student.id, { submitted: 0, graded: 0, sum: 0 })
    }
    for (const entry of data.entries) {
      const stat = map.get(entry.student_id)
      if (!stat) continue
      stat.submitted += 1
      if (entry.grade != null) {
        const assignment = assignmentMap.get(entry.assignment_id)
        stat.graded += 1
        stat.sum += gradeRatio(assignment?.grade_type, entry.grade)
      }
    }
    return map
  }, [data.entries, data.students, assignmentMap])

  const students = useMemo(() => {
    const list = [...data.students]
    if (sortMode === 'name-asc') {
      list.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
    } else if (sortMode === 'name-desc') {
      list.sort((a, b) => b.full_name.localeCompare(a.full_name, 'ru'))
    } else {
      list.sort((a, b) => {
        const sa = statsByStudent.get(a.id) ?? { submitted: 0, graded: 0, sum: 0 }
        const sb = statsByStudent.get(b.id) ?? { submitted: 0, graded: 0, sum: 0 }
        const avgA = sa.graded ? sa.sum / sa.graded : 0
        const avgB = sb.graded ? sb.sum / sb.graded : 0
        if (avgA !== avgB) return avgB - avgA
        if (sa.submitted !== sb.submitted) return sb.submitted - sa.submitted
        return a.full_name.localeCompare(b.full_name, 'ru')
      })
    }
    return list
  }, [data.students, sortMode, statsByStudent])

  const totalCells = students.length * data.assignments.length
  const totalSubmitted = data.entries.length

  const handleCell = (
    student: Profile,
    assignment: Assignment,
    entry: JournalEntry | null,
  ) => {
    if (mode === 'admin') {
      onCellClick?.(student, assignment, entry)
      return
    }
    if (student.id !== currentStudentId) return
    if (entry?.submission_id) {
      onOpenSubmission?.(entry.submission_id)
    } else {
      onSubmitAssignment?.(assignment)
    }
  }

  return (
    <section className="journal-card">
      <header className="journal-card__head">
        <div className="journal-card__title">
          <div>
            <span className="eyebrow">Рапортичка</span>
            <h2>{data.assignments[0]?.subject || defaultSubject}</h2>
            <p>
              Группа <strong>{groupName || '—'}</strong> · преподаватель Ксения
              Андреевна
            </p>
          </div>
        </div>
        <div className="journal-card__stats">
          <span>
            <b>{students.length}</b> студ.
          </span>
          <span>
            <b>{data.assignments.length}</b> заданий
          </span>
          <span>
            <b>{totalSubmitted}</b> из <b>{totalCells}</b> сдано
          </span>
        </div>
      </header>

      <div className="journal-toolbar">
        <div className="sort-control" role="group" aria-label="Сортировка студентов">
          <button
            type="button"
            className={sortMode === 'name-asc' ? 'is-active' : ''}
            onClick={() => setSortMode('name-asc')}
            title="По фамилии А→Я"
          >
            <ArrowDownAZ size={16} /> А→Я
          </button>
          <button
            type="button"
            className={sortMode === 'name-desc' ? 'is-active' : ''}
            onClick={() => setSortMode('name-desc')}
            title="По фамилии Я→А"
          >
            <ArrowUpAZ size={16} /> Я→А
          </button>
          <button
            type="button"
            className={sortMode === 'performance' ? 'is-active' : ''}
            onClick={() => setSortMode('performance')}
            title="Отличники первыми"
          >
            <Trophy size={16} /> По успеваемости
          </button>
        </div>
        {actions ? <div className="journal-toolbar__actions">{actions}</div> : null}
      </div>

      {!students.length ? (
        <div className="journal-notice" data-testid="journal-empty-students">
          <span className="journal-notice__icon">
            <UserRoundPlus size={20} />
          </span>
          <div>
            <strong>В группе пока нет студентов</strong>
            <p>
              Рапортичка заполнится автоматически: студенты появятся здесь после регистрации с
              выбором этой группы.
            </p>
          </div>
        </div>
      ) : null}

      <div className="journal-scroll">
        <table className="journal-table">
          <thead>
            <tr>
              <th className="task-col">Задание</th>
              {students.map((student) => {
                const stat = statsByStudent.get(student.id)
                const isOwn = student.id === currentStudentId
                const { surname, rest } = splitName(student.full_name)
                return (
                  <th
                    key={student.id}
                    className={`student-col ${isOwn ? 'is-own' : ''}`}
                    title={student.full_name}
                  >
                    <span className="student-col__name">{surname}</span>
                    <span className="student-col__rest">{rest}</span>
                    <span className="student-col__count">{stat?.submitted ?? 0} сдано</span>
                    {isOwn ? <span className="student-col__you">вы</span> : null}
                  </th>
                )
              })}
              <th className="date-col">
                <CalendarDays size={14} /> Выдано
              </th>
            </tr>
          </thead>
          <tbody>
            {data.assignments.length === 0 ? (
              <tr>
                <td className="journal-placeholder" colSpan={students.length + 2}>
                  Заданий пока нет. {mode === 'admin' ? 'Добавьте первое задание.' : 'Скоро появятся.'}
                </td>
              </tr>
            ) : null}
            {data.assignments.map((assignment, rowIndex) => (
              <tr key={assignment.id}>
                <th className="task-col" scope="row">
                  <div className="task-cell">
                    <span className="task-cell__index">{String(rowIndex + 1).padStart(2, '0')}</span>
                    <div className="task-cell__text">
                      <span className="task-cell__title" title={assignment.title}>
                        {assignment.title}
                      </span>
                      {assignment.description ? (
                        <span className="task-cell__desc">{assignment.description}</span>
                      ) : null}
                      {assignment.due_at ? (
                        <span
                          className={`task-cell__due ${
                            isOverdue(assignment.due_at) ? 'is-overdue' : ''
                          }`}
                          title={`Дедлайн: ${formatDateTime(assignment.due_at)}`}
                        >
                          <Clock3 size={11} /> до {formatDateTime(assignment.due_at)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </th>
                {students.map((student) => {
                  const entry = entryMap.get(entryKey(assignment.id, student.id)) ?? null
                  const isOwn = student.id === currentStudentId
                  const isAdmin = mode === 'admin'
                  const canSubmit = !isAdmin && isOwn && !entry
                  const overdue = isOverdue(assignment.due_at)
                  const showUrgent = overdue && !entry && (isAdmin || isOwn)
                  const hasRemarks = Boolean(
                    entry &&
                      entry.grade == null &&
                      entry.annotation_count > 0 &&
                      (isAdmin || isOwn),
                  )
                  return (
                    <td
                      key={student.id}
                      className={`journal-cell ${isOwn ? 'is-own' : ''} ${
                        isAdmin || (isOwn && (entry || canSubmit)) ? 'is-clickable' : ''
                      }`}
                      onClick={() => handleCell(student, assignment, entry)}
                      title={
                        showUrgent
                          ? `Дедлайн прошёл: ${formatDateTime(assignment.due_at)}`
                          : hasRemarks
                            ? `Замечаний: ${entry?.annotation_count ?? 0} — нужно исправить`
                            : isAdmin
                              ? 'Изменить отметку'
                              : canSubmit
                                ? 'Сдать работу'
                                : entry?.grade != null
                                  ? `Оценка: ${gradeLabel(
                                      assignment.grade_type,
                                      entry.grade,
                                    )}`
                                  : entry
                                    ? 'Работа сдана'
                                    : ''
                      }
                    >
                      {entry ? (
                        hasRemarks ? (
                          <span className="journal-cell__status">
                            {entry.grade != null ? (
                              <GradeBadge
                                grade={entry.grade}
                                type={assignment.grade_type}
                                variant="cell"
                              />
                            ) : null}
                            <span
                              className="revise-cell"
                              data-testid={`revise-cell-${assignment.id}-${student.id}`}
                            >
                              Исправить
                            </span>
                          </span>
                        ) : entry.grade != null ? (
                          <GradeBadge
                            grade={entry.grade}
                            type={assignment.grade_type}
                            variant="cell"
                          />
                        ) : (
                          <span className="mark-plus">+</span>
                        )
                      ) : showUrgent ? (
                        <span
                          className="urgent-cell"
                          data-testid={`urgent-cell-${assignment.id}-${student.id}`}
                        >
                          Срочно сдать!
                        </span>
                      ) : canSubmit ? (
                        <button
                          type="button"
                          className="submit-cell-btn"
                          onClick={(event) => {
                            event.stopPropagation()
                            onSubmitAssignment?.(assignment)
                          }}
                          data-testid={`submit-cell-${assignment.id}`}
                        >
                          <Plus size={13} /> Сдать
                        </button>
                      ) : (
                        <span className="cell-empty" aria-label="Не сдано" />
                      )}
                    </td>
                  )
                })}
                <td className="date-col">
                  <div className="date-cell">
                    <span className="date-cell__date" title={formatDate(assignment.assigned_date)}>
                      {formatDateShort(assignment.assigned_date)}
                    </span>
                    <span className="lesson-chip" title={`${assignment.lesson_number} пара`}>
                      {assignment.lesson_number}
                    </span>
                    {mode === 'admin' ? (
                      <span className="date-cell__actions">
                        <button
                          type="button"
                          className="mini-icon-btn"
                          title="Редактировать задание"
                          aria-label="Редактировать задание"
                          onClick={() => onEditAssignment?.(assignment)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="mini-icon-btn mini-icon-btn--danger"
                          title="Удалить задание"
                          aria-label="Удалить задание"
                          onClick={() => onDeleteAssignment?.(assignment)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="journal-legend">
        <span>
          <b className="mark-plus">+</b> сдано
        </span>
        <span>
          <span className="revise-cell">Исправить</span> есть замечания
        </span>
        <span>
          <GradeBadge grade={5} type="stars" size={13} variant="cell" /> оценки 1–5
        </span>
        <span>
          <GradeBadge grade={1} type="pass_fail" variant="cell" /> зачёт
        </span>
        <span>
          <GradeBadge grade={87} type="points" variant="cell" /> баллы 0–100
        </span>
        <span className="cell-empty" /> не сдано
        {mode === 'admin' ? <span className="muted">Клик по ячейке — редактирование</span> : null}
        {mode === 'student' ? (
          <span className="muted">Ваш столбец подсвечен · журнал можно прокручивать</span>
        ) : null}
      </footer>
    </section>
  )
}
