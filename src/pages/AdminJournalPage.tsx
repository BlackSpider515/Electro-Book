import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CalendarPlus,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Star,
  Users,
  X,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { JournalTable } from '../components/JournalTable'
import { AssignmentDialog } from '../components/AssignmentDialog'
import { ReviewDrawer } from '../components/ReviewDrawer'
import { Modal } from '../components/Modal'
import { EmptyState, ErrorBox, Spinner } from '../components/Feedback'
import { useToast } from '../context/ToastContext'
import { backend } from '../lib/api'
import type {
  Assignment,
  GradeType,
  Group,
  JournalData,
  JournalEntry,
  Profile,
} from '../lib/types'
import { formatDate } from '../lib/format'
import { gradeLabel, gradeTypeLabel, normalizeGradeType, validateGrade } from '../lib/grades'

interface CellDraft {
  student: Profile
  assignment: Assignment
  entry: JournalEntry | null
}

interface ReviewState {
  submissionId: string
  studentName: string
  assignmentTitle: string
  gradeType: GradeType
}

export function AdminJournalPage() {
  const toast = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [groupName, setGroupName] = useState('')
  const [data, setData] = useState<JournalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [editingAssignment, setEditingAssignment] = useState<Assignment | null>(null)
  const [cell, setCell] = useState<CellDraft | null>(null)
  const [cellBusy, setCellBusy] = useState(false)
  const [cellPoints, setCellPoints] = useState('')
  const [review, setReview] = useState<ReviewState | null>(null)

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
      .finally(() => setGroupsLoading(false))
  }, [])

  useEffect(() => {
    if (groupName) localStorage.setItem('diary_admin_group', groupName)
  }, [groupName])

  const load = useCallback(async () => {
    if (!groupName) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      await backend.submissions.cleanupReviewedFiles().catch(() => undefined)
      const value = await backend.journal(groupName)
      setData(value)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [groupName])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const reviewMeta = useMemo(() => {
    if (!review) return undefined
    return {
      studentName: review.studentName,
      assignmentTitle: review.assignmentTitle,
      groupName,
      gradeType: review.gradeType,
    }
  }, [review, groupName])

  const cellGradeType = normalizeGradeType(cell?.assignment.grade_type)

  const handleCellClick = (
    student: Profile,
    assignment: Assignment,
    entry: JournalEntry | null,
  ) => {
    if (entry?.submission_id) {
      setReview({
        submissionId: entry.submission_id,
        studentName: student.full_name,
        assignmentTitle: assignment.title,
        gradeType: normalizeGradeType(assignment.grade_type),
      })
      return
    }
    setCellPoints(entry?.grade != null ? String(entry.grade) : '')
    setCell({ student, assignment, entry })
  }

  const ensureSubmission = async (): Promise<string | null> => {
    if (!cell) return null
    if (cell.entry?.submission_id) return cell.entry.submission_id
    const created = await backend.submissions.markSubmitted(cell.assignment.id, cell.student.id)
    setCell((current) =>
      current
        ? {
            ...current,
            entry: {
              submission_id: created.id,
              assignment_id: created.assignment_id,
              student_id: created.student_id,
              grade: created.grade,
              status: created.status,
              submitted_at: created.submitted_at,
              annotation_count: 0,
            },
          }
        : current,
    )
    return created.id
  }

  const markSubmitted = async () => {
    if (!cell) return
    setCellBusy(true)
    try {
      await ensureSubmission()
      toast.success('Отметка «+» поставлена')
      setCell(null)
      setCellPoints('')
      setRefreshKey((value) => value + 1)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setCellBusy(false)
    }
  }

  const setCellGrade = async (grade: number) => {
    if (!cell) return
    const message = validateGrade(cell.assignment.grade_type, grade)
    if (message) {
      toast.error(message)
      return
    }
    setCellBusy(true)
    try {
      const submissionId = await ensureSubmission()
      if (!submissionId) throw new Error('Не удалось создать отметку')
      await backend.submissions.setGrade(submissionId, grade)
      toast.success(`Оценка: ${gradeLabel(cell.assignment.grade_type, grade)}`)
      setCell(null)
      setCellPoints('')
      setRefreshKey((value) => value + 1)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setCellBusy(false)
    }
  }

  const deleteAssignment = async (assignment: Assignment) => {
    if (
      !window.confirm(
        `Удалить задание «${assignment.title}»? Вместе с ним удалятся все сданные работы этой группы.`,
      )
    ) {
      return
    }
    try {
      await backend.assignments.remove(assignment.id)
      toast.success('Задание удалено')
      setRefreshKey((value) => value + 1)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <AppShell role="admin">
      <div className="page-head">
        <div>
          <span className="eyebrow">Кабинет преподавателя</span>
          <h1>Журнал {groupName ? `группы ${groupName}` : ''}</h1>
          <p>
            Ксения Андреевна · клик по ячейке открывает работу или позволяет поставить отметку
          </p>
        </div>
        <div className="page-head__actions">
          <label className="group-switch">
            <Users size={16} />
            <span>Группа</span>
            <select
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              disabled={groupsLoading || !groups.length}
              data-testid="admin-group-select"
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
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              setEditingAssignment(null)
              setAssignmentOpen(true)
            }}
            disabled={!groups.length}
            data-testid="add-assignment"
          >
            <CalendarPlus size={16} /> Добавить задание
          </button>
        </div>
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {!groupsLoading && !groups.length ? (
        <EmptyState
          icon={<Users size={30} />}
          title="Сначала создайте группу"
          text="Рапортичка привязана к группе. Добавьте группу, и студенты смогут выбрать её при регистрации."
          action={
            <Link to="/admin/groups" className="btn btn--primary btn--sm">
              <Plus size={15} /> Перейти к группам
            </Link>
          }
        />
      ) : loading && !data ? (
        <Spinner label="Загружаем журнал…" />
      ) : data ? (
        <JournalTable
          data={data}
          groupName={groupName}
          mode="admin"
          onCellClick={handleCellClick}
          onEditAssignment={(assignment) => {
            setEditingAssignment(assignment)
            setAssignmentOpen(true)
          }}
          onDeleteAssignment={deleteAssignment}
          actions={
            <span className="journal-toolbar__hint">
              <Star size={15} /> Система оценивания задаётся в задании
            </span>
          }
        />
      ) : null}

      <AssignmentDialog
        open={assignmentOpen}
        groups={groups}
        defaultGroup={groupName}
        assignment={editingAssignment}
        onClose={() => setAssignmentOpen(false)}
        onSaved={(value) => {
          if (value.group_name !== groupName) setGroupName(value.group_name)
          setRefreshKey((key) => key + 1)
        }}
      />

      <Modal
        open={Boolean(cell)}
        onClose={() => {
          setCell(null)
          setCellPoints('')
        }}
        title="Отметка в журнале"
        subtitle={
          cell
            ? `${cell.student.full_name} · ${cell.assignment.title} · ${formatDate(
                cell.assignment.assigned_date,
              )}`
            : undefined
        }
        size="sm"
      >
        {cell ? (
          <div className="cell-editor">
            <p className="cell-editor__hint">
              Студент ещё не прикреплял файл. Можно поставить «+» вручную или сразу оценку.
              Оценка автоматически создаст отметку о сдаче.
            </p>
            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={markSubmitted}
              disabled={cellBusy}
              data-testid="mark-submitted"
            >
              {cellBusy ? <Loader2 className="spin" size={17} /> : <Check size={17} />}
              Поставить «+» (сдано)
            </button>
            <div className="grade-picker">
              <span>Оценка · {gradeTypeLabel(cellGradeType)}:</span>
              {cellGradeType === 'stars' ? (
                [1, 2, 3, 4, 5].map((grade) => (
                  <button
                    key={grade}
                    type="button"
                    className="grade-picker__btn"
                    onClick={() => setCellGrade(grade)}
                    disabled={cellBusy}
                    title={`Оценка ${grade}`}
                    data-testid={`cell-grade-${grade}`}
                  >
                    {grade} <Star size={14} />
                  </button>
                ))
              ) : cellGradeType === 'pass_fail' ? (
                <>
                  <button
                    type="button"
                    className="grade-picker__btn grade-picker__btn--wide"
                    onClick={() => setCellGrade(1)}
                    disabled={cellBusy}
                    data-testid="cell-grade-pass"
                  >
                    <Check size={14} /> Зачёт
                  </button>
                  <button
                    type="button"
                    className="grade-picker__btn grade-picker__btn--wide"
                    onClick={() => setCellGrade(0)}
                    disabled={cellBusy}
                    data-testid="cell-grade-fail"
                  >
                    <X size={14} /> Незачёт
                  </button>
                </>
              ) : (
                <div className="grade-points-editor grade-points-editor--compact">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={cellPoints}
                    onChange={(event) => setCellPoints(event.target.value)}
                    placeholder="0–100"
                    disabled={cellBusy}
                    data-testid="cell-points-input"
                  />
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => setCellGrade(Number(cellPoints))}
                    disabled={cellBusy || !cellPoints.trim()}
                    data-testid="cell-save-points"
                  >
                    {cellBusy ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                    Поставить
                  </button>
                </div>
              )}
            </div>
            <p className="cell-editor__note">
              Если студент прикрепит файл позже, оценка сохранится, а файл можно будет посмотреть
              в его работе.
            </p>
          </div>
        ) : null}
      </Modal>

      <ReviewDrawer
        open={Boolean(review)}
        submissionId={review?.submissionId ?? null}
        mode="admin"
        meta={reviewMeta}
        onClose={() => setReview(null)}
        onChanged={() => setRefreshKey((value) => value + 1)}
      />
    </AppShell>
  )
}
