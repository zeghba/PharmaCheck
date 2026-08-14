/* =====================================================================
   PharmaCheck — type-ahead

   A replacement for <datalist>, which the platform renders with its own
   chrome (an opaque OS list that ignores the app's styling entirely). This
   draws the suggestions in the page, so they match everything around them
   and can carry more than a single line of text.
   ===================================================================== */
(function (global) {
  'use strict';

  var openPanel = null;

  function closeOpen() {
    if (openPanel) openPanel.close();
  }

  /* One global listener rather than one per field. */
  document.addEventListener('pointerdown', function (event) {
    if (!openPanel) return;
    if (event.target.closest('.ac-panel') || event.target === openPanel.input) return;
    closeOpen();
  }, true);

  /**
   * attach(input, options)
   *   source(query)  -> array of { value, label, meta, tag }
   *   onPick(item)   -> called when a suggestion is chosen
   *   minChars       -> 0 shows the full list on focus (default 0)
   *   emptyText      -> shown when nothing matches
   */
  function attach(input, options) {
    var opts = options || {};
    var field = input.closest('.field') || input.parentNode;
    var panel = document.createElement('div');
    panel.className = 'ac-panel';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    field.appendChild(panel);

    var items = [];
    var active = -1;
    var suppress = false;   // guards the synthetic input event below

    var api = {
      input: input,
      close: function () {
        panel.hidden = true;
        active = -1;
        input.setAttribute('aria-expanded', 'false');
        if (openPanel === api) openPanel = null;
      }
    };

    function render(list) {
      items = list;
      active = -1;

      /* Nothing to choose means nothing to tap, so the empty panel lets
         touches through to the field underneath — otherwise it swallows
         the tap that was aimed at the next input and costs a second one. */
      panel.classList.toggle('ac-panel--empty', !list.length);

      if (!list.length) {
        panel.innerHTML = '<p class="ac-empty">' +
          (opts.emptyText || 'No match — it will be added as a new entry') + '</p>';
      } else {
        panel.innerHTML = list.map(function (it, i) {
          return '<button class="ac-row" type="button" role="option" data-i="' + i + '">' +
            '<span class="ac-row__main">' +
              '<span class="ac-row__label">' + escapeHtml(it.label) + '</span>' +
              (it.meta ? '<span class="ac-row__meta">' + escapeHtml(it.meta) + '</span>' : '') +
            '</span>' +
            (it.tag ? '<span class="ac-row__tag' + (it.tagWarn ? ' ac-row__tag--warn' : '') + '">' +
              escapeHtml(it.tag) + '</span>' : '') +
            '</button>';
        }).join('');
      }

      panel.hidden = false;
      panel.scrollTop = 0;
      input.setAttribute('aria-expanded', 'true');
      if (openPanel && openPanel !== api) openPanel.close();
      openPanel = api;
    }

    function refresh() {
      if (suppress) return;
      var q = input.value.trim();
      if (q.length < (opts.minChars || 0)) { api.close(); return; }
      render(opts.source(q) || []);
    }

    function choose(index) {
      var it = items[index];
      if (!it) return;
      input.value = it.value;
      if (opts.onPick) opts.onPick(it);

      /* Let the host form react exactly as it would to typing — but the
         picked value still matches its own query, so an unguarded dispatch
         would immediately reopen the panel we are closing. */
      suppress = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      suppress = false;

      api.close();
    }

    function highlight(next) {
      var rows = panel.querySelectorAll('.ac-row');
      if (!rows.length) return;
      active = (next + rows.length) % rows.length;
      rows.forEach(function (r, i) { r.classList.toggle('is-active', i === active); });
      rows[active].scrollIntoView({ block: 'nearest' });
    }

    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('focus', refresh);
    input.addEventListener('input', refresh);

    input.addEventListener('keydown', function (event) {
      if (panel.hidden) {
        if (event.key === 'ArrowDown') { refresh(); event.preventDefault(); }
        return;
      }
      if (event.key === 'ArrowDown') { highlight(active + 1); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { highlight(active - 1); event.preventDefault(); }
      else if (event.key === 'Enter' && active >= 0) { choose(active); event.preventDefault(); }
      else if (event.key === 'Escape') { api.close(); }
    });

    panel.addEventListener('click', function (event) {
      var row = event.target.closest('.ac-row');
      if (row) choose(Number(row.dataset.i));
    });

    return api;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* Case-insensitive, prefix matches first — typing "para" should reach
     Paracetamol before something that merely contains "para". */
  function rank(list, query, getText) {
    var q = query.trim().toLowerCase();
    if (!q) return list.slice();
    var starts = [], contains = [];
    list.forEach(function (item) {
      var text = String(getText(item)).toLowerCase();
      var at = text.indexOf(q);
      if (at === 0) starts.push(item);
      else if (at > 0) contains.push(item);
    });
    return starts.concat(contains);
  }

  global.PharmaAutocomplete = { attach: attach, rank: rank, closeOpen: closeOpen };
})(typeof self !== 'undefined' ? self : this);
