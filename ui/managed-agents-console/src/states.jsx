// states.jsx — loading skeletons, empty states, error envelope → window
// Anthropic-shaped error envelope for the error state.
function errEnvelope(resource) {
  return JSON.stringify({
    type:'error',
    error:{ type:'api_error', message:`Failed to load ${resource}. The upstream OMA server returned an internal error.` },
    request_id:'req_011CRvH9b2Qm4kZ2nXa7TfP',
  }, null, 2);
}

// skeleton table — cols: array of widths (number=px fixed, 'grow'=flex)
function SkeletonTable({ rows = 6, cols = ['grow', 90, 160, 70], lead = true }) {
  return (
    <div className="panel" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          {lead && <span className="skel skel-dot" />}
          {cols.map((c, j) => {
            if (c === 'grow') return <span key={j} className="skel" style={{ height:11, flex:1, maxWidth: 120 + (i * 37 % 180) }} />;
            if (typeof c === 'string' && c === 'pill') return <span key={j} className="skel skel-pill" style={{ width:84, flex:'0 0 auto' }} />;
            return <span key={j} className="skel" style={{ height:11, width:c, flex:'0 0 auto' }} />;
          })}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon = 'folder', title, message, actionLabel, onAction, secondaryLabel, onSecondary }) {
  return (
    <div className="panel">
      <div className="state">
        <div className="state-ic"><Icon name={icon} size={22} /></div>
        <h3>{title}</h3>
        <p>{message}</p>
        {(actionLabel || secondaryLabel) && (
          <div className="actions">
            {secondaryLabel && <button className="btn" onClick={onSecondary}>{secondaryLabel}</button>}
            {actionLabel && <button className="btn btn-primary" onClick={onAction}><Icon name="plus" size={15} />{actionLabel}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorState({ resource = 'data', onRetry }) {
  return (
    <div className="panel">
      <div className="state">
        <div className="state-ic err"><Icon name="alert" size={22} /></div>
        <h3>Couldn’t load {resource}</h3>
        <p>The request to the OMA control plane failed. Check that the local server is running, then retry.</p>
        <div className="err-envelope">
          <div className="code scroll"><pre>{errEnvelope(resource)}</pre></div>
          <div className="req"><Icon name="hash" size={13} />request_id <span className="mono">req_011CRvH9b2Qm4kZ2nXa7TfP</span></div>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={onRetry}><Icon name="refresh" size={15} />Retry</button>
        </div>
      </div>
    </div>
  );
}

function PartialNotice({ resource = 'data' }) {
  return (
    <div className="inline-warn">
      <Icon name="alert" size={14} />
      <span>{resource} reached the 100-page safety cap; this view may be incomplete.</span>
    </div>
  );
}

// inline stream skeleton (event rows)
function SkeletonStream({ rows = 5 }) {
  return (
    <div className="panel" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel skel-pill" style={{ width:52, flex:'0 0 auto' }} />
          <span className="skel" style={{ height:11, flex:1, maxWidth: 200 + (i * 53 % 220) }} />
          <span className="skel" style={{ height:10, width:46, flex:'0 0 auto', marginLeft:'auto' }} />
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { SkeletonTable, SkeletonStream, EmptyState, ErrorState, PartialNotice });
