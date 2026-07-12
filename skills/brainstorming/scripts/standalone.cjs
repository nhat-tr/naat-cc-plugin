// Bundle the fixed shell, the current document, and the conversation history into one
// self-contained HTML file that opens from disk (file://) with no server, token, or network.
// Shared by the running server (live artifact) and the CLI export/stop commands.
function renderStandalone({ shell, styles, script, screen, session }) {
  const embedded = JSON.stringify({ screen, session, readOnly: true }).replace(/</g, '\\u003c');
  return String(shell)
    .replace('__BRAINSTORM_BASE_PATH_ATTR__', '/')
    .replace(
      '<link rel="stylesheet" href="assets/styles.css">',
      `<style>\n${styles}\n</style>`,
    )
    .replace(
      '<script src="assets/app.js"></script>',
      `<script>window.__BRAINSTORM_EMBEDDED__ = ${embedded};</script>\n  <script>\n${script}\n</script>`,
    );
}

module.exports = { renderStandalone };
