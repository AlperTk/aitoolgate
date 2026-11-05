/* ==========================================================================
 * policy-actions.mjs — the tool-call detail panel's "Policy" quick-actions:
 * buildPolicySection (markup), bindPolicySection (click wiring),
 * handlePolicyAction (dispatch) and createPolicyRule (quick-create + dedupe).
 * Pure feature logic over ../rules/rules.mjs; no imports back into live/view.mjs.
 * ========================================================================== */
import { esc, showNotice } from '../core/dom.mjs';
import { state } from '../core/state.mjs';
import { t } from '../i18n/index.mjs';
import { createRule, prefillNewRule, refreshRules, findDuplicatePolicyRule } from '../rules/rules.mjs';

// Wire the policy quick-action buttons built by buildPolicySection: the Policy
// section's Hide / Override / New controls. Called by renderRowDetail
// after the detail innerHTML is (re)built, so each fresh DOM has fresh
// listeners. Every button is bound by its data-policy attribute wherever it
// appears in the detail panel. Re-enables a clicked button once the action
// settles so rapid double-clicks do not stack requests.
export function bindPolicySection(rs, detailEl) {
  var ev = rs.callEv || rs.resultEv;
  var name = ev && typeof ev.toolName === 'string' ? ev.toolName : '';
  if (!name) return;
  var description = ev && typeof ev.description === 'string' ? ev.description : '';
  detailEl.querySelectorAll('button[data-policy]').forEach(function (btn) {
    var action = btn.getAttribute('data-policy');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      var p = handlePolicyAction(action, name, description);
      if (p && typeof p.then === 'function') {
        p.then(function () { btn.disabled = false; }, function () { btn.disabled = false; });
      } else {
        btn.disabled = false;
      }
    });
  });
}

// Build the compact "Policy" quick-actions section for a row. Returns an HTML
// string when the row has a non-empty tool name, otherwise '' (name-less orphan
// rows show no policy controls). The three controls map to data-policy:
// hide | addDescription | new. All text is escaped; the arrow is U+2192.
export function buildPolicySection(rs) {
  var ev = rs.callEv || rs.resultEv;
  var name = ev && typeof ev.toolName === 'string' ? ev.toolName : '';
  if (!name) return '';
  var label = t('live.policy.actionsFor', { name: name });
  return '<div class="rd-section policy-section" role="group" aria-label="' + esc(label) + '">'
    + '<div class="rd-label">' + esc(t('live.policy.title')) + '</div>'
    + '<div class="policy-actions">'
    + '<button type="button" class="btn btn-primary policy-btn" data-policy="hide" aria-label="' + esc(t('live.policy.hideAria', { name: name })) + '">' + esc(t('live.policy.hide')) + '</button>'
    + '<button type="button" class="btn policy-btn policy-add-desc" data-policy="addDescription" aria-label="' + esc(t('live.policy.overrideAria', { name: name })) + '">' + esc(t('live.policy.override')) + '</button>'
    + '<button type="button" class="btn policy-btn policy-new" data-policy="new" aria-label="' + esc(t('live.policy.newAria', { name: name })) + '">' + esc(t('live.policy.new')) + '</button>'
    + '</div>'
    + '</div>';
}
// Dispatch a policy quick-action by `action` ('hide' | 'new' |
// 'addDescription') for the given tool `name` (plus the row's description for
// 'addDescription'). Hide POSTs an enabled rule immediately; 'new' and
// 'addDescription' navigate to the pre-filled editor (synchronous) and return a
// resolved promise.
export function handlePolicyAction(action, name, description) {
  if (action === 'hide') {
    return createPolicyRule(name, {
      enabled: true,
      matcher: { type: 'toolName', toolName: name },
      action: { type: 'hideTool', toolNames: [name] }
    });
  }
  if (action === 'new') {
    prefillNewRule({
      enabled: true,
      matcher: { type: 'toolName', toolName: name },
      action: { type: 'hideTool', toolNames: [name] } // default action; the user changes it in the editor
    });
    return Promise.resolve();
  }
  if (action === 'addDescription') {
    prefillNewRule(name, typeof description === 'string' ? description : '');
    return Promise.resolve();
  }
  return Promise.resolve();
}
// Quick-create an enabled rule for `name` (spec already carries matcher + action).
// Minimal dedupe: if an ENABLED identical rule already exists in the cached
// state.rules, skip the POST and notify instead of stacking duplicates. On success
// re-sync the rules list (and state.rules) then confirm via the global notice.
// createRule has already surfaced a failure notice by the time it throws, so the
// catch only suppresses the success path.
export async function createPolicyRule(name, spec) {
  var actionType = spec.action && spec.action.type;
  var dup = findDuplicatePolicyRule(state.rules, name, actionType);
  if (dup && dup.enabled === true) {
    showNotice(t('live.policy.alreadyHidden', { name: name }));
    return;
  }
  try {
    await createRule(spec);
    await refreshRules(); // re-sync the rendered list + state.rules
    showNotice(t('live.policy.created', { name: name }));
  } catch (e) {
    // createRule already called showNotice('Rule not created: ...')
    console.warn('createPolicyRule failed for ' + name, e);
  }
}
