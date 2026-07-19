// icons.jsx — compact Lucide-style icon set (stroke, 24 viewBox)
const ICON_PATHS = {
  activity: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
  bot: 'M12 8V4H8 M4 8h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z M2 14h.01 M18 14h.01 M9 13v2 M15 13v2',
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  search: 'M21 21l-4.34-4.34 M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  plus: 'M5 12h14 M12 5v14',
  chevDown: 'M6 9l6 6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  chevLeft: 'M15 6l-6 6 6 6',
  clock: 'M12 6v6l4 2 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  layers: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z M2 12.5l8.58 3.9a2 2 0 0 0 1.66 0L21 12.5 M2 17l8.58 3.9a2 2 0 0 0 1.66 0L21 17',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  play: 'M6 3l14 9-14 9Z',
  stop: 'M9 9h6v6H9z M5 5h14v14H5z',
  x: 'M18 6L6 18 M6 6l12 12',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  terminal: 'M4 17l6-6-6-6 M12 19h8',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  arrowRight: 'M5 12h14 M12 5l7 7-7 7',
  checkCircle: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
  fileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  sparkles: 'M9.94 6.5l-1.7 3.7-3.7 1.7 3.7 1.7 1.7 3.7 1.7-3.7 3.7-1.7-3.7-1.7zM18 4l-.8 1.8-1.8.8 1.8.8.8 1.8.8-1.8 1.8-.8-1.8-.8zM18 16l-.6 1.4-1.4.6 1.4.6.6 1.4.6-1.4 1.4-.6-1.4-.6z',
  archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 10v6 M12 7h.01',
  panelLeft: 'M3 3h18v18H3z M9 3v18',
  copy: 'M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5',
  cpu: 'M9 9h6v6H9z M4 7h2 M4 12h2 M4 17h2 M18 7h2 M18 12h2 M18 17h2 M7 4v2 M12 4v2 M17 4v2 M7 18v2 M12 18v2 M17 18v2 M6 6h12v12H6z',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  hash: 'M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18',
  gitBranch: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M15 6a9 9 0 0 1-9 9',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5 M3 12c0 1.66 4 3 9 3s9-1.34 9-3',
  send: 'M14.54 9.46L4 14l16 6-6-16-4.54 10.54z M14.54 9.46L20 4',
};
function Icon({ name, size = 16, sw = 1.75, style, className }) {
  const d = ICON_PATHS[name];
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flex:'0 0 auto', ...style }}>
      {d.split(' M').map((seg, i) => <path key={i} d={(i ? 'M' : '') + seg} />)}
    </svg>
  );
}
window.Icon = Icon;
