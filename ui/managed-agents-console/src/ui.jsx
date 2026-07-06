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
  { key:'sessions', label:'Sessions', icon:'activity' },
  { key:'agents', label:'Agents', icon:'bot' },
  { key:'files', label:'Files', icon:'folder' },
];

function Sidebar({ route, go, showAdmin = false }) {
  const top = route === 'session' ? 'sessions' : route === 'agent' ? 'agents' : route;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">O</div>
        <div className="brand-name">OMA Console<small>Managed Agents</small></div>
      </div>
      <div className="ws">
        <span className="ws-dot" /><span className="ws-name">Default</span>
        <Icon name="chevDown" size={14} className="ws-chev" />
      </div>
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
      <div className="nav-label">Read-only</div>
      <div className="nav-item dim"><Icon name="database" size={16} />Environments</div>
      <div className="sidebar-spacer" />
      <div className="sidebar-foot">
        <div className="nav-item dim"><Icon name="fileText" size={16} />Documentation</div>
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
    : mode === 'mock'
      ? 'Offline — bundled demo data'
      : 'Read-only API mode';
  const copy = mode === 'demo'
    ? 'Local interactions mutate bundled demo data only.'
    : mode === 'mock'
      ? 'The API is unavailable; writes are disabled and demo data is clearly marked.'
      : 'Live API data is inspectable; create, send, archive, delete, and confirm actions are disabled.';
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
