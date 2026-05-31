/**
 * jury-fill.js — bookmarklet payload for the "Fill jury decision" tool.
 *
 * Detects whether the current page is sailti, RRS (racingrulesofsailing.org),
 * or m2s (manage2sail) and fills the matching fields with content from the
 * clipboard. The clipboard payload is produced by the Google Doc add-on
 * (Code.gs / showCopyDialog).
 */
(async () => {
  // Defined early so all helper functions (hoisted or not) can use them.
  const MONTHS = {
    january:0, february:1, march:2, april:3, may:4, june:5,
    july:6, august:7, september:8, october:9, november:10, december:11
  };
  const MONTH_NUM = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12
  };

  let data;
  try {
    data = JSON.parse(await navigator.clipboard.readText());
  } catch (e) {
    alert('Could not read the jury decision from the clipboard.\n\n' +
          'Make sure you clicked "Copy to clipboard" in the Google Doc dialog first.');
    return;
  }

  try {
    if (document.querySelector('[ng-model="item.ProceduralMatters"]')) {
      await fillM2S(data);
    } else if (document.getElementById('decision_procedures_text')) {
      await fillRRS(data);
    } else if (document.getElementById('proceduralMatters_en')) {
      fillSailti(data);
    } else {
      alert('This page does not look like a jury decision form ' +
            '(sailti, RRS, or m2s). Open the form first, then click the bookmark.');
    }
  } catch (e) {
    alert('Error filling the form: ' + e.message);
    throw e;
  }


  // =========================================================================
  // Sailti — older form, plain textareas, jQuery UI datepicker/timepicker.
  // =========================================================================

  function fillSailti(data) {
    const IDS = [
      'proceduralMatters_en', 'factsFound_en', 'rule_en',
      'conclusion_en', 'decision_en',
      'decisionDate', 'decisionTime', 'juryMembers'
    ];
    let filled = 0;
    const notFound = [];

    for (const id of IDS) {
      if (data[id] === undefined) continue;
      const el = document.getElementById(id);
      if (!el) { notFound.push(id); continue; }
      el.value = data[id];
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.jQuery) window.jQuery(el).trigger('change');
      filled++;
    }

    let msg = 'Filled ' + filled + ' field' + (filled === 1 ? '' : 's') + ' on sailti.';
    if (notFound.length) msg += '\nNot found on page: ' + notFound.join(', ');
    alert(msg);
  }


  // =========================================================================
  // RRS — racingrulesofsailing.org. Tabbed form, Trix editors, Chosen/Select2.
  // =========================================================================

  async function fillRRS(data) {
    // 1) Switch to the Hearing tab (Bootstrap 5).
    const hearingTab = document.querySelector('button[data-bs-target="#hearing"]');
    if (hearingTab) {
      hearingTab.click();
      await sleep(150); // let the tab finish showing
    }

    const filled = [];
    const failed = [];

    // 2) Trix-backed long fields.
    const trixMap = [
      ['proceduralMatters_en', 'decision_procedures_text',         'Procedural matters'],
      ['factsFound_en',        'decision_facts_found_text',        'Facts found'],
      ['conclusion_en',        'decision_rules_conclusions_text',  'Conclusions'],
      ['decision_en',          'decision_decision_text',           'Decision'],
      ['shortDecision_en',     'decision_short_decision_text',     'Decision abstract']
    ];
    for (const [src, dst, label] of trixMap) {
      if (data[src] === undefined) continue;
      const ok = await setTrixContent(dst, data[src]);
      (ok ? filled : failed).push(label);
    }

    // 3) Plain text Rules input.
    if (data.rule_en !== undefined) {
      const el = document.getElementById('decision_rules');
      if (el) {
        setInputValue(el, data.rule_en);
        filled.push('Rules');
      } else {
        failed.push('Rules');
      }
    }

    // 4) Date + time combined into datetime-local.
    if (data.decisionDate) {
      const iso = combineDateTime(data.decisionDate, data.decisionTime || '00:00');
      const el = document.getElementById('decision_decision_at');
      if (el && iso) {
        setInputValue(el, iso);
        filled.push('Date of decision');
      } else if (!el) {
        failed.push('Date of decision (field not found)');
      } else {
        failed.push('Date of decision (could not parse "' + data.decisionDate + '")');
      }
    }

    // 5) Jury members: chair → official_chair_id (chosen), the rest → multi-select.
    if (data.juryMembers) {
      const members = data.juryMembers.split(',').map(s => s.trim()).filter(Boolean);
      const result = assignJuryMembers(members);
      if (result.chairSet)               filled.push('Chair (' + result.chairName + ')');
      else if (members.length)           failed.push('Chair (no match for "' + members[0] + '")');
      if (result.membersSet > 0)         filled.push('Jury members (' + result.membersSet + ' matched)');
      if (result.unmatched.length)       filled.push('Other members (' + result.unmatched.length + ' unmatched → "Other" field)');
    }

    let msg = 'RRS form filled.\n\n';
    if (filled.length) msg += '✓ ' + filled.join('\n✓ ');
    if (failed.length) msg += (filled.length ? '\n\n' : '') + '⚠ ' + failed.join('\n⚠ ');
    msg += '\n\nReview before saving. Validity / Witnesses / Committee type are not auto-filled.';
    alert(msg);
  }


  // ---------- Trix helpers ------------------------------------------------

  async function setTrixContent(editorId, plainText) {
    const editor = document.getElementById(editorId);
    if (!editor) return false;

    // Wait for the editor to finish initializing.
    for (let i = 0; i < 20 && !editor.editor; i++) await sleep(50);
    if (!editor.editor) return false;

    editor.editor.loadHTML(plainTextToTrixHTML(plainText));
    return true;
  }

  /**
   * Converts payload text (with optional "1. " "2. " line prefixes from the
   * Apps Script's list-flattening) back into HTML that Trix recognizes — using
   * real <ol><li> so the rendered form looks identical to the source Doc.
   */
  function plainTextToTrixHTML(text) {
    const lines = (text || '').split('\n');
    let html = '';
    let inList = false;
    let prevNum = 0;

    for (const line of lines) {
      const m = line.match(/^(\d+)\.\s+(.*)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        // Start a new list when we hit a "1." or when numbering breaks.
        if (!inList || n <= prevNum) {
          if (inList) html += '</ol>';
          html += '<ol>';
          inList = true;
        }
        html += '<li>' + escapeHtml(m[2]) + '</li>';
        prevNum = n;
      } else {
        if (inList) { html += '</ol>'; inList = false; prevNum = 0; }
        if (line.trim()) html += '<div>' + escapeHtml(line) + '</div>';
        else             html += '<div><br></div>';
      }
    }
    if (inList) html += '</ol>';
    return html || '<div><br></div>';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }


  // ---------- Date / time -------------------------------------------------

  function combineDateTime(dateStr, timeStr) {
    // Accepts "30 May 2026" (the doc's normalized format) plus a few fallbacks.
    let y, mo, d;
    let m = dateStr.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (m) {
      d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3];
    } else if ((m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
      y = +m[1]; mo = +m[2] - 1; d = +m[3];
    } else if ((m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
      d = +m[1]; mo = +m[2] - 1; y = +m[3];
    } else {
      return null;
    }
    if (mo === undefined || isNaN(mo)) return null;

    const pad = n => (n < 10 ? '0' + n : '' + n);
    let hh = '00', mm = '00';
    const tm = (timeStr || '').match(/^(\d{1,2}):(\d{1,2})/);
    if (tm) { hh = pad(+tm[1]); mm = pad(+tm[2]); }

    return y + '-' + pad(mo + 1) + '-' + pad(d) + 'T' + hh + ':' + mm;
  }


  // ---------- Jury members assignment ------------------------------------

  function assignJuryMembers(names) {
    const chairSelect   = document.getElementById('official_chair_id');
    const memberSelect  = document.getElementById('official-select');
    const otherInput    = document.getElementById('decision_other_jury_members');

    let chairSet = false, chairName = '';
    let membersSet = 0;
    const unmatched = [];

    if (names.length && chairSelect) {
      const chairCandidate = names[0];
      const opt = findOption(chairSelect, chairCandidate);
      if (opt) {
        chairSelect.value = opt.value;
        triggerChange(chairSelect);
        chairSet = true;
        chairName = chairCandidate;
      } else {
        unmatched.push(chairCandidate);
      }
    }

    if (memberSelect) {
      for (let i = 1; i < names.length; i++) {
        const opt = findOption(memberSelect, names[i]);
        if (opt) {
          opt.selected = true;
          membersSet++;
        } else {
          unmatched.push(names[i]);
        }
      }
      triggerChange(memberSelect);
    } else {
      // No multi-select on the page; everything non-chair is unmatched.
      for (let i = 1; i < names.length; i++) unmatched.push(names[i]);
    }

    if (otherInput && unmatched.length) {
      setInputValue(otherInput, unmatched.join(', '));
    }

    return { chairSet, chairName, membersSet, unmatched };
  }

  /**
   * Finds a <select>'s option that matches a name. Compares the name portion
   * before "(" (e.g. "Maria Ramires (IJ-POR)" → "Maria Ramires") so the
   * country/role suffixes in either string don't prevent a match.
   */
  function findOption(select, name) {
    const target = stripParens(name).toLowerCase();
    if (!target) return null;
    for (const opt of select.options) {
      const optName = stripParens(opt.textContent).toLowerCase();
      if (optName === target) return opt;
    }
    // Fallback: substring match (e.g. one side has the country code, other doesn't).
    for (const opt of select.options) {
      const optName = stripParens(opt.textContent).toLowerCase();
      if (optName && (optName.indexOf(target) >= 0 || target.indexOf(optName) >= 0)) return opt;
    }
    return null;
  }
  function stripParens(s) { return (s || '').replace(/\([^)]*\)/g, '').trim(); }


  // ---------- Generic helpers -------------------------------------------

  function setInputValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    triggerChange(el);
  }

  function triggerChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) window.jQuery(el).trigger('change');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }



  // =========================================================================
  // manage2sail (m2s) — AngularJS app with Summernote editors and Chosen
  // selects. Form controls use name="" and ng-model="" rather than id="".
  // =========================================================================

  async function fillM2S(data) {
    // 1) Switch to the Hearing tab.
    const hearingLink = document.querySelector('a[href="#hearing"][sg-tab]');
    if (hearingLink) {
      hearingLink.click();
      await sleep(200);
    }

    if (!window.jQuery) {
      alert('Cannot fill: jQuery not found on this page.');
      return;
    }
    const $ = window.jQuery;
    const scope = getRootDetailScope();

    const filled = [];
    const failed = [];

    // 2) Summernote-backed long fields. Set via the summernote('code', ...)
    //    API which is the only reliable way to push content + sync ng-model.
    const summernoteMap = [
      ['proceduralMatters_en', 'item.ProceduralMatters', 'Procedural matters'],
      ['factsFound_en',        'item.FactsFound',        'Facts found'],
      ['conclusion_en',        'item.Conclusion',        'Conclusions'],
      ['decision_en',          'item.Decision',          'Decision']
    ];
    for (const [src, ngModel, label] of summernoteMap) {
      if (data[src] === undefined) continue;
      const ok = setSummernoteContent($, scope, ngModel, plainTextToTrixHTML(data[src]));
      (ok ? filled : failed).push(label);
    }

    // 3) Plain text inputs by name attribute.
    if (data.rule_en !== undefined) {
      // Note: m2s misspelled the field name as "tules_applicable" in their HTML.
      const el = document.querySelector('input[name="tules_applicable"]');
      if (el) { setAngularInput($, el, data.rule_en); filled.push('Rules'); }
      else                                              failed.push('Rules');
    }
    if (data.shortDecision_en !== undefined) {
      const el = document.querySelector('input[name="decision_short"]');
      if (el) { setAngularInput($, el, data.shortDecision_en); filled.push('Decision (short)'); }
      else                                                       failed.push('Decision (short)');
    }

    // 4) Date + time split into two DD/MM/YYYY + hh:mm inputs.
    if (data.decisionDate) {
      const parts = toDDMMYYYY(data.decisionDate);
      const dateEl = document.querySelector('input[name="DecisionDate"]');
      const timeEl = document.querySelector('input[name="decision_time"]');
      if (dateEl && parts) {
        setAngularInput($, dateEl, parts);
        filled.push('Decision date');
      } else {
        failed.push('Decision date');
      }
      if (timeEl && data.decisionTime) {
        setAngularInput($, timeEl, data.decisionTime);
        filled.push('Decision time');
      }
    }

    // 5) Jury members.
    if (data.juryMembers) {
      const members = data.juryMembers.split(',').map(s => s.trim()).filter(Boolean);
      const result = assignM2SJuryMembers($, scope, members);
      if (result.chairSet)         filled.push('Chairman (' + result.chairName + ')');
      else if (members.length)     failed.push('Chairman (no match for "' + members[0] + '")');
      if (result.panelAdded > 0)   filled.push('Panel Members (' + result.panelAdded + ' added)');
      if (result.signedBySet)      filled.push('Signed By (' + result.chairName + ')');
      if (result.scribeSet)        filled.push('Scribe (' + result.scribeName + ')');
      if (result.unmatched.length) filled.push('Other Panel Members (' + result.unmatched.length + ' unmatched)');
    }

    let msg = 'm2s form filled.\n\n';
    if (filled.length) msg += '✓ ' + filled.join('\n✓ ');
    if (failed.length) msg += (filled.length ? '\n\n' : '') + '⚠ ' + failed.join('\n⚠ ');
    msg += '\n\nReview before saving. Hearing opening time, Witnesses, ' +
           'validity checks, and other m2s-specific fields are not auto-filled.';
    alert(msg);
  }


  // ---------- AngularJS helpers ----------------------------------------

  /**
   * Finds the scope of the case-detail form. The whole hearing UI is rendered
   * inside a div.tabbed-detail with class "ng-scope". We grab that element's
   * scope, which is the parent scope that exposes `item`, `lists`,
   * `addCommittee()`, etc.
   */
  function getRootDetailScope() {
    if (!window.angular) return null;
    const el = document.querySelector('.tabbed-detail.ng-scope') ||
               document.querySelector('[ng-model="item.ProceduralMatters"]');
    if (!el) return null;
    return window.angular.element(el).scope();
  }

  /**
   * Safely applies fn inside an Angular digest, deferring if one is already
   * running. AngularJS throws if you call $apply while a digest is in flight.
   */
  function ngApply(scope, fn) {
    if (!scope) { fn(); return; }
    const phase = scope.$root && scope.$root.$$phase;
    if (phase === '$apply' || phase === '$digest') fn();
    else scope.$apply(fn);
  }

  /**
   * Sets an <input> bound by ng-model and notifies Angular. Uses jQuery's
   * .val() + .trigger('input') so any sg-date / sg-time directive watchers
   * also fire and parse the value.
   */
  function setAngularInput($, el, value) {
    const $el = $(el);
    $el.val(value);
    $el.trigger('input');
    $el.trigger('change');
    const scope = window.angular ? window.angular.element(el).scope() : null;
    if (scope) ngApply(scope, () => {});
  }

  /**
   * Sets a Summernote editor's content via the official API and pushes the
   * new value into the ng-model so the case can be saved. The container that
   * carries the ng-model attribute is the Summernote-bound element.
   */
  function setSummernoteContent($, scope, ngModelExpr, html) {
    const container = document.querySelector('[ng-model="' + ngModelExpr + '"]');
    if (!container) return false;

    try {
      $(container).summernote('code', html);
    } catch (e) {
      // Fall back to writing the editable directly if summernote API throws.
      const editor = container.nextElementSibling;
      if (!editor || !editor.classList.contains('note-editor')) return false;
      const editable = editor.querySelector('.note-editable');
      if (!editable) return false;
      editable.innerHTML = html;
      $(editable).trigger('input').trigger('change');
    }

    // Push into the ng-model. Summernote's code() doesn't always notify Angular.
    if (scope) {
      ngApply(scope, () => {
        const path = ngModelExpr.split('.');
        let obj = scope;
        for (let i = 0; i < path.length - 1; i++) {
          if (obj[path[i]] === undefined) obj[path[i]] = {};
          obj = obj[path[i]];
        }
        obj[path[path.length - 1]] = html;
      });
    }
    return true;
  }


  // ---------- m2s jury members ------------------------------------------

  function assignM2SJuryMembers($, scope, names) {
    let chairSet = false, chairName = '';
    let scribeSet = false, scribeName = '';
    let signedBySet = false;
    let panelAdded = 0;
    const unmatched = [];

    if (!scope || !scope.lists || !scope.lists.CommitteeMembers) {
      for (const n of names) unmatched.push(n);
      return { chairSet, chairName, scribeSet, scribeName, signedBySet,
               panelAdded, unmatched };
    }
    const allMembers = scope.lists.CommitteeMembers;

    // Doc convention for the jury-members list:
    //   names[0]             = chair
    //   names[last] (>1)     = scribe
    //   names[0..last-1]     = panel members (chair + middle members)
    const chairIdx  = names.length > 0 ? 0 : -1;
    const scribeIdx = names.length > 1 ? names.length - 1 : -1;

    // --- Chairman ---
    let chairMember = null;
    if (chairIdx >= 0) {
      chairMember = findMemberByName(allMembers, names[chairIdx]);
      if (chairMember) {
        ngApply(scope, () => { scope.item.Chairman = chairMember; });
        chairSet = true;
        chairName = names[chairIdx];
      } else {
        unmatched.push(names[chairIdx]);
      }
    }

    // --- Panel Members (everyone: chair first, middle members, scribe last) ---
    // The chair is added first so the panel list reads chair, m2, m3, …, scribe
    for (let i = 0; i < names.length; i++) {
      const member = findMemberByName(allMembers, names[i]);
      if (!member) {
        // Skip duplicates — chair/scribe failures are pushed in their own blocks.
        if (i !== chairIdx && i !== scribeIdx) unmatched.push(names[i]);
        continue;
      }
      ngApply(scope, () => {
        scope.item._selectedPanelMember = member;
        if (typeof scope.addCommittee === 'function') scope.addCommittee();
      });
      panelAdded++;
    }

    // --- Signed By = the chair, drawn from item.PanelMembers ---
    // PanelMembers is populated by addCommittee() above, so we assign by Id.
    if (chairMember && scope.item.PanelMembers && scope.item.PanelMembers.length) {
      const signer = scope.item.PanelMembers.find(m => m.Id === chairMember.Id);
      if (signer) {
        ngApply(scope, () => { scope.item.SignedBy = signer; });
        signedBySet = true;
      }
    }

    // --- Scribe (last name, drawn from lists.CommitteeMembers) ---
    if (scribeIdx >= 0) {
      const scribeMember = findMemberByName(allMembers, names[scribeIdx]);
      if (scribeMember) {
        ngApply(scope, () => { scope.item.Scribe = scribeMember; });
        scribeSet = true;
        scribeName = names[scribeIdx];
      } else {
        unmatched.push(names[scribeIdx]);
      }
    }

    // --- Other Panel Members: capture anything unmatched ---
    if (unmatched.length) {
      const otherEl = document.querySelector('input[name="other_members"]');
      if (otherEl) setAngularInput($, otherEl, unmatched.join(', '));
    }

    return { chairSet, chairName, scribeSet, scribeName, signedBySet,
             panelAdded, unmatched };
  }

  /**
   * Finds a committee member object by their FullName, stripping parenthetical
   * country/role suffixes from both sides so matches tolerate "Yoann Peronneau"
   * vs "Yoann Peronneau (FRA)" etc.
   */
  function findMemberByName(members, name) {
    if (!name) return null;
    const target = stripParens(name).toLowerCase();
    return members.find(m =>
      stripParens(m.FullName || '').toLowerCase() === target) || null;
  }


  // ---------- m2s date helpers ------------------------------------------

  /**
   * Converts the doc's "30 May 2026" date string into m2s's "DD/MM/YYYY"
   * format. Returns null if parsing fails.
   */
  function toDDMMYYYY(s) {
    const m = (s || '').match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return null;
    const mo = MONTH_NUM[m[2].toLowerCase()];
    if (!mo) return null;
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return pad(+m[1]) + '/' + pad(mo) + '/' + m[3];
  }

})();