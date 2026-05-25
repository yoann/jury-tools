/**
 * jury-fill.js — bookmarklet payload for the "Fill jury decision" tool.
 *
 * Detects whether the current page is sailti or RRS (racingrulesofsailing.org)
 * and fills the matching fields with content from the clipboard. The clipboard
 * payload is produced by the Google Doc add-on (Code.gs / showCopyDialog).
 */
(async () => {
  let data;
  try {
    data = JSON.parse(await navigator.clipboard.readText());
  } catch (e) {
    alert('Could not read the jury decision from the clipboard.\n\n' +
          'Make sure you clicked "Copy to clipboard" in the Google Doc dialog first.');
    return;
  }

  try {
    if (document.getElementById('decision_procedures_text')) {
      await fillRRS(data);
    } else if (document.getElementById('proceduralMatters_en')) {
      fillSailti(data);
    } else {
      alert('This page does not look like a jury decision form ' +
            '(sailti or RRS). Open the form first, then click the bookmark.');
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
      ['decision_en',          'decision_decision_text',           'Decision']
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

  const MONTHS = {
    january:0, february:1, march:2, april:3, may:4, june:5,
    july:6, august:7, september:8, october:9, november:10, december:11
  };

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

})();