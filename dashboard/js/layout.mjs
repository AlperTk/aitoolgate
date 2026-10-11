/* ==========================================================================
 * aitoolgate dashboard — layout composition.
 *
 * Leaf module (imports nothing). The shell (index.html) holds only placeholder
 * slots; this fetches the external HTML fragments that make up the page body
 * and mounts each into its slot — replacing the slot element with the fragment's
 * parsed nodes so the resulting DOM matches the original static markup. It runs
 * BEFORE any feature wiring (see app.js boot()).
 *
 * Resilient by design (matching the dashboard's dual-source philosophy): a
 * missing slot, a non-ok fetch, or a parse error is reported via console.error,
 * shows a visible "Failed to load dashboard section." message in that slot, and
 * the remaining fragments still mount.
 * ==================================================================== */

// Ordered pairs of [slotId, absoluteFragmentUrl]. Fragment URLs are anchored to
// THIS module's own location (import.meta.url) rather than the document location,
// so they resolve correctly whether the page is served at the web root, under a
// tunnel/port-forward subpath, or any other base path — exactly like the
// browser already resolved the relative app.js/styles.css links that loaded this
// module. import.meta.url ends in .../js/layout.mjs, so each fragment sits at ../html/*.
function fragmentUrl(relPath) {
  return new URL(relPath, import.meta.url).href;
}
const FRAGMENTS = [
  ['app-header-slot', fragmentUrl('../html/header.html')],
  ['view-rules-slot', fragmentUrl('../html/rules-view.html')]
];

const FAIL_MSG = 'Failed to load dashboard section.';

// Fetch one fragment, parse it into a <template>, and replace the slot element
// with the parsed fragment nodes. Never throws: on any failure it reports the
// problem and labels the slot, then returns so the caller can continue.
async function mountFragment(slotId, path) {
  const slot = document.getElementById(slotId);
  if (!slot) {
    console.error('[layout] Missing slot "' + slotId + '" for fragment "' + path + '".');
    return;
  }
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tpl = document.createElement('template');
    tpl.innerHTML = await res.text();
    slot.replaceWith(tpl.content); // preserve structure: swap the slot for its fragment nodes
  } catch (e) {
    console.error(
      '[layout] Failed to load "' + path + '" into "' + slotId + '": ' +
        (e && e.message ? e.message : String(e))
    );
    slot.textContent = FAIL_MSG;
  }
}

// Mount every fragment in order. A per-fragment failure does not abort the rest.
export async function mountLayout() {
  for (const [slotId, path] of FRAGMENTS) {
    await mountFragment(slotId, path);
  }
}
