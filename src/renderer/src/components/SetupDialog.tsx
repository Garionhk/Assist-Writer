import { useEffect, useRef, useState } from 'react'
import type { SetupProgress, SetupStatus, Settings } from '../../../shared/types'
import { KNOWN_MODEL_BYTES, formatGB, formatVram, hasVram, vramFit, vramNeeded } from '../../../shared/models'
import { cleanError, isCancelled, newRequestId } from '../ai/liveChecker'
import { t } from '../i18n'

interface Props {
  settings: Settings
  /** Called when something changed (Ollama installed, a model downloaded). */
  onChanged: () => void
  onClose: () => void
}

interface Task {
  requestId: string
  progress: SetupProgress | null
  error: string | null
}

/**
 * Setting up the AI: Ollama (download and install), the graphics card's memory against what the
 * models need, and downloading the models chosen in Settings. Desktop app only.
 */
export function SetupDialog({ settings, onChanged, onClose }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const running = useRef(new Set<string>())

  const refresh = async () => {
    try {
      setStatus(await window.api.setupStatus!())
      setLoadError(null)
    } catch (err) {
      setLoadError(cleanError(err instanceof Error ? err.message : String(err)))
    }
  }

  useEffect(() => {
    void refresh()
    // Leaving the window stops downloads that are still running.
    return () => running.current.forEach((id) => window.api.cancelChat(id))
  }, [])

  const run = async (key: string, job: (requestId: string, onProgress: (p: SetupProgress) => void) => Promise<unknown>) => {
    const requestId = newRequestId('setup')
    running.current.add(requestId)
    setTasks((m) => ({ ...m, [key]: { requestId, progress: null, error: null } }))
    try {
      await job(requestId, (progress) => setTasks((m) => (m[key] ? { ...m, [key]: { ...m[key], progress } } : m)))
      setTasks((m) => {
        const { [key]: _, ...rest } = m
        return rest
      })
      onChanged()
    } catch (err) {
      const message = cleanError(err instanceof Error ? err.message : String(err))
      setTasks((m) => ({ ...m, [key]: { requestId, progress: null, error: isCancelled(message) ? t('Stopped.') : message } }))
    } finally {
      running.current.delete(requestId)
      await refresh()
    }
  }

  const installOllama = () => run('ollama', (id, onProgress) => window.api.installOllama!(id, onProgress))
  const pull = (model: string) => run(model, (id, onProgress) => window.api.pullModel!(model, id, onProgress))
  const stop = (key: string) => {
    const task = tasks[key]
    if (task) window.api.cancelChat(task.requestId)
  }

  const vram = Math.max(0, ...(status?.gpus ?? []).map((g) => g.vramBytes))
  const installed = new Map(status?.models ?? [])
  const models = [
    { role: t('Checking while you type and “Improve”'), name: settings.liveModel },
    { role: t('Rewriting whole documents'), name: settings.rewriteModel }
  ].filter((m, i, list) => list.findIndex((x) => x.name === m.name) === i)
  const sizeOf = (name: string) => installed.get(name) ?? KNOWN_MODEL_BYTES[name] ?? 0
  const needs = models.map((m) => (sizeOf(m.name) ? vramNeeded(sizeOf(m.name)) : 0))
  const [needLive, needRewrite] = [needs[0] ?? 0, needs[needs.length - 1] ?? 0]
  const missing = models.filter((m) => !installed.has(m.name))
  const missingBytes = missing.reduce((n, m) => n + sizeOf(m.name), 0)

  const progressBar = (task: Task | undefined) => {
    if (!task) return null
    if (task.error) return <small className="bad">{task.error}</small>
    const p = task.progress
    const pct = p && p.total ? Math.min(100, Math.round((p.completed / p.total) * 100)) : null
    const label = !p
      ? t('Starting…')
      : p.status === 'installing'
        ? t('Installing Ollama… (a window may appear briefly)')
        : p.total
          ? t('{done} of {total} ({pct}%)', { done: formatGB(p.completed), total: formatGB(p.total), pct: pct ?? 0 })
          : p.status
    return (
      <div className="setup-progress">
        <progress value={pct ?? undefined} max={100} />
        <small className="muted">{label}</small>
      </div>
    )
  }

  const verdict = (bytes: number) => {
    if (!bytes) return <small className="muted">{t('Size shown once the download starts.')}</small>
    const fit = vramFit(bytes, vram)
    return fit === 'gpu' ? (
      <small className="ok">{t('✓ Runs fully on your graphics card (fast).')}</small>
    ) : fit === 'partial' ? (
      <small className="bad">{t('Partly on the processor: about 2–4 times slower. A smaller model is faster.')}</small>
    ) : (
      <small className="bad">{t('No graphics card memory found: runs on the processor (slow).')}</small>
    )
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide setup" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('Set up Ollama and AI models')}</h2>
        <p className="muted">{t('Assist Writer runs its AI models on this PC with Ollama. Your writing never leaves your computer.')}</p>

        {!status && !loadError && (
          <p>
            <span className="spinner" /> {t('Checking this PC…')}
          </p>
        )}
        {loadError && <p className="bad">{loadError}</p>}

        {status && (
          <>
            <section className="setup-section">
              <h3>{t('1. Graphics card')}</h3>
              {status.gpus.length ? (
                status.gpus.map((g) => (
                  <div key={g.name}>
                    <strong>{g.name}</strong> — {t('{gb} of graphics memory (VRAM)', { gb: formatVram(g.vramBytes) })}
                  </div>
                ))
              ) : (
                <div className="bad">{t('No graphics card memory found. The models will run on the processor, which is much slower.')}</div>
              )}
              <p className="setup-need">
                {t('Needed: at least {live} GB of graphics memory for checking while you type, and {rewrite} GB to rewrite whole documents at full speed. The two models are used one at a time, so the larger one decides.', {
                  live: needLive || 8,
                  rewrite: needRewrite || 16
                })}
              </p>
              {vram > 0 && (
                <p className={hasVram(vram, needRewrite || 16) ? 'ok' : 'bad'}>
                  {hasVram(vram, needRewrite || 16)
                    ? t('✓ Your graphics card has enough memory for both models.')
                    : hasVram(vram, needLive || 8)
                      ? t('Checking while you type will be fast. Rewriting whole documents will be slower; choose a smaller rewrite model in Settings to speed it up.')
                      : t('Your graphics card has less memory than recommended. Everything works, but more slowly; smaller models in Settings are faster.')}
                </p>
              )}
            </section>

            <section className="setup-section">
              <h3>{t('2. Ollama')}</h3>
              {status.ollama.running ? (
                <div className="ok">
                  {t('✓ Ollama {version} is installed and running.', { version: status.ollama.version ?? '' })}
                  {status.ollama.startedByApp && <span className="muted"> {t('(Started by Assist Writer; it closes with Assist Writer.)')}</span>}
                </div>
              ) : status.ollama.installed ? (
                <div className="bad">{t('Ollama is installed but could not be started. Start Ollama from the Start menu, then click Check again.')}</div>
              ) : (
                <>
                  <div>{t('Ollama is not installed yet.')}</div>
                  <div className="row">
                    <button className="primary" disabled={!!tasks.ollama && !tasks.ollama.error} onClick={() => void installOllama()}>
                      {t('Download and install Ollama (1.7 GB download, about 3 GB installed)')}
                    </button>
                    {tasks.ollama && !tasks.ollama.error && <button onClick={() => stop('ollama')}>{t('Stop')}</button>}
                  </div>
                  {progressBar(tasks.ollama)}
                  <small className="muted">{t('From ollama.com. It installs for your Windows account only; no administrator rights needed.')}</small>
                </>
              )}
            </section>

            <section className="setup-section">
              <h3>{t('3. AI models')}</h3>
              <table className="setup-models">
                <tbody>
                  {models.map((m) => {
                    const bytes = sizeOf(m.name)
                    const task = tasks[m.name]
                    const busy = !!task && !task.error
                    return (
                      <tr key={m.name}>
                        <td>
                          <div className="muted">{m.role}</div>
                          <code>{m.name}</code>
                          <div>
                            {bytes ? t('{size} download · needs about {gb} GB of graphics memory', { size: formatGB(bytes), gb: vramNeeded(bytes) }) : null}
                          </div>
                          {verdict(bytes)}
                          {progressBar(task)}
                        </td>
                        <td className="setup-action">
                          {installed.has(m.name) ? (
                            <span className="ok">{t('✓ Installed')}</span>
                          ) : busy ? (
                            <button onClick={() => stop(m.name)}>{t('Stop')}</button>
                          ) : (
                            <button className="primary" disabled={!status.ollama.running} onClick={() => void pull(m.name)}>
                              {t('Download')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {missing.length > 0 && (
                <div className="row">
                  <button
                    className="primary"
                    disabled={!status.ollama.running || missing.some((m) => tasks[m.name] && !tasks[m.name].error)}
                    onClick={() => missing.forEach((m) => void pull(m.name))}
                  >
                    {missingBytes ? t('Download all ({size})', { size: formatGB(missingBytes) }) : t('Download all')}
                  </button>
                  <small className="muted">{t('Models you choose later in Settings can be downloaded here too.')}</small>
                </div>
              )}
              {missing.length === 0 && status.ollama.running && <p className="ok">{t('✓ Everything is ready.')}</p>}
            </section>
          </>
        )}

        <div className="modal-actions">
          <button onClick={() => void refresh()}>{t('Check again')}</button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            {status && missing.length === 0 && status.ollama.running ? t('Done') : t('Later')}
          </button>
        </div>
      </div>
    </div>
  )
}
