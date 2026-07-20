// forms.jsx — Create-session / create-agent modals → window
const { useState: useStateF } = React;

function Modal({ icon, title, sub, onClose, children, footer }) {
  const stop = (e) => e.stopPropagation();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={stop} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="ic"><Icon name={icon} size={18} /></div>
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <span className="kebab x" onClick={onClose}><Icon name="x" size={17} /></span>
        </div>
        <div className="modal-body scroll">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}

function Labeled({ label, opt, hint, htmlFor, children }) {
  return (
    <div className="form-row">
      <label className="form-label" htmlFor={htmlFor}>{label}{opt && <span className="opt">optional</span>}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ─────────── Create session ───────────
function CreateSession({ agents = AGENTS, environments = ENVIRONMENTS, presetAgent, onClose, onCreate, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const choices = agents.filter((a) => a.status === 'active');
  const activePreset = presetAgent?.status === 'active' ? presetAgent : null;
  const [agentId, setAgentId] = useStateF((activePreset && activePreset.id) || (choices[0] && choices[0].id));
  const [env, setEnv] = useStateF(() => apiMode === 'api'
    ? (environments[0]?.id || '')
    : (environments[0]?.id || ENVIRONMENTS[0].id));
  const [customEnv, setCustomEnv] = useStateF('');
  const [title, setTitle] = useStateF('');
  const [msg, setMsg] = useStateF('');
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');
  const [partial, setPartial] = useStateF(null);
  const [sessionIntent] = useStateF(() => api?.createIdempotencyIntent?.());
  const [eventIntent] = useStateF(() => api?.createIdempotencyIntent?.());

  const agent = agents.find((a) => a.id === agentId);
  const usingCustom = env === '__custom';
  const finalEnv = usingCustom ? customEnv.trim() : env;
  const valid = !!agentId && !!finalEnv && !busy;
  const live = apiMode === 'api';
  const initialMessageEvent = () => ({
    type: 'user.message',
    content: [{ type: 'text', text: msg.trim() }],
  });

  const demoSession = () => ({
    id:'sesn_01' + Math.random().toString(36).slice(2, 8) + '…new',
    short:'sesn_…' + Math.random().toString(36).slice(2, 8),
    title: title.trim() || (msg.trim() ? msg.trim().slice(0, 42) : 'Untitled session'),
    status: msg.trim() ? 'running' : 'idle',
    agent: agent.name, env: finalEnv,
    created:'Just now', updated:'Just now', dur:'—', tokens:'0 / 0', resources:0,
  });

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    setPartial(null);
    if (!live) {
      onCreate(demoSession());
      setBusy(false);
      return;
    }
    const body = {
      agent: agentId,
      environment_id: finalEnv,
      ...(title.trim() ? { title: title.trim() } : {}),
    };
    try {
      const session = await api.createSession(body, {
        intent: sessionIntent,
        agentNames: new Map(agents.map((item) => [item.id, item.name])),
      });
      if (!msg.trim()) {
        onCreate({ ...session, firstMessage: { status: 'not_sent' } });
        return;
      }
      try {
        const firstMessage = await api.sendSessionEvents(session.id, [initialMessageEvent()], {
          intent: eventIntent,
        });
        onCreate({ ...session, status:'running', firstMessage: { status:'sent', response:firstMessage } });
      } catch (messageError) {
        setPartial({ session, error: messageError.message || 'First message failed.' });
        setError(`Session ${session.short || session.id} was created, but the first message was not accepted: ${messageError.message || 'Request failed'}`);
        if (messageError.status === 401 && onAuthExpired) onAuthExpired();
      }
    } catch (createError) {
      setError(createError.message || 'Session creation failed.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  const retryFirstMessage = async () => {
    if (!partial || !msg.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const firstMessage = await api.sendSessionEvents(partial.session.id, [initialMessageEvent()], {
        intent: eventIntent,
      });
      onCreate({ ...partial.session, status:'running', firstMessage: { status:'sent_after_retry', response:firstMessage } });
    } catch (messageError) {
      setError(`Session ${partial.session.short || partial.session.id} exists, but the first message retry failed: ${messageError.message || 'Request failed'}`);
      if (messageError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal icon="activity" title="Create session" sub="Start a new Managed Agents session against a local environment." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/sessions</span>{msg.trim() && <> then <span className="mono">POST /v1/sessions/:id/events</span></>}</span>
        <button className="btn" onClick={onClose}>{partial ? 'Close' : 'Cancel'}</button>
        {partial && <button className="btn" disabled={busy} onClick={() => onCreate(partial.session)}>Open session</button>}
        {partial && msg.trim() && <button className="btn btn-primary" disabled={busy} onClick={retryFirstMessage} style={{ opacity: busy ? .5 : 1 }}>
          <Icon name="send" size={15} />Retry message</button>}
        {!partial && <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />{busy ? 'Creating…' : 'Create session'}</button>}
      </>}>
      <Labeled label="Agent" htmlFor="create-session-agent">
        <select id="create-session-agent" name="agent" className="selectbox" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
          ))}
        </select>
        {agent && <div className="field-hint">{agent.short} · system prompt {agent.system.length} chars · {agent.tools} tools</div>}
      </Labeled>

      <Labeled label="Environment" htmlFor="create-session-environment" hint="Pick an existing environment or enter an ID manually.">
        <select id="create-session-environment" name="environment" className="selectbox" value={env} onChange={(e) => setEnv(e.target.value)}>
          {live && environments.length === 0 && <option value="" disabled>Create an environment first…</option>}
          {environments.map((en) => <option key={en.id} value={en.id}>{en.label} — {en.image}</option>)}
          <option value="__custom">Enter an environment ID manually…</option>
        </select>
      </Labeled>
      {live && environments.length === 0 && !usingCustom && (
        <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>No live environments exist yet. Close this dialog and create one, or select “Enter an environment ID manually”.</span></div>
      )}
      {usingCustom && (
        <Labeled label="Environment ID" htmlFor="create-session-environment-id">
          <input id="create-session-environment-id" name="environment_id" className="input mono" placeholder="env_…" value={customEnv} onChange={(e) => setCustomEnv(e.target.value)} />
        </Labeled>
      )}

      <Labeled label="Title" htmlFor="create-session-title" opt hint="Defaults to the first message if left blank.">
        <input id="create-session-title" name="title" className="input" placeholder="e.g. Ship your first Managed Agent" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Labeled>

      <Labeled label="First message" htmlFor="create-session-message" opt hint="Send an initial user.message — the session starts running immediately.">
        <textarea id="create-session-message" name="message" className="textarea" placeholder="Send a message to start the session…" value={msg} onChange={(e) => setMsg(e.target.value)} />
      </Labeled>
      {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
    </Modal>
  );
}

// ─────────── Create agent ───────────
function CreateAgent({ models = [], onClose, onCreate, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const defaultModel = models.find((item) => item.default) || models[0] || null;
  const [name, setName] = useStateF('');
  const [provider, setProvider] = useStateF(defaultModel?.provider || '');
  const [model, setModel] = useStateF(defaultModel?.id || '');
  const [prompt, setPrompt] = useStateF('');
  const [tools, setTools] = useStateF(['bash']);
  const [toolPolicy, setToolPolicy] = useStateF('always_ask');
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');

  const live = apiMode === 'api';
  const providers = [...new Set(models.map((item) => item.provider))];
  const providerModels = models.filter((item) => item.provider === provider);
  const selectedModel = providerModels.find((item) => item.id === model) || null;
  const valid = name.trim().length > 0 && selectedModel !== null && !busy;
  const toggle = (t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]);
  const chooseProvider = (nextProvider) => {
    setProvider(nextProvider);
    const choices = models.filter((item) => item.provider === nextProvider);
    const nextModel = choices.find((item) => item.default) || choices[0] || null;
    setModel(nextModel?.id || '');
  };

  const demoAgent = () => ({
    id:'agent_01' + Math.random().toString(36).slice(2, 8) + '…new',
    short:'agent_…' + Math.random().toString(36).slice(2, 8),
    name: name.trim(), model:`${provider}/${model}`, modelProvider:provider, modelId:model,
    status:'active', created:'Just now', updated:'Just now', version:'v1',
    tools: tools.length, system: prompt.trim() || 'No system prompt set.',
    toolset:'agent_toolset_20260401',
    toolPermission:toolPolicy === 'always_allow' ? 'Allow automatically' : 'Ask before use',
    sessions:[],
  });

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    if (!live) {
      onCreate(demoAgent());
      setBusy(false);
      return;
    }
    const body = {
      name: name.trim(),
      model: api.modelInputForSelection(selectedModel),
      ...(prompt.trim() ? { system: prompt.trim() } : {}),
      tools: [{
        type: 'agent_toolset_20260401',
        configs: TOOL_OPTIONS.map((tool) => ({
          name:tool,
          enabled:tools.includes(tool),
          ...(tools.includes(tool) ? { permission_policy:{ type:toolPolicy } } : {}),
        })),
      }],
    };
    try {
      const agent = await api.createAgent(body);
      onCreate(agent);
    } catch (createError) {
      setError(createError.message || 'Agent creation failed. Refresh the agent list before retrying if the request may have reached the server.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal icon="bot" title="Create agent" sub="Define a reusable agent template — model, prompt, and tools." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/agents</span></span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />{busy ? 'Creating…' : 'Create agent'}</button>
      </>}>
      <div className="form-row two">
        <Labeled label="Name" htmlFor="create-agent-name">
          <input id="create-agent-name" name="name" className="input" placeholder="e.g. cwc-agent" value={name} onChange={(e) => setName(e.target.value)} />
        </Labeled>
        <Labeled label="Provider" htmlFor="create-agent-provider">
          <select id="create-agent-provider" name="provider" className="selectbox mono" value={provider} onChange={(e) => chooseProvider(e.target.value)}>
            {providers.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </Labeled>
      </div>

      <Labeled label="Model" htmlFor="create-agent-model" hint="Search the deployment-enabled Pi catalog for this provider.">
        <input id="create-agent-model" name="model" className="input mono" list="oma-model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="oma-model-suggestions">{providerModels.map((item) => <option key={`${item.provider}/${item.id}`} value={item.id}>{item.name}</option>)}</datalist>
      </Labeled>
      {selectedModel && <div className={selectedModel.credentials_configured ? 'field-hint' : 'inline-warn'} role={selectedModel.credentials_configured ? undefined : 'status'}>
        {!selectedModel.credentials_configured && <Icon name="alert" size={14} />}
        <span>{selectedModel.credentials_configured
          ? `${selectedModel.provider_name || selectedModel.provider} credentials are configured on this appliance.`
          : `Credentials are not configured for ${selectedModel.provider}/${selectedModel.id}. You can create the agent, but sessions will be rejected until the operator runs oma auth set ${selectedModel.provider} and restarts oma up.`}</span>
      </div>}
      {live && models.length === 0 && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>No deployment-enabled models were returned. Agent creation is unavailable.</span></div>}

      <Labeled label="System prompt" htmlFor="create-agent-system" opt hint="Plain text. Markdown is preserved.">
        <textarea id="create-agent-system" name="system" className="textarea" placeholder="You help me navigate…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Labeled>

      <Labeled label="Built-in tools" hint="Choose which sandbox-backed tools the agent may use.">
        <div className="seg-tools">
          {TOOL_OPTIONS.map((t) => {
            const on = tools.includes(t);
            return (
              <button type="button" key={t} className={'tool-toggle' + (on ? ' on' : '')}
                aria-pressed={on} onClick={() => toggle(t)}>
                <span className="chk">{on && <Icon name="checkCircle" size={9} />}</span>
                <span className="mono">{t}</span>
              </button>
            );
          })}
        </div>
      </Labeled>
      <Labeled label="Tool approval" hint="This applies to every enabled built-in tool on this agent.">
        <div className="env-preset-grid" role="radiogroup" aria-label="Tool approval policy">
          <button type="button" className={'env-choice' + (toolPolicy === 'always_ask' ? ' on' : '')}
            role="radio" aria-checked={toolPolicy === 'always_ask'} disabled={busy}
            onClick={() => setToolPolicy('always_ask')}>
            <span className="dot-r" />
            <span><span className="r-main">Ask before use</span><span className="r-sub">Show Allow/Deny before each tool call.</span></span>
          </button>
          <button type="button" className={'env-choice' + (toolPolicy === 'always_allow' ? ' on' : '')}
            role="radio" aria-checked={toolPolicy === 'always_allow'} disabled={busy}
            onClick={() => setToolPolicy('always_allow')}>
            <span className="dot-r" />
            <span><span className="r-main">Allow automatically</span><span className="r-sub">No confirmation prompts. Sandbox and network restrictions still apply.</span></span>
          </button>
        </div>
        {toolPolicy === 'always_allow' && <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>The model may run every enabled tool without asking. Use this for trusted, disposable coding sessions.</span></div>}
      </Labeled>
      {live && <div className="field-hint">Only the currently supported sandbox-backed tools are offered. Disabled tools are persisted explicitly.</div>}
      {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
    </Modal>
  );
}

Object.assign(window, { Modal, CreateSession, CreateAgent, ConfirmDialog });

// ─────────── Archive / delete confirmation ───────────
function ConfirmDialog({ icon = 'archive', danger, title, message, confirmLabel, endpoint, onClose, onConfirm, busy = false, error = null }) {
  return (
    <div className="overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className={'ic' + (danger ? ' danger' : '')}><Icon name={icon} size={18} /></div>
          <div><h2>{title}</h2></div>
          <span className="kebab x" onClick={() => { if (!busy) onClose(); }}><Icon name="x" size={17} /></span>
        </div>
        <div className="modal-body">
          <div className="confirm-msg">{message}</div>
          {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error.message || String(error)}</span></div>}
        </div>
        <div className="modal-foot">
          {endpoint && <span className="left">Sends to <span className="mono">{endpoint}</span></span>}
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
