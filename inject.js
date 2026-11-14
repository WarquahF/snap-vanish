/* Snap Vanish - Thanos dust effect for Zoom web (page-context script).
 *
 * Installs a getUserMedia wrapper: when a page asks for camera, frames are
 * routed through a WebGL2 pipeline (person segmentation + particle dissolve)
 * and the page receives the processed canvas stream instead.
 *
 * Snap fingers -> you disintegrate into dust (background stays).
 * Snap again   -> the dust flies back and you reassemble.
 */
(function () {
  'use strict';
  if (window.__snapVanishInstalled) return;
  window.__snapVanishInstalled = true;

  var SCRIPT = document.currentScript;
  var EXT_BASE = (SCRIPT && SCRIPT.src)
    ? SCRIPT.src.slice(0, SCRIPT.src.length - 'inject.js'.length)
    : ((SCRIPT && SCRIPT.dataset && SCRIPT.dataset.extBase) || '');
  // MAIN-world content scripts have no src: take the base URL stamped on the
  // DOM by the isolated bridge script.
  var baseResolve;
  var basePromise = new Promise(function (r) { baseResolve = r; });
  if (EXT_BASE) baseResolve(EXT_BASE);
  else {
    var baseTries = 0;
    var baseIv = setInterval(function () {
      var el = document.documentElement;
      var v = el && el.getAttribute('data-sv-ext');
      if (v || ++baseTries > 200) {
        clearInterval(baseIv);
        EXT_BASE = v || '';
        baseResolve(EXT_BASE);
      }
    }, 25);
  }
  var VERSION = '1.0.0';
  var DISSOLVE_MS = 2100;
  var MAX_W = 1280, MAX_H = 720;

  var enabled = true;
  var forceMaskMode = null; // null = ML, 'rect' = synthetic box (testing)
  var mlState = 'loading';  // loading | ready | failed
  var net = null;
  var pipelines = new Set();
  var snapCount = 0;

  function log() { console.log.apply(console, ['[snapvanish]'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[snapvanish]'].concat([].slice.call(arguments))); }

  // ---------------------------------------------------------------- GLSL
  var VERT_QUAD = '#version 300 es\n' +
    'layout(location=0) in vec2 aPos;out vec2 vUV;' +
    'void main(){vUV=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}';

  var FRAG_COPY = '#version 300 es\nprecision highp float;' +
    'uniform sampler2D uSrc;in vec2 vUV;out vec4 o;' +
    'void main(){o=texture(uSrc,vUV);}';

  // Compose live video + plate + dissolve erosion.
  var FRAG_COMPOSE = '#version 300 es\nprecision highp float;' +
    'uniform sampler2D uVideo;uniform sampler2D uMask;uniform sampler2D uPlate;' +
    'uniform sampler2D uClean;uniform float uHasClean;' +
    'uniform float uP;uniform float uUseEffect;in vec2 vUV;out vec4 o;' +
    'float hash(vec2 c){return fract(sin(dot(c,vec2(127.1,311.7)))*43758.5453);}' +
    'void main(){' +
    ' vec3 video=texture(uVideo,vUV).rgb;' +
    ' float m=texture(uMask,vUV).r;' +
    ' float person=smoothstep(0.35,0.65,m);' +
    ' vec3 plate=texture(uPlate,vUV).rgb;' +
    ' float keep=1.0;' +
    ' if(uUseEffect>0.5){float n=hash(floor(gl_FragCoord.xy/3.0));keep=smoothstep(uP,uP+0.06,n);}' +
    ' vec3 bgFill=uHasClean>0.5?texture(uClean,vUV).rgb:plate;' +
    ' vec3 personCol=mix(bgFill,video,keep);' +
    ' o=vec4(mix(video,personCol,person),1.0);}';

  // Masked blur fill: person pixels pull a weighted average of nearby
  // background pixels. Run horizontal then vertical, a few rounds.
  // plate init: rgb = frozen frame, a = certainty (1 = known background)
  var FRAG_PLATEINIT = '#version 300 es\nprecision highp float;' +
    'uniform sampler2D uSrc;uniform sampler2D uMask;in vec2 vUV;out vec4 o;' +
    'void main(){' +
    ' float m=texture(uMask,vUV).r;' +
    ' o=vec4(texture(uSrc,vUV).rgb, m>0.5?0.0:1.0);}';

  // pull-push pyramid fill: downsample averaging only known (a=1) pixels,
  // then fill unknown pixels top-down from coarser levels. Clean, no wedges.
  var FRAG_PULL = '#version 300 es\nprecision highp float;' +
    'uniform sampler2D uSrc;uniform ivec2 uPrevSize;in vec2 vUV;out vec4 o;' +
    'void main(){' +
    ' ivec2 c=ivec2(gl_FragCoord.xy)*2;' +
    ' vec3 sum=vec3(0.0);float wsum=0.0;' +
    ' for(int dy=0;dy<2;dy++)for(int dx=0;dx<2;dx++){' +
    '  ivec2 p=min(c+ivec2(dx,dy),uPrevSize-1);' +
    '  vec4 s=texelFetch(uSrc,p,0);' +
    '  sum+=s.rgb*s.a;wsum+=s.a;}' +
    ' o=wsum>0.001?vec4(sum/wsum,1.0):vec4(0.0);}';
  var FRAG_PUSH = '#version 300 es\nprecision highp float;' +
    'uniform sampler2D uSrc;uniform sampler2D uCoarse;in vec2 vUV;out vec4 o;' +
    'void main(){' +
    ' vec4 c=texture(uSrc,vUV);' +
    ' if(c.a>0.5){o=vec4(c.rgb,1.0);return;}' +
    ' o=vec4(texture(uCoarse,vUV).rgb,1.0);}';

  // Dust particles: one point per grid cell of the captured person region.
  var VERT_PART = '#version 300 es\n' +
    'layout(location=0) in vec3 aCell;' +
    'uniform sampler2D uCapMask;uniform sampler2D uCapTex;' +
    'uniform vec2 uRes;uniform float uP;uniform float uTime;uniform float uPointScale;' +
    'out vec4 vColor;' +
    'float hash1(float n){return fract(sin(n)*43758.5453);}' +
    'void main(){' +
    ' vec2 uv=vec2((aCell.x+0.5)/uRes.x,1.0-(aCell.y+0.5)/uRes.y);' +
    ' float m=texture(uCapMask,uv).r;' +
    ' if(m<0.5||uP>=1.0){gl_Position=vec4(2.0,2.0,2.0,1.0);gl_PointSize=0.0;vColor=vec4(0.0);return;}' +
    ' float s=aCell.z;' +
    ' float delay=hash1(s*1.37)*0.5;' +
    ' float t=clamp((uP-delay)/(1.0-delay),0.0,1.0);' +
    ' float tt=t*t*(3.0-2.0*t);' +
    ' float a1=hash1(s*2.11);float a2=hash1(s*3.73);float a3=hash1(s*5.19);float a4=hash1(s*7.31);' +
    ' float ang=a1*6.2831853;' +
    ' float spd=(0.25+0.75*a2)*160.0;' +
    ' vec2 dir=vec2(cos(ang),sin(ang));' +
    ' dir.y=dir.y*0.6-0.55;' +
    ' vec2 offset=dir*(tt*spd);' +
    ' offset.y-=tt*tt*90.0*(0.4+0.6*a3);' +
    ' offset+=vec2(sin(uTime*2.7+s*0.7),cos(uTime*2.1+s*1.3))*(7.0*t);' +
    ' vec2 pos=aCell.xy+offset;' +
    ' vec2 clip=vec2(pos.x/uRes.x*2.0-1.0,1.0-pos.y/uRes.y*2.0);' +
    ' gl_Position=vec4(clip,0.0,1.0);' +
    ' gl_PointSize=mix(4.0,1.2,tt)*uPointScale*(0.7+0.6*a4);' +
    ' vec3 col=texture(uCapTex,uv).rgb*(0.85+0.35*a3);' +
    ' float alpha=(1.0-tt)*step(0.001,t);' +
    ' vColor=vec4(col,alpha);}';

  var FRAG_PART = '#version 300 es\nprecision highp float;' +
    'in vec4 vColor;out vec4 o;' +
    'void main(){vec2 d=gl_PointCoord-0.5;float r=length(d);' +
    ' if(r>0.5)discard;' +
    ' float a=vColor.a*smoothstep(0.5,0.25,r);' +
    ' o=vec4(vColor.rgb,a);}';

  // ------------------------------------------------------------- helpers
  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }
  function program(gl, vsrc, fsrc) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }
  function makeTex(gl, w, h, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }
  function makeFBO(gl, tex) {
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }

  // ------------------------------------------------------------ pipeline
  function Pipeline(realStream) {
    var self = this;
    this.real = realStream;
    this.track = realStream.getVideoTracks()[0];
    var set = {};
    try { set = this.track.getSettings() || {}; } catch (e) {}
    var w = set.width || 640, h = set.height || 480;
    var scale = Math.min(1, MAX_W / w, MAX_H / h);
    this.W = Math.round(w * scale);
    this.H = Math.round(h * scale);

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([this.track]);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    var gl = this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');

    // quad vbo
    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.quad = quad;

    this.progCopy = program(gl, VERT_QUAD, FRAG_COPY);
    this.progCompose = program(gl, VERT_QUAD, FRAG_COMPOSE);
    this.progPlateInit = program(gl, VERT_QUAD, FRAG_PLATEINIT);
    this.progPull = program(gl, VERT_QUAD, FRAG_PULL);
    this.progPush = program(gl, VERT_QUAD, FRAG_PUSH);
    this.progPart = program(gl, VERT_PART, FRAG_PART);

    this.texVideo = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texMask = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texCap = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texCapMask = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texPlateA = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texClean = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.texPlateB = makeTex(gl, this.W, this.H, gl.LINEAR);
    this.fboCap = makeFBO(gl, this.texCap);
    this.fboCapMask = makeFBO(gl, this.texCapMask);
    this.fboPlateA = makeFBO(gl, this.texPlateA);
    this.fboClean = makeFBO(gl, this.texClean);
    this.fboPlateB = makeFBO(gl, this.texPlateB);

    // neutral mask (all background) until first segmentation lands
    var zero = new Uint8Array(this.W * this.H);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, this.W, this.H, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, zero);
    // note: texCapMask must stay RGBA (LUMINANCE is not color-renderable,
    // redefining it would silently break its FBO)

    // particle buffer: grid cells over the frame
    var step = this.W > 768 ? 4 : 3;
    var cols = Math.ceil(this.W / step), rows = Math.ceil(this.H / step);
    var data = new Float32Array(cols * rows * 3);
    var k = 0, seed = 1;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        data[k++] = x * step; data[k++] = y * step; data[k++] = seed++;
      }
    }
    this.partCount = cols * rows;
    var pvao = gl.createVertexArray();
    gl.bindVertexArray(pvao);
    var pbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.partVAO = pvao;

    // fill pyramid levels
    this.pyrTex = [];
    this.pyrFbo = [];
    this.pushTex = [];
    this.pushFbo = [];
    this.pyrL = 0;
    var pw = this.W, ph = this.H;
    while (Math.max(pw, ph) > 4) {
      this.pyrTex.push(makeTex(gl, pw, ph, gl.LINEAR));
      this.pyrFbo.push(makeFBO(gl, this.pyrTex[this.pyrTex.length - 1]));
      this.pushTex.push(makeTex(gl, pw, ph, gl.LINEAR));
      this.pushFbo.push(makeFBO(gl, this.pushTex[this.pushTex.length - 1]));
      pw = Math.max(1, pw >> 1); ph = Math.max(1, ph >> 1);
      this.pyrL++;
    }

    this.hasClean = false;     // user-calibrated clean background plate
    this.bgMsg = '';
    this.state = 'idle';       // idle | vanish | vanished | return
    this.p = 0;                // dissolve progress 0..1
    this.hasCapture = false;
    this.latestMask = null;    // {data,w,h}
    this.maskDirty = false;
    this.lastFrame = performance.now();
    this.t0 = performance.now();
    this.dead = false;

    this.outCanvasStream = this.canvas.captureStream(24);
    this.outTrack = this.outCanvasStream.getVideoTracks()[0];
    this.outStream = new MediaStream(realStream.getAudioTracks().concat([this.outTrack]));

    var cleanup = function () { self.destroy(); };
    this.track.addEventListener('ended', cleanup);
    var origStop = this.outTrack.stop.bind(this.outTrack);
    this.outTrack.stop = function () { cleanup(); origStop(); };

    this.ready = new Promise(function (res, rej) {
      self.video.onloadedmetadata = function () { self.video.play().then(res, rej); };
      self.video.onerror = rej;
      setTimeout(function () { rej(new Error('video metadata timeout')); }, 8000);
    }).then(function () { self._loop(); });

    pipelines.add(this);
  }

  Pipeline.prototype.destroy = function () {
    if (this.dead) return;
    this.dead = true;
    pipelines.delete(this);
    try { this.track.stop(); } catch (e) {}
    try { this.video.srcObject = null; } catch (e) {}
  };

  Pipeline.prototype.uploadMask = function (seg) {
    var gl = this.gl;
    // bodypix masks are 0/1 bytes; scale to full luminance range once
    if (!seg._scaled) {
      var s = new Uint8Array(seg.data.length);
      for (var i = 0; i < seg.data.length; i++) s[i] = seg.data[i] ? 255 : 0;
      seg._scaled = s;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, seg.width, seg.height, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, seg._scaled);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  };

  Pipeline.prototype.runPass = function (prog, fbo, setup, w, h) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w || this.W, h || this.H);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (setup) setup(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  Pipeline.prototype.bindTex = function (prog, name, unit, tex) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  };

  Pipeline.prototype.captureCleanPlate = function () {
    var self = this;
    this.runPass(this.progCopy, this.fboClean, function (p) { self.bindTex(p, 'uSrc', 0, self.texVideo); });
    this.hasClean = true;
  };

  Pipeline.prototype.capturePerson = function (seg) {
    var gl = this.gl, self = this;
    // freeze frame
    this.runPass(this.progCopy, this.fboCap, function (p) { self.bindTex(p, 'uSrc', 0, self.texVideo); });
    // freeze mask
    this.uploadMask(seg);
    this.runPass(this.progCopy, this.fboCapMask, function (p) { self.bindTex(p, 'uSrc', 0, self.texMask); });
    // plate: init with certainty, then pull-push pyramid fill
    this.runPass(this.progPlateInit, this.pyrFbo[0], function (p) {
      self.bindTex(p, 'uSrc', 0, self.texVideo);
      self.bindTex(p, 'uMask', 1, self.texCapMask);
    });
    var lw = this.W, lh = this.H;
    for (var l = 1; l < this.pyrL; l++) {
      var cw = Math.max(1, lw >> 1), ch = Math.max(1, lh >> 1);
      this.runPass(this.progPull, this.pyrFbo[l], function (p) {
        self.bindTex(p, 'uSrc', 0, self.pyrTex[l - 1]);
        gl.uniform2i(gl.getUniformLocation(p, 'uPrevSize'), lw, lh);
      }, cw, ch);
      lw = cw; lh = ch;
    }
    for (var l2 = this.pyrL - 2; l2 >= 0; l2--) {
      var tw = Math.max(1, this.W >> l2), th = Math.max(1, this.H >> l2);
      var target = l2 === 0 ? this.fboPlateA : this.pushFbo[l2];
      var coarse = l2 === this.pyrL - 2 ? this.pyrTex[this.pyrL - 1] : this.pushTex[l2 + 1];
      this.runPass(this.progPush, target, function (p) {
        self.bindTex(p, 'uSrc', 0, self.pyrTex[l2]);
        self.bindTex(p, 'uCoarse', 1, coarse);
      }, tw, th);
      if (l2 > 0) { /* result stored in pushTex[l2] via pushFbo[l2] */ }
    }
    this.hasCapture = true;
  };

  Pipeline.prototype._loop = function () {
    var self = this, gl = this.gl;
    function frame(now) {
      if (self.dead) return;
      var dt = Math.min(100, now - self.lastFrame);
      self.lastFrame = now;

      // advance animation
      if (self.state === 'vanish') {
        self.p += dt / DISSOLVE_MS;
        if (self.p >= 1) { self.p = 1; self.state = 'vanished'; postStatus(); }
      } else if (self.state === 'return') {
        self.p -= dt / (DISSOLVE_MS * 0.9);
        if (self.p <= 0) { self.p = 0; self.state = 'idle'; self.hasCapture = false; postStatus(); }
      }

      // upload live frame
      if (self.video.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, self.texVideo);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, self.video);
        } catch (e) {}
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      if (self.maskDirty && self.latestMask) {
        self.maskDirty = false;
        self.uploadMask(self.latestMask);
      }

      // compose
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, self.W, self.H);
      gl.disable(gl.BLEND);
      gl.useProgram(self.progCompose);
      gl.bindBuffer(gl.ARRAY_BUFFER, self.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      self.bindTex(self.progCompose, 'uVideo', 0, self.texVideo);
      self.bindTex(self.progCompose, 'uMask', 1, self.texMask);
      self.bindTex(self.progCompose, 'uPlate', 2, self.texPlateA);
      self.bindTex(self.progCompose, 'uClean', 3, self.texClean);
      gl.uniform1f(gl.getUniformLocation(self.progCompose, 'uHasClean'), self.hasClean ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(self.progCompose, 'uP'), self.p);
      gl.uniform1f(gl.getUniformLocation(self.progCompose, 'uUseEffect'),
        (self.state === 'idle' && !self.hasCapture) ? 0 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // particles
      if (self.hasCapture && self.p > 0.001 && self.p < 1.0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(self.progPart);
        gl.bindVertexArray(self.partVAO);
        self.bindTex(self.progPart, 'uCapMask', 0, self.texCapMask);
        self.bindTex(self.progPart, 'uCapTex', 1, self.texCap);
        gl.uniform2f(gl.getUniformLocation(self.progPart, 'uRes'), self.W, self.H);
        gl.uniform1f(gl.getUniformLocation(self.progPart, 'uP'), self.p);
        gl.uniform1f(gl.getUniformLocation(self.progPart, 'uTime'), (now - self.t0) / 1000);
        gl.uniform1f(gl.getUniformLocation(self.progPart, 'uPointScale'), self.W / 640);
        gl.drawArrays(gl.POINTS, 0, self.partCount);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  // -------------------------------------------------------- segmentation
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('load failed: ' + src)); };
      document.documentElement.appendChild(s);
    });
  }

  var mlPromise = null;
  function ensureML() {
    if (mlPromise) return mlPromise;
    mlPromise = (async function () {
      await basePromise;
      if (!EXT_BASE) { mlState = 'failed'; warn('no extension base URL'); return; }
      try {
        await loadScript(EXT_BASE + 'tf.min.js');
        await loadScript(EXT_BASE + 'body-pix.min.js');
        await loadScript(EXT_BASE + 'snap-detector.js');
        if (tf.setBackend) { await tf.setBackend('webgl'); }
        await tf.ready();
        var handler = {
          load: async function () {
            var jf = fetch(EXT_BASE + 'model-stride16.json').then(function (r) { return r.json(); });
            var bf = fetch(EXT_BASE + 'group1-shard1of1.bin').then(function (r) { return r.arrayBuffer(); });
            var json = await jf, bin = await bf;
            var specs = [];
            json.weightsManifest.forEach(function (g) {
              g.weights.forEach(function (w) { specs.push(w); });
            });
            return {
              modelTopology: json.modelTopology,
              weightSpecs: specs,
              weightData: bin,
              format: json.format,
              generatedBy: json.generatedBy,
              convertedBy: json.convertedBy
            };
          }
        };
        if (tf.io && tf.io.registerLoadRouter) {
          tf.io.registerLoadRouter(function (url) {
            return url === 'sv-bodypix://model' ? handler : null;
          });
        }
        net = await bodyPix.load({
          architecture: 'MobileNetV1',
          outputStride: 16,
          multiplier: 0.5,
          quantBytes: 2,
          modelUrl: 'sv-bodypix://model'
        });
        mlState = 'ready';
        log('person segmentation ready');
      } catch (e) {
        mlState = 'failed';
        warn('segmentation failed to load:', e);
      }
      postStatus();
    })();
    return mlPromise;
  }

  function syntheticRectMask(w, h) {
    var data = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var inX = x > w * 0.3 && x < w * 0.7;
        var inY = y > h * 0.2 && y < h * 0.9;
        if (inX && inY) data[y * w + x] = 1;
      }
    }
    return { data: data, width: w, height: h };
  }

  var lastSegCoverage = -1;
  async function segmentNow(video) {
    if (forceMaskMode === 'rect') {
      return syntheticRectMask(video.videoWidth || 640, video.videoHeight || 480);
    }
    if (mlState !== 'ready') await ensureML();
    if (mlState !== 'ready') throw new Error('segmentation unavailable');
    var seg = await net.segmentPerson(video, {
      flipHorizontal: false,
      internalResolution: 0.25,
      segmentationThreshold: 0.5,
      maxDetections: 1,
      scoreThreshold: 0.2
    });
    var c = 0;
    for (var i = 0; i < seg.data.length; i++) if (seg.data[i]) c++;
    lastSegCoverage = c / seg.data.length;
    return seg;
  }

  // background mask refresh while effect is engaged (person may move)
  setInterval(function () {
    pipelines.forEach(function (pipe) {
      if (pipe.dead) return;
      if (pipe.state === 'idle' && !pipe.hasCapture) return;
      if (mlState !== 'ready' && forceMaskMode !== 'rect') return;
      segmentNow(pipe.video).then(function (seg) {
        pipe.latestMask = seg;
        pipe.maskDirty = true;
      }).catch(function () {});
    });
  }, 140);

  // ------------------------------------------------------------- control
  function anyPipeline() {
    var it = pipelines.values().next();
    return it.done ? null : it.value;
  }

  async function toggle() {
    var pipe = anyPipeline();
    if (!pipe) { warn('no camera pipeline yet'); return; }
    snapCount++;
    try {
      if (pipe.state === 'idle') {
        var seg = await segmentNow(pipe.video);
        pipe.capturePerson(seg);
        pipe.state = 'vanish';
        pipe.p = Math.max(pipe.p, 0.001);
        log('snap: vanish');
      } else if (pipe.state === 'vanished') {
        var seg2 = await segmentNow(pipe.video);
        pipe.capturePerson(seg2);
        pipe.state = 'return';
        pipe.p = Math.min(pipe.p, 0.999);
        log('snap: return');
      } else if (pipe.state === 'vanish') {
        pipe.state = 'return'; // reverse mid-flight
      } else if (pipe.state === 'return') {
        pipe.state = 'vanish';
      }
    } catch (e) {
      warn('toggle failed:', e);
    }
    postStatus();
  }

  function postStatus() {
    var pipe = anyPipeline();
    window.postMessage({
      __sv: 'status',
      version: VERSION,
      enabled: enabled,
      mlState: mlState,
      snapCount: snapCount,
      audio: !!audioCtx,
      state: pipe ? pipe.state : 'no-camera',
      pipelines: pipelines.size,
      hasClean: pipe ? pipe.hasClean : false,
      bgMsg: pipe ? pipe.bgMsg : ''
    }, '*');
  }

  // ------------------------------------------------------- snap listener
  var audioCtx = null;
  var snapStream = null;
  var snapAudioOn = true;
  async function initSnapListener() {
    if (audioCtx) return;
    try {
      var orig = window.__svOrigGUM;
      snapStream = await orig({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(snapStream);
      var an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.2;
      src.connect(an);
      var bins = new Uint8Array(an.frequencyBinCount);
      var det = new SnapDetector({
        sampleRate: audioCtx.sampleRate,
        fftSize: 1024,
        onSnap: function () {
          log('snap heard');
          toggle();
        }
      });
      if (audioCtx.state === 'suspended') {
        var resume = function () { audioCtx.resume(); };
        window.addEventListener('click', resume);
        window.addEventListener('keydown', resume);
      }
      setInterval(function () {
        if (!snapAudioOn || audioCtx.state !== 'running') return;
        an.getByteFrequencyData(bins);
        det.process(bins, performance.now());
      }, 40);
      log('snap listener armed');
      postStatus();
    } catch (e) {
      warn('mic for snap detection unavailable:', e);
    }
  }

  // --------------------------------------------------- getUserMedia wrap
  function installWrapper() {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return;
    var orig = md.getUserMedia.bind(md);
    window.__svOrigGUM = orig;
    md.getUserMedia = async function (constraints) {
      if (!enabled || !constraints || !constraints.video) return orig(constraints);
      var real = await orig(constraints);
      if (!real.getVideoTracks().length) return real;
      try {
        var pipe = new Pipeline(real);
        await pipe.ready;
        log('camera pipeline active', pipe.W + 'x' + pipe.H);
        ensureML();
        initSnapListener();
        postStatus();
        return pipe.outStream;
      } catch (e) {
        warn('pipeline failed, passing camera through:', e);
        return real;
      }
    };
  }
  installWrapper();
  ensureML();

  // ------------------------------------------------------------ messages
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__sv !== 'cmd') return;
    if (d.cmd === 'captureBg') {
      (async function () {
        var pipe = anyPipeline();
        if (!pipe) return;
        var coverage = -1;
        try {
          var seg = await segmentNow(pipe.video);
          var c = 0;
          for (var i = 0; i < seg.data.length; i++) if (seg.data[i]) c++;
          coverage = c / seg.data.length;
        } catch (e) {}
        pipe.captureCleanPlate();
        pipe.bgMsg = coverage < 0 ? 'clean background captured (no person check)'
          : coverage > 0.05 ? 'warning: someone is in frame (' + Math.round(coverage * 100) + '%) - step out and capture again'
          : 'clean background captured';
        log(pipe.bgMsg);
        postStatus();
      })();
    }
    if (d.cmd === 'toggle') toggle();
    else if (d.cmd === 'setEnabled') { enabled = !!d.value; postStatus(); }
    else if (d.cmd === 'status') postStatus();
  });

  // -------------------------------------------------------------- debug
  window.__snapVanish = {
    version: VERSION,
    toggle: toggle,
    status: function () {
      var pipe = anyPipeline();
      return {
        enabled: enabled, mlState: mlState, snapCount: snapCount,
        state: pipe ? pipe.state : 'no-camera', pipelines: pipelines.size
      };
    },
    setForceMask: function (mode) { forceMaskMode = mode; },
    setSnapAudio: function (on) { snapAudioOn = !!on; },
    dumpTex: function (name) {
      var pipe = anyPipeline();
      if (!pipe) return null;
      var gl = pipe.gl;
      var map = { cap: pipe.fboCap, capmask: pipe.fboCapMask, plate: pipe.fboPlateA };
      var f = map[name];
      if (!f) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      var px = new Uint8Array(4 * pipe.W * pipe.H);
      gl.readPixels(0, 0, pipe.W, pipe.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      var c = document.createElement('canvas');
      c.width = pipe.W; c.height = pipe.H;
      var x = c.getContext('2d');
      var img = x.createImageData(pipe.W, pipe.H);
      for (var y = 0; y < pipe.H; y++) {
        var sy = pipe.H - 1 - y;
        for (var i = 0; i < pipe.W; i++) {
          var di = (y * pipe.W + i) * 4, si = (sy * pipe.W + i) * 4;
          img.data[di] = px[si]; img.data[di+1] = px[si+1]; img.data[di+2] = px[si+2]; img.data[di+3] = 255;
        }
      }
      x.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    },
    readTex: function (name) {
      var pipe = anyPipeline();
      if (!pipe) return null;
      var gl = pipe.gl;
      if (name === 'mask') {
        // render the live mask through the copy program into plateB and read it
        var self = pipe;
        pipe.runPass(pipe.progCopy, pipe.fboPlateB, function (p) { self.bindTex(p, 'uSrc', 0, self.texMask); });
        name = 'plateB';
      }
      var map = { cap: pipe.fboCap, capmask: pipe.fboCapMask, plate: pipe.fboPlateA, plateB: pipe.fboPlateB };
      var f = map[name];
      if (!f) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      var px = new Uint8Array(4 * 40 * 40);
      gl.readPixels(Math.floor(pipe.W / 2) - 20, Math.floor(pipe.H / 2) - 20, 40, 40, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      var s = 0;
      for (var i = 0; i < px.length; i += 4) s += px[i];
      return s / (px.length / 4);
    },
    debug: function () {
      var pipe = anyPipeline();
      return {
        segCoverage: lastSegCoverage, mlState: mlState,
        pipe: pipe ? { state: pipe.state, p: pipe.p, hasCapture: pipe.hasCapture, W: pipe.W, H: pipe.H } : null
      };
    },
    setProgress: function (p) {
      var pipe = anyPipeline();
      if (pipe) { pipe.p = p; }
    }
  };
  log('installed v' + VERSION);
})();
