// The folder picker page. An admin comes here from Settings to choose the Google Drive folders editors may
// upload to, in Google's own picker. Picking a folder there is also what lets the app put files in it: the app
// only ever has Drive's narrowest permission (drive.file). The folders go to the dn-drive function, which
// checks each one with Google, and the admin goes back to Settings, which says how many were added.
(function () {
  "use strict";
  if (window.top !== window.self) return;          // never inside a frame on someone else's page
  const CFG = window.EDIT_ROOM_CONFIG || {};
  const DRIVE = String(CFG.url || "").replace(/\/+$/, "") + "/functions/v1/dn-drive";
  const status = document.getElementById("pick-status"), again = document.getElementById("pick-again");
  const say = (text) => { status.textContent = text; };
  const home = (query) => location.replace("./" + (query ? "?" + query : ""));
  const MESSAGES = {
    auth: "You've been signed out. Sign in to DN Studios again, then come back from Settings.",
    forbidden: "Only an admin can choose the folders.",
    not_set_up: "Google Drive isn't set up for this app yet.",
    drive_off: "Google Drive isn't connected. Connect it in Settings first.",
    drive_lost: "Google ended the Drive connection. Connect it again in Settings first.",
    offline: "Can't reach the server. Check your connection, then open Google Drive again.",
  };
  const message = (code) => MESSAGES[code] || "That didn't work. Open Google Drive again in a minute.";
  let token = null;
  try { token = localStorage.getItem("editroom.token"); } catch (e) { /* no saved sign-in */ }

  async function call(action, args) {
    let res;
    try {
      res = await fetch(DRIVE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: action, token: token }, args || {})), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) { throw new Error("offline"); }
    let body = null;
    try { body = await res.json(); } catch (e) { /* unreadable */ }
    if (!res.ok || !body || body.error) throw new Error(body && body.error ? String(body.error) : "failed");
    return body;
  }
  function script(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("offline"));
      document.head.appendChild(s);
    });
  }
  let pickerReady = null;
  function loadPicker() {
    if (!pickerReady) {
      pickerReady = script("https://apis.google.com/js/api.js").then(() => new Promise((resolve, reject) => {
        window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("offline")), timeout: 20000, ontimeout: () => reject(new Error("offline")) });
      }));
      pickerReady.catch(() => { pickerReady = null; });
    }
    return pickerReady;
  }

  async function open() {
    again.hidden = true;
    say("Opening your Google Drive…");
    if (!token) { say(message("auth")); return; }
    let key;
    try { key = await call("picker"); await loadPicker(); }
    catch (e) { say(e.message === "offline" ? "Google's folder picker didn't load. Check your connection, then open Google Drive again." : message(e.message)); again.hidden = false; return; }
    const G = window.google.picker;
    const view = new G.DocsView(G.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes("application/vnd.google-apps.folder");
    const picker = new G.PickerBuilder()
      .setTitle("Choose the folders editors can upload to")
      .addView(view)
      .enableFeature(G.Feature.MULTISELECT_ENABLED)
      .enableFeature(G.Feature.SUPPORT_DRIVES)
      .setOAuthToken(key.token)
      .setDeveloperKey(key.key)
      .setAppId(key.app)
      .setOrigin(location.protocol + "//" + location.host)
      .setCallback(async (data) => {
        const act = data && data[G.Response.ACTION];
        if (act === G.Action.CANCEL) { home(""); return; }
        if (act !== G.Action.PICKED) return;
        const ids = (data[G.Response.DOCUMENTS] || []).map((d) => d[G.Document.ID]).filter((id) => typeof id === "string").slice(0, 50);
        if (!ids.length) { home(""); return; }
        say(ids.length === 1 ? "Adding the folder…" : "Adding " + ids.length + " folders…");
        try {
          const r = await call("folders", { ids: ids });
          home("drive=folders&n=" + Number(r.added || 0) + "&u=" + Number(r.usable || 0));
        } catch (e) { say(message(e.message)); again.hidden = false; }
      })
      .build();
    picker.setVisible(true);
    say("Choose the folders in the Google Drive window.");
  }
  again.addEventListener("click", open);
  open();
})();
