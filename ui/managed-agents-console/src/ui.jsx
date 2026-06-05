// ui.jsx — shared console chrome (status, sidebar, toolbar bits). → window
const { useState } = React;

const STLABEL = { running:'Running', active:'Active', idle:'Idle', error:'Error', archived:'Archived', open:'open', action:'Needs action' };
function St({ k }) {
  return <span className={'badge st-' + k}><i className="dot" />{STLABEL[k] || k}</span>;
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

function Sidebar({ route, go }) {
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
      <div className="nav-label">Read-only</div>
      <div className="nav-item dim"><Icon name="database" size={16} />Environments</div>
      <div className="sidebar-spacer" />
      <div className="sidebar-foot">
        <div className="nav-item dim"><Icon name="fileText" size={16} />Documentation</div>
        <div className="nav-item dim"><Icon name="terminal" size={16} />localhost:4000</div>
      </div>
    </aside>
  );
}

function PageHead({ title, sub, action, onAction }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {action && <button className="btn btn-primary" onClick={onAction}><Icon name="plus" size={15} />{action}</button>}
    </div>
  );
}

Object.assign(window, { St, Pill, Field, Select, Kebab, Pager, Crumbs, Sidebar, PageHead });
