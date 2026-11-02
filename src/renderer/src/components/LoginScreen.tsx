import { useState } from 'react'
import { loginRequest } from '../webApi'
import { t } from '../i18n'

export function LoginScreen({ passwordSet }: { passwordSet: boolean }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await loginRequest(password)
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-box" onSubmit={submit}>
        <h1>Assist Writer</h1>
        {passwordSet ? (
          <>
            <p className="muted">{t('Enter the password set on the PC running Assist Writer.')}</p>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder={t('Password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="bad">{error}</p>}
            <button className="primary" disabled={busy || !password}>
              {busy ? t('Logging in…') : t('Log in')}
            </button>
          </>
        ) : (
          <p>
            {t("Network access isn't set up yet. On the PC running Assist Writer, open {url}, click the ⚙ Settings button and set a network password. Then reload this page.", {
              url: `http://localhost:${window.location.port || '80'}`
            })}
          </p>
        )}
      </form>
    </div>
  )
}
