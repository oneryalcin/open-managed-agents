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

function Labeled({ label, opt, hint, children }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}{opt && <span className="opt">optional</span>}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ─────────── Create session ───────────
function CreateSession({ agents = AGENTS, environments = ENVIRONMENTS, presetAgent, onClose, onCreate }) {
  // active agents, plus the preset agent even if archived/just-created
  const choices = agents.filter((a) => a.status === 'active' || (presetAgent && a.id === presetAgent.id));
  const [agentId, setAgentId] = useStateF((presetAgent && presetAgent.id) || (choices[0] && choices[0].id));
  const [env, setEnv] = useStateF(environments[0]?.id || ENVIRONMENTS[0].id);
  const [customEnv, setCustomEnv] = useStateF('');
  const [title, setTitle] = useStateF('');
  const [msg, setMsg] = useStateF('');

  const agent = agents.find((a) => a.id === agentId);
  const usingCustom = env === '__custom';
  const finalEnv = usingCustom ? customEnv.trim() : env;
  const valid = !!agentId && !!finalEnv;

  const submit = () => {
    if (!valid) return;
    onCreate({
      id:'sesn_01' + Math.random().toString(36).slice(2, 8) + '…new',
      short:'sesn_…' + Math.random().toString(36).slice(2, 8),
      title: title.trim() || (msg.trim() ? msg.trim().slice(0, 42) : 'Untitled session'),
      status: msg.trim() ? 'running' : 'idle',
      agent: agent.name, env: finalEnv,
      created:'Just now', updated:'Just now', dur:'—', tokens:'0 / 0', resources:0,
    });
  };

  return (
    <Modal icon="activity" title="Create session" sub="Start a new Managed Agents session against a local environment." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/sessions</span></span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />Create session</button>
      </>}>
      <Labeled label="Agent">
        <select className="selectbox" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
          ))}
        </select>
        {agent && <div className="field-hint">{agent.short} · system prompt {agent.system.length} chars · {agent.tools} tools</div>}
      </Labeled>

      <Labeled label="Environment" hint="Pick an existing environment or enter an ID manually.">
        <select className="selectbox" value={env} onChange={(e) => setEnv(e.target.value)}>
          {environments.map((en) => <option key={en.id} value={en.id}>{en.label} — {en.image}</option>)}
          <option value="__custom">Enter an environment ID manually…</option>
        </select>
      </Labeled>
      {usingCustom && (
        <Labeled label="Environment ID">
          <input className="input mono" placeholder="env_…" value={customEnv} onChange={(e) => setCustomEnv(e.target.value)} />
        </Labeled>
      )}

      <Labeled label="Title" opt hint="Defaults to the first message if left blank.">
        <input className="input" placeholder="e.g. Ship your first Managed Agent" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Labeled>

      <Labeled label="First message" opt hint="Send an initial user.message — the session starts running immediately.">
        <textarea className="textarea" placeholder="Send a message to start the session…" value={msg} onChange={(e) => setMsg(e.target.value)} />
      </Labeled>
    </Modal>
  );
}

// ─────────── Create agent ───────────
function CreateAgent({ onClose, onCreate }) {
  const [name, setName] = useStateF('');
  const [model, setModel] = useStateF(MODELS[1]);
  const [prompt, setPrompt] = useStateF('');
  const [tools, setTools] = useStateF(['bash']);

  const valid = name.trim().length > 0;
  const toggle = (t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]);

  const submit = () => {
    if (!valid) return;
    onCreate({
      id:'agent_01' + Math.random().toString(36).slice(2, 8) + '…new',
      short:'agent_…' + Math.random().toString(36).slice(2, 8),
      name: name.trim(), model, status:'active', created:'Just now', updated:'Just now', version:'v1',
      tools: tools.length, system: prompt.trim() || 'No system prompt set.',
      toolset:'agent_toolset_20260401', sessions:[],
    });
  };

  return (
    <Modal icon="bot" title="Create agent" sub="Define a reusable agent template — model, prompt, and tools." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/agents</span></span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />Create agent</button>
      </>}>
      <div className="form-row two">
        <Labeled label="Name">
          <input className="input" placeholder="e.g. cwc-agent" value={name} onChange={(e) => setName(e.target.value)} />
        </Labeled>
        <Labeled label="Model">
          <select className="selectbox mono" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Labeled>
      </div>

      <Labeled label="System prompt" opt hint="Plain text. Markdown is preserved.">
        <textarea className="textarea" placeholder="You help me navigate…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Labeled>

      <Labeled label="Built-in tools" hint="Permissions default to “ask” and can be tuned after creation.">
        <div className="seg-tools">
          {TOOL_OPTIONS.map((t) => {
            const on = tools.includes(t);
            return (
              <span key={t} className={'tool-toggle' + (on ? ' on' : '')} onClick={() => toggle(t)}>
                <span className="chk">{on && <Icon name="checkCircle" size={9} />}</span>
                <span className="mono">{t}</span>
              </span>
            );
          })}
        </div>
      </Labeled>
    </Modal>
  );
}

Object.assign(window, { Modal, CreateSession, CreateAgent, ConfirmDialog });

// ─────────── Archive / delete confirmation ───────────
function ConfirmDialog({ icon = 'archive', danger, title, message, confirmLabel, endpoint, onClose, onConfirm }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className={'ic' + (danger ? ' danger' : '')}><Icon name={icon} size={18} /></div>
          <div><h2>{title}</h2></div>
          <span className="kebab x" onClick={onClose}><Icon name="x" size={17} /></span>
        </div>
        <div className="modal-body">
          <div className="confirm-msg">{message}</div>
        </div>
        <div className="modal-foot">
          {endpoint && <span className="left">Sends to <span className="mono">{endpoint}</span></span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
