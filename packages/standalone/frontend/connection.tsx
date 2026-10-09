import { useState } from 'react'
import { Cable, Copy, Eye, EyeOff, KeyRound, RotateCcw, ShieldAlert } from 'lucide-react'
import { Button, Card } from './components/ui'
import type { Host, Summary } from './types'

export function Connection({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  if (!active) return null
  const endpoint = `${summary.baseUrl}/v1`
  const model = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  const example = `curl ${summary.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`
  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setNotice(''); setError('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }
  const toggleKey = () => void run(async () => {
    if (apiKey) { setApiKey(''); return }
    setApiKey(await host.getApiKey())
  })
  const rotate = () => {
    if (!window.confirm('轮换后旧 API Key 会立即失效，确认继续吗？')) return
    void run(async () => setApiKey(await host.rotateKey()), '密钥已轮换，请更新所有客户端配置。')
  }
  return <div className="connection-browser" data-testid="connection-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CONNECT YOUR TOOLS</div>
      <h1>API 接入</h1><p>使用 OpenAI 兼容接口，把本地模型接入你的工具。</p></div>
      <Cable size={22} aria-hidden="true" /></header>
    {notice && <p className="connection-feedback" role="status">{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}
    <Card className="connection-card"><div className="connection-card-heading"><KeyRound size={18} /><div><h2>连接凭据</h2><p>管理会话与推理密钥相互独立。</p></div></div>
      <label className="field-label" htmlFor="connection-endpoint">API Base URL</label>
      <div className="copy-field"><input id="connection-endpoint" readOnly value={endpoint} /><Button variant="outline" disabled={busy} onClick={() => void run(() => host.copy(endpoint), '地址已复制。')}><Copy size={14} />复制地址</Button></div>
      <label className="field-label" htmlFor="connection-key">API Key</label>
      <div className="copy-field"><input id="connection-key" type={apiKey ? 'text' : 'password'} readOnly value={apiKey} placeholder="点击查看后显示" />
        <Button variant="outline" disabled={busy} onClick={toggleKey}>{apiKey ? <EyeOff size={14} /> : <Eye size={14} />}{apiKey ? '隐藏密钥' : '查看密钥'}</Button>
        <Button variant="outline" disabled={!apiKey || busy} onClick={() => void run(() => host.copy(apiKey), '密钥已复制。')}><Copy size={14} />复制</Button></div>
      <p className="footnote">密钥用于客户端调用，请妥善保管。</p>
    </Card>
    <Card className="connection-card"><div className="connection-card-heading"><Cable size={18} /><div><h2>快速开始</h2><p>将 YOUR_API_KEY 替换为上方密钥。</p></div><Button variant="ghost" disabled={busy} onClick={() => void run(() => host.copy(example), '示例已复制。')}><Copy size={14} />复制示例</Button></div>
      <pre className="connection-example">{example}</pre>
    </Card>
    <Card className="connection-card connection-danger"><div><h2>轮换 API Key</h2><p>轮换后旧密钥立即失效，需要更新所有客户端。</p></div><Button variant="outline" disabled={busy} onClick={rotate}><RotateCcw size={15} />轮换密钥</Button></Card>
  </div>
}
