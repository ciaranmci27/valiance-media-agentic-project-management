'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { blendColor, type TimeOfDay } from './timeOfDay';
import { directionFor } from './celestial';
import { GROUND_RADIUS, GROUND_Y, hazeAt } from './atmosphere';
import { Sky } from './Sky';
import { planCity, parkCentres, type Building, type CityPlan } from './cityLayout';
import { ROOM_CENTER_Z } from './roomLayout';

/**
 * The world outside the glass.
 *
 * The buildings are real geometry at a spread of real distances — that part was
 * already right, and it is what produces depth: near ones slide against the
 * window as you move while far ones barely budge, and they hide each other. A
 * photograph on a cylinder could never do that, because every pixel of it sat
 * at exactly one distance.
 *
 * What was wrong was the surface. Every tower was one flat near-black box, with
 * lit windows scattered over it as separate glowing quads on a synthetic grid,
 * because there was no facade for them to line up with. From inside the room
 * that reads as cardboard: no material, no sun and shade across the faces, and
 * windows that are rectangles of light rather than windows.
 *
 * They now carry photographed facades (ambientCG, CC0) with the matching
 * emission map from the same wall with its lights on — so the lit windows are
 * the building's own windows, in the right places, at the right spacing, with
 * the variation a real block has. The separate quad system is gone.
 */


/**
 * The six facades, and the real-world size of one tile of each.
 *
 * `metersPerTile` is the number that decides whether a building reads as a
 * building or as a photograph stretched over a box: it converts the instance's
 * actual width and height into a UV repeat, so a 40m tower gets twice the
 * window rows of a 20m one instead of the same texture squashed differently.
 * 019B is the one exact value — ambientCG publishes its physical size as
 * 13x13m — and the rest are set from the window pitch visible in each scan.
 *
 * `tint` is a mild per-facade cast so six textures cover 300 buildings without
 * the repetition reading as repetition.
 */
type Facade = {
  slug: string;
  metersPerTile: number;
  tint: string;
};

const CITY_FACADES: Facade[] = [
  { slug: 'facade002', metersPerTile: 30, tint: '#9fb0c4' }, // modern blue-grey glass
  { slug: 'facade013', metersPerTile: 54, tint: '#b6a894' }, // tan curtain wall
  { slug: 'facade015', metersPerTile: 50, tint: '#b9bfc6' }, // pale grey curtain wall
  { slug: 'facade016', metersPerTile: 50, tint: '#ab9585' }, // warm brown curtain wall
  { slug: 'facade017', metersPerTile: 34, tint: '#8f949c' }, // dark piers, warm bands
  { slug: 'facade019b', metersPerTile: 13, tint: '#adb2b3' }, // grey concrete bands
];

/**
 * Where the haze begins, where it saturates, and how much it is ever allowed to
 * take.
 *
 * The first pass ran 60m to 780m and washed the skyline into a flat pale
 * cut-out: by 400m a building was already more than half haze, which erased the
 * facades the whole change exists to show. Real aerial perspective over a few
 * hundred metres of city air is much gentler than that. Starting further out,
 * saturating further out, and biting late (the exponent) keeps the middle
 * distance legible; the cap stops even the furthest tower from dissolving
 * completely into the sky, which is what makes a skyline read as a silhouette
 * against it rather than as nothing at all.
 */
const HAZE_NEAR = 140;
const HAZE_FAR = 1100;
const HAZE_CURVE = 1.35;
const HAZE_MAX = 0.82;

/** Seeded LCG. Same generator the rest of the scene uses, so a reload always
 *  produces the identical city rather than reshuffling it. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/**
 * The one shader the whole city is drawn with.
 *
 * A bespoke `ShaderMaterial` rather than a stock material for two reasons.
 *
 * First, lighting. `MeshLambertMaterial` would pick up every light in the
 * scene, and the scene is an office: two strong rim lights aimed down the
 * window axis, a spot over the desks, ceiling pools. Those exist to shape four
 * seated figures three metres away and have no business reaching a tower 400m
 * outside, but a directional light does not fall off, so they would wash the
 * skyline flat. The city gets exactly two lights — the sun, and the sky — both
 * passed in as uniforms.
 *
 * Second, aerial perspective. `three` allows one fog per scene, and the room's
 * is `[18, 40]`, which would erase everything out here before the nearest
 * tower. The distance haze is therefore done here, per pixel, mixing toward the
 * same atmospheric tone the sky dome and the ground fade into. Per pixel rather
 * than the previous per-building tint, because that is what makes a near tower
 * read as being in front of a far one rather than merely darker than it.
 */
function makeCityMaterial(map: THREE.Texture, emissive: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uMap: { value: map },
      uEmissive: { value: emissive },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0, 0, 0) },
      uSkyColor: { value: new THREE.Color(0, 0, 0) },
      uHazeColor: { value: new THREE.Color(0, 0, 0) },
      uWindowGain: { value: 0 },
      uHazeNear: { value: HAZE_NEAR },
      uHazeFar: { value: HAZE_FAR },
      uHazeCurve: { value: HAZE_CURVE },
      uHazeMax: { value: HAZE_MAX },
    },
    vertexShader: /* glsl */ `
      // Per-instance, because one InstancedMesh shares one geometry and one
      // material: without these every tower would tile its facade identically
      // regardless of how big it is, which is the reason the previous version
      // concluded a texture could not be used here at all.
      attribute vec3 aUvScale;   // (repeats across X-facing faces, across Z-facing faces, up)
      attribute vec2 aUvOffset;  // where in the texture this building starts
      attribute vec3 aTint;
      attribute vec3 aEmissive;  // self-lit, for mast beacons; zero on facades

      varying vec2 vCityUv;
      varying vec3 vCityNormal;
      varying vec3 vCityWorld;
      varying vec3 vCityTint;
      varying vec3 vCityEmissive;
      varying float vCityRoof;

      void main() {
        // A box's four side faces all carry uv 0..1, but the X-facing pair
        // spans the depth and the Z-facing pair spans the width, so which
        // repeat count applies depends on the face.
        float xFacing = step(0.5, abs(normal.x));
        float acrossRepeats = mix(aUvScale.y, aUvScale.x, xFacing);
        vCityRoof = step(0.5, abs(normal.y));
        vCityUv = vec2(uv.x * acrossRepeats, uv.y * aUvScale.z) + aUvOffset;

        // The ground plane uses this same material so it takes the same sun,
        // sky and haze as the buildings standing on it — but it is a plain mesh,
        // and instanceMatrix only exists on an InstancedMesh.
        #ifdef USE_INSTANCING
          mat4 inst = instanceMatrix;
        #else
          mat4 inst = mat4(1.0);
        #endif

        // inst scales each axis independently, which would skew an arbitrary
        // normal — but a box's normals are axis-aligned, so each one comes out
        // along its own scaled axis and normalises back exactly.
        vCityNormal = normalize(mat3(modelMatrix) * mat3(inst) * normal);

        vec4 world = modelMatrix * inst * vec4(position, 1.0);
        vCityWorld = world.xyz;
        vCityTint = aTint;
        vCityEmissive = aEmissive;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    // `sRGBTransferEOTF` and `linearToOutputTexel` come free: WebGLProgram puts
    // `colorspace_pars_fragment` and the generated output transfer into every
    // fragment prefix, so they must NOT be included again here.
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform sampler2D uEmissive;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uHazeColor;
      uniform float uWindowGain;
      uniform float uHazeNear;
      uniform float uHazeFar;
      uniform float uHazeCurve;
      uniform float uHazeMax;

      varying vec2 vCityUv;
      varying vec3 vCityNormal;
      varying vec3 vCityWorld;
      varying vec3 vCityTint;
      varying vec3 vCityEmissive;
      varying float vCityRoof;

      void main() {
        vec3 albedo = sRGBTransferEOTF(texture2D(uMap, vCityUv)).rgb * vCityTint;
        vec3 windows = sRGBTransferEOTF(texture2D(uEmissive, vCityUv)).rgb * uWindowGain;

        // Roofs are plant, gravel and ducting, not more wall. Flattening them
        // to one dark tone is both truer and cheaper than wrapping a facade
        // over the top of a building, and the near layer is all roof.
        albedo = mix(albedo, vec3(0.055, 0.058, 0.062), vCityRoof);
        windows *= 1.0 - vCityRoof;

        vec3 n = normalize(vCityNormal);
        float sun = max(dot(n, uSunDirection), 0.0);
        // Sky light falls mostly from above, so upward faces get more of it.
        float sky = 0.5 + 0.5 * n.y;

        vec3 color = albedo * (uSunColor * sun + uSkyColor * sky) + windows + vCityEmissive;

        // Aerial perspective. Horizontal distance only: the vertical spread of
        // the city is 160m against a 780m haze range, and using the true 3D
        // distance would make the tops of near towers hazier than their bases.
        float d = length(vCityWorld.xz - cameraPosition.xz);
        float haze = clamp((d - uHazeNear) / (uHazeFar - uHazeNear), 0.0, 1.0);
        color = mix(color, uHazeColor, pow(haze, uHazeCurve) * uHazeMax);

        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Stable module constant: `useLoader` re-fetches if the input array identity churns. */
const FACADE_URLS = CITY_FACADES.flatMap((f) => [
  `/textures/command/facade/${f.slug}_color.jpg`,
  `/textures/command/facade/${f.slug}_emissive.jpg`,
]);

/**
 * Set up the facade maps once they have loaded.
 *
 * Done through `useTexture`'s own `onLoad` rather than by reaching into the
 * hook's return value during render. drei runs this in a layout effect, which
 * is before R3F draws its first frame, so nothing is ever rendered with the
 * defaults.
 *
 * The tiling and filtering here are not incidental: the facades are repeated
 * per building by the shader, so `RepeatWrapping` is what makes that legal at
 * all, and distant towers are far below one texel per pixel — without mipmaps
 * and real anisotropy the whole skyline crawls as the camera drifts.
 */
function configureFacadeMaps(maps: THREE.Texture[]) {
  for (const t of maps) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
  }
}

/** A 1x1 texture, for the geometry that wants the city shader but no photograph. */
function solidTexture(value: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([value, value, value, 255]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** What one instanced draw needs: a transform, a UV mapping, and a colour. */
type Instance = {
  position: THREE.Vector3;
  yaw: number;
  scale: THREE.Vector3;
  uvScale: [number, number, number];
  uvOffset: [number, number];
  tint: THREE.Color;
  emissive?: THREE.Color;
};

/**
 * Build one `InstancedMesh` and hand it to R3F as a primitive.
 *
 * Written imperatively rather than as `<instancedMesh>` with a ref because the
 * per-instance attributes have to exist on the geometry before the first
 * render, and a ref-and-effect version draws one frame with them missing.
 */
function buildInstances(instances: Instance[], material: THREE.ShaderMaterial): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const count = instances.length;

  const uvScale = new Float32Array(count * 3);
  const uvOffset = new Float32Array(count * 2);
  const tint = new Float32Array(count * 3);
  const emissive = new Float32Array(count * 3);

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);

  instances.forEach((instance, i) => {
    quaternion.setFromAxisAngle(axis, instance.yaw);
    matrix.compose(instance.position, quaternion, instance.scale);
    mesh.setMatrixAt(i, matrix);

    uvScale.set(instance.uvScale, i * 3);
    uvOffset.set(instance.uvOffset, i * 2);
    tint.set([instance.tint.r, instance.tint.g, instance.tint.b], i * 3);
    const e = instance.emissive;
    emissive.set(e ? [e.r, e.g, e.b] : [0, 0, 0], i * 3);
  });

  geometry.setAttribute('aUvScale', new THREE.InstancedBufferAttribute(uvScale, 3));
  geometry.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(uvOffset, 2));
  geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  geometry.setAttribute('aEmissive', new THREE.InstancedBufferAttribute(emissive, 3));

  mesh.instanceMatrix.needsUpdate = true;
  // The bounding sphere of the base box says nothing about where 300 instances
  // ended up, and everything here is meant to be visible whenever the window is.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Rooftop plant, and masts on the landmarks.
 *
 * The near layer is nothing but roofs — you are looking down onto it — and a
 * bare box lid is the single most obvious tell left once the walls are
 * photographs. These are cheap: one more instanced draw of the same unit box,
 * through the same shader, so they take the same sun and the same haze.
 *
 * The masts get a red beacon, which is the one thing in the whole city that is
 * emissive by day as well as by night, because an aircraft warning light is.
 */
function rooftopInstances(buildings: Building[]): Instance[] {
  const rnd = lcg(5501);
  const out: Instance[] = [];
  const plant = new THREE.Color('#3c4046');
  const mast = new THREE.Color('#2a2d33');
  const beacon = new THREE.Color('#ff2a2a').multiplyScalar(3.4);
  const flatUv: Pick<Instance, 'uvScale' | 'uvOffset'> = { uvScale: [1, 1, 1], uvOffset: [0, 0] };

  for (const b of buildings) {
    // Only where it can be seen. Past the middle distance a 3m box on a roof is
    // well under a pixel, and 300 of them would be 300 instances of nothing.
    if (b.dist > 320) {
      if (!b.landmark) continue;
    }

    const units = b.landmark ? 2 : 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < units; i++) {
      const w = Math.min(b.width, b.depth) * (0.16 + rnd() * 0.26);
      const h = 1.6 + rnd() * 4.2;
      // Kept inside the roof's own footprint, allowing for the building's yaw.
      const inset = 0.5 - w / Math.min(b.width, b.depth) / 2 - 0.06;
      const ox = (rnd() - 0.5) * 2 * inset;
      const oz = (rnd() - 0.5) * 2 * inset;
      const cos = Math.cos(b.yaw);
      const sin = Math.sin(b.yaw);
      const dx = ox * b.width;
      const dz = oz * b.depth;
      out.push({
        position: new THREE.Vector3(
          b.x + dx * cos + dz * sin,
          b.top + h / 2,
          b.z - dx * sin + dz * cos
        ),
        yaw: b.yaw,
        scale: new THREE.Vector3(w, h, w * (0.7 + rnd() * 0.6)),
        ...flatUv,
        tint: plant.clone().multiplyScalar(0.8 + rnd() * 0.5),
      });
    }

    if (b.landmark) {
      const mastHeight = 10 + rnd() * 16;
      out.push({
        position: new THREE.Vector3(b.x, b.top + mastHeight / 2, b.z),
        yaw: b.yaw,
        scale: new THREE.Vector3(0.9, mastHeight, 0.9),
        ...flatUv,
        tint: mast,
      });
      out.push({
        position: new THREE.Vector3(b.x, b.top + mastHeight + 1.2, b.z),
        yaw: b.yaw,
        scale: new THREE.Vector3(1.8, 1.8, 1.8),
        ...flatUv,
        tint: new THREE.Color('#1a0505'),
        emissive: beacon,
      });
    }
  }
  return out;
}

/** Convert a building into the instance the shader wants. */
function buildingInstance(b: Building): Instance {
  const facade = CITY_FACADES[b.facade];
  const height = b.top - GROUND_Y;
  const perTile = facade.metersPerTile;
  return {
    position: new THREE.Vector3(b.x, GROUND_Y + height / 2, b.z),
    yaw: b.yaw,
    scale: new THREE.Vector3(b.width, height, b.depth),
    // Real-world tiling: how many texture tiles fit across each face and up the
    // building. This is the whole point of the per-instance attributes.
    uvScale: [b.depth / perTile, b.width / perTile, height / perTile],
    // A random start, so two towers with the same facade are not the same
    // building. Costs nothing and removes most of the visible repetition.
    uvOffset: [b.x % 1, b.z % 1],
    tint: new THREE.Color(facade.tint).multiplyScalar(b.shade),
  };
}

/**
 * The buildings: one instanced draw per facade, six in total.
 *
 * Grouping by facade is what makes textured instancing possible at all —
 * instances share a material, so each texture needs its own mesh — and six
 * draw calls for three hundred buildings is still nothing.
 */
function CityBuildings({ buildings, materials }: { buildings: Building[]; materials: THREE.ShaderMaterial[] }) {
  const meshes = useMemo(() => {
    return CITY_FACADES.map((_, index) => {
      const instances = buildings.filter((b) => b.facade === index).map(buildingInstance);
      return instances.length ? buildInstances(instances, materials[index]) : null;
    }).filter((m): m is THREE.InstancedMesh => m !== null);
  }, [buildings, materials]);

  useEffect(() => {
    return () => {
      // The materials are owned by CityView, which disposes them; only the
      // geometry built here belongs to this component.
      for (const mesh of meshes) mesh.geometry.dispose();
    };
  }, [meshes]);

  return (
    <>
      {meshes.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </>
  );
}

function CityRooftops({ buildings, material }: { buildings: Building[]; material: THREE.ShaderMaterial }) {
  const mesh = useMemo(() => buildInstances(rooftopInstances(buildings), material), [buildings, material]);
  useEffect(() => () => mesh.geometry.dispose(), [mesh]);
  return <primitive object={mesh} />;
}

/**
 * The ground far below, with a river through it.
 *
 * A disc rather than a plane, sized to meet the sky dome at its own horizon so
 * the two share an edge. Both fade to the same haze tone there, which is what
 * puts the apparent horizon at eye level even though the ground actually stops
 * at GROUND_RADIUS. Only ever seen at steep angles from near the glass.
 */
/** The ground plane spans this much world, and the texture covers exactly it. */
const GROUND_SPAN = GROUND_RADIUS * 2;
const GROUND_TEXTURE_SIZE = 2048;
/** 2360m across 2048px — a 24m street comes out 21px wide, which is legible from 150m up. */
const METRES_PER_TEXEL = GROUND_SPAN / GROUND_TEXTURE_SIZE;

/**
 * The ground, drawn from the same plan the buildings are placed from.
 *
 * This is the fix for "there is no street or ground". The old version painted a
 * 1024px canvas across 2360m — 2.3 metres per pixel, on which no street can
 * exist — with a river bezier bearing no relation to anything, and faded it into
 * haze from 354m out, so most of what you could see was flat fog. Buildings
 * stood on it at random angles, so even a perfect street drawing would not have
 * lined up with the gaps between them.
 *
 * Now the streets ARE the gaps. The canvas is filled with road surface and then
 * every planned block is painted over it, so the road network is exactly the
 * negative space the buildings leave — they cannot disagree, because they are
 * the same rectangles.
 *
 * Two maps, matching the facades: an albedo that the shader lights with the same
 * sun and sky as everything else, and an emissive carrying the street lights.
 * Both are built ONCE. The previous version redrew a canvas every minute as the
 * light changed; with the city shader doing the lighting, the ground only has to
 * describe what is there, not what time it is.
 */
function drawGround(plan: CityPlan): { color: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = GROUND_TEXTURE_SIZE;
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    return canvas;
  };
  const colorCanvas = make();
  const emissiveCanvas = make();
  const ctx = colorCanvas.getContext('2d')!;
  const ectx = emissiveCanvas.getContext('2d')!;

  // World -> texel. The plane is centred on the room and rotated -90° about X,
  // which maps +X to +u and +Z to +v once the texture's own Y flip is applied.
  const px = (x: number) => (0.5 + x / GROUND_SPAN) * S;
  const py = (z: number) => (0.5 + (z - ROOM_CENTER_Z) / GROUND_SPAN) * S;
  const m = (metres: number) => metres / METRES_PER_TEXEL;

  // Road surface everywhere; blocks are painted on top. Everything left over is
  // street, which is exactly what a street is.
  // Asphalt is genuinely dark, but a horizontal surface takes the full sun term
  // plus the whole sky dome, so at 0.033 linear it was coming back at about 24%
  // grey from 150m up and reading as a hole rather than a road.
  ctx.fillStyle = '#4a4e55';
  ctx.fillRect(0, 0, S, S);
  ectx.fillStyle = '#000000';
  ectx.fillRect(0, 0, S, S);

  const rnd = lcg(4451);

  const fillBlock = (b: CityPlan['blocks'][number], style: string) => {
    ctx.save();
    ctx.translate(px(b.cx), py(b.cz));
    ctx.rotate(plan.gridYaw);
    ctx.fillStyle = style;
    ctx.fillRect(-m(b.halfU), -m(b.halfV), m(b.halfU * 2), m(b.halfV * 2));
    ctx.restore();
  };

  for (const b of plan.blocks) {
    if (b.district === 'water') continue; // the river is drawn over the top
    if (b.district === 'park') {
      fillBlock(b, '#3d5834');
      continue;
    }
    // Built blocks: dark, because almost all of this is under a building or in
    // its shadow. What reads is the street around it.
    fillBlock(b, '#34373d');
  }

  // Pavements: a lighter hairline just inside each block edge. One cheap detail
  // that does a lot, because it is what gives the street a defined kerb rather
  // than a soft tonal change.
  ctx.strokeStyle = '#5a5f67';
  ctx.lineWidth = Math.max(1, m(3));
  for (const b of plan.blocks) {
    if (b.district === 'water') continue;
    ctx.save();
    ctx.translate(px(b.cx), py(b.cz));
    ctx.rotate(plan.gridYaw);
    ctx.strokeRect(-m(b.halfU), -m(b.halfV), m(b.halfU * 2), m(b.halfV * 2));
    ctx.restore();
  }

  // The river, over everything — it cuts the grid rather than fitting into it.
  ctx.strokeStyle = '#1b2836';
  ctx.lineWidth = m(plan.riverWidth);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  plan.river.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
  ctx.stroke();
  // A quay line either side, so the water has an edge instead of a soft blur.
  ctx.strokeStyle = '#2f3a44';
  ctx.lineWidth = Math.max(1, m(4));
  ctx.stroke();

  // Park detail: clumps of trees, so it reads as planting rather than a green
  // rectangle. Drawn after the river so a riverside park still gets them.
  for (const park of parkCentres()) {
    const cx = px(park.x);
    const cz = py(park.z);
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * m(park.r);
      ctx.fillStyle = rnd() < 0.5 ? '#2f4a28' : '#476b39';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cz + Math.sin(a) * r, m(3 + rnd() * 5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- Street lighting, into the emissive map. ---
  //
  // Laid along block edges rather than scattered at random, so at night the road
  // network draws itself in points of light — which is most of what a city looks
  // like from above after dark.
  for (const b of plan.blocks) {
    if (b.district === 'water') continue;
    const warm = b.district === 'park';
    ectx.save();
    ectx.translate(px(b.cx), py(b.cz));
    ectx.rotate(plan.gridYaw);
    const spacing = m(park(b) ? 34 : 26);
    const hu = m(b.halfU) + m(6);
    const hv = m(b.halfV) + m(6);
    // A lamp is a bright point AND the pool it throws on the road. The pool is
    // what actually matters here: without it the carriageway is unlit at night
    // and the street network reads as scattered dots floating in black, because
    // sky light at 22:00 is effectively zero and the asphalt has nothing else
    // falling on it. With it, the roads draw themselves.
    const lamp = (u: number, v: number, tint: string) => {
      const pool = ectx.createRadialGradient(u, v, 0, u, v, m(16));
      pool.addColorStop(0, `rgba(${tint}, 0.30)`);
      pool.addColorStop(0.45, `rgba(${tint}, 0.10)`);
      pool.addColorStop(1, `rgba(${tint}, 0)`);
      ectx.fillStyle = pool;
      ectx.beginPath();
      ectx.arc(u, v, m(16), 0, Math.PI * 2);
      ectx.fill();
      ectx.fillStyle = `rgba(${tint}, 0.95)`;
      ectx.beginPath();
      ectx.arc(u, v, Math.max(1, m(1.4)), 0, Math.PI * 2);
      ectx.fill();
    };

    const sodium = warm ? '255,214,150' : '255,196,120';
    const mercury = warm ? '255,214,150' : '190,215,255';
    for (let u = -hu; u <= hu; u += spacing) {
      lamp(u, -hv, sodium);
      lamp(u, hv, sodium);
    }
    for (let v = -hv; v <= hv; v += spacing) {
      lamp(-hu, v, mercury);
      lamp(hu, v, mercury);
    }
    ectx.restore();
  }

  const toTexture = (canvas: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  };
  return { color: toTexture(colorCanvas), emissive: toTexture(emissiveCanvas) };
}

/** Park blocks get sparser, warmer lamps than a carriageway. */
const park = (b: CityPlan['blocks'][number]) => b.district === 'park';

/** Sky, ground, buildings, rooftops: everything past the glass. */
/**
 * The ground, as a plane carrying the plan's own drawing.
 *
 * A plane rather than the old disc, because a plane's UVs map 1:1 onto the
 * canvas with no distortion — and its corners, at 1668m, are already past the
 * haze's 1100m saturation, so the edge is never an edge.
 *
 * The per-instance attributes the city shader reads have to exist here too, or
 * an unbound attribute reads as zero and collapses the whole texture to one
 * texel. Four vertices, constant values.
 */
function CityGround({ material }: { material: THREE.ShaderMaterial }) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(GROUND_SPAN, GROUND_SPAN);
    const n = geo.attributes.position.count;
    const fill = (size: number, value: number[]) => {
      const arr = new Float32Array(n * size);
      for (let i = 0; i < n; i++) arr.set(value, i * size);
      return new THREE.BufferAttribute(arr, size);
    };
    geo.setAttribute('aUvScale', fill(3, [1, 1, 1]));
    geo.setAttribute('aUvOffset', fill(2, [0, 0]));
    geo.setAttribute('aTint', fill(3, [1, 1, 1]));
    geo.setAttribute('aEmissive', fill(3, [0, 0, 0]));
    return geo;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, GROUND_Y, ROOM_CENTER_Z]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={-1}
    />
  );
}

export function CityView({ time }: { time: TimeOfDay }) {
  const plan = useMemo(() => planCity(), []);
  const buildings = plan.buildings;

  const maps = useTexture(FACADE_URLS, configureFacadeMaps);

  const { materials, roofMaterial, groundMaterial } = useMemo(() => {
    const ground = drawGround(plan);
    return {
      materials: CITY_FACADES.map((_, i) => makeCityMaterial(maps[i * 2], maps[i * 2 + 1])),
      roofMaterial: makeCityMaterial(solidTexture(255), solidTexture(0)),
      groundMaterial: makeCityMaterial(ground.color, ground.emissive),
    };
  }, [maps, plan]);

  useEffect(() => {
    return () => {
      for (const m of materials) m.dispose();
      // Only the textures this component created get disposed. The facade maps
      // come from drei's loader cache and are shared with anything else that
      // asks for the same URL, so freeing them here would be reaching into
      // someone else's resource.
      for (const m of [roofMaterial, groundMaterial]) {
        (m.uniforms.uMap.value as THREE.Texture | null)?.dispose();
        (m.uniforms.uEmissive.value as THREE.Texture | null)?.dispose();
        m.dispose();
      }
    };
  }, [materials, roofMaterial, groundMaterial]);

  // One set of lighting values, written into every city material. The sun is
  // the same sun the sky draws and the same one that casts the room's shadows —
  // it comes from `celestial.ts` in all three places, so a shadow on the floor,
  // a lit facade outside and the disc in the window can never disagree.
  useEffect(() => {
    const { dayT, twilightT, nightT } = time;
    const sunDirection = directionFor(time.sun, time.bearingDeg, 1);
    const sunColor = blendColor('#ff8a4a', '#fff4dd', '#ffb070', dayT, twilightT).multiplyScalar(
      dayT * 1.15 + twilightT * 0.55
    );
    // Skylight, not fill: on a clear day the whole dome is a light source, and
    // it is the only thing lighting the faces the sun cannot reach. Too low and
    // those faces go black and then get hazed to flat grey, which is what made
    // the first pass read as cardboard.
    const skyColor = hazeAt(dayT, twilightT).multiplyScalar(0.17 + dayT * 0.5);
    const haze = hazeAt(dayT, twilightT);
    // Windows are on around the clock in a real tower, but against a sunlit
    // facade you cannot see them at all — and the emission maps are photographs
    // of fully lit windows, so even a small multiplier puts visible orange
    // squares on a midday building. The daylight floor is 0.03, barely a hint;
    // 0.12 was clearly wrong at 13:00. The same gain drives the ground's street
    // lamps, which have exactly the same problem.
    const windowGain = 0.03 + nightT * 2.5 + twilightT * 0.6;

    for (const m of [...materials, roofMaterial, groundMaterial]) {
      m.uniforms.uSunDirection.value.copy(sunDirection);
      m.uniforms.uSunColor.value.copy(sunColor);
      m.uniforms.uSkyColor.value.copy(skyColor);
      m.uniforms.uHazeColor.value.copy(haze);
      // Street lamps are not office windows. At the buildings' gain they clear
      // the bloom threshold hard and every lamp becomes a fuzzy blob, which
      // erases the grid they are supposed to be drawing. A third of it keeps
      // them as points with a pool, which is what a road looks like from above
      // at night.
      m.uniforms.uWindowGain.value = m === groundMaterial ? windowGain * 0.34 : windowGain;
    }
  }, [time, materials, roofMaterial, groundMaterial]);

  return (
    <group>
      <Sky time={time} />

      <CityGround material={groundMaterial} />

      <CityBuildings buildings={buildings} materials={materials} />
      <CityRooftops buildings={buildings} material={roofMaterial} />
    </group>
  );
}
