import type {
  Annotation,
  Assignment,
  Group,
  JournalData,
  NewAssignment,
  Profile,
  StudentCredentials,
  Submission,
  SubmissionVersion,
  UploadProgress,
  WorkRow,
} from '../types'
import type { AnnotationInput, Backend, SubmissionFilters } from '../backend'
import {
  clearDemoFiles,
  coerceProfile,
  deleteDemoFile,
  demoId,
  getDemoFile,
  getSessionProfile,
  loadDb,
  patchDb,
  putDemoFile,
  resetDb,
  saveDb,
} from './demoDb'
import { extensionOf, fileKind, safeMime, sanitizeFileName } from '../fileTypes'
import { defaultSubject } from '../supabase'
import { validateGrade } from '../grades'
import { isReviewRetentionExpired } from '../retention'

const listeners = new Set<(profile: Profile | null) => void>()

function emit(): void {
  const profile = getSessionProfile()
  for (const listener of listeners) listener(profile)
}

function requireSession(): Profile {
  const profile = getSessionProfile()
  if (!profile) throw new Error('Нужно войти в дневник')
  return profile
}

function requireAdmin(): Profile {
  const profile = requireSession()
  if (profile.role !== 'admin') throw new Error('Действие доступно только преподавателю')
  return profile
}

function requireStudent(): Profile {
  const profile = requireSession()
  if (profile.role !== 'student') throw new Error('Действие доступно только студенту')
  return profile
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ru-RU') === b.trim().toLocaleLowerCase('ru-RU')
}

function randomPassword(length = 10): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function translit(value: string): string {
  return value
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? (/[a-z0-9]/.test(ch) ? ch : ''))
    .join('')
    .replace(/[^a-z0-9]/g, '')
}

function makeLogin(fullName: string, existing: string[]): string {
  const base = translit(fullName.split(' ')[0]).slice(0, 12) || 'student'
  const used = new Set(existing.map((login) => login.toLowerCase()))
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `student${Date.now().toString().slice(-8)}`
}

async function simulateProgress(onProgress?: UploadProgress): Promise<void> {
  if (!onProgress) return
  const steps = [12, 28, 47, 66, 82, 94]
  for (const value of steps) {
    await new Promise((resolve) => setTimeout(resolve, 55))
    onProgress(value)
  }
}

function ensureAssignmentForStudent(db: ReturnType<typeof loadDb>, assignmentId: string, student: Profile): Assignment {
  const assignment = db.assignments.find((a) => a.id === assignmentId)
  if (!assignment) throw new Error('Задание не найдено')
  if (assignment.group_name !== student.group_name) {
    throw new Error('Это задание другой группы')
  }
  return assignment
}

async function storeFile(
  profile: Profile,
  assignmentId: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<{ path: string; name: string; mime: string; size: number; version: number; existing: Submission | null }> {
  if (profile.role !== 'student') throw new Error('Загружать работу может только студент')
  const db = loadDb()
  ensureAssignmentForStudent(db, assignmentId, profile)

  const existing =
    db.submissions.find((s) => s.assignment_id === assignmentId && s.student_id === profile.id) ?? null
  if (existing?.grade != null) {
    throw new Error('Работа уже оценена — заменить файл больше нельзя')
  }

  const ext = extensionOf(file.name)
  if (!ext) throw new Error('У файла нет расширения')
  const path = `${profile.id}/${assignmentId}/${demoId()}.${ext}`
  await putDemoFile(path, file)
  await simulateProgress(onProgress)
  onProgress?.(100)

  return {
    path,
    name: sanitizeFileName(file.name),
    mime: safeMime(file),
    size: file.size,
    version: (existing?.version ?? 0) + 1,
    existing,
  }
}

function latestVersionTime(db: ReturnType<typeof loadDb>, submissionId: string): number {
  let latest = 0
  for (const version of db.versions) {
    if (version.submission_id !== submissionId) continue
    const time = new Date(version.created_at).getTime()
    if (!Number.isNaN(time) && time > latest) latest = time
  }
  return latest
}

function activeAnnotationCount(db: ReturnType<typeof loadDb>, submissionId: string): number {
  const latestVersion = latestVersionTime(db, submissionId)
  let count = 0
  for (const annotation of db.annotations) {
    if (annotation.submission_id !== submissionId) continue
    const time = new Date(annotation.created_at).getTime()
    if (Number.isNaN(time) || time > latestVersion) count += 1
  }
  return count
}

function rowFor(submission: Submission, db: ReturnType<typeof loadDb>): WorkRow | null {  const assignment = db.assignments.find((a) => a.id === submission.assignment_id)
  const student = db.users.find((u) => u.profile.id === submission.student_id)?.profile
  if (!assignment || !student) return null
  return {
    submission,
    assignment,
    student: { id: student.id, full_name: student.full_name, group_name: student.group_name },
  }
}

export const demoBackend: Backend = {
  mode: 'demo',

  auth: {
    async getProfile() {
      return getSessionProfile()
    },
    onAuthChange(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    async signIn(login, password) {
      const db = loadDb()
      const normalized = login.trim().toLowerCase()
      const user = db.users.find(
        (u) => u.login.toLowerCase() === normalized && u.password === password,
      )
      if (!user) throw new Error('Неверный логин или пароль')
      db.sessionLogin = user.login
      saveDb()
      emit()
      return coerceProfile(user.profile)
    },
    async signOut() {
      const db = loadDb()
      db.sessionLogin = null
      saveDb()
      emit()
    },
    async register(fullName, groupName): Promise<StudentCredentials> {
      const db = loadDb()
      const name = normalizeName(fullName)
      const group = groupName.trim()
      if (name.length < 5 || !/^[А-Яа-яЁёA-Za-z\s-]+$/.test(name) || name.split(' ').length < 2) {
        throw new Error('Укажите ФИО полностью (только буквы, пробелы и дефис)')
      }
      if (!db.groups.some((g) => g.name === group)) {
        throw new Error('Такой группы не существует')
      }
      const duplicate = db.users.some(
        (u) =>
          u.profile.role === 'student' &&
          u.profile.group_name === group &&
          sameName(u.profile.full_name, name),
      )
      if (duplicate) {
        throw new Error(
          'Студент с таким ФИО уже зарегистрирован в этой группе. Войдите со своими логином и паролем.',
        )
      }
      const login = makeLogin(name, db.users.map((u) => u.login))
      const password = randomPassword()
      const profile: Profile = {
        id: demoId(),
        role: 'student',
        full_name: name,
        group_name: group,
        created_at: new Date().toISOString(),
      }
      db.users.push({ login, password, profile })
      saveDb()
      return { login, password, fullName: name, groupName: group }
    },
  },

  groups: {
    async list(): Promise<Group[]> {
      return [...loadDb().groups].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    },
    async create(name: string) {
      requireAdmin()
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 20) {
        throw new Error('Название группы должно быть длиной от 1 до 20 символов')
      }
      const db = loadDb()
      if (db.groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error('Такая группа уже существует')
      }
      const group: Group = { name: trimmed, created_at: new Date().toISOString() }
      db.groups.push(group)
      saveDb()
      return group
    },
    async rename(oldName: string, newName: string) {
      requireAdmin()
      const trimmed = newName.trim()
      if (!trimmed || trimmed.length > 20) {
        throw new Error('Название группы должно быть длиной от 1 до 20 символов')
      }
      const db = loadDb()
      if (!db.groups.some((g) => g.name === oldName)) throw new Error('Группа не найдена')
      if (oldName === trimmed) return
      if (db.groups.some((g) => g.name === trimmed)) throw new Error('Группа уже существует')
      const group = db.groups.find((g) => g.name === oldName)
      if (group) group.name = trimmed
      for (const user of db.users) {
        if (user.profile.group_name === oldName) user.profile.group_name = trimmed
      }
      for (const assignment of db.assignments) {
        if (assignment.group_name === oldName) assignment.group_name = trimmed
      }
      saveDb()
    },
    async remove(name: string) {
      requireAdmin()
      const db = loadDb()
      if (!db.groups.some((g) => g.name === name)) throw new Error('Группа не найдена')
      if (
        db.users.some(
          (u) => u.profile.role === 'student' && u.profile.group_name === name,
        )
      ) {
        throw new Error(
          'В группе есть студенты. Удалить её можно только после того, как студентов переведут или удалят.',
        )
      }

      const assignmentIds = new Set(
        db.assignments.filter((a) => a.group_name === name).map((a) => a.id),
      )
      const submissions = db.submissions.filter((s) => assignmentIds.has(s.assignment_id))
      for (const submission of submissions) {
        if (submission.file_path) await deleteDemoFile(submission.file_path)
      }
      const submissionIds = new Set(submissions.map((s) => s.id))
      for (const version of db.versions.filter((v) => submissionIds.has(v.submission_id))) {
        if (version.file_path) await deleteDemoFile(version.file_path)
      }

      db.groups = db.groups.filter((g) => g.name !== name)
      db.assignments = db.assignments.filter((a) => a.group_name !== name)
      db.submissions = db.submissions.filter((s) => !submissionIds.has(s.id))
      db.versions = db.versions.filter((v) => !submissionIds.has(v.submission_id))
      db.annotations = db.annotations.filter((a) => !submissionIds.has(a.submission_id))
      saveDb()
    },
  },

  async students(groupName: string) {
    const profile = requireSession()
    if (profile.role !== 'admin' && profile.group_name !== groupName) {
      throw new Error('Можно смотреть только свою группу')
    }
    return loadDb()
      .users.filter((u) => u.profile.role === 'student' && u.profile.group_name === groupName)
      .map((u) => coerceProfile(u.profile))
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
  },

  assignments: {
    async list(groupName: string) {
      requireSession()
      return loadDb()
        .assignments.filter((a) => a.group_name === groupName)
        .sort((a, b) => {
          if (a.assigned_date !== b.assigned_date) return a.assigned_date.localeCompare(b.assigned_date)
          return a.lesson_number - b.lesson_number
        })
    },
    async create(input: NewAssignment) {
      requireAdmin()
      const db = loadDb()
      if (!db.groups.some((g) => g.name === input.group_name)) throw new Error('Группа не найдена')
      const assignment: Assignment = {
        id: demoId(),
        title: input.title.trim(),
        description: input.description.trim(),
        group_name: input.group_name,
        subject: input.subject?.trim() || defaultSubject,
        grade_type: input.grade_type || 'stars',
        assigned_date: input.assigned_date,
        lesson_number: input.lesson_number,
        due_at: input.due_at || null,
        created_at: new Date().toISOString(),
      }
      if (!assignment.title) throw new Error('Введите название задания')
      db.assignments.push(assignment)
      saveDb()
      return assignment
    },
    async update(id: string, input: NewAssignment) {
      requireAdmin()
      const db = loadDb()
      const assignment = db.assignments.find((a) => a.id === id)
      if (!assignment) throw new Error('Задание не найдено')
      if (!input.title.trim()) throw new Error('Введите название задания')
      const nextGradeType = input.grade_type || 'stars'
      const currentGradeType = assignment.grade_type || 'stars'
      if (
        nextGradeType !== currentGradeType &&
        db.submissions.some((s) => s.assignment_id === id && s.grade != null)
      ) {
        throw new Error('Нельзя менять систему оценивания после выставления оценок')
      }
      assignment.title = input.title.trim()
      assignment.description = input.description.trim()
      assignment.group_name = input.group_name
      if (input.subject) assignment.subject = input.subject
      assignment.grade_type = nextGradeType
      assignment.assigned_date = input.assigned_date
      assignment.lesson_number = input.lesson_number
      assignment.due_at = input.due_at || null
      saveDb()
      return { ...assignment }
    },
    async remove(id: string) {
      requireAdmin()
      const db = loadDb()
      const submissions = db.submissions.filter((s) => s.assignment_id === id)
      for (const submission of submissions) {
        if (submission.file_path) await deleteDemoFile(submission.file_path)
      }
      const submissionIds = new Set(submissions.map((s) => s.id))
      for (const version of db.versions.filter((v) => submissionIds.has(v.submission_id))) {
        if (version.file_path) await deleteDemoFile(version.file_path)
      }
      db.submissions = db.submissions.filter((s) => s.assignment_id !== id)
      db.versions = db.versions.filter((v) => !submissionIds.has(v.submission_id))
      db.annotations = db.annotations.filter((a) => !submissionIds.has(a.submission_id))
      db.assignments = db.assignments.filter((a) => a.id !== id)
      saveDb()
    },
  },

  async journal(groupName?: string): Promise<JournalData> {
    const profile = requireSession()
    const db = loadDb()
    const group =
      profile.role === 'admin' ? groupName ?? db.groups[0]?.name ?? '' : profile.group_name ?? ''
    const students = db.users
      .filter((u) => u.profile.role === 'student' && u.profile.group_name === group)
      .map((u) => coerceProfile(u.profile))
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
    const assignments = db.assignments
      .filter((a) => a.group_name === group)
      .sort((a, b) => {
        if (a.assigned_date !== b.assigned_date) return a.assigned_date.localeCompare(b.assigned_date)
        return a.lesson_number - b.lesson_number
      })
    const studentIds = new Set(students.map((s) => s.id))
    const entries = db.submissions
      .filter((s) => studentIds.has(s.student_id))
      .map((s) => ({
        submission_id: s.id,
        assignment_id: s.assignment_id,
        student_id: s.student_id,
        grade: s.grade,
        status: s.status,
        submitted_at: s.submitted_at,
        annotation_count: s.grade == null ? activeAnnotationCount(db, s.id) : 0,
      }))
    return { assignments, students, entries }
  },

  submissions: {
    async mine() {
      const profile = requireStudent()
      return loadDb().submissions.filter((s) => s.student_id === profile.id)
    },
    async list(groupName: string, filters: SubmissionFilters = {}): Promise<WorkRow[]> {
      requireAdmin()
      const db = loadDb()
      const groupAssignments = new Set(
        db.assignments.filter((a) => a.group_name === groupName).map((a) => a.id),
      )
      return db.submissions
        .filter((s) => groupAssignments.has(s.assignment_id))
        .filter((s) => !filters.assignmentId || s.assignment_id === filters.assignmentId)
        .filter((s) => !filters.studentId || s.student_id === filters.studentId)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
        .map((s) => rowFor(s, db))
        .filter((row): row is WorkRow => row !== null)
    },
    async get(id: string) {
      const profile = requireSession()
      const submission = loadDb().submissions.find((s) => s.id === id)
      if (!submission) throw new Error('Работа не найдена')
      if (profile.role !== 'admin' && submission.student_id !== profile.id) {
        throw new Error('Нет доступа к этой работе')
      }
      return { ...submission }
    },
    async upload(assignmentId: string, file: File) {
      const profile = requireStudent()
      const stored = await storeFile(profile, assignmentId, file)
      const db = loadDb()
      const timestamp = new Date().toISOString()
      let submission: Submission
      if (stored.existing) {
        submission = stored.existing
        submission.file_path = stored.path
        submission.original_name = stored.name
        submission.mime = stored.mime
        submission.size = stored.size
        submission.version = stored.version
        submission.status = 'submitted'
        submission.submitted_at = timestamp
        submission.reviewed_at = null
        submission.file_deleted_at = null
        submission.updated_at = timestamp
      } else {
        submission = {
          id: demoId(),
          assignment_id: assignmentId,
          student_id: profile.id,
          file_path: stored.path,
          original_name: stored.name,
          mime: stored.mime,
          size: stored.size,
          submitted_at: timestamp,
          grade: null,
          status: 'submitted',
          version: stored.version,
          reviewed_at: null,
          file_deleted_at: null,
          updated_at: timestamp,
        }
        db.submissions.push(submission)
      }
      db.versions.push({
        id: demoId(),
        submission_id: submission.id,
        file_path: stored.path,
        original_name: stored.name,
        mime: stored.mime,
        size: stored.size,
        version: stored.version,
        created_at: timestamp,
        file_deleted_at: null,
      })
      saveDb()
      return { ...submission }
    },
    async replace(submissionId: string, file: File) {
      const profile = requireStudent()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) throw new Error('Работа не найдена')
      if (submission.student_id !== profile.id) throw new Error('Это чужая работа')
      return demoBackend.submissions.upload(submission.assignment_id, file)
    },
    async setGrade(submissionId: string, grade: number | null) {
      requireAdmin()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) throw new Error('Работа не найдена')
      const assignment = db.assignments.find((a) => a.id === submission.assignment_id)
      const message = validateGrade(assignment?.grade_type, grade)
      if (message) throw new Error(message)
      if (
        grade != null &&
        submission.grade == null &&
        activeAnnotationCount(db, submissionId) > 0
      ) {
        throw new Error(
          'Сначала исправьте замечания: пока они активны, оценку ставить нельзя',
        )
      }
      submission.grade = grade
      submission.status = grade != null ? 'reviewed' : 'submitted'
      submission.reviewed_at = grade != null ? new Date().toISOString() : null
      submission.updated_at = new Date().toISOString()
      saveDb()
    },
    async markSubmitted(assignmentId: string, studentId: string) {
      requireAdmin()
      const db = loadDb()
      const existing = db.submissions.find(
        (s) => s.assignment_id === assignmentId && s.student_id === studentId,
      )
      if (existing) return { ...existing }
      const assignment = db.assignments.find((a) => a.id === assignmentId)
      if (!assignment) throw new Error('Задание не найдено')
      const timestamp = new Date().toISOString()
      const submission: Submission = {
        id: demoId(),
        assignment_id: assignmentId,
        student_id: studentId,
        file_path: null,
        original_name: null,
        mime: null,
        size: null,
        submitted_at: timestamp,
        grade: null,
        status: 'submitted',
        version: 1,
        reviewed_at: null,
        file_deleted_at: null,
        updated_at: timestamp,
      }
      db.submissions.push(submission)
      saveDb()
      return { ...submission }
    },
    async remove(submissionId: string) {
      requireAdmin()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) return
      if (submission.file_path) await deleteDemoFile(submission.file_path)
      const versions = db.versions.filter((v) => v.submission_id === submissionId)
      for (const version of versions) {
        if (version.file_path) await deleteDemoFile(version.file_path)
      }
      db.submissions = db.submissions.filter((s) => s.id !== submissionId)
      db.versions = db.versions.filter((v) => v.submission_id !== submissionId)
      db.annotations = db.annotations.filter((a) => a.submission_id !== submissionId)
      saveDb()
    },
    async versions(submissionId: string) {
      const profile = requireSession()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) throw new Error('Работа не найдена')
      if (profile.role !== 'admin' && submission.student_id !== profile.id) {
        throw new Error('Нет доступа')
      }
      return db.versions
        .filter((v) => v.submission_id === submissionId)
        .sort((a, b) => b.version - a.version)
    },
    async saveText(submissionId: string, text: string) {
      const profile = requireStudent()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) throw new Error('Работа не найдена')
      if (submission.student_id !== profile.id) throw new Error('Это чужая работа')
      if (submission.grade != null) throw new Error('Оценённая работа заблокирована')
      if (!submission.original_name?.toLowerCase().endsWith('.txt')) {
        throw new Error('Онлайн-редактирование доступно только для TXT')
      }
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const file = new File([blob], submission.original_name, { type: 'text/plain' })
      return demoBackend.submissions.replace(submission.id, file)
    },
    async cleanupReviewedFiles() {
      requireAdmin()
      const db = loadDb()
      const expired = db.submissions.filter(
        (submission) =>
          submission.grade != null &&
          !submission.file_deleted_at &&
          isReviewRetentionExpired(submission.reviewed_at ?? submission.updated_at),
      )
      if (!expired.length) return 0

      const submissionIds = new Set(expired.map((submission) => submission.id))
      const paths = new Set<string>()
      for (const submission of expired) {
        if (submission.file_path) paths.add(submission.file_path)
      }
      for (const version of db.versions) {
        if (submissionIds.has(version.submission_id) && version.file_path) {
          paths.add(version.file_path)
        }
      }
      for (const path of paths) await deleteDemoFile(path)

      const deletedAt = new Date().toISOString()
      for (const submission of expired) {
        submission.file_path = null
        submission.file_deleted_at = deletedAt
      }
      for (const version of db.versions) {
        if (submissionIds.has(version.submission_id)) {
          version.file_path = null
          version.file_deleted_at = deletedAt
        }
      }
      saveDb()
      return expired.length
    },
  },

  annotations: {
    async list(submissionId: string): Promise<Annotation[]> {
      const profile = requireSession()
      const db = loadDb()
      const submission = db.submissions.find((s) => s.id === submissionId)
      if (!submission) return []
      if (profile.role !== 'admin' && submission.student_id !== profile.id) {
        throw new Error('Нет доступа к отметкам')
      }
      return db.annotations
        .filter((a) => a.submission_id === submissionId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    async create(input: AnnotationInput) {
      const admin = requireAdmin()
      if (!input.comment.trim()) throw new Error('Добавьте комментарий к замечанию')
      const annotation: Annotation = {
        id: demoId(),
        submission_id: input.submission_id,
        kind: input.kind,
        page: input.page ?? null,
        rects: input.rects ?? null,
        range: input.range ?? null,
        color: input.color,
        comment: input.comment.trim(),
        created_by: admin.id,
        created_at: new Date().toISOString(),
      }
      const db = loadDb()
      db.annotations.push(annotation)
      saveDb()
      return annotation
    },
    async remove(id: string) {
      requireAdmin()
      const db = loadDb()
      db.annotations = db.annotations.filter((a) => a.id !== id)
      saveDb()
    },
  },

  files: {
    async blob(path: string) {
      const profile = requireSession()
      if (profile.role !== 'admin') {
        const db = loadDb()
        const ownsCurrent = db.submissions.some(
          (s) => s.student_id === profile.id && s.file_path === path,
        )
        // Студент также может скачать файл из истории своих версий.
        const ownsVersion = db.versions.some((version) => {
          if (version.file_path !== path) return false
          return db.submissions.some(
            (s) => s.id === version.submission_id && s.student_id === profile.id,
          )
        })
        if (!ownsCurrent && !ownsVersion) throw new Error('Нет доступа к файлу')
      }
      const blob = await getDemoFile(path)
      if (!blob) throw new Error('Файл не найден в демо-хранилище')
      return blob
    },
    async url(path: string) {
      const blob = await demoBackend.files.blob(path)
      return URL.createObjectURL(blob)
    },
    async download(path: string, name: string) {
      const blob = await demoBackend.files.blob(path)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    },
  },

  async resetDemo() {
    resetDb()
    await clearDemoFiles()
    emit()
  },
}

export function demoKindLabel(name: string): string {
  return fileKind(name).label
}
