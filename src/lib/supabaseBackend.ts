import type { SupabaseClient } from '@supabase/supabase-js'
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
} from './types'
import type { AnnotationInput, Backend, SubmissionFilters } from './backend'
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase'
import { extensionOf, safeMime, sanitizeFileName } from './fileTypes'

function client(): SupabaseClient {
  if (!supabase) throw new Error('Supabase не настроен')
  return supabase
}

async function fetchProfile(id: string): Promise<Profile | null> {
  const { data, error } = await client()
    .from('profiles')
    .select('id, role, full_name, group_name, created_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Profile | null) ?? null
}

async function requireProfile(): Promise<Profile> {
  const { data, error } = await client().auth.getUser()
  if (error || !data.user) throw new Error('Нужно войти в дневник')
  const profile = await fetchProfile(data.user.id)
  if (!profile) throw new Error('Профиль не найден. Обратитесь к преподавателю.')
  return profile
}

async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile()
  if (profile.role !== 'admin') throw new Error('Действие доступно только преподавателю')
  return profile
}

async function requireStudent(): Promise<Profile> {
  const profile = await requireProfile()
  if (profile.role !== 'student') throw new Error('Действие доступно только студенту')
  return profile
}

function readableAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Неверный логин или пароль'
  if (/email not confirmed/i.test(message)) {
    return 'Подтверждение email включено. В настройках Supabase его нужно отключить.'
  }
  if (/rate limit/i.test(message)) return 'Слишком много попыток. Подождите минуту.'
  return message
}

function storagePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function uploadFileToStorage(
  path: string,
  file: File,
  mime: string,
  onProgress?: UploadProgress,
): Promise<void> {
  const { data, error } = await client().auth.getSession()
  if (error || !data.session) throw new Error('Сессия истекла — войдите заново.')
  const token = data.session.access_token

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/submissions/${storagePath(path)}`)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', supabaseAnonKey)
    xhr.setRequestHeader('cache-control', '3600')
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.setRequestHeader('Content-Type', mime)
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    }
    xhr.onerror = () => reject(new Error('Не удалось загрузить файл. Проверьте интернет.'))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve()
        return
      }
      let message = 'Не удалось загрузить файл в хранилище.'
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string }
        message = body.message || body.error || message
      } catch {
        // ignore
      }
      if (xhr.status === 413) message = 'Файл больше лимита хранилища (50 МБ).'
      if (xhr.status === 403) message = 'Загрузка запрещена: работа уже оценена или файл не разрешён.'
      reject(new Error(message))
    }
    xhr.send(file)
  })
}

async function removeStorageObject(path: string): Promise<void> {
  try {
    await client().storage.from('submissions').remove([path])
  } catch {
    // Не критично: файл мог быть уже удалён.
  }
}

async function storeSubmission(
  profile: Profile,
  assignmentId: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<Submission> {
  const db = client()
  const { data: assignment, error: assignmentError } = await db
    .from('assignments')
    .select('*')
    .eq('id', assignmentId)
    .maybeSingle()
  if (assignmentError) throw new Error(assignmentError.message)
  if (!assignment) throw new Error('Задание не найдено')
  if (assignment.group_name !== profile.group_name) throw new Error('Это задание другой группы')

  const { data: existing, error: existingError } = await db
    .from('submissions')
    .select('*')
    .eq('assignment_id', assignmentId)
    .eq('student_id', profile.id)
    .maybeSingle()
  if (existingError) throw new Error(existingError.message)
  if (existing?.grade != null) {
    throw new Error('Работа уже оценена — заменить файл больше нельзя')
  }

  const ext = extensionOf(file.name)
  if (!ext) throw new Error('У файла нет расширения')
  const path = `${profile.id}/${assignmentId}/${crypto.randomUUID()}.${ext}`
  const mime = safeMime(file)
  const version = (existing?.version ?? 0) + 1

  await uploadFileToStorage(path, file, mime, onProgress)

  const payload = {
    file_path: path,
    original_name: sanitizeFileName(file.name),
    mime,
    size: file.size,
    submitted_at: new Date().toISOString(),
    status: 'submitted' as const,
    version,
  }

  let submission: Submission | null = null
  if (existing) {
    const { data, error } = await db
      .from('submissions')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) {
      await removeStorageObject(path)
      throw new Error(
        error.code === 'PGRST116' || error.code === '42501'
          ? 'Работа уже оценена или нет прав на замену файла.'
          : error.message,
      )
    }
    submission = data as Submission
  } else {
    const { data, error } = await db
      .from('submissions')
      .insert({
        assignment_id: assignmentId,
        student_id: profile.id,
        ...payload,
      })
      .select('*')
      .single()
    if (error) {
      await removeStorageObject(path)
      throw new Error(error.message)
    }
    submission = data as Submission
  }

  const { error: versionError } = await db.from('submission_versions').insert({
    submission_id: submission.id,
    file_path: path,
    original_name: payload.original_name,
    mime,
    size: file.size,
    version,
  })
  if (versionError) console.warn('Не удалось сохранить версию файла', versionError.message)

  return submission
}

export const supabaseBackend: Backend = {
  mode: 'supabase',

  auth: {
    async getProfile() {
      const { data } = await client().auth.getSession()
      if (!data.session?.user) return null
      try {
        return await fetchProfile(data.session.user.id)
      } catch {
        return null
      }
    },
    onAuthChange(callback) {
      const { data } = client().auth.onAuthStateChange((_event, session) => {
        if (!session?.user) {
          callback(null)
          return
        }
        fetchProfile(session.user.id)
          .then(callback)
          .catch(() => callback(null))
      })
      return () => data.subscription.unsubscribe()
    },
    async signIn(login, password) {
      const raw = login.trim()
      const email = raw.includes('@') ? raw.toLowerCase() : `${raw.toLowerCase()}@diary.local`
      const { data, error } = await client().auth.signInWithPassword({ email, password })
      if (error) throw new Error(readableAuthError(error.message))
      if (!data.user) throw new Error('Не удалось войти')
      const profile = await fetchProfile(data.user.id)
      if (!profile) {
        await client().auth.signOut()
        throw new Error('Профиль не найден. Обратитесь к преподавателю.')
      }
      return profile
    },
    async signOut() {
      await client().auth.signOut()
    },
    async register(fullName, groupName): Promise<StudentCredentials> {
      const { data, error } = await client().functions.invoke('register', {
        body: { fullName, groupName },
      })
      if (error) {
        let message = error.message || 'Не удалось создать аккаунт'
        const context = (error as { context?: Response }).context
        if (context && typeof context.json === 'function') {
          try {
            const body = (await context.json()) as { error?: string }
            if (body?.error) message = body.error
          } catch {
            // ignore
          }
        }
        if (/Failed to send a request|not found|404/i.test(message)) {
          message =
            'Сервис регистрации не задеплоен. Задеплойте Edge Function «register» (см. README).'
        }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error as string)
      return data as StudentCredentials
    },
  },

  groups: {
    async list(): Promise<Group[]> {
      const { data, error } = await client()
        .from('groups')
        .select('name, created_at')
        .order('name')
      if (error) throw new Error(error.message)
      return (data ?? []) as Group[]
    },
    async create(name: string) {
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 20) {
        throw new Error('Название группы должно быть длиной от 1 до 20 символов')
      }
      const { data, error } = await client()
        .from('groups')
        .insert({ name: trimmed })
        .select('name, created_at')
        .single()
      if (error) {
        throw new Error(error.code === '23505' ? 'Такая группа уже существует' : error.message)
      }
      return data as Group
    },
    async rename(oldName: string, newName: string) {
      const { error } = await client().rpc('rename_group', { p_old: oldName, p_new: newName })
      if (error) throw new Error(error.message)
    },
    async remove(name: string) {
      const { error } = await client().rpc('delete_group', { p_name: name })
      if (error) throw new Error(error.message)
    },
  },

  async students(groupName: string) {
    const { data, error } = await client()
      .from('profiles')
      .select('id, role, full_name, group_name, created_at')
      .eq('group_name', groupName)
      .eq('role', 'student')
      .order('full_name')
    if (error) throw new Error(error.message)
    return (data ?? []) as Profile[]
  },

  assignments: {
    async list(groupName: string) {
      const { data, error } = await client()
        .from('assignments')
        .select('*')
        .eq('group_name', groupName)
        .order('assigned_date')
        .order('lesson_number')
      if (error) throw new Error(error.message)
      return (data ?? []) as Assignment[]
    },
    async create(input: NewAssignment) {
      await requireAdmin()
      const { data, error } = await client()
        .from('assignments')
        .insert({
          title: input.title.trim(),
          description: input.description.trim(),
          group_name: input.group_name,
          assigned_date: input.assigned_date,
          lesson_number: input.lesson_number,
          ...(input.subject ? { subject: input.subject } : {}),
        })
        .select('*')
        .single()
      if (error) throw new Error(error.message)
      return data as Assignment
    },
    async update(id: string, input: NewAssignment) {
      await requireAdmin()
      const { data, error } = await client()
        .from('assignments')
        .update({
          title: input.title.trim(),
          description: input.description.trim(),
          group_name: input.group_name,
          assigned_date: input.assigned_date,
          lesson_number: input.lesson_number,
          ...(input.subject ? { subject: input.subject } : {}),
        })
        .eq('id', id)
        .select('*')
        .single()
      if (error) throw new Error(error.message)
      return data as Assignment
    },
    async remove(id: string) {
      await requireAdmin()
      const db = client()
      const { data: submissions, error: submissionsError } = await db
        .from('submissions')
        .select('id, file_path')
        .eq('assignment_id', id)
      if (submissionsError) throw new Error(submissionsError.message)

      const submissionIds = (submissions ?? []).map((s: { id: string }) => s.id)
      const paths = (submissions ?? [])
        .map((s: { file_path: string | null }) => s.file_path)
        .filter((p): p is string => Boolean(p))

      // История версий удаляется каскадно вместе со сдачами, поэтому пути
      // нужно собрать до удаления задания.
      if (submissionIds.length) {
        const { data: versions } = await db
          .from('submission_versions')
          .select('file_path')
          .in('submission_id', submissionIds)
        for (const version of (versions ?? []) as { file_path: string }[]) {
          if (version.file_path) paths.push(version.file_path)
        }
      }

      const { error } = await db.from('assignments').delete().eq('id', id)
      if (error) throw new Error(error.message)
      const uniquePaths = [...new Set(paths)]
      if (uniquePaths.length) await db.storage.from('submissions').remove(uniquePaths)
    },
  },

  async journal(groupName?: string): Promise<JournalData> {
    const profile = await requireProfile()
    const db = client()
    const group = profile.role === 'admin' ? groupName ?? '' : profile.group_name ?? ''
    if (!group) return { assignments: [], students: [], entries: [] }

    const [studentsResult, assignmentsResult] = await Promise.all([
      db
        .from('profiles')
        .select('id, role, full_name, group_name, created_at')
        .eq('group_name', group)
        .eq('role', 'student')
        .order('full_name'),
      db
        .from('assignments')
        .select('*')
        .eq('group_name', group)
        .order('assigned_date')
        .order('lesson_number'),
    ])
    if (studentsResult.error) throw new Error(studentsResult.error.message)
    if (assignmentsResult.error) throw new Error(assignmentsResult.error.message)

    const assignments = (assignmentsResult.data ?? []) as Assignment[]
    const assignmentIds = assignments.map((a) => a.id)
    let entries: JournalData['entries'] = []
    if (assignmentIds.length) {
      const { data, error } = await db
        .from('journal_entries')
        .select('submission_id, assignment_id, student_id, grade, status, submitted_at')
        .in('assignment_id', assignmentIds)
      if (error) throw new Error(error.message)
      entries = (data ?? []) as JournalData['entries']
    }

    return {
      assignments,
      students: (studentsResult.data ?? []) as Profile[],
      entries,
    }
  },

  submissions: {
    async mine() {
      const profile = await requireStudent()
      const { data, error } = await client()
        .from('submissions')
        .select('*')
        .eq('student_id', profile.id)
        .order('submitted_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as Submission[]
    },
    async list(groupName: string, filters: SubmissionFilters = {}): Promise<WorkRow[]> {
      await requireAdmin()
      const db = client()
      const [assignmentsResult, studentsResult] = await Promise.all([
        db.from('assignments').select('*').eq('group_name', groupName),
        db
          .from('profiles')
          .select('id, full_name, group_name, role')
          .eq('group_name', groupName)
          .eq('role', 'student'),
      ])
      if (assignmentsResult.error) throw new Error(assignmentsResult.error.message)
      if (studentsResult.error) throw new Error(studentsResult.error.message)

      const assignments = (assignmentsResult.data ?? []) as Assignment[]
      const assignmentById = new Map(assignments.map((a) => [a.id, a]))
      const studentById = new Map(
        ((studentsResult.data ?? []) as Profile[]).map((s) => [s.id, s]),
      )
      const assignmentIds = filters.assignmentId ? [filters.assignmentId] : assignments.map((a) => a.id)
      if (!assignmentIds.length) return []

      let query = db
        .from('submissions')
        .select('*')
        .in('assignment_id', assignmentIds)
        .order('submitted_at', { ascending: false })
      if (filters.studentId) query = query.eq('student_id', filters.studentId)
      const { data, error } = await query
      if (error) throw new Error(error.message)

      return ((data ?? []) as Submission[])
        .map((submission) => {
          const assignment = assignmentById.get(submission.assignment_id)
          const student = studentById.get(submission.student_id)
          if (!assignment || !student) return null
          return {
            submission,
            assignment,
            student: {
              id: student.id,
              full_name: student.full_name,
              group_name: student.group_name,
            },
          } satisfies WorkRow
        })
        .filter((row): row is WorkRow => row !== null)
    },
    async get(id: string) {
      const { data, error } = await client().from('submissions').select('*').eq('id', id).single()
      if (error) throw new Error(error.message)
      return data as Submission
    },
    async upload(assignmentId, file, onProgress) {
      const profile = await requireStudent()
      return storeSubmission(profile, assignmentId, file, onProgress)
    },
    async replace(submissionId, file, onProgress) {
      const profile = await requireStudent()
      const { data: submission, error } = await client()
        .from('submissions')
        .select('*')
        .eq('id', submissionId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!submission) throw new Error('Работа не найдена')
      if (submission.student_id !== profile.id) throw new Error('Это чужая работа')
      return storeSubmission(profile, submission.assignment_id, file, onProgress)
    },
    async setGrade(submissionId: string, grade: number | null) {
      await requireAdmin()
      if (grade != null && (grade < 1 || grade > 5)) throw new Error('Оценка от 1 до 5')
      const { error } = await client()
        .from('submissions')
        .update({ grade, status: grade != null ? 'reviewed' : 'submitted' })
        .eq('id', submissionId)
      if (error) throw new Error(error.message)
    },
    async markSubmitted(assignmentId: string, studentId: string) {
      await requireAdmin()
      const { data, error } = await client()
        .from('submissions')
        .insert({
          assignment_id: assignmentId,
          student_id: studentId,
          status: 'submitted',
          version: 1,
        })
        .select('*')
        .single()
      if (error) {
        if (error.code === '23505') {
          const { data: existing, error: existingError } = await client()
            .from('submissions')
            .select('*')
            .eq('assignment_id', assignmentId)
            .eq('student_id', studentId)
            .single()
          if (existingError) throw new Error(existingError.message)
          return existing as Submission
        }
        throw new Error(error.message)
      }
      return data as Submission
    },
    async remove(submissionId: string) {
      await requireAdmin()
      const db = client()
      const { data } = await db
        .from('submissions')
        .select('file_path')
        .eq('id', submissionId)
        .maybeSingle()
      const currentPath = (data as { file_path: string | null } | null)?.file_path

      // Сначала собираем файлы всех версий, иначе после каскадного удаления
      // строк узнать их пути будет уже нельзя, и объекты останутся в бакете.
      const { data: versions } = await db
        .from('submission_versions')
        .select('file_path')
        .eq('submission_id', submissionId)
      const paths = [
        ...(currentPath ? [currentPath] : []),
        ...((versions ?? []) as { file_path: string }[]).map((version) => version.file_path),
      ]

      const { error } = await db.from('submissions').delete().eq('id', submissionId)
      if (error) throw new Error(error.message)
      const uniquePaths = [...new Set(paths)].filter(Boolean)
      if (uniquePaths.length) await db.storage.from('submissions').remove(uniquePaths)
    },
    async versions(submissionId: string) {
      const { data, error } = await client()
        .from('submission_versions')
        .select('*')
        .eq('submission_id', submissionId)
        .order('version', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as SubmissionVersion[]
    },
    async saveText(submissionId: string, text: string) {
      const profile = await requireStudent()
      const { data: submission, error } = await client()
        .from('submissions')
        .select('*')
        .eq('id', submissionId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!submission) throw new Error('Работа не найдена')
      if (submission.student_id !== profile.id) throw new Error('Это чужая работа')
      if (submission.grade != null) throw new Error('Оценённая работа заблокирована')
      if (!String(submission.original_name ?? '').toLowerCase().endsWith('.txt')) {
        throw new Error('Онлайн-редактирование доступно только для TXT')
      }
      const file = new File([text], submission.original_name as string, { type: 'text/plain' })
      return storeSubmission(profile, submission.assignment_id, file)
    },
  },

  annotations: {
    async list(submissionId): Promise<Annotation[]> {
      const { data, error } = await client()
        .from('annotations')
        .select('*')
        .eq('submission_id', submissionId)
        .order('created_at')
      if (error) throw new Error(error.message)
      return (data ?? []) as Annotation[]
    },
    async create(input: AnnotationInput) {
      const admin = await requireAdmin()
      if (!input.comment.trim()) throw new Error('Добавьте комментарий к замечанию')
      const { data, error } = await client()
        .from('annotations')
        .insert({
          submission_id: input.submission_id,
          kind: input.kind,
          page: input.page ?? null,
          rects: input.rects ?? null,
          range: input.range ?? null,
          color: input.color,
          comment: input.comment.trim(),
          created_by: admin.id,
        })
        .select('*')
        .single()
      if (error) throw new Error(error.message)
      return data as Annotation
    },
    async remove(id: string) {
      await requireAdmin()
      const { error } = await client().from('annotations').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  },

  files: {
    async blob(path: string) {
      const url = await supabaseBackend.files.url(path)
      const response = await fetch(url)
      if (!response.ok) throw new Error('Не удалось скачать файл из хранилища')
      return response.blob()
    },
    async url(path: string) {
      const { data, error } = await client()
        .storage.from('submissions')
        .createSignedUrl(path, 60 * 30)
      if (error || !data?.signedUrl) {
        throw new Error(error?.message || 'Не удалось получить ссылку на файл')
      }
      return data.signedUrl
    },
    async download(path: string, name: string) {
      const blob = await supabaseBackend.files.blob(path)
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
}

