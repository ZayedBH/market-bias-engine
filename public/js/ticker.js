'use strict';

// ── Shared custom ticker dropdown ─────────────────────────────────────────────
// Called from each page's init(). onSelect(value) is fired when user picks a symbol.
// The hidden #symbolSelect is kept in sync so any legacy code reading .value still works.

window.initTickerDropdown = function initTickerDropdown(onSelect) {
  const btn       = document.getElementById('tickerBtn');
  const menu      = document.getElementById('tickerMenu');
  const display   = document.getElementById('tickerDisplay');
  const hiddenSel = document.getElementById('symbolSelect');
  if (!btn || !menu) return;

  function markSelected(value) {
    menu.querySelectorAll('.ticker-option').forEach(el =>
      el.classList.toggle('selected', el.dataset.value === value)
    );
  }

  function openMenu()  { btn.classList.add('open');    menu.classList.add('open'); }
  function closeMenu() { btn.classList.remove('open'); menu.classList.remove('open'); }

  function pickSymbol(value) {
    display.textContent = value;
    if (hiddenSel) hiddenSel.value = value;
    markSelected(value);
    closeMenu();
    if (onSelect) onSelect(value);
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.contains('open') ? closeMenu() : openMenu();
  });

  menu.querySelectorAll('.ticker-option').forEach(el =>
    el.addEventListener('click', () => pickSymbol(el.dataset.value))
  );

  // Close on any outside click
  document.addEventListener('click', closeMenu);
  menu.addEventListener('click', e => e.stopPropagation());

  // Set initial state from hiddenSel or default
  const initial = (hiddenSel?.value) || 'SPY';
  display.textContent = initial;
  markSelected(initial);
};
