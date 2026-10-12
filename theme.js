// Day or night for the DN Studios app. This runs in the page's head, before anything is drawn, so a phone
// that chose Night never flashes Day. A choice made in the app ("light" for Day, "dark" for Night) is kept
// on this phone; with no choice the phone's own setting decides, and styles.css handles that by itself.
(function () {
  "use strict";
  var KEY = "editroom.theme", root = document.documentElement;
  var valid = function (v) { return v === "light" || v === "dark" ? v : null; };
  // the phone's status bar takes the page's colour: index.html gives one for each setting
  var bars = document.querySelectorAll('meta[name="theme-color"]'), own = {};
  for (var i = 0; i < bars.length; i++) own[/dark/.test(bars[i].media) ? "dark" : "light"] = bars[i].content;
  var current = null;
  try { current = valid(localStorage.getItem(KEY)); } catch (e) { /* storage blocked: follow the phone */ }

  function apply() {
    if (current) root.setAttribute("data-theme", current); else root.removeAttribute("data-theme");
    for (var i = 0; i < bars.length; i++) {
      var c = own[current || (/dark/.test(bars[i].media) ? "dark" : "light")];
      if (c) bars[i].content = c;
    }
  }

  window.dnTheme = {
    get: function () { return current; },      // "light", "dark", or null for the phone's own setting
    set: function (pick) {
      current = valid(pick);
      try { if (current) localStorage.setItem(KEY, current); else localStorage.removeItem(KEY); } catch (e) { /* used now, not kept */ }
      apply();
    },
    dark: function () { return current ? current === "dark" : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); },
  };
  // another tab of the app changed it
  window.addEventListener("storage", function (e) { if (e.key === KEY) { current = valid(e.newValue); apply(); } });
  if (current) apply();
})();
