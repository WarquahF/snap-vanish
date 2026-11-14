/* Snap Vanish bridge (isolated world): hands the extension base URL to the
 * MAIN-world page script via a DOM attribute, relays popup/keyboard commands.
 * Runs at document_start, before page scripts.
 */
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;
  var base = api.runtime.getURL('');

  function stamp() {
    var el = document.documentElement;
    if (el) { el.setAttribute('data-sv-ext', base); return true; }
    return false;
  }
  if (!stamp()) {
    var iv = setInterval(function () { if (stamp()) clearInterval(iv); }, 10);
  }

  // Ctrl+Shift+S toggles the effect (backup to finger snap)
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
      window.postMessage({ __sv: 'cmd', cmd: 'toggle' }, '*');
    }
  }, true);

  // popup -> page
  api.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.__sv === 'popup') {
      window.postMessage({ __sv: 'cmd', cmd: msg.cmd, value: msg.value }, '*');
    }
  });

  // page -> popup
  window.addEventListener('message', function (e) {
    if (e.source === window && e.data && e.data.__sv === 'status') {
      api.runtime.sendMessage({ __sv: 'status', data: e.data }).catch(function () {});
    }
  });
})();
