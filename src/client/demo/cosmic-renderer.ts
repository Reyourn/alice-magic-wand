export interface CosmicRenderer {
  readonly animated: boolean;
  resize(width: number, height: number, dpr: number): void;
  draw(time: number): void;
  dispose(): void;
}

type Body = { x: number; y: number; width: number; height: number };
type Layout = { hole: Body; star: Body };

function layout(width: number, height: number): Layout {
  const compact = width < 760;
  const holeWidth = Math.min(width * (compact ? 1.45 : .77), height * 1.02, 1080);
  const holeHeight = holeWidth * .70;
  const starSize = Math.min(width * (compact ? .65 : .34), height * .42, 450);
  const holeX = compact ? width * .53 : Math.min(width - holeWidth / 2 - 5, width * .65);
  const holeY = Math.max(holeHeight / 2 + 16, height * .37);
  const starX = Math.max(starSize / 2 + 5, width * (compact ? .32 : .3));
  const starY = Math.min(height - starSize / 2 - 8, height * .70);
  return {
    hole: { x: holeX - holeWidth / 2, y: holeY - holeHeight / 2, width: holeWidth, height: holeHeight },
    star: { x: starX - starSize / 2, y: starY - starSize / 2, width: starSize, height: starSize },
  };
}

const quadVertex = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() { vUv = aPosition; gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const noiseShader = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x),
             mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float hash31(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x+p.y)*p.z);
}
float noise3(vec3 p) {
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
                 mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
                 mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
mat2 rotate2(float a) { float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
`;

const skyFragment = `
precision highp float;
uniform vec2 uResolution;
uniform float uDpr;
varying vec2 vUv;
` + noiseShader + `
void main() {
  vec2 pixel = gl_FragCoord.xy / uDpr;
  vec2 grid = floor(pixel / 31.0), part = fract(pixel / 31.0);
  float seed = hash21(grid);
  vec2 pos = vec2(hash21(grid+13.1),hash21(grid+7.7))*.8+.1;
  float size = mix(.014,.04,hash21(grid+18.3));
  float core = exp(-dot(part-pos,part-pos)/(size*size));
  float star = step(.942,seed) * core * (.24+hash21(grid+5.4)*.74);
  vec3 color = mix(vec3(.67,.80,1.0),vec3(1.0,.89,.72),hash21(grid+93.0));
  gl_FragColor = vec4(vec3(.005,.007,.012) + color*star,1.0);
}
`;

// Curved rays intersect a thin three-dimensional disk. Light from the rear
// reaches above and below the horizon; the scene is not a stack of SVG rings.
const holeFragment = `
precision highp float;
uniform float uTime;
uniform float uAspect;
varying vec2 vUv;
` + noiseShader + `
vec3 disk(vec3 p) {
  float r=length(p.xz);
  float angle=atan(p.z,p.x);
  float phase=angle-uTime*.27/pow(max(r,1.0),.9);
  float grain=noise2(vec2(r*49.0,phase*24.0+r*4.0));
  float fine=noise2(vec2(r*163.0,phase*61.0));
  float threads=pow(noise2(vec2(r*124.0,phase*13.0+sin(r*7.0)*2.0)),4.0);
  float inner=smoothstep(1.25,1.55,r);
  float outer=1.0-smoothstep(2.45,4.45,r);
  float brightness=exp(-(r-1.4)*1.05)*inner*outer;
  float approaching=.72+.48*smoothstep(-1.0,1.0,p.x/r);
  float texture=.018+pow(grain,3.4)*1.5+fine*.06+threads*.70;
  vec3 warm=mix(vec3(1.0,.36,.075),vec3(1.0,.93,.76),exp(-(r-1.4)*.58));
  float innerLight=1.0+.95*exp(-max(r-1.5,0.0)*2.2);
  return warm*brightness*texture*approaching*3.1*innerLight;
}
void main() {
  float elevation=.22+sin(uTime*.026)*.03;
  float tilt=.36+sin(uTime*.019)*.035;
  vec2 p=rotate2(tilt)*vec2(vUv.x*uAspect,vUv.y);
  vec3 observer=vec3(0.0,sin(elevation),cos(elevation))*8.5;
  vec3 forward=-normalize(observer);
  vec3 up=vec3(0.0,cos(elevation),-sin(elevation));
  vec3 ray=normalize(forward*1.15+vec3(p.x,0,0)+up*p.y);
  vec3 position=observer;
  vec3 light=vec3(0.0);
  float transmission=1.0;
  float captured=0.0;
  float closest=20.0;
  for(int i=0;i<88;i++) {
    float r=length(position);
    closest=min(closest,r);
    if(r<.855) { captured=1.0; break; }
    if(r>12.0) break;
    float stepLength=clamp(r*.145,.065,.54);
    vec3 direction=normalize(ray-position*(.72*stepLength/(r*r*r)));
    vec3 next=position+direction*stepLength;
    if(position.y*next.y<0.0) {
      float crossing=position.y/(position.y-next.y);
      vec3 hit=mix(position,next,crossing);
      float radius=length(hit.xz);
      if(radius>1.25 && radius<5.2) {
        light+=disk(hit)*transmission;
        transmission*=.28;
      }
    }
    position=next;
    ray=direction;
  }
  float bloom=exp(-pow(length(vec2(p.x,p.y*1.5))/.79,2.0))*0.018;
  light+=vec3(1.0,.55,.20)*bloom*(1.0-captured);
  vec3 color=1.0-exp(-light*1.17);
  float alpha=max(captured,.82*smoothstep(.015,.85,max(color.r,max(color.g,color.b))));
  alpha*=1.0-smoothstep(.78,.98,max(abs(vUv.x),abs(vUv.y)));
  // A very faint veil softens the bright material without brightening the hole.
  gl_FragColor=vec4(color,alpha);
}
`;

const starFragment = `
precision highp float;
uniform float uTime;
varying vec2 vUv;
` + noiseShader + `
void main() {
  vec2 p=vUv;
  float r=length(p), radius=.355;
  float angle=atan(p.y,p.x);
  float coronaNoise=noise2(vec2(angle*4.0,uTime*.025+2.0));
  float corona=exp(-max(0.0,r-radius)*11.0)*(.6+.4*coronaNoise);
  float glow=exp(-r*r*5.2)*.22;
  vec3 color=vec3(.20,.48,.93)*(corona*.52+glow);
  float alpha=clamp(corona*.59+glow,0.0,.88);
  if(r<radius) {
    vec3 normal=vec3(p/radius,sqrt(max(0.0,1.0-r*r/(radius*radius))));
    float t=uTime*.055;
    vec3 surface=vec3(cos(t)*normal.x+sin(t)*normal.z,normal.y,-sin(t)*normal.x+cos(t)*normal.z);
    float cloud=noise3(surface*8.5)*.56+noise3(surface*19.0)*.28+noise3(surface*44.0)*.16;
    float cells=noise3(surface*91.0);
    float limb=.60+.40*pow(normal.z,.55);
    float heat=smoothstep(.19,.83,cloud*.82+cells*.18);
    color=mix(vec3(.29,.52,.81),vec3(.95,.985,1.0),heat)*limb;
    color+=vec3(.14,.20,.23)*pow(heat,4.0);
    alpha=1.0;
  }
  // Long, irregular prominences stay subdued behind the spherical surface.
  float strands=pow(.5+.5*sin(angle*27.0+coronaNoise*9.0),12.0);
  color+=vec3(.22,.40,.66)*strands*exp(-abs(r-radius-.055)*22.0)*.11;
  gl_FragColor=vec4(color,alpha*(1.0-smoothstep(.87,1.02,r)));
}
`;

const particleVertex = `
precision highp float;
attribute vec4 aParticle;
uniform float uTime;
uniform float uAspect;
uniform float uDpr;
varying vec3 vColor;
varying float vOpacity;
void main() {
  float radius=aParticle.x;
  float theta=aParticle.y+uTime*.27/pow(radius,.9);
  float elevation=.22+sin(uTime*.026)*.03;
  float tilt=.36+sin(uTime*.019)*.035;
  vec3 position=vec3(cos(theta)*radius,aParticle.z*radius*.018,sin(theta)*radius);
  vec3 observer=vec3(0.0,sin(elevation),cos(elevation))*8.5;
  vec3 forward=-normalize(observer), up=vec3(0.0,cos(elevation),-sin(elevation));
  vec3 relative=position-observer;
  float depth=dot(relative,forward);
  vec2 projected=vec2(position.x,dot(relative,up))*1.15/depth;
  float c=cos(tilt),s=sin(tilt);
  projected=mat2(c,s,-s,c)*projected;
  gl_Position=vec4(projected.x/uAspect,projected.y,0.0,1.0);
  gl_PointSize=clamp((.4+aParticle.w)*uDpr*8.5/depth,.7,2.0*uDpr);
  // Apparent horizon: hide material occluded by the central mass, including
  // particles on the rear half of the disk. They must never sparkle inside it.
  vec3 dir=normalize(relative);
  float b=dot(observer,dir);
  float discriminant=b*b-dot(observer,observer)+1.42*1.42;
  float occluded=0.0;
  if(discriminant>0.0 && -b-sqrt(discriminant)<length(relative)) occluded=1.0;
  float strength=exp(-(radius-1.4)*.52)*(.06+aParticle.w*.25);
  vOpacity=strength*(1.0-occluded);
  vColor=mix(vec3(1.0,.43,.12),vec3(1.0,.94,.73),exp(-(radius-1.4)*.50));
}
`;

const particleFragment = `
precision mediump float;
varying vec3 vColor;
varying float vOpacity;
void main() {
  vec2 p=gl_PointCoord*2.0-1.0;
  float glow=exp(-dot(p,p)*3.4);
  gl_FragColor=vec4(vColor,glow*vOpacity*.65);
}
`;

function random(seed: number) {
  let value = seed >>> 0;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}

function particles(count: number) {
  const rand = random(74193);
  const result = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    result[i * 4] = 1.48 + Math.pow(rand(), 1.35) * 3.63;
    result[i * 4 + 1] = rand() * Math.PI * 2;
    result[i * 4 + 2] = rand() * 2 - 1;
    result[i * 4 + 3] = rand();
  }
  return result;
}

export function createCosmicRenderer(canvas: HTMLCanvasElement): CosmicRenderer {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  const dispose = () => {
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const program of programs) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  };
  function compile(source: string, kind: number) {
    const shader = gl!.createShader(kind);
    if (!shader) throw new Error('Shader unavailable');
    shaders.push(shader);
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error('Cosmic shader compilation failed');
    return shader;
  }
  function program(vertex: string, fragment: string) {
    const result = gl!.createProgram();
    if (!result) throw new Error('Program unavailable');
    programs.push(result);
    gl!.attachShader(result, compile(vertex, gl!.VERTEX_SHADER));
    gl!.attachShader(result, compile(fragment, gl!.FRAGMENT_SHADER));
    gl!.linkProgram(result);
    if (!gl!.getProgramParameter(result, gl!.LINK_STATUS)) throw new Error('Cosmic program link failed');
    return result;
  }
  function buffer(data: Float32Array) {
    const result = gl!.createBuffer();
    if (!result) throw new Error('Buffer unavailable');
    buffers.push(result);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, result);
    gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);
    return result;
  }
  try {
    const sky = program(quadVertex, skyFragment);
    const hole = program(quadVertex, holeFragment);
    const star = program(quadVertex, starFragment);
    const dust = program(particleVertex, particleFragment);
    const quad = buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    const dustCount = 20_000;
    const dustBuffer = buffer(particles(dustCount));
    const uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
    let width = 1, height = 1, dpr = 1;
    let bodies = layout(width, height);
    function uniform(target: WebGLProgram, name: string) {
      let values = uniformCache.get(target);
      if (!values) { values = new Map(); uniformCache.set(target, values); }
      if (!values.has(name)) values.set(name, gl!.getUniformLocation(target, name));
      return values.get(name)!;
    }
    function viewport(body: Body) {
      gl!.viewport(Math.round(body.x * dpr), Math.round((height - body.y - body.height) * dpr), Math.round(body.width * dpr), Math.round(body.height * dpr));
    }
    function drawQuad(target: WebGLProgram, time: number, aspect = 1) {
      gl!.useProgram(target);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, quad);
      const attribute = gl!.getAttribLocation(target, 'aPosition');
      gl!.enableVertexAttribArray(attribute);
      gl!.vertexAttribPointer(attribute, 2, gl!.FLOAT, false, 0, 0);
      gl!.uniform1f(uniform(target, 'uTime'), time);
      gl!.uniform1f(uniform(target, 'uAspect'), aspect);
      gl!.uniform1f(uniform(target, 'uDpr'), dpr);
      gl!.uniform2f(uniform(target, 'uResolution'), width * dpr, height * dpr);
      gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      gl!.disableVertexAttribArray(attribute);
    }
    return {
      animated: true,
      resize(nextWidth, nextHeight, nextDpr) {
        width = nextWidth; height = nextHeight; dpr = nextDpr;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        bodies = layout(width, height);
      },
      draw(time) {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, canvas.width, canvas.height);
        drawQuad(sky, time);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        viewport(bodies.star);
        drawQuad(star, time);
        viewport(bodies.hole);
        drawQuad(hole, time, bodies.hole.width / bodies.hole.height);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.useProgram(dust);
        gl.bindBuffer(gl.ARRAY_BUFFER, dustBuffer);
        const attribute = gl.getAttribLocation(dust, 'aParticle');
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(uniform(dust, 'uTime'), time);
        gl.uniform1f(uniform(dust, 'uAspect'), bodies.hole.width / bodies.hole.height);
        gl.uniform1f(uniform(dust, 'uDpr'), dpr);
        gl.drawArrays(gl.POINTS, 0, dustCount);
        gl.disableVertexAttribArray(attribute);
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}

// Static software rendering is deliberately kept independent of WebGL so a
// rejected/lost GPU context still shows both bodies instead of a blank page.
export function createStaticCosmicRenderer(canvas: HTMLCanvasElement): CosmicRenderer {
  const ctx = canvas.getContext('2d');
  let width = 1, height = 1, dpr = 1;
  const material = particles(14_000);
  return {
    animated: false,
    resize(nextWidth, nextHeight, nextDpr) {
      width = nextWidth; height = nextHeight; dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    },
    draw() {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#020307'; ctx.fillRect(0, 0, width, height);
      const rand = random(14713);
      for (let i = 0; i < 120; i++) {
        const x = rand() * width, y = rand() * height, size = .35 + rand() * .9;
        ctx.fillStyle = 'rgba(205,221,246,' + (.18 + rand() * .7) + ')';
        ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
      }
      const bodies = layout(width, height);
      const star = bodies.star, sx = star.x + star.width / 2, sy = star.y + star.height / 2;
      const sphere = star.width * .1775;
      let gradient = ctx.createRadialGradient(sx, sy, sphere * .3, sx, sy, star.width * .48);
      gradient.addColorStop(0, '#b9ddff'); gradient.addColorStop(.3, '#659edf75'); gradient.addColorStop(.7, '#2a508823'); gradient.addColorStop(1, '#15274300');
      ctx.fillStyle = gradient; ctx.fillRect(star.x, star.y, star.width, star.height);
      gradient = ctx.createRadialGradient(sx - sphere * .2, sy - sphere * .15, 0, sx, sy, sphere);
      gradient.addColorStop(0, '#dcefff'); gradient.addColorStop(.7, '#a4c8e6'); gradient.addColorStop(1, '#5881b0');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(sx, sy, sphere, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sphere, 0, Math.PI * 2); ctx.clip();
      for (let i = 0; i < 4_000; i++) {
        const x = (rand() * 2 - 1) * sphere, y = (rand() * 2 - 1) * sphere;
        ctx.fillStyle = rand() > .5 ? '#f6fcff26' : '#19416a2b';
        ctx.fillRect(sx + x, sy + y, 1 + rand() * 2.3, 1 + rand() * 2.3);
      }
      ctx.restore();
      const hole = bodies.hole, cx = hole.x + hole.width / 2, cy = hole.y + hole.height / 2;
      const scale = hole.height * .5 * 1.15, horizon = scale * 1.42 / 8.5;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-.36);
      gradient = ctx.createRadialGradient(0, 0, horizon * .9, 0, 0, horizon * 2.2);
      gradient.addColorStop(0, '#00000000'); gradient.addColorStop(.13, '#ffdda771'); gradient.addColorStop(.5, '#a96b2627'); gradient.addColorStop(1, '#00000000');
      ctx.scale(1, .68); ctx.fillStyle = gradient; ctx.fillRect(-horizon * 2.5, -horizon * 2.5, horizon * 5, horizon * 5); ctx.scale(1, 1 / .68);
      const projected: { x: number; y: number; depth: number; radius: number; light: number }[] = [];
      for (let i = 0; i < material.length; i += 4) {
        const r = material[i], a = material[i + 1], x = Math.cos(a) * r, z = Math.sin(a) * r;
        const y = material[i + 2] * r * .018;
        const depth = 8.5 - y * Math.sin(.22) - z * Math.cos(.22);
        projected.push({ x: x / depth * scale, y: -(y * Math.cos(.22) - z * Math.sin(.22)) / depth * scale, depth, radius: r, light: material[i + 3] });
      }
      projected.sort((a, b) => b.depth - a.depth);
      for (const point of projected) {
        if (Math.hypot(point.x, point.y) < horizon * .97) continue;
        const inner = Math.exp(-(point.radius - 1.4) * .5);
        ctx.fillStyle = 'rgba(255,' + Math.round(112 + inner * 120) + ',' + Math.round(33 + inner * 149) + ',' + (.10 + point.light * .58) + ')';
        const size = .45 + point.light * .85;
        ctx.fillRect(point.x, point.y, size, size);
      }
      ctx.fillStyle = '#010102'; ctx.beginPath(); ctx.arc(0, 0, horizon * .96, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffe6b6a8'; ctx.lineWidth = Math.max(.7, horizon * .013);
      ctx.beginPath(); ctx.arc(0, 0, horizon * .985, .92 * Math.PI, 2.04 * Math.PI); ctx.stroke();
      ctx.restore();
    },
    dispose() { /* No timer or GPU allocation in the static fallback. */ },
  };
}
