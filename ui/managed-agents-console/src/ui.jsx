// ui.jsx — shared console chrome (status, sidebar, toolbar bits). → window
const { useState } = React;

const STLABEL = {
  running:'Running',
  rescheduling:'Rescheduling',
  active:'Active',
  idle:'Idle',
  error:'Error',
  archived:'Archived',
  terminated:'Terminated',
  open:'open',
  action:'Needs action'
};
function St({ k }) {
  return <span className={'badge st-' + k}><i className="dot" />{STLABEL[k] || k}</span>;
}

function NeedsAction() {
  return <span className="badge st-action"><i className="dot" />Needs action</span>;
}

function Pill({ icon, children }) {
  return <span className="pill">{icon && <Icon name={icon} size={12} />}{children}</span>;
}

function Field({ icon = 'search', placeholder, wide, value, onChange, style }) {
  return (
    <div className="field" style={{ flex: wide ? 1 : undefined, maxWidth: wide ? 360 : undefined, ...style }}>
      {icon && <Icon name={icon} size={15} />}
      <input placeholder={placeholder} value={value || ''} onChange={(e) => onChange && onChange(e.target.value)} />
    </div>
  );
}

function Select({ label, value, w }) {
  return (
    <div className="field select" style={{ width:w }}>
      <span style={{ color:'var(--faint)' }}>{label}</span>
      {value && <b>{value}</b>}
      <Icon name="chevDown" size={14} className="chev" />
    </div>
  );
}

function Kebab() { return <span className="kebab"><Icon name="more" size={16} /></span>; }
function Pager() {
  return (
    <div className="pager">
      <button className="btn"><Icon name="chevLeft" size={15} /></button>
      <button className="btn"><Icon name="chevRight" size={15} /></button>
    </div>
  );
}
function Crumbs({ items }) {
  return (
    <div className="crumbs">
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="sep">/</span>}
          {it.onClick ? <a onClick={it.onClick}>{it.label}</a> : <span style={{ color:'var(--ink)' }}>{it.label}</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

const NAV = [
  { key:'start', label:'Start', icon:'checkCircle' },
  { key:'sessions', label:'Sessions', icon:'activity' },
  { key:'agents', label:'Agents', icon:'bot' },
  { key:'environments', label:'Environments', icon:'database' },
  { key:'files', label:'Files', icon:'folder' },
  { key:'vaults', label:'Vaults', icon:'database' },
  { key:'skills', label:'Skills', icon:'fileText' },
];

function WorkspaceSwitcher({ workspace, admin, onSelectWorkspace, onSwitchWorkspace, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && admin && workspaces === null) {
      OmaConsoleApi.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
    }
  };
  const label = workspace?.name || (admin ? 'Choose workspace' : 'Connect workspace');
  return (
    <div className="workspace-switcher">
      <button className="ws" type="button" onClick={toggle} aria-expanded={open}>
        <span className="ws-dot" /><span className="ws-name">{label}</span>
        <Icon name="chevDown" size={14} className="ws-chev" />
      </button>
      {open && <div className="workspace-menu">
        {admin && <>
          <div className="workspace-menu-label">Switch workspace</div>
          {workspaces === null ? <div className="workspace-menu-note">Loading workspaces…</div>
            : workspaces.length === 0 ? <div className="workspace-menu-note">No workspaces yet.</div>
            : workspaces.map((item) => <button key={item.id} type="button" className="workspace-menu-item"
              onClick={() => { setOpen(false); onSelectWorkspace(item.id); }}>
              <span>{item.name}</span><small className="mono">{item.id}</small>
            </button>)}
        </>}
        {!admin && <button type="button" className="workspace-menu-item" onClick={() => { setOpen(false); onSwitchWorkspace(); }}>
          Enter another workspace key
        </button>}
        <button type="button" className="workspace-menu-item workspace-signout" onClick={() => { setOpen(false); onSignOut(); }}>
          Sign out
        </button>
      </div>}
    </div>
  );
}

function Sidebar({ route, go, showAdmin = false, workspace, admin = false, onSelectWorkspace, onSwitchWorkspace, onSignOut }) {
  const top = route === 'session' ? 'sessions' : route === 'agent' ? 'agents' : route;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">O</div>
        <div className="brand-name">OMA Console<small>Managed Agents</small></div>
      </div>
      <WorkspaceSwitcher workspace={workspace} admin={admin} onSelectWorkspace={onSelectWorkspace}
        onSwitchWorkspace={onSwitchWorkspace} onSignOut={onSignOut} />
      <div className="nav-label">Managed Agents</div>
      {NAV.map((n) => (
        <div key={n.key} className={'nav-item' + (top === n.key ? ' active' : '')} onClick={() => go(n.key)}>
          <Icon name={n.icon} size={16} />{n.label}
        </div>
      ))}
      {showAdmin && <>
        <div className="nav-label">Operator</div>
        <div className={'nav-item' + (top === 'admin' ? ' active' : '')} onClick={() => go('admin')}>
          <Icon name="database" size={16} />Admin
        </div>
      </>}
      <div className="sidebar-spacer" />
      <div className="sidebar-foot">
        <button type="button" className={'nav-item' + (top === 'documentation' ? ' active' : '')} onClick={() => go('documentation')}>
          <Icon name="fileText" size={16} />Documentation
        </button>
        <div className="nav-item dim"><Icon name="terminal" size={16} />proxy /v1</div>
      </div>
    </aside>
  );
}

function PageHead({ title, sub, action, onAction, readOnly = false, endpoint }) {
  const disabled = Boolean(action && readOnly);
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {action && <div className="action-wrap" title={disabled && endpoint ? `Read-only API mode · ${endpoint}` : undefined}>
        <button className={'btn btn-primary' + (disabled ? ' ro' : '')}
          disabled={disabled}
          onClick={disabled ? undefined : onAction}>
          <Icon name="plus" size={15} />{action}
        </button>
        {disabled && endpoint && <span className="endpoint-hint mono">{endpoint}</span>}
      </div>}
    </div>
  );
}

function ModeBar({ mode, warnings = [] }) {
  const label = mode === 'demo'
    ? 'Demo review mode'
    : mode === 'error'
      ? 'Live API unavailable'
      : 'Live API mode';
  const copy = mode === 'demo'
    ? 'Local interactions mutate bundled demo data only.'
    : mode === 'error'
      ? 'The live request failed; no bundled demo records are being shown.'
      : 'Live agent, environment, session, prompt, interrupt, and confirmation actions are enabled; unsupported writes stay disabled.';
  return (
    <div className={'modebar mode-' + mode}>
      <Icon name={mode === 'api' ? 'database' : 'alert'} size={14} />
      <span className="mode-main">{label}</span>
      <span className="mode-copy">{copy}</span>
      {warnings.length > 0 && <span className="mode-warn">{warnings.join(' ')}</span>}
    </div>
  );
}

Object.assign(window, { St, NeedsAction, Pill, Field, Select, Kebab, Pager, Crumbs, Sidebar, PageHead, ModeBar });
