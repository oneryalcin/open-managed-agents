// skills.jsx — workspace custom-skill inventory. Skill bundles are uploaded
// separately, then attached to an immutable agent version during authoring.
function SkillsView({ skills = [], mode, onCreate, readOnly = false }) {
  const live = mode === 'api';
  return <div className="main-scroll scroll fade-in">
    <PageHead title="Skills" sub="Upload reusable custom skill bundles, then attach them to an agent version."
      action="Upload skill" onAction={onCreate} readOnly={readOnly} endpoint="POST /v1/skills" />
    <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>OMA supports custom skill bundles. Anthropic-hosted prebuilt skills are not provided by this appliance.</span></div>
    {!live ? <div className="field-hint" style={{ marginTop:14 }}>Demo mode does not persist uploaded skill bundles.</div>
      : skills.length === 0 ? <EmptyState icon="fileText" title="No custom skills" message="Upload a bundle containing SKILL.md and its supporting files, then select it when creating an agent."
        actionLabel={!readOnly ? 'Upload skill' : null} onAction={onCreate} />
      : <div className="panel" style={{ marginTop:14 }}>
        <div className="thead"><span className="th grow">Skill</span><span className="th" style={{ width:130 }}>Latest version</span><span className="th" style={{ width:110 }}>Created</span></div>
        {skills.map((skill) => <div className="trow" key={skill.id} style={{ cursor:'default' }}>
          <span className="td grow"><span className="cell-strong">{skill.display_title}</span><div className="mono" style={{ fontSize:11.5, color:'var(--faint)', marginTop:3 }}>{skill.id}</div></span>
          <span className="td mono" style={{ width:130, color:'var(--soft)' }}>{skill.latest_version || '—'}</span>
          <span className="td mono" style={{ width:110, color:'var(--faint)' }}>{skill.created_at ? new Date(skill.created_at).toLocaleDateString() : '—'}</span>
        </div>)}
      </div>}
  </div>;
}
