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

  api.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.__sv !== 'status') return;
    var d = msg.data;
    stateEl.textContent = d.state === 'no-camera' ? 'no camera yet' : d.state;
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
