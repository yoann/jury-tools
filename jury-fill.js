/**
 * jury-fill.js — Hosted script for the "Fill jury decision" bookmarklet.
 *
 * Loaded by the loader bookmarklet on every click. Reads the JSON payload
 * placed on the clipboard by the Google Doc Apps Script and fills the
 * matching fields on the jury decision form.
 *
 * Updating this file updates the bookmarklet for everyone — the loader
 * appends a cache-buster query string so each click fetches a fresh copy.
 */
(async () => {
  const IDS = [
    'proceduralMatters_en', 'factsFound_en', 'rule_en',
    'conclusion_en', 'decision_en',
    'decisionDate', 'decisionTime', 'juryMembers'
  ];

  try {
    const raw = await navigator.clipboard.readText();
    const data = JSON.parse(raw);
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

    let msg = 'Filled ' + filled + ' field' + (filled === 1 ? '' : 's') + '.';
    if (notFound.length) msg += '\nNot found on page: ' + notFound.join(', ');
    alert(msg);
  } catch (e) {
    alert('Could not fill the form.\n\n' + e.message +
      '\n\nMake sure you clicked "Copy to clipboard" in the Google Doc dialog first.');
  }
})();
