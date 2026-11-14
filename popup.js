(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;
  var stateEl = document.getElementById('state');
  var mlEl = document.getElementById('ml');
  var enabledEl = document.getElementById('enabled');

  function send(cmd, value) {
    api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (!tabs[0]) return;
      api.tabs.sendMessage(tabs[0].id, { __sv: 'popup', cmd: cmd, value: value }).catch(function () {});
    });
  }

  document.getElementById('snap').addEventListener('click', function () { send('toggle'); });
  document.getElementById('bg').addEventListener('click', function () { send('captureBg'); });
  enabledEl.addEventListener('change', function () { send('setEnabled', enabledEl.checked); });

  // Per-site enable (stored map hostname -> true; default off)
  var siteEl = document.getElementById('site');
  var host = null;
  api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    try { host = new URL(tabs[0].url).hostname; } catch (e) {}
    document.getElementById('host').textContent = host || 'this site';
    if (!host) { siteEl.disabled = true; return; }
    api.storage.local.get('svSites').then(function (r) {
      siteEl.checked = !!(((r && r.svSites) || {})[host]);
    });
  });
  siteEl.addEventListener('change', function () {
    if (!host) return;
    api.storage.local.get('svSites').then(function (r) {
      var m = (r && r.svSites) || {};
      if (siteEl.checked) m[host] = true; else delete m[host];
      api.storage.local.set({ svSites: m });
    });
  });

  api.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.__sv !== 'status') return;
    var d = msg.data;
    if (d.siteEnabled === false) stateEl.textContent = 'site not enabled';
    else stateEl.textContent = d.state === 'no-camera' ? 'no camera yet' : d.state;
    stateEl.className = d.state;
    enabledEl.checked = !!d.enabled;
    document.getElementById('bgmsg').textContent = d.bgMsg || (d.hasClean ? 'clean background set' : '');
    mlEl.textContent =
      (d.mlState === 'ready' ? 'person detection ready' :
       d.mlState === 'failed' ? 'person detection failed to load' : 'person detection loading...') +
      (d.audio ? ' - mic listening for snaps' : '');
  });

  send('status');
  setInterval(function () { send('status'); }, 1000);
})();
