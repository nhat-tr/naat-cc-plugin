const { gzipSync } = require('node:zlib');

const RAW_STANDALONE_LIMIT_BYTES = 3 * 1024 * 1024;

function copyText(value) {
  return typeof value === 'string' ? value : null;
}

function copyScreenIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = {};
  for (const key of ['id', 'revision']) {
    const text = copyText(value[key]);
    if (text != null) identity[key] = text;
  }
  const file = copyText(value.file);
  if (file && /^[a-zA-Z0-9._-]+$/.test(file)) identity.file = file;
  return Object.keys(identity).length ? identity : null;
}

function copyTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = {};
  for (const key of ['componentId', 'selector', 'label']) {
    const text = copyText(value[key]);
    if (text != null) target[key] = text;
    else if (value[key] === null) target[key] = null;
  }
  return Object.keys(target).length ? target : null;
}

function copyAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.map(annotation => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return null;
    const exported = {};
    for (const key of ['id', 'comment']) {
      const text = copyText(annotation[key]);
      if (text != null) exported[key] = text;
    }
    const target = copyTarget(annotation.target);
    if (target) exported.target = target;
    return exported;
  }).filter(Boolean);
}

function copyChoices(value) {
  if (!Array.isArray(value)) return [];
  return value.map(choice => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return null;
    const exported = {};
    for (const key of ['groupId', 'componentId', 'value', 'label']) {
      const text = copyText(choice[key]);
      if (text != null) exported[key] = text;
      else if (choice[key] === null) exported[key] = null;
    }
    return exported;
  }).filter(Boolean);
}

function copyEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = {};
  for (const key of ['version', 'id', 'seq', 'timestamp', 'type', 'role', 'clientTurnId', 'message', 'replyTo']) {
    const field = value[key];
    if (typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field))) {
      event[key] = field;
    }
  }
  if (value.type === 'user.turn') {
    event.annotations = copyAnnotations(value.annotations);
    event.choices = copyChoices(value.choices);
    const screen = copyScreenIdentity(value.screen);
    if (screen) event.screen = screen;
  }
  return event;
}

function exportSession(value) {
  const session = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const exported = {
    version: Number.isInteger(session.version) ? session.version : 1,
    cursor: Number.isInteger(session.cursor) ? session.cursor : 0,
    pendingTurns: Number.isInteger(session.pendingTurns) ? session.pendingTurns : 0,
    events: Array.isArray(session.events) ? session.events.map(copyEvent).filter(Boolean) : [],
  };
  return exported;
}

function copyRevisionSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.seq)
    || typeof value.revision !== 'string'
    || value.document == null
    || typeof value.document !== 'object') return null;
  const snapshot = {
    seq: value.seq,
    revision: value.revision,
    document: structuredClone(value.document),
  };
  if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) {
    snapshot.timestamp = value.timestamp;
  }
  return snapshot;
}

function exportRevisions(value) {
  return Array.isArray(value) ? value.map(copyRevisionSnapshot).filter(Boolean) : [];
}

// Bundle the fixed shell, the current document, and allowlisted feedback history into one
// self-contained HTML file. The host owns read-only behavior; the Revision-bearing Visual
// Document remains byte-for-byte semantic state rather than being rewritten for export.
function workerBootstrap(worker) {
  if (worker == null) return '';
  const compressed = gzipSync(String(worker), { level: 9 }).toString('base64');
  return `<script>window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__ = (async () => {
    const encoded = "${compressed}";
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const source = await new Response(stream).text();
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  })();</script>`;
}

function renderStandalone({ shell, styles, script, worker, screen, session, revisions }) {
  const state = { screen: structuredClone(screen), session: exportSession(session), readOnly: true };
  const revisionTimeline = exportRevisions(revisions);
  if (revisionTimeline.length > 0) state.revisions = revisionTimeline;
  const embedded = JSON.stringify(state)
    .replace(/</g, '\\u003c');
  const inlineScript = String(script).replace(/<\/script/giu, '<\\/script');
  const inlineWorker = workerBootstrap(worker);
  const rawStandalone = String(shell)
    .replace('__BRAINSTORM_BASE_PATH_ATTR__', '/')
    .replace(
      '<link rel="stylesheet" href="assets/styles.css">',
      () => `<style>\n${styles}\n</style>`,
    )
    .replace(
      '<script src="assets/app.js"></script>',
      () => `${inlineWorker}\n  <script>window.__BRAINSTORM_EMBEDDED__ = ${embedded};</script>\n  <script>\n${inlineScript}\n</script>`,
    );

  if (Buffer.byteLength(rawStandalone) <= RAW_STANDALONE_LIMIT_BYTES) return rawStandalone;

  const payload = JSON.stringify({
    script: String(script),
    styles: String(styles),
  });
  const compressed = gzipSync(payload, { level: 9 }).toString('base64');
  const bootstrap = `(() => {
    const encoded = "${compressed}";
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    new Response(stream).text().then(serialized => {
      const payload = JSON.parse(serialized);
      const style = document.createElement("style");
      style.textContent = payload.styles;
      document.head.append(style);
      const sourceUrl = URL.createObjectURL(new Blob([payload.script], { type: "text/javascript" }));
      const application = document.createElement("script");
      application.src = sourceUrl;
      application.addEventListener("load", () => URL.revokeObjectURL(sourceUrl), { once: true });
      document.body.append(application);
    }).catch(error => setTimeout(() => { throw error; }));
  })();`;

  const compressedStandalone = String(shell)
    .replace('__BRAINSTORM_BASE_PATH_ATTR__', '/')
    .replace('<link rel="stylesheet" href="assets/styles.css">', '')
    .replace(
      '<script src="assets/app.js"></script>',
      `${inlineWorker}\n  <script>window.__BRAINSTORM_EMBEDDED__ = ${embedded};</script>\n  <script>${bootstrap}</script>`,
    );

  if (Buffer.byteLength(compressedStandalone) <= RAW_STANDALONE_LIMIT_BYTES) {
    return compressedStandalone;
  }

  const fullyCompressedPayload = JSON.stringify({
    script: String(script),
    state,
    styles: String(styles),
    worker: worker == null ? null : String(worker),
  });
  const fullyCompressed = gzipSync(fullyCompressedPayload, { level: 9 }).toString('base64');
  const fullyCompressedBootstrap = `(() => {
    const encoded = "${fullyCompressed}";
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    new Response(stream).text().then(serialized => {
      const payload = JSON.parse(serialized);
      window.__BRAINSTORM_EMBEDDED__ = payload.state;
      if (payload.worker !== null) {
        const workerUrl = URL.createObjectURL(new Blob([payload.worker], { type: "text/javascript" }));
        window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__ = Promise.resolve(workerUrl);
      }
      const style = document.createElement("style");
      style.textContent = payload.styles;
      document.head.append(style);
      const sourceUrl = URL.createObjectURL(new Blob([payload.script], { type: "text/javascript" }));
      const application = document.createElement("script");
      application.src = sourceUrl;
      application.addEventListener("load", () => URL.revokeObjectURL(sourceUrl), { once: true });
      document.body.append(application);
    }).catch(error => setTimeout(() => { throw error; }));
  })();`;

  return String(shell)
    .replace('__BRAINSTORM_BASE_PATH_ATTR__', '/')
    .replace('<link rel="stylesheet" href="assets/styles.css">', '')
    .replace(
      '<script src="assets/app.js"></script>',
      `<script>${fullyCompressedBootstrap}</script>`,
    );
}

module.exports = { RAW_STANDALONE_LIMIT_BYTES, exportRevisions, exportSession, renderStandalone };
