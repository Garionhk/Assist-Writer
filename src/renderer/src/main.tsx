import { createRoot } from 'react-dom/client'
import App from './App'
import { LoginScreen } from './components/LoginScreen'
import { createWebApi, getSession } from './webApi'
import { createTauriApi } from './tauriApi'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

async function start(): Promise<void> {
  // Desktop app: the Tauri shell (or the older Electron preload) provides the API.
  // In a plain browser we talk to the web server instead.
  if ('__TAURI_INTERNALS__' in window) window.api = createTauriApi()
  if (window.api) {
    root.render(<App />)
    return
  }
  try {
    const session = await getSession()
    if (!session.authenticated) {
      root.render(<LoginScreen passwordSet={session.passwordSet} />)
      return
    }
    window.api = createWebApi()
    root.render(<App />)
  } catch {
    root.render(
      <div className="login">
        <div className="login-box">
          <h1>Assist Writer</h1>
          <p className="bad">Can't reach the Assist Writer server. Make sure it's running, then reload this page.</p>
        </div>
      </div>
    )
  }
}

void start()
