import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  GraduationCap,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ErrorBox } from '../components/Feedback'

export function AdminLoginPage() {
  const { profile, loading, login, logout } = useAuth()
  const navigate = useNavigate()
  const [loginValue, setLoginValue] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (loading) {
    return (
      <div className="auth-page auth-page--loading">
        <Loader2 className="spin" size={28} /> <span>Загружаем кабинет…</span>
      </div>
    )
  }

  if (profile?.role === 'admin') {
    return <Navigate to="/admin/journal" replace />
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!loginValue.trim() || !password) {
      setError('Введите логин и пароль')
      return
    }
    setBusy(true)
    try {
      const value = await login(loginValue.trim(), password)
      if (value.role !== 'admin') {
        await logout()
        setError('Этот аккаунт не является преподавательским. Войдите как студент на главной странице.')
        return
      }
      navigate('/admin/journal', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-login">
      <div className="admin-login__decor" aria-hidden="true" />
      <div className="admin-login__card">
        <div className="admin-login__brand">
          <span className="admin-login__mark">
            <GraduationCap size={26} />
          </span>
          <span>
            <strong>Кабинет преподавателя</strong>
            <small>Электронный дневник</small>
          </span>
        </div>

        <div className="admin-login__teacher">
          <span className="admin-login__avatar">КА</span>
          <div>
            <strong>Ксения Андреевна</strong>
            <span>преподаватель</span>
          </div>
        </div>

        {profile?.role === 'student' ? (
          <div className="admin-login__student">
            <p>
              Вы вошли как студент <strong>{profile.full_name}</strong>. Для входа в кабинет
              преподавателя нужно выйти из студенческого аккаунта.
            </p>
            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={() => logout()}
            >
              Выйти из аккаунта студента
            </button>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            {error ? <ErrorBox>{error}</ErrorBox> : null}
            <label className="field">
              <span>Логин преподавателя</span>
              <div className="input-with-icon">
                <KeyRound size={17} />
                <input
                  name="adminLogin"
                  autoComplete="username"
                  value={loginValue}
                  onChange={(event) => setLoginValue(event.target.value)}
                  placeholder="логин или email"
                  data-testid="admin-login-input"
                />
              </div>
            </label>
            <label className="field">
              <span>Пароль</span>
              <div className="input-with-icon">
                <LockKeyhole size={17} />
                <input
                  name="adminPassword"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="пароль"
                  data-testid="admin-password-input"
                />
              </div>
            </label>
            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={busy}
              data-testid="admin-login-submit"
            >
              {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
              {busy ? 'Проверяем…' : 'Войти в кабинет'}
            </button>

          </form>
        )}

        <div className="admin-login__foot">
          <Link to="/" className="subtle-link">
            <ArrowLeft size={14} /> На страницу студентов
          </Link>
          <span className="muted">Доступ только для преподавателя</span>
        </div>
      </div>
    </div>
  )
}
