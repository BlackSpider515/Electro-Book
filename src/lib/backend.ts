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

export interface AnnotationInput {
  submission_id: string
  kind: 'pdf' | 'text'
  page?: number | null
  rects?: { x: number; y: number; w: number; h: number }[] | null
  range?: { start: number; end: number; text: string } | null
  color: string
  comment: string
}

export interface SubmissionFilters {
  assignmentId?: string
  studentId?: string
}

export interface Backend {
  mode: 'supabase' | 'demo'
  auth: {
    getProfile: () => Promise<Profile | null>
    onAuthChange: (callback: (profile: Profile | null) => void) => () => void
    signIn: (login: string, password: string) => Promise<Profile>
    signOut: () => Promise<void>
    register: (fullName: string, groupName: string) => Promise<StudentCredentials>
  }
  groups: {
    list: () => Promise<Group[]>
    create: (name: string) => Promise<Group>
    rename: (oldName: string, newName: string) => Promise<void>
    remove: (name: string) => Promise<void>
  }
  students: (groupName: string) => Promise<Profile[]>
  assignments: {
    list: (groupName: string) => Promise<Assignment[]>
    create: (input: NewAssignment) => Promise<Assignment>
    update: (id: string, input: NewAssignment) => Promise<Assignment>
    remove: (id: string) => Promise<void>
  }
  journal: (groupName?: string) => Promise<JournalData>
  submissions: {
    mine: () => Promise<Submission[]>
    list: (groupName: string, filters?: SubmissionFilters) => Promise<WorkRow[]>
    get: (id: string) => Promise<Submission>
    upload: (assignmentId: string, file: File, onProgress?: UploadProgress) => Promise<Submission>
    replace: (submissionId: string, file: File, onProgress?: UploadProgress) => Promise<Submission>
    setGrade: (submissionId: string, grade: number | null) => Promise<void>
    markSubmitted: (assignmentId: string, studentId: string) => Promise<Submission>
    remove: (submissionId: string) => Promise<void>
    versions: (submissionId: string) => Promise<SubmissionVersion[]>
    saveText: (submissionId: string, text: string) => Promise<Submission>
  }
  annotations: {
    list: (submissionId: string) => Promise<Annotation[]>
    create: (input: AnnotationInput) => Promise<Annotation>
    remove: (id: string) => Promise<void>
  }
  files: {
    blob: (path: string) => Promise<Blob>
    url: (path: string) => Promise<string>
    download: (path: string, name: string) => Promise<void>
  }
  resetDemo?: () => Promise<void>
}
