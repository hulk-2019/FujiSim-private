import { useCallback, useEffect, useRef } from "react";
import type { FilterSettings } from "@/types";

const GPU_INTERACTIVE_CANVAS_MAX_EDGE = 1280;

type GlState = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  buffer: WebGLBuffer;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  uniforms: Record<
    | "exposure"
    | "brightness"
    | "contrast"
    | "saturation"
    | "wb"
    | "highlight"
    | "shadow"
    | "white"
    | "black"
    | "hslHue"
    | "hslSat"
    | "hslLum",
    WebGLUniformLocation | null
  >;
};

export function GpuInteractivePreviewCanvas({
  src,
  filter,
  visible,
  onReadyChange,
}: {
  src: string;
  filter: FilterSettings;
  visible: boolean;
  onReadyChange: (ready: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GlState | null>(null);
  const latestFilterRef = useRef(filter);
  const drawRafRef = useRef<number | null>(null);
  const hslHueUniformRef = useRef(new Float32Array(8));
  const hslSatUniformRef = useRef(new Float32Array(8));
  const hslLumUniformRef = useRef(new Float32Array(8));

  useEffect(() => {
    latestFilterRef.current = filter;
  }, [filter]);

  const draw = useCallback((settings: FilterSettings) => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return false;

    const { gl, program } = state;
    const cssW = Math.max(1, canvas.clientWidth);
    const cssH = Math.max(1, canvas.clientHeight);
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const scale = Math.min(1, GPU_INTERACTIVE_CANVAS_MAX_EDGE / Math.max(cssW, cssH));
    const width = Math.max(1, Math.round(cssW * dpr * scale));
    const height = Math.max(1, Math.round(cssH * dpr * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    fillHslUniforms(settings, hslHueUniformRef.current, hslSatUniformRef.current, hslLumUniformRef.current);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform1f(state.uniforms.exposure, settings.exposure);
    gl.uniform1f(state.uniforms.brightness, settings.brightness * 0.005);
    gl.uniform1f(state.uniforms.contrast, 1 + settings.contrast * 0.01);
    gl.uniform1f(
      state.uniforms.saturation,
      Math.max(0, 1 + (settings.color_saturation + settings.vibrance * 0.5) * 0.01),
    );
    gl.uniform3f(
      state.uniforms.wb,
      1 + settings.wb_shift_r * 0.005,
      1 + settings.wb_shift_g * 0.005,
      1 + settings.wb_shift_b * 0.005,
    );
    gl.uniform1f(state.uniforms.highlight, settings.highlight_tone * 0.004);
    gl.uniform1f(state.uniforms.shadow, settings.shadow_tone * 0.004);
    gl.uniform1f(state.uniforms.white, settings.white * 0.004);
    gl.uniform1f(state.uniforms.black, settings.black * 0.004);
    gl.uniform1fv(state.uniforms.hslHue, hslHueUniformRef.current);
    gl.uniform1fv(state.uniforms.hslSat, hslSatUniformRef.current);
    gl.uniform1fv(state.uniforms.hslLum, hslLumUniformRef.current);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }, []);

  const scheduleDraw = useCallback((settings: FilterSettings) => {
    latestFilterRef.current = settings;
    if (drawRafRef.current != null) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      if (draw(latestFilterRef.current)) onReadyChange(true);
    });
  }, [draw, onReadyChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    onReadyChange(false);
    cleanupGl(glStateRef, drawRafRef);

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      const gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) return;

      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = linkProgram(gl, vertexShader, fragmentShader);
      const buffer = gl.createBuffer();
      const texture = gl.createTexture();
      if (!buffer || !texture) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD_BUFFER, gl.STATIC_DRAW);
      const stride = 4 * 4;
      const posLoc = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
      const texLoc = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, stride, 2 * 4);

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      glStateRef.current = { gl, program, texture, buffer, vertexShader, fragmentShader, uniforms: getUniforms(gl, program) };
      if (draw(latestFilterRef.current)) onReadyChange(true);
    };
    image.src = src;

    return () => {
      cancelled = true;
      cleanupGl(glStateRef, drawRafRef);
    };
  }, [src, draw, onReadyChange]);

  useEffect(() => {
    scheduleDraw(filter);
  }, [filter, scheduleDraw]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: visible ? 1 : 0, pointerEvents: "none" }}
    />
  );
}

function fillHslUniforms(settings: FilterSettings, hue: Float32Array, sat: Float32Array, lum: Float32Array) {
  hue.set([
    settings.hsl_red_hue / 360,
    settings.hsl_orange_hue / 360,
    settings.hsl_yellow_hue / 360,
    settings.hsl_green_hue / 360,
    settings.hsl_aqua_hue / 360,
    settings.hsl_blue_hue / 360,
    settings.hsl_purple_hue / 360,
    settings.hsl_magenta_hue / 360,
  ]);
  sat.set([
    settings.hsl_red_sat * 0.01,
    settings.hsl_orange_sat * 0.01,
    settings.hsl_yellow_sat * 0.01,
    settings.hsl_green_sat * 0.01,
    settings.hsl_aqua_sat * 0.01,
    settings.hsl_blue_sat * 0.01,
    settings.hsl_purple_sat * 0.01,
    settings.hsl_magenta_sat * 0.01,
  ]);
  lum.set([
    settings.hsl_red_lum * 0.01,
    settings.hsl_orange_lum * 0.01,
    settings.hsl_yellow_lum * 0.01,
    settings.hsl_green_lum * 0.01,
    settings.hsl_aqua_lum * 0.01,
    settings.hsl_blue_lum * 0.01,
    settings.hsl_purple_lum * 0.01,
    settings.hsl_magenta_lum * 0.01,
  ]);
}

function cleanupGl(glStateRef: React.MutableRefObject<GlState | null>, drawRafRef: React.MutableRefObject<number | null>) {
  if (drawRafRef.current != null) {
    cancelAnimationFrame(drawRafRef.current);
    drawRafRef.current = null;
  }
  const state = glStateRef.current;
  if (!state) return;
  state.gl.deleteTexture(state.texture);
  state.gl.deleteBuffer(state.buffer);
  state.gl.deleteShader(state.vertexShader);
  state.gl.deleteShader(state.fragmentShader);
  state.gl.deleteProgram(state.program);
  glStateRef.current = null;
}

function getUniforms(gl: WebGLRenderingContext, program: WebGLProgram): GlState["uniforms"] {
  return {
    exposure: gl.getUniformLocation(program, "u_exposure"),
    brightness: gl.getUniformLocation(program, "u_brightness"),
    contrast: gl.getUniformLocation(program, "u_contrast"),
    saturation: gl.getUniformLocation(program, "u_saturation"),
    wb: gl.getUniformLocation(program, "u_wb"),
    highlight: gl.getUniformLocation(program, "u_highlight"),
    shadow: gl.getUniformLocation(program, "u_shadow"),
    white: gl.getUniformLocation(program, "u_white"),
    black: gl.getUniformLocation(program, "u_black"),
    hslHue: gl.getUniformLocation(program, "u_hsl_hue[0]"),
    hslSat: gl.getUniformLocation(program, "u_hsl_sat[0]"),
    hslLum: gl.getUniformLocation(program, "u_hsl_lum[0]"),
  };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "shader compile failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "program link failed";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

const QUAD_BUFFER = new Float32Array([
  -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0,
  -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
]);

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_image;
uniform float u_exposure, u_brightness, u_contrast, u_saturation;
uniform vec3 u_wb;
uniform float u_highlight, u_shadow, u_white, u_black;
uniform float u_hsl_hue[8], u_hsl_sat[8], u_hsl_lum[8];
varying vec2 v_texCoord;
float hueDistance(float a, float b){float d=abs(a-b);return min(d,1.0-d);}
vec3 rgbToHsl(vec3 c){float mx=max(max(c.r,c.g),c.b),mn=min(min(c.r,c.g),c.b),l=(mx+mn)*0.5,h=0.0,s=0.0,d=mx-mn;if(d>0.00001){s=l>0.5?d/(2.0-mx-mn):d/(mx+mn);if(mx==c.r){h=(c.g-c.b)/d+(c.g<c.b?6.0:0.0);}else if(mx==c.g){h=(c.b-c.r)/d+2.0;}else{h=(c.r-c.g)/d+4.0;}h/=6.0;}return vec3(h,s,l);}
float hueToRgb(float p,float q,float t){if(t<0.0)t+=1.0;if(t>1.0)t-=1.0;if(t<1.0/6.0)return p+(q-p)*6.0*t;if(t<0.5)return q;if(t<2.0/3.0)return p+(q-p)*(2.0/3.0-t)*6.0;return p;}
vec3 hslToRgb(vec3 hsl){float h=hsl.x,s=hsl.y,l=hsl.z;if(s<=0.00001)return vec3(l);float q=l<0.5?l*(1.0+s):l+s-l*s;float p=2.0*l-q;return vec3(hueToRgb(p,q,h+1.0/3.0),hueToRgb(p,q,h),hueToRgb(p,q,h-1.0/3.0));}
vec3 applyTone(vec3 c){float l=dot(c,vec3(0.2126,0.7152,0.0722));float sw=1.0-smoothstep(0.05,0.55,l);float hw=smoothstep(0.45,0.95,l);float bw=1.0-smoothstep(0.0,0.25,l);float ww=smoothstep(0.75,1.0,l);return c+vec3(u_shadow*sw+u_highlight*hw+u_black*bw+u_white*ww);}
vec3 applyHsl(vec3 c){vec3 hsl=rgbToHsl(c);float centers[8];centers[0]=0.0;centers[1]=30.0/360.0;centers[2]=60.0/360.0;centers[3]=120.0/360.0;centers[4]=180.0/360.0;centers[5]=240.0/360.0;centers[6]=280.0/360.0;centers[7]=320.0/360.0;float hs=0.0,ss=0.0,ls=0.0,tw=0.0;for(int i=0;i<8;i++){float w=smoothstep(1.0/6.0,0.0,hueDistance(hsl.x,centers[i]));hs+=u_hsl_hue[i]*w;ss+=u_hsl_sat[i]*w;ls+=u_hsl_lum[i]*w;tw+=w;}if(tw>0.00001){hs/=tw;ss/=tw;ls/=tw;}hsl.x=fract(hsl.x+hs+1.0);hsl.y=clamp(hsl.y*(1.0+ss),0.0,1.0);hsl.z=clamp(hsl.z+ls*0.5,0.0,1.0);return hslToRgb(hsl);}
void main(){vec3 c=texture2D(u_image,v_texCoord).rgb;float l0=max(dot(c,vec3(0.2126,0.7152,0.0722)),0.00001);c*=u_wb;float l1=max(dot(c,vec3(0.2126,0.7152,0.0722)),0.00001);c*=l0/l1;c*=pow(2.0,u_exposure);c+=vec3(u_brightness);c=(c-vec3(0.5))*u_contrast+vec3(0.5);c=applyTone(c);float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,u_saturation);c=applyHsl(clamp(c,0.0,1.0));gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}
`;
