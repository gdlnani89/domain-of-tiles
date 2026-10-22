import './style.css';
import * as THREE from 'three';
import { soundManager } from './soundManager';

/**
 * ============================================================================
 * ISO RTS FOUNDATION - THREE.JS
 * ============================================================================
 * 1. Scene setup with soft directional light & neutral background.
 * 2. OrthographicCamera at classic isometric angle:
 *    - Rotation Y: 45° (Math.PI / 4)
 *    - Rotation X: ~35.264° (-Math.atan(1 / Math.SQRT2))
 * 3. Ground plane with visible 50x50 tile grid.
 * 4. RTS Camera controls (MMB pan, edge pan, scroll zoom, WASD).
 * 5. GridMap (50x50 occupancy matrix) & obstacles (trees, stone wall, TC).
 * 6. 8-directional A* pathfinding (binary heap, anti-corner cutting,
 *    nearest-walkable fallback).
 * 7. Town Center (3x3) as default resource DropoffPoint.
 * 8. Wood gathering cycle (FSM):
 *    IDLE -> MOVING_TO_RESOURCE -> GATHERING -> RETURNING_TO_BASE
 *         -> DEPOSITING -> (back to same tree / nearest tree).
 * 9. Tree depletion (100 wood each) & automatic migration.
 * 10. Building Construction System (Quartel / Barracks - 2x2):
 *    - HUD Build Menu (Button & Shortcut B, Cost: 50 Wood)
 *    - Ghost Building (2x2 snap, green valid / red blocked validation)
 *    - Cancel via Esc or RMB
 *    - Construction Site (dirt base, corner stakes, 3D progress bar)
 *    - Villager Building Work (A* to perimeter, hammering animation,
 *      10% progress/sec per villager, transforms to complete Barracks at 100%,
 *      villagers return to IDLE).
 * ============================================================================
 */

// --- 1. SCENE & RENDERER SETUP ---
const container = document.getElementById('canvas-container') || document.body;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1e24);
scene.fog = new THREE.FogExp2(0x1a1e24, 0.007);

export const isMobileDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

const renderer = new THREE.WebGLRenderer({ antialias: !isMobileDevice, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// --- 2. SOFT RTS LIGHTING ---
const hemiLight = new THREE.HemisphereLight(0xe5edfa, 0x242832, 0.75);
hemiLight.position.set(0, 60, 0);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfffaec, 1.45);
sunLight.position.set(35, 55, 25);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = isMobileDevice ? 1024 : 2048;
sunLight.shadow.mapSize.height = isMobileDevice ? 1024 : 2048;
sunLight.shadow.camera.near = 10;
sunLight.shadow.camera.far = 160;
sunLight.shadow.camera.left = -35;
sunLight.shadow.camera.right = 35;
sunLight.shadow.camera.top = 35;
sunLight.shadow.camera.bottom = -35;
sunLight.shadow.bias = -0.0004;
scene.add(sunLight);

const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.35);
rimLight.position.set(-30, 25, -30);
scene.add(rimLight);

// --- 3. CLASSIC ISOMETRIC ORTHOGRAPHIC CAMERA ---
const ISO_ROT_Y = Math.PI / 4;
const ISO_ROT_X = -Math.atan(1 / Math.SQRT2); // -0.6154797 rad (~ -35.264°)
const CAMERA_DISTANCE = 120;

const SQRT_3 = Math.sqrt(3);
const isoOffset = new THREE.Vector3(
  CAMERA_DISTANCE / SQRT_3,
  CAMERA_DISTANCE / SQRT_3,
  CAMERA_DISTANCE / SQRT_3
);

export type UnitFaction = 'PLAYER' | 'ENEMY';

// Estoque de recursos e população isolados da IA Inimiga
export const enemyResources = {
  wood: 150,
  food: 0,
  gold: 0,
  stone: 0
};
export let enemyPopCap = 5;
export let enemyTcIsTraining = false;
export let enemyTcTrainTimer = 0;

// --- ESTRUTURA DE DADOS DE BALANCEAMENTO (MATCH CONFIG / SANDBOX) ---
export interface MatchConfig {
  townCenterHp: number;    // padrão 400 (min: 100, max: 2000)
  enemyCampHp: number;     // padrão 200 (min: 50, max: 1000)
  woodGatherTime: number;  // padrão 3.0s (min: 0.5s, max: 10.0s)
  stoneMiningTime: number; // padrão 3.5s (min: 0.5s, max: 10.0s)
  goldMiningTime: number;  // padrão 3.5s (min: 0.5s, max: 10.0s)
  treeCapacity: number;    // padrão 100 (min: 20, max: 500)
  stoneCapacity: number;   // padrão 250 (min: 50, max: 1000)
  goldCapacity: number;    // padrão 300 (min: 50, max: 1000)
  swordsmanHp: number;     // padrão 100 (min: 20, max: 200)
  swordsmanDamage: number; // padrão 8 (min: 2, max: 40)
  trainingTime: number;    // padrão 5.0s (min: 1.0s, max: 15.0s)
  initialWood: number;     // padrão 150 (min: 0, max: 500)
  mapSize: number;         // padrão 50 (30, 50, 80)
  revealWholeMap: boolean; // padrão false (100% visão sem névoa)
  peacefulMode: boolean;   // padrão false (sem facção ou tropas inimigas)
  aiDifficulty?: 'EASY' | 'MEDIUM' | 'HARD'; // Dificuldade da IA inimiga
  schoolStudyDurationSec: number; // padrão 120 (tempo de estudo para se formar na escola)
  collegeStudyDurationSec: number; // padrão 240 (tempo de estudo de elite na faculdade)
  invasionIntervalMinutes: number; // padrão 3.0 (min: 1.0, max: 10.0)
}

export type AIDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export let currentAIDifficulty: AIDifficulty = 'MEDIUM';

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  townCenterHp: 400,
  enemyCampHp: 200,
  woodGatherTime: 3.0,
  stoneMiningTime: 3.5,
  goldMiningTime: 3.5,
  treeCapacity: 100,
  stoneCapacity: 250,
  goldCapacity: 300,
  swordsmanHp: 100,
  swordsmanDamage: 8,
  trainingTime: 5.0,
  initialWood: 150,
  mapSize: 50,
  revealWholeMap: false,
  peacefulMode: false,
  aiDifficulty: 'MEDIUM',
  schoolStudyDurationSec: 120,
  collegeStudyDurationSec: 240,
  invasionIntervalMinutes: 3.0
};

export const currentMatchConfig: MatchConfig = { ...DEFAULT_MATCH_CONFIG };
export type GameState = 'MENU' | 'IN_GAME' | 'PAUSED';
export let currentGameState: GameState = 'MENU';
export let isMatchConfigModalOpen = false; // Inicia na Tela Inicial / Menu Principal Oficial
export let isSaveLoadModalOpen = false;
export let isPauseMenuModalOpen = false;
export let hasMatchEverStarted = false;
export let hasEnemyFaction = true;

let aspect = window.innerWidth / window.innerHeight;
let frustumSize = 28;
let targetFrustumSize = 28;
const MIN_FRUSTUM = 8;
let MAX_FRUSTUM = 65; // recalculado proporcionalmente ao mapSize em applyMapSize()

const camera = new THREE.OrthographicCamera(
  (-frustumSize * aspect) / 2,
  (frustumSize * aspect) / 2,
  frustumSize / 2,
  -frustumSize / 2,
  0.1,
  1000
);
camera.rotation.order = 'YXZ';

const cameraTarget = new THREE.Vector3(0.5, 0, 0.5);
const targetDesired = new THREE.Vector3(0.5, 0, 0.5);

function updateCameraFrustum() {
  aspect = window.innerWidth / window.innerHeight;
  camera.left = (-frustumSize * aspect) / 2;
  camera.right = (frustumSize * aspect) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.updateProjectionMatrix();
}

let cameraShakeRemaining = 0;
export function triggerCameraShake(duration = 0.4) {
  cameraShakeRemaining = duration;
}

function updateCameraTransform() {
  camera.position.copy(cameraTarget).add(isoOffset);
  if (cameraShakeRemaining > 0) {
    const s = cameraShakeRemaining * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }
  camera.lookAt(cameraTarget);
  camera.rotation.y = ISO_ROT_Y;
  camera.rotation.x = ISO_ROT_X;
  camera.rotation.z = 0;
}

updateCameraFrustum();
updateCameraTransform();

// --- 4. GROUND PLANE & VISIBLE GRID (TAMANHO DINÂMICO: mapSize) ---
/**
 * Tamanhos de mapa disponíveis:
 *  - Pequeno: 30x30 (escaramuças rápidas)
 *  - Médio (Padrão): 50x50
 *  - Grande: 80x80 (estilo mapa aberto de AoE)
 */
export const MAP_SIZE_OPTIONS = [
  { id: 'SMALL', label: 'Pequeno', size: 30 },
  { id: 'MEDIUM', label: 'Médio', size: 50 },
  { id: 'LARGE', label: 'Grande', size: 80 },
  { id: 'GIANT', label: 'Gigante', size: 100 }
] as const;
const DEFAULT_MAP_SIZE = 50;
const MAP_SIZE_STORAGE_KEY = 'aoe-rts:mapSize';

function isValidMapSize(size: number): boolean {
  return MAP_SIZE_OPTIONS.some((o) => o.size === size);
}

function loadSavedMapSize(): number {
  try {
    const saved = Number(localStorage.getItem(MAP_SIZE_STORAGE_KEY));
    if (isValidMapSize(saved)) return saved;
  } catch (_) {}
  return DEFAULT_MAP_SIZE;
}

export let mapSize = loadSavedMapSize();

// Limites derivados do mapSize (recalculados em recomputeMapBounds)
let GRID_SIZE = mapSize;                       // nº de células por eixo
let MAP_MIN = -Math.floor(mapSize / 2);        // ex.: -25 (50x50)
let MAP_MAX = Math.ceil(mapSize / 2) - 1;      // ex.:  24 (50x50)
let HALF_GRID = -MAP_MIN;                      // offset célula-mundo -> índice da matriz
let MAP_CENTER = (MAP_MIN + MAP_MAX + 1) / 2;  // centro geométrico do tabuleiro (0 para tamanhos pares)

/** PRNG determinístico (mulberry32) — cada tamanho de mapa gera sempre o mesmo layout quando fixada a seed. */
function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export let currentMapSeed: number = Math.floor(Math.random() * 900000) + 10000;

// Coordenadas dinâmicas do Town Center Aliado (3x3) e Acampamento Inimigo (2x2)
export const tcCoord = {
  minX: -1,
  maxX: 1,
  minZ: -1,
  maxZ: 1,
  size: 3
};

export const TC_WORLD_CENTER = new THREE.Vector3(
  (tcCoord.minX + tcCoord.maxX + 1) / 2,
  0,
  (tcCoord.minZ + tcCoord.maxZ + 1) / 2
);

export const enemyCampCoord = { x: 0, z: 0, size: 3 };
export let enemyCampState: any = null;

/**
 * Sorteia aleatoriamente a posição do Town Center aliado em um quadrante do mapa
 * (Sudoeste, Noroeste, Sudeste ou Nordeste) com margem de segurança de ~6-8 células da borda.
 * Posiciona o Acampamento Inimigo no canto diametralmente oposto, garantindo distância euclidiana mínima >= 60% do mapa.
 */
export function randomizeBasePositions(seed: number = currentMapSeed): void {
  const rng = createSeededRandom(seed * 41 + 17);
  const margin = Math.max(6, Math.min(10, Math.floor(mapSize * 0.12)));

  // Sorteia quadrante aliado:
  // 0: Sudoeste (-X, +Z)
  // 1: Noroeste (-X, -Z)
  // 2: Nordeste (+X, -Z)
  // 3: Sudeste (+X, +Z)
  const playerQuad = Math.floor(rng() * 4);
  const enemyQuad = (playerQuad + 2) % 4; // Canto diametralmente oposto

  const getQuadrantCoords = (quad: number, size: number): { x: number; z: number } => {
    const jitterX = Math.floor(rng() * 3);
    const jitterZ = Math.floor(rng() * 3);
    let qx = 0;
    let qz = 0;

    if (quad === 0) {
      // Sudoeste: -X, +Z
      qx = MAP_MIN + margin + jitterX;
      qz = MAP_MAX - margin - size + 1 - jitterZ;
    } else if (quad === 1) {
      // Noroeste: -X, -Z
      qx = MAP_MIN + margin + jitterX;
      qz = MAP_MIN + margin + jitterZ;
    } else if (quad === 2) {
      // Nordeste: +X, -Z
      qx = MAP_MAX - margin - size + 1 - jitterX;
      qz = MAP_MIN + margin + jitterZ;
    } else {
      // Sudeste: +X, +Z
      qx = MAP_MAX - margin - size + 1 - jitterX;
      qz = MAP_MAX - margin - size + 1 - jitterZ;
    }

    return {
      x: THREE.MathUtils.clamp(qx, MAP_MIN + margin, MAP_MAX - margin - size + 1),
      z: THREE.MathUtils.clamp(qz, MAP_MIN + margin, MAP_MAX - margin - size + 1)
    };
  };

  const pCoords = getQuadrantCoords(playerQuad, 3);
  tcCoord.minX = pCoords.x;
  tcCoord.maxX = pCoords.x + 2;
  tcCoord.minZ = pCoords.z;
  tcCoord.maxZ = pCoords.z + 2;

  TC_WORLD_CENTER.set(
    tcCoord.minX + 1.5,
    0,
    tcCoord.minZ + 1.5
  );

  const eCoords = getQuadrantCoords(enemyQuad, 3);
  enemyCampCoord.size = 3;
  enemyCampCoord.x = eCoords.x;
  enemyCampCoord.z = eCoords.z;

  const dist = Math.hypot((tcCoord.minX + 1.5) - (enemyCampCoord.x + 1.5), (tcCoord.minZ + 1.5) - (enemyCampCoord.z + 1.5));
  console.log(`[RTS Bases] Base Aliada em [${tcCoord.minX}, ${tcCoord.minZ}] (Quad ${playerQuad}) • Base Inimiga em [${enemyCampCoord.x}, ${enemyCampCoord.z}] (Quad ${enemyQuad}) • Distância: ${dist.toFixed(1)} células (${((dist / mapSize) * 100).toFixed(0)}% do mapa)`);
}

function recomputeMapBounds(size: number): void {
  mapSize = size;
  GRID_SIZE = size;
  MAP_MIN = -Math.floor(size / 2);
  MAP_MAX = Math.ceil(size / 2) - 1;
  HALF_GRID = -MAP_MIN;
  MAP_CENTER = (MAP_MIN + MAP_MAX + 1) / 2;

  randomizeBasePositions(currentMapSeed);

  // Zoom máximo proporcional ao tamanho do tabuleiro (30 → 40, 50 → 65, 80 → 100, 100 → 130)
  MAX_FRUSTUM = THREE.MathUtils.clamp(Math.round(size * 1.3), 40, 130);
}
recomputeMapBounds(mapSize);

function createTileTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#262d37';
  ctx.fillRect(0, 0, 512, 512);

  const grad = ctx.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.025)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.04)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = 'rgba(74, 90, 110, 0.25)';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, 500, 500);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GRID_SIZE, GRID_SIZE);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --- 4.5 GERADOR PROCEDURAL DE RELEVO COM SEMENTE (SEED), MONTES E PLATÔS ---
function hash2D(ix: number, iz: number, seed: number): number {
  let n = (ix * 374761393 + iz * 668265263 + seed * 314159265) ^ 0x5bf03635;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function smoothNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const sx = x - x0;
  const sz = z - z0;
  // Quintic polynomial (Perlin fade)
  const wx = sx * sx * sx * (sx * (sx * 6 - 15) + 10);
  const wz = sz * sz * sz * (sz * (sz * 6 - 15) + 10);

  const n00 = hash2D(x0, z0, seed);
  const n10 = hash2D(x1, z0, seed);
  const n01 = hash2D(x0, z1, seed);
  const n11 = hash2D(x1, z1, seed);

  const nx0 = n00 * (1 - wx) + n10 * wx;
  const nx1 = n01 * (1 - wx) + n11 * wx;
  return nx0 * (1 - wz) + nx1 * wz;
}

function fbmNoise2D(x: number, z: number, seed: number, octaves = 3, lacunarity = 2.0, gain = 0.5): number {
  let total = 0;
  let freq = 1.0;
  let amp = 1.0;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    total += smoothNoise2D(x * freq, z * freq, seed + i * 1013) * amp;
    max += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return total / max;
}

export let heightVertexGrid = new Float32Array((GRID_SIZE + 1) * (GRID_SIZE + 1));
export const cliffCellsSet = new Set<number>();

export function getTerrainHeight(worldX: number, worldZ: number): number {
  if (!heightVertexGrid || heightVertexGrid.length === 0) return 0;
  const ix = worldX - MAP_MIN;
  const iz = worldZ - MAP_MIN;
  if (ix <= 0 || ix >= GRID_SIZE || iz <= 0 || iz >= GRID_SIZE) {
    const cix = THREE.MathUtils.clamp(Math.round(ix), 0, GRID_SIZE);
    const ciz = THREE.MathUtils.clamp(Math.round(iz), 0, GRID_SIZE);
    return heightVertexGrid[ciz * (GRID_SIZE + 1) + cix] ?? 0;
  }
  const x0 = Math.floor(ix);
  const z0 = Math.floor(iz);
  const x1 = Math.min(x0 + 1, GRID_SIZE);
  const z1 = Math.min(z0 + 1, GRID_SIZE);
  const fx = ix - x0;
  const fz = iz - z0;
  const row0 = z0 * (GRID_SIZE + 1);
  const row1 = z1 * (GRID_SIZE + 1);
  const h00 = heightVertexGrid[row0 + x0];
  const h10 = heightVertexGrid[row0 + x1];
  const h01 = heightVertexGrid[row1 + x0];
  const h11 = heightVertexGrid[row1 + x1];
  const hTop = h00 * (1 - fx) + h10 * fx;
  const hBot = h01 * (1 - fx) + h11 * fx;
  return hTop * (1 - fz) + hBot * fz;
}

export function getCellHeight(gridX: number, gridZ: number): number {
  return getTerrainHeight(gridX + 0.5, gridZ + 0.5);
}

/**
 * Calcula a altura de posicionamento nivelada para uma estrutura no grid.
 * Amostra todos os vértices da malha e os centros das células sob o footprint do edifício
 * e retorna a MAIOR altura encontrada, garantindo que o piso do edifício fique
 * perfeitamente nivelado sobre o topo do relevo sem afundar na colina.
 */
export function getBuildingPlacementHeight(gridX: number, gridZ: number, size: number): number {
  let maxHeight = -Infinity;
  // Amostra todos os vértices dos cantos da malha sob o edifício (ex: para 2x2, são 3x3 = 9 vértices)
  for (let dx = 0; dx <= size; dx++) {
    for (let dz = 0; dz <= size; dz++) {
      const h = getTerrainHeight(gridX + dx, gridZ + dz);
      if (h > maxHeight) maxHeight = h;
    }
  }
  // Amostra também os centros das células sob o edifício
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const h = getTerrainHeight(gridX + dx + 0.5, gridZ + dz + 0.5);
      if (h > maxHeight) maxHeight = h;
    }
  }
  return Number.isFinite(maxHeight) ? maxHeight : 0;
}

function computeVertexHeight(wx: number, wz: number, seed: number): number {
  // Distância à base aliada e ao acampamento inimigo
  const tcCX = tcCoord.minX + 1.5;
  const tcCZ = tcCoord.minZ + 1.5;
  const dAllied = Math.hypot(wx - tcCX, wz - tcCZ);
  const ecCX = enemyCampCoord.x + 1.5;
  const ecCZ = enemyCampCoord.z + 1.5;
  const dEnemy = Math.hypot(wx - ecCX, wz - ecCZ);

  // Zonas de exclusão: raio <= 6 é 100% plano (Y = 0) para permitir expansão imediata
  const mAllied = THREE.MathUtils.clamp((dAllied - 6.0) / 3.0, 0, 1);
  const mEnemy = THREE.MathUtils.clamp((dEnemy - 6.0) / 3.0, 0, 1);
  const mask = Math.min(mAllied, mEnemy);
  if (mask <= 0) return 0;
  const smoothMask = mask * mask * (3 - 2 * mask);

  // Ruído contínuo 2D para elevação
  const n1 = smoothNoise2D(wx * 0.055 + 100.5, wz * 0.055 + 100.5, seed);
  const n2 = smoothNoise2D(wx * 0.11 + 312.3, wz * 0.11 + 312.3, seed + 777);
  const n3 = smoothNoise2D(wx * 0.22 + 543.1, wz * 0.22 + 543.1, seed + 1444);
  const raw = n1 * 0.65 + n2 * 0.25 + n3 * 0.10;

  let h = 0;
  if (raw < 0.40) {
    // Planícies: Y = 0
    h = 0;
  } else if (raw < 0.62) {
    // Colinas suaves: Y variando de 0 a 0.75
    const t = (raw - 0.40) / 0.22;
    h = t * t * (3 - 2 * t) * 0.75;
  } else if (raw < 0.72) {
    // Penhasco / desnível íngreme de platô: salto abrupto > 1.0
    const t = (raw - 0.62) / 0.10;
    h = 0.75 + Math.pow(t, 0.7) * 1.05;
  } else {
    // Platô alto: Y variando de 1.65 a 1.80
    const t = (raw - 0.72) / 0.28;
    h = 1.70 + Math.sin(t * Math.PI) * 0.10;
  }

  return h * smoothMask;
}

function generateTerrainHeights(size: number, seed: number): void {
  if (heightVertexGrid.length !== (size + 1) * (size + 1)) {
    heightVertexGrid = new Float32Array((size + 1) * (size + 1));
  }
  for (let iz = 0; iz <= size; iz++) {
    for (let ix = 0; ix <= size; ix++) {
      const wx = MAP_MIN + ix;
      const wz = MAP_MIN + iz;
      heightVertexGrid[iz * (size + 1) + ix] = computeVertexHeight(wx, wz, seed);
    }
  }
}

// --- 5. GRID DE OCUPAÇÃO (GRIDMAP mapSize x mapSize) ---
function createOccupancyGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array(size).fill(true));
}
let gridOccupancy: boolean[][] = createOccupancyGrid(GRID_SIZE);

function isCellInside(gridX: number, gridZ: number): boolean {
  return gridX >= MAP_MIN && gridX <= MAP_MAX && gridZ >= MAP_MIN && gridZ <= MAP_MAX;
}

export function isCellWalkable(gridX: number, gridZ: number): boolean {
  if (!isCellInside(gridX, gridZ)) return false;
  return gridOccupancy[gridX + HALF_GRID][gridZ + HALF_GRID];
}

export function setCellWalkable(gridX: number, gridZ: number, walkable: boolean): void {
  if (!isCellInside(gridX, gridZ)) return;
  gridOccupancy[gridX + HALF_GRID][gridZ + HALF_GRID] = walkable;
}

export const blockedGridTiles = new Set<string>();

export function setWallCellOccupancy(gridX: number, gridZ: number, isBlocked: boolean): void {
  const x = Math.round(gridX);
  const z = Math.round(gridZ);
  setCellWalkable(x, z, !isBlocked);
  const key = `${x},${z}`;
  if (isBlocked) {
    blockedGridTiles.add(key);
  } else {
    blockedGridTiles.delete(key);
  }
}

function cellKey(gridX: number, gridZ: number): number {
  return (gridX + HALF_GRID) * GRID_SIZE + (gridZ + HALF_GRID);
}

function evaluateCliffsAndPlateaus(): void {
  cliffCellsSet.clear();
  for (let gx = MAP_MIN; gx <= MAP_MAX; gx++) {
    for (let gz = MAP_MIN; gz <= MAP_MAX; gz++) {
      const myH = getCellHeight(gx, gz);
      let isCliff = false;
      const neighbors = [
        [gx + 1, gz],
        [gx - 1, gz],
        [gx, gz + 1],
        [gx, gz - 1]
      ];
      for (const [nx, nz] of neighbors) {
        if (isCellInside(nx, nz)) {
          const nH = getCellHeight(nx, nz);
          if (Math.abs(myH - nH) > 1.0) {
            isCliff = true;
            break;
          }
        }
      }
      if (isCliff) {
        setCellWalkable(gx, gz, false);
        cliffCellsSet.add(cellKey(gx, gz));
      }
    }
  }
}

// Inicializa alturas e penhascos para o mapa inicial
generateTerrainHeights(GRID_SIZE, currentMapSeed);
evaluateCliffsAndPlateaus();

function buildTerrainGeometry(size: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Vértices do topo com relevo e cores de elevação
  for (let iz = 0; iz <= size; iz++) {
    for (let ix = 0; ix <= size; ix++) {
      const wx = MAP_MIN + ix;
      const wz = MAP_MIN + iz;
      const wy = heightVertexGrid[iz * (size + 1) + ix];

      positions.push(wx, wy, wz);
      uvs.push(ix / size, 1 - iz / size);

      let r = 0.85, g = 0.88, b = 0.92;
      if (wy <= 0.05) {
        r = 0.82; g = 0.85; b = 0.88;
      } else if (wy < 1.1) {
        const t = wy / 1.1;
        r = 0.82 * (1 - t) + 0.72 * t;
        g = 0.85 * (1 - t) + 0.92 * t;
        b = 0.88 * (1 - t) + 0.78 * t;
      } else {
        const t = Math.min(1, (wy - 1.1) / 0.7);
        r = 0.72 * (1 - t) + 0.84 * t;
        g = 0.92 * (1 - t) + 0.82 * t;
        b = 0.78 * (1 - t) + 0.80 * t;
      }
      colors.push(r, g, b);
    }
  }

  // Triângulos do topo
  let topIndexCount = 0;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i0 = iz * (size + 1) + ix;
      const i1 = i0 + 1;
      const i2 = (iz + 1) * (size + 1) + ix;
      const i3 = i2 + 1;
      indices.push(i0, i2, i1);
      indices.push(i1, i2, i3);
      topIndexCount += 6;
    }
  }
  geo.addGroup(0, topIndexCount, 0);

  // Bordas laterais (saias) descendo até -1.2 para formar um bloco isométrico sólido
  const skirtStartIndex = indices.length;
  const bottomY = -1.2;

  const addSkirtQuad = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number
  ) => {
    const baseIdx = positions.length / 3;
    positions.push(x0, y0, z0);
    uvs.push(0, 0);
    colors.push(0.55, 0.55, 0.55);

    positions.push(x0, bottomY, z0);
    uvs.push(0, 1);
    colors.push(0.35, 0.35, 0.35);

    positions.push(x1, y1, z1);
    uvs.push(1, 0);
    colors.push(0.55, 0.55, 0.55);

    positions.push(x1, bottomY, z1);
    uvs.push(1, 1);
    colors.push(0.35, 0.35, 0.35);

    indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    indices.push(baseIdx + 2, baseIdx + 1, baseIdx + 3);
  };

  // Sul
  for (let ix = 0; ix < size; ix++) {
    const wy0 = heightVertexGrid[size * (size + 1) + ix];
    const wy1 = heightVertexGrid[size * (size + 1) + ix + 1];
    addSkirtQuad(MAP_MIN + ix, wy0, MAP_MIN + size, MAP_MIN + ix + 1, wy1, MAP_MIN + size);
  }
  // Norte
  for (let ix = size; ix > 0; ix--) {
    const wy0 = heightVertexGrid[ix];
    const wy1 = heightVertexGrid[ix - 1];
    addSkirtQuad(MAP_MIN + ix, wy0, MAP_MIN, MAP_MIN + ix - 1, wy1, MAP_MIN);
  }
  // Leste
  for (let iz = 0; iz < size; iz++) {
    const wy0 = heightVertexGrid[iz * (size + 1) + size];
    const wy1 = heightVertexGrid[(iz + 1) * (size + 1) + size];
    addSkirtQuad(MAP_MIN + size, wy0, MAP_MIN + iz, MAP_MIN + size, wy1, MAP_MIN + iz + 1);
  }
  // Oeste
  for (let iz = size; iz > 0; iz--) {
    const wy0 = heightVertexGrid[iz * (size + 1)];
    const wy1 = heightVertexGrid[(iz - 1) * (size + 1)];
    addSkirtQuad(MAP_MIN, wy0, MAP_MIN + iz, MAP_MIN, wy1, MAP_MIN + iz - 1);
  }

  geo.addGroup(skirtStartIndex, indices.length - skirtStartIndex, 1);

  // Fundo inferior
  const bottomStartIndex = indices.length;
  const b0 = positions.length / 3;
  positions.push(MAP_MIN, bottomY, MAP_MIN);
  positions.push(MAP_MIN + size, bottomY, MAP_MIN);
  positions.push(MAP_MIN + size, bottomY, MAP_MIN + size);
  positions.push(MAP_MIN, bottomY, MAP_MIN + size);
  uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  colors.push(0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3);

  indices.push(b0, b0 + 2, b0 + 1);
  indices.push(b0, b0 + 3, b0 + 2);
  geo.addGroup(bottomStartIndex, indices.length - bottomStartIndex, 2);

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  return geo;
}

const tileTexture = createTileTexture();

const groundTopMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.78,
  metalness: 0.05,
  map: tileTexture
});
const groundSideMaterial = new THREE.MeshStandardMaterial({
  color: 0x181e25,
  roughness: 0.85
});
const groundBottomMaterial = new THREE.MeshStandardMaterial({
  color: 0x101318
});
const groundMaterials = [groundTopMaterial, groundSideMaterial, groundBottomMaterial];

const groundMesh = new THREE.Mesh(buildTerrainGeometry(GRID_SIZE), groundMaterials);
groundMesh.position.set(0, 0, 0);
groundMesh.receiveShadow = true;
scene.add(groundMesh);

let gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x38bdf8, 0x3a4858);
gridHelper.position.set(MAP_CENTER, 0.002, MAP_CENTER);
gridHelper.visible = false; // Grid demarcado de forma nítida e contínua via tileTexture
scene.add(gridHelper);


// --- FOG OF WAR (FoW) DEFINITIONS ---
export const FogState = {
  UNEXPLORED: 0, // totalmente escuro/preto
  EXPLORED: 1,   // névoa cinza / descoberta anteriormente
  VISIBLE: 2     // visível agora por unidades ou construções aliadas
} as const;
export type FogState = typeof FogState[keyof typeof FogState];

export let fogGrid = new Uint8Array(GRID_SIZE * GRID_SIZE);

export function getFogStateAt(gx: number, gz: number): FogState {
  if (!isCellInside(gx, gz)) return FogState.UNEXPLORED;
  const ix = gx + HALF_GRID;
  const iz = gz + HALF_GRID;
  return (fogGrid[iz * GRID_SIZE + ix] ?? FogState.UNEXPLORED) as FogState;
}

export function isBuildingDiscovered(b: { gridX: number; gridZ: number; size: number; sizeX?: number; sizeZ?: number }): boolean {
  if (currentMatchConfig.revealWholeMap) return true;
  const sx = b.sizeX || b.size || 1;
  const sz = b.sizeZ || b.size || 1;
  for (let dx = 0; dx < sx; dx++) {
    for (let dz = 0; dz < sz; dz++) {
      const state = getFogStateAt(b.gridX + dx, b.gridZ + dz);
      if (state === FogState.EXPLORED || state === FogState.VISIBLE) {
        return true;
      }
    }
  }
  return false;
}

export function isBuildingDirectlyVisible(b: { gridX: number; gridZ: number; size: number; sizeX?: number; sizeZ?: number }): boolean {
  if (currentMatchConfig.revealWholeMap) return true;
  const sx = b.sizeX || b.size || 1;
  const sz = b.sizeZ || b.size || 1;
  for (let dx = 0; dx < sx; dx++) {
    for (let dz = 0; dz < sz; dz++) {
      const state = getFogStateAt(b.gridX + dx, b.gridZ + dz);
      if (state === FogState.VISIBLE) {
        return true;
      }
    }
  }
  return false;
}

// Textura Dinâmica de Névoa de Guerra (mapSize x mapSize com interpolação linear suave)
const fogCanvas = document.createElement('canvas');
const fogCtx = fogCanvas.getContext('2d', { willReadFrequently: true })!;
let fogImageData: ImageData;
let fogTexture: THREE.CanvasTexture;

/** (Re)cria o canvas/ImageData/CanvasTexture da névoa com as dimensões atuais do grid. */
function createFogTexture(): THREE.CanvasTexture {
  fogCanvas.width = GRID_SIZE;
  fogCanvas.height = GRID_SIZE;
  fogImageData = fogCtx.createImageData(GRID_SIZE, GRID_SIZE);

  // Inicializa a textura como totalmente preta (UNEXPLORED)
  for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
    const p = i * 4;
    fogImageData.data[p + 0] = 6;
    fogImageData.data[p + 1] = 8;
    fogImageData.data[p + 2] = 12;
    fogImageData.data[p + 3] = 255;
  }
  fogCtx.putImageData(fogImageData, 0, 0);

  const tex = new THREE.CanvasTexture(fogCanvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
fogTexture = createFogTexture();

// Overlay Mesh translúcido sobre o chão para renderizar a névoa suavemente acompanhando o relevo
function createFogPlaneGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz <= GRID_SIZE; iz++) {
    for (let ix = 0; ix <= GRID_SIZE; ix++) {
      const wx = MAP_MIN + ix;
      const wz = MAP_MIN + iz;
      const wy = heightVertexGrid[iz * (GRID_SIZE + 1) + ix] + 0.038;
      positions.push(wx, wy, wz);
      uvs.push(ix / GRID_SIZE, 1 - iz / GRID_SIZE);
    }
  }

  for (let iz = 0; iz < GRID_SIZE; iz++) {
    for (let ix = 0; ix < GRID_SIZE; ix++) {
      const i0 = iz * (GRID_SIZE + 1) + ix;
      const i1 = i0 + 1;
      const i2 = (iz + 1) * (GRID_SIZE + 1) + ix;
      const i3 = i2 + 1;
      indices.push(i0, i2, i1);
      indices.push(i1, i2, i3);
    }
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const fogMat = new THREE.MeshBasicMaterial({
  map: fogTexture,
  transparent: true,
  depthWrite: false
});

const fogMesh = new THREE.Mesh(createFogPlaneGeometry(), fogMat);
fogMesh.position.set(0, 0, 0); // Levemente acima das elevações do terreno (+0.038)
fogMesh.renderOrder = 8;
scene.add(fogMesh);

/** Ajusta o frustum de sombras do sol para cobrir todo o tabuleiro (inclusive 100x100). */
function updateShadowBounds(): void {
  const extent = GRID_SIZE >= 100 ? 80 : (GRID_SIZE >= 80 ? 65 : (GRID_SIZE >= 50 ? 45 : 35));
  const cam = sunLight.shadow.camera;
  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.far = Math.max(200, extent * 4);
  cam.updateProjectionMatrix();
}
updateShadowBounds();

function syncSeedUI(): void {
  const seedDisplayEl = document.getElementById('current-seed-display');
  if (seedDisplayEl) {
    seedDisplayEl.textContent = `#${currentMapSeed}`;
  }
}
syncSeedUI();

/**
 * Aplica um novo tamanho de mapa e/ou semente: recalcula limites e recria a matriz de ocupação,
 * a malha de relevo com montes e platôs, a matriz de névoa e a geometria da névoa.
 */
function applyMapSize(size: number, seed: number = currentMapSeed): void {
  recomputeMapBounds(size);

  // Matrizes lógicas
  gridOccupancy = createOccupancyGrid(GRID_SIZE);
  fogGrid = new Uint8Array(GRID_SIZE * GRID_SIZE);

  // Gera relevo e avalia penhascos
  generateTerrainHeights(GRID_SIZE, seed);
  evaluateCliffsAndPlateaus();

  // Chão com relevo procedural
  groundMesh.geometry.dispose();
  groundMesh.geometry = buildTerrainGeometry(GRID_SIZE);
  groundMesh.position.set(0, 0, 0);
  tileTexture.repeat.set(GRID_SIZE, GRID_SIZE);
  tileTexture.needsUpdate = true;

  // Grade visual
  gridHelper.visible = false;

  // Névoa de Guerra: textura + malha com elevação
  fogTexture.dispose();
  fogTexture = createFogTexture();
  fogMat.map = fogTexture;
  fogMat.needsUpdate = true;
  fogMesh.geometry.dispose();
  fogMesh.geometry = createFogPlaneGeometry();
  fogMesh.position.set(0, 0, 0);

  updateShadowBounds();
  syncSeedUI();

  if (typeof townCenter !== 'undefined' && townCenter) {
    TC_WORLD_CENTER.set(
      tcCoord.minX + 1.5,
      getBuildingPlacementHeight(tcCoord.minX, tcCoord.minZ, 3),
      tcCoord.minZ + 1.5
    );
    townCenter.position.copy(TC_WORLD_CENTER);
    updateTownCenterOutline();
  }

  try {
    localStorage.setItem(MAP_SIZE_STORAGE_KEY, String(size));
  } catch (_) {}
}

export interface WallBlock {
  gridX: number;
  gridZ: number;
  group: THREE.Group;
  isReinforced?: boolean;
}
export const wallsList: WallBlock[] = [];
export let isStoneWallReinforced = false;

export function addReinforcementDecorToWall(wall: WallBlock): void {
  if (wall.isReinforced) return;
  wall.isReinforced = true;

  const shieldMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.8, roughness: 0.25 });
  const crestMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.3 });

  // Escudo frontal com brasão dourado
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, 0.08), shieldMat);
  shield.position.set(0, 0.75, 0.49);
  shield.castShadow = true;
  wall.group.add(shield);

  const crest = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), crestMat);
  crest.rotation.x = Math.PI / 2;
  crest.position.set(0, 0.75, 0.54);
  wall.group.add(crest);

  // Escudo traseiro
  const shieldBack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, 0.08), shieldMat);
  shieldBack.position.set(0, 0.75, -0.49);
  shieldBack.castShadow = true;
  wall.group.add(shieldBack);

  // Plinto superior com ameias reforçadas
  const topCrest = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.1, 0.88), shieldMat);
  topCrest.position.set(0, 1.15, 0);
  topCrest.castShadow = true;
  wall.group.add(topCrest);
}

export function reinforceStoneWalls(): void {
  isStoneWallReinforced = true;
  wallsList.forEach((w) => addReinforcementDecorToWall(w));
}


// --- 6. TOWN CENTER (3x3) — DROPOFF POINT PADRÃO ---
/** Posições iniciais dos 4 aldeões no quadrante frontal visível do TC (Sul/Sudoeste, em leque aberto) */
export function getInitialVillagerSpawns(): [number, number][] {
  return [
    [tcCoord.minX - 1, tcCoord.minZ + 3], // Sudoeste
    [tcCoord.minX + 0, tcCoord.minZ + 4], // Sul-Sudoeste frontal (+Z)
    [tcCoord.minX + 1, tcCoord.minZ + 4], // Sul frontal (+Z)
    [tcCoord.minX + 2, tcCoord.minZ + 3]  // Sul-Sudeste
  ];
}

function createTownCenterMeshGroup(faction: UnitFaction = 'PLAYER'): THREE.Group {
  const tc = new THREE.Group();

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8b8f97, roughness: 0.9 });
  const stoneDarkMat = new THREE.MeshStandardMaterial({ color: 0x5b6069, roughness: 0.9 });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xd9c7a3, roughness: 0.85 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4a24, roughness: 0.8 });
  const roofColor = faction === 'ENEMY' ? 0x991b1b : 0x8b5a2b;
  const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.75, flatShading: true });

  // Fundação com "Saia de Pedra" estendida para baixo (evita flutuação em terreno inclinado)
  const tcSkirtGeo = new THREE.BoxGeometry(2.96, 1.2, 2.96);
  const tcSkirt = new THREE.Mesh(tcSkirtGeo, stoneDarkMat);
  tcSkirt.position.y = -0.58;
  tcSkirt.receiveShadow = true;
  tc.add(tcSkirt);

  const baseGeo = new THREE.BoxGeometry(2.9, 0.45, 2.9);
  const base = new THREE.Mesh(baseGeo, stoneMat);
  base.position.y = 0.225;
  base.castShadow = true;
  base.receiveShadow = true;
  tc.add(base);
  base.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(baseGeo),
    new THREE.LineBasicMaterial({ color: 0x3f444c, transparent: true, opacity: 0.6 })
  ));

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 2.5), stoneDarkMat);
  plinth.position.y = 0.575;
  plinth.castShadow = true;
  tc.add(plinth);

  const walls = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.0, 2.3), plasterMat);
  walls.position.y = 1.2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  tc.add(walls);

  const beamGeo = new THREE.BoxGeometry(0.14, 1.05, 0.14);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const beam = new THREE.Mesh(beamGeo, woodMat);
      beam.position.set(sx * 1.15, 1.2, sz * 1.15);
      beam.castShadow = true;
      tc.add(beam);
    }
  }

  const doorGeo = new THREE.BoxGeometry(0.5, 0.7, 0.05);
  const doorZ = new THREE.Mesh(doorGeo, woodMat);
  doorZ.position.set(0, 1.05, 1.16);
  tc.add(doorZ);
  const doorX = new THREE.Mesh(doorGeo, woodMat);
  doorX.rotation.y = Math.PI / 2;
  doorX.position.set(1.16, 1.05, 0);
  tc.add(doorX);

  const roofGeo = new THREE.ConeGeometry(2.05, 1.3, 4);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 1.7 + 0.65;
  roof.castShadow = true;
  tc.add(roof);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6), woodMat);
  pole.position.set(0, 3.5, 0);
  tc.add(pole);
  const flagColor = faction === 'ENEMY' ? 0xef4444 : 0x2563eb;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.3),
    new THREE.MeshStandardMaterial({ color: flagColor, side: THREE.DoubleSide })
  );
  flag.position.set(0.26, 3.85, 0);
  flag.name = 'tc-flag';
  tc.add(flag);

  return tc;
}

function createTownCenter(): THREE.Group {
  const tc = createTownCenterMeshGroup('PLAYER');
  tc.position.copy(TC_WORLD_CENTER);
  scene.add(tc);
  return tc;
}

const townCenter = createTownCenter();
const tcFlag = townCenter.getObjectByName('tc-flag') as THREE.Mesh;

// --- SISTEMA DE PONTO DE ENCONTRO (RALLY POINT) ---
export interface RallyPoint {
  x: number;
  z: number;
  targetType: 'GROUND' | 'RESOURCE' | 'BUILDING';
  targetId?: number | string;
  resourceType?: 'WOOD' | 'FOOD' | 'STONE' | 'GOLD';
}

// --- TOWN CENTER HP (400 HP) & RUÍNAS ---
export interface TownCenterState {
  group: THREE.Group;
  faction: UnitFaction;
  isEnemy: boolean;
  hp: number;
  maxHp: number;
  isDestroyed: boolean;
  hpBarGroup: THREE.Group;
  hpBarFillMesh: THREE.Mesh;
  ruinsGroup: THREE.Group | null;
  currentOpacity?: number;
  rallyPoint?: RallyPoint | null;
}

function createTownCenterHpBar(faction: UnitFaction = 'PLAYER'): { group: THREE.Group; fillMesh: THREE.Mesh } {
  const group = new THREE.Group();
  group.position.set(0, 4.35, 0);

  const bgGeo = new THREE.PlaneGeometry(2.4, 0.22);
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x090d16, side: THREE.DoubleSide });
  const bg = new THREE.Mesh(bgGeo, bgMat);
  group.add(bg);

  const fillGeo = new THREE.PlaneGeometry(2.32, 0.16);
  const fillMat = new THREE.MeshBasicMaterial({ color: faction === 'ENEMY' ? 0xef4444 : 0x22c55e, side: THREE.DoubleSide });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.z = 0.005;
  group.add(fill);

  return { group, fillMesh: fill };
}

const tcHpBar = createTownCenterHpBar('PLAYER');
townCenter.add(tcHpBar.group);

export const townCenterState: TownCenterState = {
  group: townCenter,
  faction: 'PLAYER',
  isEnemy: false,
  hp: currentMatchConfig.townCenterHp,
  maxHp: currentMatchConfig.townCenterHp,
  isDestroyed: false,
  hpBarGroup: tcHpBar.group,
  hpBarFillMesh: tcHpBar.fillMesh,
  ruinsGroup: null,
  currentOpacity: 1.0,
  rallyPoint: null
};

export function updateTownCenterHpBar() {
  const pct = THREE.MathUtils.clamp(townCenterState.hp / townCenterState.maxHp, 0, 1);
  townCenterState.hpBarFillMesh.scale.x = Math.max(0.001, pct);
  townCenterState.hpBarFillMesh.position.x = -1.16 * (1 - pct);

  const mat = townCenterState.hpBarFillMesh.material as THREE.MeshBasicMaterial;
  if (pct > 0.5) mat.color.setHex(0x22c55e);
  else if (pct > 0.25) mat.color.setHex(0xeab308);
  else mat.color.setHex(0xef4444);

  townCenterState.hpBarGroup.visible = !townCenterState.isDestroyed;
}

// --- MICRO-ANIMAÇÕES E VISUAIS 3D DO RALLY POINT ---
interface RallyPulseEffect {
  mesh: THREE.Mesh;
  createdAt: number;
  duration: number;
}
export const activeRallyPulses: RallyPulseEffect[] = [];

export function spawnRallyPointPulse(worldX: number, worldZ: number) {
  const geo = new THREE.RingGeometry(0.12, 0.24, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(worldX, getTerrainHeight(worldX, worldZ) + 0.04, worldZ);
  scene.add(mesh);
  activeRallyPulses.push({ mesh, createdAt: performance.now(), duration: 500 });
}

let rallyPointVisualGroup: THREE.Group;
let rallyFlagGroup: THREE.Group;
let rallyFlagMesh: THREE.Mesh;
let rallyLineMesh: THREE.Line;
let rallyLineGeo: THREE.BufferGeometry;

function initRallyPointVisuals() {
  rallyPointVisualGroup = new THREE.Group();
  rallyPointVisualGroup.name = 'rally-point-visuals';
  rallyPointVisualGroup.visible = false;

  rallyFlagGroup = new THREE.Group();

  // Haste: CylinderGeometry(0.03, 0.03, 0.7) de madeira escura
  const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.7, 12);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d2314, roughness: 0.8 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 0.35;
  pole.castShadow = true;
  rallyFlagGroup.add(pole);

  // Topo dourado da haste
  const finialGeo = new THREE.SphereGeometry(0.045, 12, 12);
  const finialMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.8, roughness: 0.2 });
  const finial = new THREE.Mesh(finialGeo, finialMat);
  finial.position.y = 0.7;
  rallyFlagGroup.add(finial);

  // Flâmula: triângulo em azul vibrante (0x2563eb)
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0.7);
  flagShape.lineTo(0.35, 0.55);
  flagShape.lineTo(0, 0.4);
  flagShape.closePath();
  const flagGeo = new THREE.ShapeGeometry(flagShape);
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0x2563eb,
    side: THREE.DoubleSide,
    roughness: 0.3,
    metalness: 0.1
  });
  rallyFlagMesh = new THREE.Mesh(flagGeo, flagMat);
  rallyFlagMesh.castShadow = true;
  rallyFlagGroup.add(rallyFlagMesh);

  // Base circular suave no solo
  const baseRingGeo = new THREE.RingGeometry(0.12, 0.24, 24);
  const baseRingMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
    depthWrite: false
  });
  const baseRing = new THREE.Mesh(baseRingGeo, baseRingMat);
  baseRing.rotation.x = -Math.PI / 2;
  baseRing.position.y = 0.02;
  rallyFlagGroup.add(baseRing);

  rallyPointVisualGroup.add(rallyFlagGroup);

  // Linha conectora suave pontilhada/translúcida
  rallyLineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 0)
  ]);
  const lineMat = new THREE.LineDashedMaterial({
    color: 0xfacc15,
    dashSize: 0.3,
    gapSize: 0.2,
    transparent: true,
    opacity: 0.8,
    depthWrite: false
  });
  rallyLineMesh = new THREE.Line(rallyLineGeo, lineMat);
  rallyLineMesh.frustumCulled = false;
  rallyPointVisualGroup.add(rallyLineMesh);

  scene.add(rallyPointVisualGroup);
}
initRallyPointVisuals();

export function updateRallyPointVisuals(): void {
  if (!rallyPointVisualGroup) return;

  let activeRp: RallyPoint | null | undefined = null;
  let sourcePos: THREE.Vector3 | null = null;

  if (isTownCenterSelected && !townCenterState.isDestroyed) {
    activeRp = townCenterState.rallyPoint;
    sourcePos = new THREE.Vector3(TC_WORLD_CENTER.x, getTerrainHeight(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z) + 0.2, TC_WORLD_CENTER.z);
  } else if (
    selectedBuilding &&
    (selectedBuilding.faction === 'PLAYER' || !selectedBuilding.isEnemy) &&
    ['BARRACKS', 'ARCHERY_RANGE', 'SCHOOL', 'COLLEGE'].includes(selectedBuilding.type)
  ) {
    activeRp = selectedBuilding.rallyPoint;
    sourcePos = new THREE.Vector3(selectedBuilding.worldCenter.x, getTerrainHeight(selectedBuilding.worldCenter.x, selectedBuilding.worldCenter.z) + 0.2, selectedBuilding.worldCenter.z);
  }

  if (!activeRp || !sourcePos) {
    rallyPointVisualGroup.visible = false;
    return;
  }

  const targetY = getTerrainHeight(activeRp.x + 0.5, activeRp.z + 0.5);
  rallyFlagGroup.position.set(activeRp.x + 0.5, targetY, activeRp.z + 0.5);

  const startPt = sourcePos;
  const endPt = new THREE.Vector3(activeRp.x + 0.5, targetY + 0.1, activeRp.z + 0.5);

  rallyLineGeo.setFromPoints([startPt, endPt]);
  rallyLineMesh.computeLineDistances();

  rallyPointVisualGroup.visible = true;
}

export function updateTownCenterRallyHUD(): void {
  const statusEl = document.getElementById('tc-rally-status');
  const btnClear = document.getElementById('btn-clear-tc-rally') as HTMLButtonElement | null;
  if (!statusEl) return;

  const rp = townCenterState.rallyPoint;
  if (rp) {
    let typeDesc = '';
    if (rp.targetType === 'RESOURCE') {
      typeDesc = rp.resourceType
        ? ` (${rp.resourceType === 'WOOD' ? 'Madeira 🪵' : (rp.resourceType === 'FOOD' ? 'Alimento 🍖' : (rp.resourceType === 'GOLD' ? 'Ouro 🪙' : 'Pedra 🪨'))})`
        : ' (Recurso)';
    } else if (rp.targetType === 'BUILDING') {
      typeDesc = ' (Obra 🔨)';
    }
    statusEl.textContent = `🚩 Ponto de Encontro: (${rp.x}, ${rp.z})${typeDesc}`;
    statusEl.style.color = '#38bdf8';
    if (btnClear) btnClear.style.display = 'inline-flex';
  } else {
    statusEl.textContent = '🚩 Padrão (Porta)';
    statusEl.style.color = '#94a3b8';
    if (btnClear) btnClear.style.display = 'none';
  }
}

export function updateBuildingRallyHUD(building: ConstructionBuilding | null): void {
  if (!building) return;
  let prefix = '';
  if (building.type === 'BARRACKS') prefix = 'barracks';
  else if (building.type === 'ARCHERY_RANGE') prefix = 'archery';
  else if (building.type === 'SCHOOL') prefix = 'school';
  else if (building.type === 'COLLEGE') prefix = 'college';
  if (!prefix) return;

  const statusEl = document.getElementById(`${prefix}-rally-status`);
  const btnClear = document.getElementById(`btn-clear-${prefix}-rally`) as HTMLButtonElement | null;
  if (!statusEl) return;

  const rp = building.rallyPoint;
  if (rp) {
    statusEl.textContent = `🚩 Ponto de Encontro: (${rp.x}, ${rp.z})`;
    statusEl.style.color = '#38bdf8';
    if (btnClear) btnClear.style.display = 'inline-flex';
  } else {
    statusEl.textContent = '🚩 Padrão (Porta)';
    statusEl.style.color = '#94a3b8';
    if (btnClear) btnClear.style.display = 'none';
  }
}


// --- SISTEMA DE PARTÍCULAS (EXPLOSÕES, FOGO & ESCOMBROS) ---
interface ParticleEffect {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotSpeed: THREE.Vector3;
  life: number;
  maxLife: number;
}
export const activeParticles: ParticleEffect[] = [];

export function spawnParticles(pos: THREE.Vector3, count = 15, color = 0xf97316) {
  if (!currentMatchConfig.revealWholeMap) {
    const gx = Math.floor(pos.x);
    const gz = Math.floor(pos.z);
    if (isCellInside(gx, gz) && getFogStateAt(gx, gz) === FogState.UNEXPLORED) {
      return;
    }
  }
  for (let i = 0; i < count; i++) {
    const size = 0.08 + Math.random() * 0.14;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    const p = new THREE.Mesh(geo, mat);
    p.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.9,
      Math.random() * 0.5,
      (Math.random() - 0.5) * 0.9
    ));

    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 4.0,
      1.8 + Math.random() * 3.8,
      (Math.random() - 0.5) * 4.0
    );
    const rotSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12
    );

    scene.add(p);
    activeParticles.push({
      mesh: p,
      vel,
      rotSpeed,
      life: 0,
      maxLife: 0.8 + Math.random() * 0.7
    });
  }
}

export function updateParticles(delta: number) {
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.life += delta;
    if (p.life >= p.maxLife) {
      scene.remove(p.mesh);
      activeParticles.splice(i, 1);
    } else {
      p.vel.y -= 9.8 * delta * 0.7; // gravidade
      p.mesh.position.addScaledVector(p.vel, delta);
      p.mesh.rotation.x += p.rotSpeed.x * delta;
      p.mesh.rotation.y += p.rotSpeed.y * delta;
      p.mesh.rotation.z += p.rotSpeed.z * delta;
      const progress = p.life / p.maxLife;
      const scale = Math.max(0.01, 1 - progress);
      p.mesh.scale.setScalar(scale);
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      if (mat) mat.opacity = 1 - progress;
    }
  }
}

// --- ESTATÍSTICAS DA PARTIDA & ESTADO DE JOGO ---
export interface GameStats {
  startTime: number;
  woodCollectedTotal: number;
  foodCollectedTotal: number;
  stoneCollectedTotal: number;
  goldCollectedTotal: number;
  unitsTrainedTotal: number;
  enemiesKilledTotal: number;
  buildingsConstructedTotal: number;
}

export const gameStats: GameStats = {
  startTime: performance.now(),
  woodCollectedTotal: 0,
  foodCollectedTotal: 0,
  stoneCollectedTotal: 0,
  goldCollectedTotal: 0,
  unitsTrainedTotal: 4, // 4 aldeões iniciais
  enemiesKilledTotal: 0,
  buildingsConstructedTotal: 0
};

export let isGameOver = false;
export let isGamePaused: boolean = false;
export let pauseStartTime: number = 0;
export let playerSwordsmenTrainedCount = 0;
export let hasInvasionTriggered = false;


// Bloqueia as 9 células do Town Center
for (let x = tcCoord.minX; x <= tcCoord.maxX; x++) {
  for (let z = tcCoord.minZ; z <= tcCoord.maxZ; z++) {
    setCellWalkable(x, z, false);
  }
}

// Bordas de entrega do TC: anel de células ao redor
const dropoffCells: THREE.Vector2[] = [];
function recomputeTownCenterDropoffCells(): void {
  dropoffCells.length = 0;
  for (let x = tcCoord.minX - 1; x <= tcCoord.maxX + 1; x++) {
    for (let z = tcCoord.minZ - 1; z <= tcCoord.maxZ + 1; z++) {
      const inside = x >= tcCoord.minX && x <= tcCoord.maxX && z >= tcCoord.minZ && z <= tcCoord.maxZ;
      if (!inside) dropoffCells.push(new THREE.Vector2(x, z));
    }
  }
}
recomputeTownCenterDropoffCells();

// Contorno dourado marcando a borda de entrega (acompanha a elevação do relevo)
let tcOutlineMesh: THREE.Line | null = null;
function updateTownCenterOutline(): void {
  const aX = tcCoord.minX - 1;
  const bX = tcCoord.maxX + 2;
  const aZ = tcCoord.minZ - 1;
  const bZ = tcCoord.maxZ + 2;
  const pts: THREE.Vector3[] = [];
  const step = 0.25;
  for (let x = aX; x <= bX; x += step) pts.push(new THREE.Vector3(x, getTerrainHeight(x, aZ) + 0.025, aZ));
  for (let z = aZ; z <= bZ; z += step) pts.push(new THREE.Vector3(bX, getTerrainHeight(bX, z) + 0.025, z));
  for (let x = bX; x >= aX; x -= step) pts.push(new THREE.Vector3(x, getTerrainHeight(x, bZ) + 0.025, bZ));
  for (let z = bZ; z >= aZ; z -= step) pts.push(new THREE.Vector3(aX, getTerrainHeight(aX, z) + 0.025, z));
  pts.push(pts[0].clone());

  if (tcOutlineMesh) {
    tcOutlineMesh.geometry.dispose();
    tcOutlineMesh.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    tcOutlineMesh.computeLineDistances();
  } else {
    tcOutlineMesh = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xfbbf24, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.55 })
    );
    tcOutlineMesh.computeLineDistances();
    scene.add(tcOutlineMesh);
  }
}
updateTownCenterOutline();

// --- 7. OBSTÁCULOS: ÁRVORES & MURALHA ---
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x654321, roughness: 0.85 });
const foliageMat1 = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.6 });
const foliageMat2 = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.6 });
const stoneWallMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85, metalness: 0.1 });
const stoneWallEdgeMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.5 });

const trunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 0.7, 8);
const coneGeo1 = new THREE.ConeGeometry(0.55, 0.85, 8);
const coneGeo2 = new THREE.ConeGeometry(0.42, 0.65, 8);

const TREE_MAX_WOOD = 100;

interface TreeResource {
  key: number;
  gridX: number;
  gridZ: number;
  group: THREE.Group;
  wood: number;
  depleting: boolean;
  depleteProgress: number;
  baseScale: number;
  chopUntil: number;
}

const treesMap = new Map<number, TreeResource>();

function createTree(gridX: number, gridZ: number): TreeResource {
  const tree = new THREE.Group();
  tree.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = 0.35;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  tree.add(trunk);

  const cone1 = new THREE.Mesh(coneGeo1, foliageMat1);
  cone1.position.y = 0.8;
  cone1.castShadow = true;
  cone1.receiveShadow = true;
  tree.add(cone1);

  const cone2 = new THREE.Mesh(coneGeo2, foliageMat2);
  cone2.position.y = 1.25;
  cone2.castShadow = true;
  cone2.receiveShadow = true;
  tree.add(cone2);

  const baseScale = 0.9 + Math.random() * 0.22;
  tree.scale.setScalar(baseScale);
  tree.rotation.y = Math.random() * Math.PI * 2;

  const key = cellKey(gridX, gridZ);
  tree.userData.treeKey = key;

  scene.add(tree);
  setCellWalkable(gridX, gridZ, false);

  const res: TreeResource = {
    key,
    gridX,
    gridZ,
    group: tree,
    wood: currentMatchConfig.treeCapacity,
    depleting: false,
    depleteProgress: 0,
    baseScale,
    chopUntil: 0
  };
  treesMap.set(key, res);
  return res;
}

// --- 7.05 ARBUSTOS DE FRUTAS (BERRY BUSHES - 150 ALIMENTO) ---
const BERRY_MAX_FOOD = 150;
const bushFoliageMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.85 }); // Verde-oliva denso
const berryFruitMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.35, metalness: 0.1 }); // Frutas vermelhas brilhantes

export interface BerryBushResource {
  key: number;
  gridX: number;
  gridZ: number;
  group: THREE.Group;
  foliageMeshes: THREE.Mesh[];
  fruitMeshes: THREE.Mesh[];
  food: number;
  maxFood: number;
  depleting: boolean;
  depleteProgress: number;
  baseScale: number;
  forageUntil: number;
}

export const berryBushesMap = new Map<number, BerryBushResource>();

function createBerryBush(gridX: number, gridZ: number): BerryBushResource {
  const bush = new THREE.Group();
  bush.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  const foliageMeshes: THREE.Mesh[] = [];
  const fruitMeshes: THREE.Mesh[] = [];

  // Folhagem densa em verde-oliva com vários domos sobrepostos
  const foliageGeo1 = new THREE.DodecahedronGeometry(0.38, 1);
  const foliageGeo2 = new THREE.DodecahedronGeometry(0.3, 1);
  const foliageGeo3 = new THREE.DodecahedronGeometry(0.26, 1);

  const foliageMat = bushFoliageMat.clone();

  const dome1 = new THREE.Mesh(foliageGeo1, foliageMat);
  dome1.position.set(0, 0.32, 0);
  dome1.castShadow = true;
  dome1.receiveShadow = true;
  bush.add(dome1);
  foliageMeshes.push(dome1);

  const dome2 = new THREE.Mesh(foliageGeo2, foliageMat);
  dome2.position.set(0.18, 0.26, 0.14);
  dome2.castShadow = true;
  dome2.receiveShadow = true;
  bush.add(dome2);
  foliageMeshes.push(dome2);

  const dome3 = new THREE.Mesh(foliageGeo2, foliageMat);
  dome3.position.set(-0.16, 0.28, -0.12);
  dome3.castShadow = true;
  dome3.receiveShadow = true;
  bush.add(dome3);
  foliageMeshes.push(dome3);

  const dome4 = new THREE.Mesh(foliageGeo3, foliageMat);
  dome4.position.set(0.08, 0.38, -0.16);
  dome4.castShadow = true;
  bush.add(dome4);
  foliageMeshes.push(dome4);

  // Esferas vermelhas (frutas espalhadas pelos galhos)
  const berryOffsets = [
    new THREE.Vector3(0.24, 0.44, 0.18),
    new THREE.Vector3(-0.22, 0.42, 0.2),
    new THREE.Vector3(0.02, 0.52, 0.22),
    new THREE.Vector3(-0.18, 0.46, -0.22),
    new THREE.Vector3(0.22, 0.4, -0.2),
    new THREE.Vector3(0.32, 0.32, -0.04),
    new THREE.Vector3(-0.3, 0.32, 0.04),
    new THREE.Vector3(0.04, 0.56, -0.06),
    new THREE.Vector3(-0.06, 0.5, 0.14),
    new THREE.Vector3(0.16, 0.48, -0.1)
  ];

  const berryGeo = new THREE.SphereGeometry(0.065, 8, 8);
  for (const offset of berryOffsets) {
    const berry = new THREE.Mesh(berryGeo, berryFruitMat);
    berry.position.copy(offset);
    berry.castShadow = true;
    bush.add(berry);
    fruitMeshes.push(berry);
  }

  const baseScale = 0.95 + Math.random() * 0.18;
  bush.scale.setScalar(baseScale);
  bush.rotation.y = Math.random() * Math.PI * 2;

  const key = cellKey(gridX, gridZ);
  bush.userData.berryKey = key;

  scene.add(bush);
  setCellWalkable(gridX, gridZ, false);

  const res: BerryBushResource = {
    key,
    gridX,
    gridZ,
    group: bush,
    foliageMeshes,
    fruitMeshes,
    food: BERRY_MAX_FOOD,
    maxFood: BERRY_MAX_FOOD,
    depleting: false,
    depleteProgress: 0,
    baseScale,
    forageUntil: 0
  };
  berryBushesMap.set(key, res);
  return res;
}

// --- 7.08 JAZIDA DE PEDRA (STONE MINE / QUARRY) ---
const stoneMineMat = new THREE.MeshStandardMaterial({
  color: 0x64748b, // Cinza-ardósia
  roughness: 0.9,
  metalness: 0.1,
  flatShading: true
});
const stoneDarkCrackMat = new THREE.MeshStandardMaterial({
  color: 0x334155, // Tom mais escuro para veios e lascas
  roughness: 0.95,
  flatShading: true
});
const stoneCrackLineMat = new THREE.LineBasicMaterial({
  color: 0x1e293b,
  transparent: true,
  opacity: 0.8
});

export interface StoneMineResource {
  key: number;
  gridX: number;
  gridZ: number;
  group: THREE.Group;
  bouldersGroup: THREE.Group;
  stone: number;
  maxStone: number;
  depleting: boolean;
  depleteProgress: number;
  baseScale: number;
  mineUntil: number;
}

export const stoneMinesMap = new Map<number, StoneMineResource>();

function createStoneMine(gridX: number, gridZ: number): StoneMineResource {
  const group = new THREE.Group();
  group.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  const bouldersGroup = new THREE.Group();
  group.add(bouldersGroup);

  // Bloco de rocha principal (facetado e irregular)
  const mainBoulderGeo = new THREE.DodecahedronGeometry(0.38, 0);
  const mainBoulder = new THREE.Mesh(mainBoulderGeo, stoneMineMat);
  mainBoulder.position.set(0, 0.32, 0);
  mainBoulder.scale.set(1.15, 0.9, 1.05);
  mainBoulder.rotation.set(0.1, 0.4, 0.2);
  mainBoulder.castShadow = true;
  mainBoulder.receiveShadow = true;
  bouldersGroup.add(mainBoulder);

  // Rachaduras no bloco principal
  const crackEdges = new THREE.LineSegments(new THREE.EdgesGeometry(mainBoulderGeo), stoneCrackLineMat);
  mainBoulder.add(crackEdges);

  // Rocha secundária adjacente
  const secBoulderGeo = new THREE.DodecahedronGeometry(0.28, 0);
  const secBoulder = new THREE.Mesh(secBoulderGeo, stoneMineMat);
  secBoulder.position.set(0.22, 0.22, -0.16);
  secBoulder.scale.set(0.9, 0.8, 1.1);
  secBoulder.rotation.set(0.3, 0.8, -0.2);
  secBoulder.castShadow = true;
  secBoulder.receiveShadow = true;
  bouldersGroup.add(secBoulder);

  // Rocha terciária
  const tertBoulderGeo = new THREE.DodecahedronGeometry(0.24, 0);
  const tertBoulder = new THREE.Mesh(tertBoulderGeo, stoneMineMat);
  tertBoulder.position.set(-0.2, 0.18, 0.18);
  tertBoulder.scale.set(1.0, 0.75, 0.9);
  tertBoulder.rotation.set(-0.2, 0.6, 0.3);
  tertBoulder.castShadow = true;
  tertBoulder.receiveShadow = true;
  bouldersGroup.add(tertBoulder);

  // Pequenas lascas e fragmentos facetados ao redor da base
  const chipOffsets = [
    { x: -0.32, z: -0.22, s: 0.10, r: 0.4 },
    { x: 0.34, z: 0.24, s: 0.09, r: 1.1 },
    { x: 0.12, z: 0.36, s: 0.08, r: 2.2 },
    { x: -0.28, z: -0.06, s: 0.07, r: 0.8 },
    { x: 0.28, z: -0.32, s: 0.09, r: 1.7 }
  ];

  const chipGeo = new THREE.DodecahedronGeometry(0.08, 0);
  for (const c of chipOffsets) {
    const chip = new THREE.Mesh(chipGeo, stoneDarkCrackMat);
    chip.position.set(c.x, 0.05, c.z);
    chip.scale.set(c.s * 10, c.s * 4, c.s * 10);
    chip.rotation.set(0.2, c.r, 0.1);
    chip.castShadow = true;
    bouldersGroup.add(chip);
  }

  const baseScale = 0.95 + Math.random() * 0.15;
  group.scale.setScalar(baseScale);
  group.rotation.y = Math.random() * Math.PI * 2;

  const key = cellKey(gridX, gridZ);
  group.userData.stoneKey = key;

  scene.add(group);
  setCellWalkable(gridX, gridZ, false);

  const res: StoneMineResource = {
    key,
    gridX,
    gridZ,
    group,
    bouldersGroup,
    stone: currentMatchConfig.stoneCapacity,
    maxStone: currentMatchConfig.stoneCapacity,
    depleting: false,
    depleteProgress: 0,
    baseScale,
    mineUntil: 0
  };
  stoneMinesMap.set(key, res);
  return res;
}

// --- 7.09 MINA DE OURO (GOLD MINE - 300 OURO) ---
const goldRockBaseMat = new THREE.MeshStandardMaterial({
  color: 0x1e293b, // Ardósia escura quase preta para contrastar fortemente com o ouro
  roughness: 0.85,
  metalness: 0.2,
  flatShading: true
});

const goldVeinLineMat = new THREE.LineBasicMaterial({
  color: 0xfef08a,
  transparent: true,
  opacity: 0.85
});

export interface GoldMineResource {
  key: number;
  gridX: number;
  gridZ: number;
  group: THREE.Group;
  bouldersGroup: THREE.Group;
  goldVeinsGroup: THREE.Group;
  goldVeinMaterials: THREE.MeshStandardMaterial[];
  gold: number;
  maxGold: number;
  depleting: boolean;
  depleteProgress: number;
  baseScale: number;
  mineUntil: number;
}

export const goldMinesMap = new Map<number, GoldMineResource>();

function createGoldMine(gridX: number, gridZ: number): GoldMineResource {
  const group = new THREE.Group();
  group.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  const bouldersGroup = new THREE.Group();
  group.add(bouldersGroup);

  const goldVeinsGroup = new THREE.Group();
  group.add(goldVeinsGroup);

  const goldVeinMaterials: THREE.MeshStandardMaterial[] = [];

  // Material de ouro brilhante e metálico (#eab308 / #facc15 com emissividade)
  const createGoldMat = (emissiveColor = 0xa16207, emissiveIntensity = 0.35) => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: emissiveColor,
      emissiveIntensity,
      roughness: 0.16,
      metalness: 0.92,
      flatShading: true
    });
    goldVeinMaterials.push(mat);
    return mat;
  };

  const primaryGoldMat = createGoldMat(0xa16207, 0.4);
  const brightGoldMat = createGoldMat(0xca8a04, 0.55);

  // 1. Matriz de rocha escura facetada principal
  const mainRockGeo = new THREE.DodecahedronGeometry(0.38, 0);
  const mainRock = new THREE.Mesh(mainRockGeo, goldRockBaseMat);
  mainRock.position.set(0, 0.30, 0);
  mainRock.scale.set(1.18, 0.88, 1.05);
  mainRock.rotation.set(0.12, 0.5, 0.18);
  mainRock.castShadow = true;
  mainRock.receiveShadow = true;
  bouldersGroup.add(mainRock);

  // Rocha escura secundária
  const secRockGeo = new THREE.DodecahedronGeometry(0.28, 0);
  const secRock = new THREE.Mesh(secRockGeo, goldRockBaseMat);
  secRock.position.set(-0.22, 0.22, 0.18);
  secRock.scale.set(0.95, 0.82, 1.08);
  secRock.rotation.set(-0.25, 0.7, 0.3);
  secRock.castShadow = true;
  secRock.receiveShadow = true;
  bouldersGroup.add(secRock);

  // 2. Grandes blocos/veios de minério dourado reluzente incrustados na rocha
  const mainGoldNuggetGeo = new THREE.DodecahedronGeometry(0.26, 0);
  const mainGoldNugget = new THREE.Mesh(mainGoldNuggetGeo, primaryGoldMat);
  mainGoldNugget.position.set(0.08, 0.36, -0.06);
  mainGoldNugget.scale.set(1.1, 1.25, 1.0);
  mainGoldNugget.rotation.set(0.3, 0.4, 0.2);
  mainGoldNugget.castShadow = true;
  mainGoldNugget.receiveShadow = true;
  mainGoldNugget.add(new THREE.LineSegments(new THREE.EdgesGeometry(mainGoldNuggetGeo), goldVeinLineMat));
  goldVeinsGroup.add(mainGoldNugget);

  // Veio de ouro proeminente superior
  const topGoldNuggetGeo = new THREE.OctahedronGeometry(0.22, 0);
  const topGoldNugget = new THREE.Mesh(topGoldNuggetGeo, brightGoldMat);
  topGoldNugget.position.set(-0.06, 0.48, 0.08);
  topGoldNugget.scale.set(0.9, 1.3, 0.95);
  topGoldNugget.rotation.set(-0.2, 0.9, 0.4);
  topGoldNugget.castShadow = true;
  topGoldNugget.receiveShadow = true;
  topGoldNugget.add(new THREE.LineSegments(new THREE.EdgesGeometry(topGoldNuggetGeo), goldVeinLineMat));
  goldVeinsGroup.add(topGoldNugget);

  // Pepita dourada lateral facetada
  const sideGoldGeo = new THREE.IcosahedronGeometry(0.18, 0);
  const sideGold = new THREE.Mesh(sideGoldGeo, primaryGoldMat);
  sideGold.position.set(0.26, 0.26, 0.20);
  sideGold.scale.set(1.2, 0.9, 1.0);
  sideGold.rotation.set(0.4, 0.2, -0.3);
  sideGold.castShadow = true;
  sideGold.receiveShadow = true;
  sideGold.add(new THREE.LineSegments(new THREE.EdgesGeometry(sideGoldGeo), goldVeinLineMat));
  goldVeinsGroup.add(sideGold);

  // Outra pepita facetada saindo pela base
  const lowGoldGeo = new THREE.OctahedronGeometry(0.15, 0);
  const lowGold = new THREE.Mesh(lowGoldGeo, brightGoldMat);
  lowGold.position.set(-0.26, 0.18, -0.16);
  lowGold.scale.set(1.1, 1.1, 0.85);
  lowGold.rotation.set(0.5, 0.6, 0.1);
  lowGold.castShadow = true;
  lowGold.receiveShadow = true;
  goldVeinsGroup.add(lowGold);

  // Pequenas lascas e cristais de ouro na base ao redor
  const goldChips = [
    { x: 0.32, z: -0.25, s: 0.07, r: 0.3 },
    { x: -0.34, z: 0.22, s: 0.08, r: 1.2 },
    { x: 0.12, z: 0.38, s: 0.065, r: 2.1 },
    { x: -0.22, z: -0.30, s: 0.07, r: 0.8 }
  ];
  const chipGeo = new THREE.OctahedronGeometry(0.08, 0);
  for (const c of goldChips) {
    const chip = new THREE.Mesh(chipGeo, brightGoldMat);
    chip.position.set(c.x, 0.06, c.z);
    chip.scale.setScalar(c.s * 10);
    chip.rotation.set(0.2, c.r, 0.1);
    chip.castShadow = true;
    goldVeinsGroup.add(chip);
  }

  const baseScale = 0.95 + Math.random() * 0.15;
  group.scale.setScalar(baseScale);
  group.rotation.y = Math.random() * Math.PI * 2;

  const key = cellKey(gridX, gridZ);
  group.userData.goldKey = key;

  scene.add(group);
  setCellWalkable(gridX, gridZ, false);

  const res: GoldMineResource = {
    key,
    gridX,
    gridZ,
    group,
    bouldersGroup,
    goldVeinsGroup,
    goldVeinMaterials,
    gold: currentMatchConfig.goldCapacity,
    maxGold: currentMatchConfig.goldCapacity,
    depleting: false,
    depleteProgress: 0,
    baseScale,
    mineUntil: 0
  };
  goldMinesMap.set(key, res);
  return res;
}

function createWallBlock(gridX: number, gridZ: number): THREE.Group {
  const wallGroup = new THREE.Group();
  wallGroup.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  // Saia de pedra estendida para baixo (ancora o bloco no terreno em declives)
  const wallSkirt = new THREE.Mesh(new THREE.BoxGeometry(0.94, 1.0, 0.94), stoneWallMat);
  wallSkirt.position.y = -0.5;
  wallSkirt.receiveShadow = true;
  wallGroup.add(wallSkirt);

  const blockGeo = new THREE.BoxGeometry(0.94, 1.1, 0.94);
  const block = new THREE.Mesh(blockGeo, stoneWallMat);
  block.position.y = 0.55;
  block.castShadow = true;
  block.receiveShadow = true;
  wallGroup.add(block);
  block.add(new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), stoneWallEdgeMat));

  const crenGeo = new THREE.BoxGeometry(0.28, 0.25, 0.28);
  const cren1 = new THREE.Mesh(crenGeo, stoneWallMat);
  cren1.position.set(-0.3, 1.2, -0.3);
  cren1.castShadow = true;
  wallGroup.add(cren1);

  const cren2 = new THREE.Mesh(crenGeo, stoneWallMat);
  cren2.position.set(0.3, 1.2, 0.3);
  cren2.castShadow = true;
  wallGroup.add(cren2);

  scene.add(wallGroup);
  setWallCellOccupancy(gridX, gridZ, true);
  const wallObj: WallBlock = { gridX, gridZ, group: wallGroup };
  if (isStoneWallReinforced) {
    addReinforcementDecorToWall(wallObj);
  }
  wallsList.push(wallObj);
  return wallGroup;
}

// --- 7.1 DISTRIBUIÇÃO COMPETITIVA E SIMÉTRICA DE RECURSOS LOCAIS ---

/**
 * Gera os recursos garantidos de forma relativa à posição de uma base (Aliada ou Inimiga):
 *  - 1 bosque de madeira a 4-5 células de distância (6 árvores).
 *  - 1 aglomerado de arbustos de frutas a 4-5 células (5 arbustos).
 *  - 1 jazida de pedra a 6-7 células (4 nós).
 *  - 1 mina de ouro a 6-7 células (4 nós).
 */
function spawnBaseGuaranteedResources(centerX: number, centerZ: number, _isPlayer: boolean): void {
  let dirX = -centerX;
  let dirZ = -centerZ;
  const len = Math.hypot(dirX, dirZ);
  if (len > 0.001) {
    dirX /= len;
    dirZ /= len;
  } else {
    dirX = 1;
    dirZ = 0;
  }
  const perpX = -dirZ;
  const perpZ = dirX;

  // 1. Bosque de Madeira (6 árvores, ~4-5 células de distância)
  const woodAnchorX = Math.round(centerX + perpX * 4.5);
  const woodAnchorZ = Math.round(centerZ + perpZ * 4.5);
  const woodOffsets = [
    [0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]
  ];
  for (const [ox, oz] of woodOffsets) {
    const wx = woodAnchorX + ox;
    const wz = woodAnchorZ + oz;
    if (isCellInside(wx, wz) && isCellWalkable(wx, wz)) {
      createTree(wx, wz);
    }
  }

  // 2. Aglomerado de Arbustos de Frutas (5 arbustos, ~4-5 células de distância)
  const berryAnchorX = Math.round(centerX - perpX * 4.5);
  const berryAnchorZ = Math.round(centerZ - perpZ * 4.5);
  const berryOffsets = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]
  ];
  for (const [ox, oz] of berryOffsets) {
    const bx = berryAnchorX + ox;
    const bz = berryAnchorZ + oz;
    if (isCellInside(bx, bz) && isCellWalkable(bx, bz)) {
      createBerryBush(bx, bz);
    }
  }

  // 3. Jazida de Pedra (4 nós de pedra, ~6-7 células de distância)
  let sDirX = dirX + perpX * 0.45;
  let sDirZ = dirZ + perpZ * 0.45;
  const sLen = Math.hypot(sDirX, sDirZ);
  sDirX /= sLen;
  sDirZ /= sLen;
  const stoneAnchorX = Math.round(centerX + sDirX * 6.5);
  const stoneAnchorZ = Math.round(centerZ + sDirZ * 6.5);
  const stoneOffsets = [
    [0, 0], [1, 0], [0, 1], [1, 1]
  ];
  for (const [ox, oz] of stoneOffsets) {
    const sx = stoneAnchorX + ox;
    const sz = stoneAnchorZ + oz;
    if (isCellInside(sx, sz) && isCellWalkable(sx, sz)) {
      createStoneMine(sx, sz);
    }
  }

  // 4. Mina de Ouro (4 nós dourados, ~6-7 células de distância)
  let gDirX = dirX - perpX * 0.45;
  let gDirZ = dirZ - perpZ * 0.45;
  const gLen = Math.hypot(gDirX, gDirZ);
  gDirX /= gLen;
  gDirZ /= gLen;
  const goldAnchorX = Math.round(centerX + gDirX * 6.5);
  const goldAnchorZ = Math.round(centerZ + gDirZ * 6.5);
  const goldOffsets = [
    [0, 0], [1, 0], [0, 1], [1, 1]
  ];
  for (const [ox, oz] of goldOffsets) {
    const gx = goldAnchorX + ox;
    const gz = goldAnchorZ + oz;
    if (isCellInside(gx, gz) && isCellWalkable(gx, gz)) {
      createGoldMine(gx, gz);
    }
  }
}

function spawnGuaranteedAlliedResources(): void {
  spawnBaseGuaranteedResources(tcCoord.minX + 1.5, tcCoord.minZ + 1.5, true);
}

function spawnGuaranteedEnemyResources(): void {
  spawnBaseGuaranteedResources(enemyCampCoord.x + 1.5, enemyCampCoord.z + 1.5, false);
}

/**
 * Aglomerados densos e contíguos de árvores distribuídos organicamente via ruído 2D.
 * Onde o ruído de vegetação for > 0.65 (fora das zonas de exclusão e penhascos), brota floresta.
 */
function spawnOrganicForests(seed: number): void {
  const tcCX = tcCoord.minX + 1.5;
  const tcCZ = tcCoord.minZ + 1.5;
  const ecCX = enemyCampCoord.x + enemyCampCoord.size / 2;
  const ecCZ = enemyCampCoord.z + enemyCampCoord.size / 2;

  for (let gx = MAP_MIN + 2; gx <= MAP_MAX - 2; gx++) {
    for (let gz = MAP_MIN + 2; gz <= MAP_MAX - 2; gz++) {
      // Exclusão aliada: raio 6.5 em torno da base
      if (Math.hypot(gx + 0.5 - tcCX, gz + 0.5 - tcCZ) <= 6.5) continue;
      // Exclusão inimiga: raio 6.5 em torno do acampamento
      if (Math.hypot(gx + 0.5 - ecCX, gz + 0.5 - ecCZ) <= 6.5) continue;

      if (!isCellWalkable(gx, gz)) continue;

      // Ruído contínuo de vegetação (escala ~0.12)
      const vegNoise = fbmNoise2D(gx * 0.12 + 250, gz * 0.12 + 250, seed + 9999, 2);
      if (vegNoise > 0.65) {
        createTree(gx, gz);
      }
    }
  }

  // Para o mapa Gigante (100x100): gera 12 a 14 bosques densos de árvores distribuídos pelas regiões selvagens
  if (mapSize >= 100) {
    const grovesCount = 13;
    const rng = createSeededRandom(seed * 71 + 333);
    for (let g = 0; g < grovesCount; g++) {
      const gX = Math.floor(MAP_MIN + 6 + rng() * (GRID_SIZE - 12));
      const gZ = Math.floor(MAP_MIN + 6 + rng() * (GRID_SIZE - 12));
      if (Math.hypot(gX + 0.5 - tcCX, gZ + 0.5 - tcCZ) < 9.5) continue;
      if (Math.hypot(gX + 0.5 - ecCX, gZ + 0.5 - ecCZ) < 9.5) continue;

      const groveRadius = 2.4 + rng() * 1.6; // raio ~2.4 a 4 células
      const r2 = groveRadius * groveRadius;
      for (let ox = -Math.ceil(groveRadius); ox <= Math.ceil(groveRadius); ox++) {
        for (let oz = -Math.ceil(groveRadius); oz <= Math.ceil(groveRadius); oz++) {
          if (ox * ox + oz * oz <= r2) {
            const tx = gX + ox;
            const tz = gZ + oz;
            if (isCellInside(tx, tz) && isCellWalkable(tx, tz)) {
              if (Math.hypot(tx + 0.5 - tcCX, tz + 0.5 - tcCZ) >= 7.0 &&
                  Math.hypot(tx + 0.5 - ecCX, tz + 0.5 - ecCZ) >= 7.0) {
                createTree(tx, tz);
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Jazidas de Pedra e Frutas spawnadas em grupos compactos (clusters de 3 a 5 nós adjacentes)
 * nos vales e sopés das colinas (elevação moderada/baixa).
 */
function spawnWildMineralAndFruitClusters(seed: number): void {
  const tcCX = tcCoord.minX + 1.5;
  const tcCZ = tcCoord.minZ + 1.5;
  const ecCX = enemyCampCoord.x + enemyCampCoord.size / 2;
  const ecCZ = enemyCampCoord.z + enemyCampCoord.size / 2;
  const clusterCount = mapSize <= 30 ? 2 : mapSize <= 50 ? 3 : mapSize <= 80 ? 5 : 8;
  const rng = createSeededRandom(seed * 37 + 101);

  const trySpawnCluster = (type: 'STONE' | 'BERRY' | 'GOLD'): boolean => {
    const attempts = 45;
    for (let a = 0; a < attempts; a++) {
      const rx = Math.floor(MAP_MIN + 4 + rng() * (GRID_SIZE - 8));
      const rz = Math.floor(MAP_MIN + 4 + rng() * (GRID_SIZE - 8));

      // Fora das zonas de exclusão de base
      if (Math.hypot(rx + 0.5 - tcCX, rz + 0.5 - tcCZ) < 7.5) continue;
      if (Math.hypot(rx + 0.5 - ecCX, rz + 0.5 - ecCZ) < 7.5) continue;

      // Valas e sopés: altura baixa a moderada (0 a 0.55)
      const h = getCellHeight(rx, rz);
      if (h > 0.55) continue;

      // Fora de floresta densa
      const vegNoise = fbmNoise2D(rx * 0.12 + 250, rz * 0.12 + 250, seed + 9999, 2);
      if (vegNoise > 0.60) continue;

      if (!isCellInside(rx, rz) || !isCellWalkable(rx, rz)) continue;

      // Aglomerado compacto de 3 a 5 nós adjacentes
      const targetSize = 3 + Math.floor(rng() * 3);
      const placed: [number, number][] = [];
      const queue: [number, number][] = [[rx, rz]];
      const visited = new Set<number>();
      visited.add(cellKey(rx, rz));

      while (queue.length > 0 && placed.length < targetSize) {
        const [cx, cz] = queue.shift()!;
        if (!isCellInside(cx, cz) || !isCellWalkable(cx, cz)) continue;
        if (getCellHeight(cx, cz) > 0.70) continue;

        if (type === 'STONE') {
          createStoneMine(cx, cz);
        } else if (type === 'BERRY') {
          createBerryBush(cx, cz);
        } else {
          createGoldMine(cx, cz);
        }
        placed.push([cx, cz]);

        const neighbors = [
          [cx + 1, cz],
          [cx - 1, cz],
          [cx, cz + 1],
          [cx, cz - 1]
        ];
        for (const [nx, nz] of neighbors) {
          const k = cellKey(nx, nz);
          if (!visited.has(k) && isCellInside(nx, nz) && isCellWalkable(nx, nz)) {
            visited.add(k);
            queue.push([nx, nz]);
          }
        }
      }

      if (placed.length >= 3) return true;
    }
    return false;
  };

  for (let i = 0; i < clusterCount; i++) {
    trySpawnCluster('STONE');
  }
  for (let i = 0; i < clusterCount; i++) {
    trySpawnCluster('BERRY');
  }
  if (mapSize >= 50) {
    const goldCount = mapSize >= 100 ? clusterCount : Math.max(1, clusterCount - 1);
    for (let i = 0; i < goldCount; i++) {
      trySpawnCluster('GOLD');
    }
  }
  // No mapa 100x100: adiciona 2 a 3 aglomerados extras de pedra e minas de ouro neutras no centro e bordas para incentivar expansão
  if (mapSize >= 100) {
    for (let i = 0; i < 3; i++) {
      trySpawnCluster('STONE');
      trySpawnCluster('GOLD');
    }
  }
}

function spawnStoneWall(): void {
  const cx = tcCoord.minX + 1.5;
  const cz = tcCoord.minZ + 1.5;
  let dirX = -cx;
  let dirZ = -cz;
  const len = Math.hypot(dirX, dirZ);
  if (len > 0.001) {
    dirX /= len;
    dirZ /= len;
  }
  const perpX = Math.round(-dirZ);
  const perpZ = Math.round(dirX);
  const wallAnchorX = Math.round(cx + dirX * 5.0);
  const wallAnchorZ = Math.round(cz + dirZ * 5.0);

  for (let i = -2; i <= 2; i++) {
    const wx = wallAnchorX + perpX * i;
    const wz = wallAnchorZ + perpZ * i;
    if (isCellInside(wx, wz) && isCellWalkable(wx, wz)) {
      createWallBlock(wx, wz);
    }
  }
}

/** Remove todas as árvores, arbustos, jazidas e blocos de muralha da cena. */
function clearMapObstacles(): void {
  treesMap.forEach((tree) => scene.remove(tree.group));
  treesMap.clear();

  berryBushesMap.forEach((bush) => scene.remove(bush.group));
  berryBushesMap.clear();

  stoneMinesMap.forEach((mine) => scene.remove(mine.group));
  stoneMinesMap.clear();

  goldMinesMap.forEach((mine) => scene.remove(mine.group));
  goldMinesMap.clear();

  for (const wall of wallsList) {
    setWallCellOccupancy(wall.gridX, wall.gridZ, false);
    scene.remove(wall.group);
    wall.group.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) c.geometry.dispose();
    });
  }
  wallsList.length = 0;
}

/** Bloqueia as 9 células do Town Center no grid atual. */
function blockTownCenterCells(): void {
  for (let x = tcCoord.minX; x <= tcCoord.maxX; x++) {
    for (let z = tcCoord.minZ; z <= tcCoord.maxZ; z++) {
      setCellWalkable(x, z, false);
    }
  }
}

// Obstáculos, recursos, muralhas e unidades são gerados na rotina estrita e segura setupInitialMatch()

// --- 8. ALGORITMO A* (8 DIREÇÕES, HEAP BINÁRIO, ANTI-CORNER CUTTING) ---
interface NodeAStar {
  x: number;
  z: number;
  g: number;
  h: number;
  f: number;
  parent: NodeAStar | null;
}

class NodeHeap {
  private data: NodeAStar[] = [];

  get size(): number {
    return this.data.length;
  }

  push(node: NodeAStar): void {
    const d = this.data;
    d.push(node);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].f <= d[i].f) break;
      [d[p], d[i]] = [d[i], d[p]];
      i = p;
    }
  }

  pop(): NodeAStar | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && d[l].f < d[m].f) m = l;
        if (r < d.length && d[r].f < d[m].f) m = r;
        if (m === i) break;
        [d[m], d[i]] = [d[i], d[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  { dx: 0, dz: 1, cost: 1.0 },
  { dx: 0, dz: -1, cost: 1.0 },
  { dx: 1, dz: 0, cost: 1.0 },
  { dx: -1, dz: 0, cost: 1.0 },
  { dx: 1, dz: 1, cost: 1.414 },
  { dx: -1, dz: 1, cost: 1.414 },
  { dx: 1, dz: -1, cost: 1.414 },
  { dx: -1, dz: -1, cost: 1.414 }
];

function octileDistance(x1: number, z1: number, x2: number, z2: number): number {
  const dx = Math.abs(x1 - x2);
  const dz = Math.abs(z1 - z2);
  return (dx + dz) + (1.414 - 2.0) * Math.min(dx, dz);
}

function findClosestWalkableCell(target: THREE.Vector2, start: THREE.Vector2): THREE.Vector2 {
  if (isCellWalkable(target.x, target.y)) return target.clone();

  for (let r = 1; r <= 12; r++) {
    let best: THREE.Vector2 | null = null;
    let bestScore = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const nx = target.x + dx;
        const nz = target.y + dz;
        if (!isCellWalkable(nx, nz)) continue;
        const score = Math.hypot(dx, dz) * 10 + Math.hypot(nx - start.x, nz - start.y);
        if (score < bestScore) {
          bestScore = score;
          best = new THREE.Vector2(nx, nz);
        }
      }
    }
    if (best) return best;
  }
  return target.clone();
}

function isCellWalkableForPath(gx: number, gz: number, faction: UnitFaction = 'PLAYER'): boolean {
  if (!isCellInside(gx, gz)) return false;
  if (isCellWalkable(gx, gz)) return true;
  // Se for um portão aliado concluído, é transitável para o planejador de rota aliado
  if (faction === 'PLAYER') {
    const b = buildingsGridMap.get(cellKey(gx, gz));
    if (b && b.type === 'GATE' && b.isCompleted && b.faction === 'PLAYER') {
      return true;
    }
  }
  return false;
}

export function findPath(startGrid: THREE.Vector2, rawTargetGrid: THREE.Vector2, faction: UnitFaction = 'PLAYER'): THREE.Vector2[] {
  const targetGrid = findClosestWalkableCell(rawTargetGrid, startGrid);

  if (startGrid.x === targetGrid.x && startGrid.y === targetGrid.y) {
    return [targetGrid.clone()];
  }

  const open = new NodeHeap();
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  const h0 = octileDistance(startGrid.x, startGrid.y, targetGrid.x, targetGrid.y);
  open.push({ x: startGrid.x, z: startGrid.y, g: 0, h: h0, f: h0, parent: null });
  gScore.set(cellKey(startGrid.x, startGrid.y), 0);

  while (open.size > 0) {
    const current = open.pop()!;
    const ck = cellKey(current.x, current.z);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (current.x === targetGrid.x && current.z === targetGrid.y) {
      const path: THREE.Vector2[] = [];
      let n: NodeAStar | null = current;
      while (n) {
        path.push(new THREE.Vector2(n.x, n.z));
        n = n.parent;
      }
      path.reverse();
      if (path.length > 1) path.shift();
      return path;
    }

    for (const dir of DIRS) {
      const nx = current.x + dir.dx;
      const nz = current.z + dir.dz;
      const nk = cellKey(nx, nz);

      if (!isCellWalkableForPath(nx, nz, faction) || closed.has(nk)) continue;

      // Desnível abrupto (> 1.0) entre células adjacentes impede passagem
      if (Math.abs(getCellHeight(current.x, current.z) - getCellHeight(nx, nz)) > 1.0) continue;

      if (dir.dx !== 0 && dir.dz !== 0) {
        // Bloqueio de corte de quina (Corner-Cutting): se (current.x + dx, current.z) OU (current.x, current.z + dz)
        // for obstáculo (como uma muralha), a passagem diagonal é terminantemente proibida.
        const c1Walkable = isCellWalkableForPath(current.x + dir.dx, current.z, faction);
        const c2Walkable = isCellWalkableForPath(current.x, current.z + dir.dz, faction);
        if (!c1Walkable || !c2Walkable) {
          continue;
        }
      }

      const g = current.g + dir.cost;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        const h = octileDistance(nx, nz, targetGrid.x, targetGrid.y);
        open.push({ x: nx, z: nz, g, h, f: g + h, parent: current });
      }
    }
  }

  return [targetGrid.clone()];
}

// --- 9. SISTEMA DE CONSTRUÇÃO DE EDIFÍCIOS (QUARTEL / BARRACKS 2x2) ---
export interface ProductionQueueItem {
  id: string;
  unitType: 'SWORDSMAN' | 'ARCHER';
  totalDuration: number;
}

export type EliteCourse = 'ARCHITECT' | 'AGRONOMIST' | 'ARMORER' | 'ALCHEMIST';

export interface EnrolledStudent {
  unitId: string;
  progressSec: number;
  chosenCourse?: EliteCourse;
}

export interface ConstructionBuilding {
  id: string;
  type: 'BARRACKS' | 'TOWER' | 'LUMBER_CAMP' | 'MINING_CAMP' | 'HOUSE' | 'MILL' | 'FARM' | 'SCHOOL' | 'COLLEGE' | 'WALL' | 'GATE' | 'ARCHERY_RANGE';
  faction: UnitFaction;
  isEnemy: boolean;
  gridX: number; // célula superior-esquerda X
  gridZ: number; // célula superior-esquerda Z
  size: number;  // 3x3 para Faculdade/TC, 2x2 para Quartel/Madeireira/Mina/Moinho/Fazenda/Escola/Portão, 1x1 para Torre/Casa/Muralha
  sizeX?: number;
  sizeZ?: number;
  worldCenter: THREE.Vector3;
  isCompleted: boolean;
  progress: number; // 0 a 100%
  group: THREE.Group;
  mesh?: THREE.Group;
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  progressGroup: THREE.Group;
  trainingQueue: ProductionQueueItem[];
  trainingTimer: number;
  selectionMesh: THREE.Mesh;
  trainingProgressGroup: THREE.Group;
  trainingProgressBarMesh: THREE.Mesh;
  lastAttackTime?: number;
  currentOpacity?: number;

  // Propriedades agrícolas e de moagem
  farmFood?: number;
  maxFarmFood?: number;
  isDepleted?: boolean;
  assignedFarmerId?: string | null;
  cropMeshes?: THREE.Object3D[];
  windmillBlades?: THREE.Group;

  // Propriedades de Educação (Escola & Faculdade)
  enrolledStudents?: EnrolledStudent[];
  maxStudents?: number;
  selectedCollegeCourse?: EliteCourse;
  hp?: number;
  maxHp?: number;
  hpBarGroup?: THREE.Group;
  hpBarFillMesh?: THREE.Mesh;
  hpBarShowUntil?: number;

  // Propriedades de Fortificação (Portões)
  gateState?: 'CLOSED' | 'OPENING' | 'OPEN' | 'CLOSING';
  gateOpenProgress?: number;
  leftGateLeaf?: THREE.Object3D;
  rightGateLeaf?: THREE.Object3D;
  portcullisMesh?: THREE.Object3D;

  // Ponto de Encontro (Rally Point)
  rallyPoint?: RallyPoint | null;
}

const BARRACKS_COST_WOOD = 50;
const ARCHERY_RANGE_COST_WOOD = 100;
const ARCHERY_RANGE_COST_STONE = 50;
const ARCHER_COST_WOOD = 40;
const ARCHER_COST_GOLD = 45;
const ARCHER_TRAIN_TIME_SEC = 14;
const ARCHER_HP = 40;
const ARCHER_DAMAGE = 7;
const ARCHER_ATTACK_RANGE = 6.0;
const ARCHER_ATTACK_COOLDOWN = 1.6;
const ARCHER_SPEED = 4.62;
const TOWER_COST_STONE = 70;
const TOWER_COST_WOOD = 30;
const LUMBER_CAMP_COST_WOOD = 100;
const MINING_CAMP_COST_WOOD = 100;
const HOUSE_COST_WOOD = 30;
const MILL_COST_WOOD = 70;
const FARM_COST_WOOD = 60;
const SCHOOL_COST_WOOD = 80;
const SCHOOL_COST_STONE = 40;
const SCHOOL_MAX_STUDENTS = 3;
const COLLEGE_COST_WOOD = 150;
const COLLEGE_COST_STONE = 120;
const COLLEGE_COST_GOLD = 80;
const COLLEGE_MAX_STUDENTS = 3;

// Constantes de Fortificação (Muralhas e Portões)
const WALL_COST_STONE = 5;
const WALL_HP = 250;
const GATE_COST_STONE = 20;
const GATE_COST_WOOD = 20;
const GATE_HP = 350;

/** Contagem e checagem contínua de Arquitetos vivos formados no império */
export function getLivingArchitectsCount(): number {
  return unitsList.filter(
    (u) =>
      ((u.faction as string) === 'ALLIED' || !u.isEnemy) &&
      !u.isDying &&
      u.hp > 0 &&
      u.educationLevel >= 2 &&
      (u.specialization === 'ARCHITECT' || u.eliteSpecialization === 'ARCHITECT')
  ).length;
}

export function hasLivingArchitect(): boolean {
  return unitsList.some(
    (u) =>
      ((u.faction as string) === 'ALLIED' || !u.isEnemy) &&
      (u.specialization === 'ARCHITECT' || u.eliteSpecialization === 'ARCHITECT') &&
      u.hp > 0 &&
      !u.isDying
  );
}

export function hasLivingAgronomist(): boolean {
  return unitsList.some(
    (u) =>
      ((u.faction as string) === 'ALLIED' || !u.isEnemy) &&
      (u.specialization === 'AGRONOMIST' || u.eliteSpecialization === 'AGRONOMIST') &&
      u.hp > 0 &&
      !u.isDying
  );
}

export function hasLivingArmorer(): boolean {
  return unitsList.some(
    (u) =>
      ((u.faction as string) === 'ALLIED' || !u.isEnemy) &&
      (u.specialization === 'ARMORER' || u.eliteSpecialization === 'ARMORER') &&
      u.hp > 0 &&
      !u.isDying
  );
}
const FARM_FOOD_CAPACITY = 175;
const MAX_GLOBAL_POPULATION = 50;
const BASE_TC_POPULATION = 5;
const HOUSE_POPULATION_BONUS = 5;

export function getPopulationCap(): number {
  let cap = 0;
  if (!townCenterState.isDestroyed) {
    cap += BASE_TC_POPULATION;
  }
  for (const b of buildingsList) {
    if (
      b.type === 'HOUSE' &&
      (b.faction === 'PLAYER' || (b.faction as string) === 'ALLIED' || !b.isEnemy) &&
      b.isCompleted &&
      (b.hp === undefined || b.hp > 0)
    ) {
      cap += HOUSE_POPULATION_BONUS;
    }
  }
  return Math.min(MAX_GLOBAL_POPULATION, cap);
}

export function getEnemyPopulationCap(): number {
  let cap = BASE_TC_POPULATION;
  for (const b of buildingsList) {
    if (
      b.type === 'HOUSE' &&
      (b.faction === 'ENEMY' || b.isEnemy) &&
      b.isCompleted &&
      (b.hp === undefined || b.hp > 0)
    ) {
      cap += HOUSE_POPULATION_BONUS;
    }
  }
  return Math.min(MAX_GLOBAL_POPULATION, cap);
}

export function recalculatePopCap(): { player: number; enemy: number } {
  // Apenas Casas aliadas CONCLUÍDAS aumentam o limite do jogador:
  const alliedHouses = buildingsList.filter(
    (b) =>
      b.type === 'HOUSE' &&
      (b.faction === 'PLAYER' || (b.faction as string) === 'ALLIED' || !b.isEnemy) &&
      b.isCompleted &&
      (b.hp === undefined || b.hp > 0)
  );
  const playerCap = Math.min(
    MAX_GLOBAL_POPULATION,
    (!townCenterState.isDestroyed ? BASE_TC_POPULATION : 0) + alliedHouses.length * HOUSE_POPULATION_BONUS
  );

  const enemyHouses = buildingsList.filter(
    (b) =>
      b.type === 'HOUSE' &&
      (b.faction === 'ENEMY' || b.isEnemy) &&
      b.isCompleted &&
      (b.hp === undefined || b.hp > 0)
  );
  enemyPopCap = Math.min(MAX_GLOBAL_POPULATION, BASE_TC_POPULATION + enemyHouses.length * HOUSE_POPULATION_BONUS);

  updateTelemetryUnitsCount();
  return { player: playerCap, enemy: enemyPopCap };
}

export function getCurrentPlayerPopulation(): number {
  return unitsList.filter((u) => u.faction === 'PLAYER' && !u.isDying).length;
}

export function getTotalQueuedPlayerUnits(): number {
  let queued = tcTrainingQueue.length;
  for (const b of buildingsList) {
    if (
      (b.type === 'BARRACKS' || b.type === 'ARCHERY_RANGE') &&
      (b.faction === 'PLAYER' || (b.faction as string) === 'ALLIED' || !b.isEnemy) &&
      b.isCompleted
    ) {
      queued += b.trainingQueue.length;
    }
  }
  return queued;
}
const TOWER_ATTACK_RANGE = 7.5;
const TOWER_ATTACK_COOLDOWN = 1.35; // segundos por disparo
const TOWER_DAMAGE = 14;
const TOWER_VISION_RADIUS = 10;
const SWORDSMAN_COST_WOOD = 25;
const SWORDSMAN_COST_GOLD = 10;
function getSwordsmanTrainTime(): number {
  return currentMatchConfig.trainingTime;
}

const VILLAGER_COST_FOOD = 50;
const VILLAGER_TRAIN_TIME = 4.0; // 4 segundos por aldeão no Town Center

export interface TcProductionItem {
  id: string;
  unitType: 'VILLAGER';
  totalDuration: number;
}

export const tcTrainingQueue: TcProductionItem[] = [];
export let tcTrainingTimer = 0;

const buildingsList: ConstructionBuilding[] = [];
const buildingsGridMap = new Map<number, ConstructionBuilding>();

/**
 * Cria o modelo 3D do Quartel (Canteiro de Obras + Quartel Finalizado)
 */
function createBarracksModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
  trainingProgressGroup: THREE.Group;
  trainingProgressBarMesh: THREE.Mesh;
} {
  // 1. Canteiro de Obras (CONSTRUCTION_SITE)
  const siteGroup = new THREE.Group();

  // Fundação com "Saia de Pedra" estendida para baixo no relevo (evita cantos flutuando em colinas)
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 1.2, 1.94),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  // Piso de terra batida (compacted dirt foundation)
  const dirtGeo = new THREE.BoxGeometry(1.92, 0.08, 1.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  // 4 estacas de madeira nos cantos delimitando o quadrado
  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  const sOffsets = [-0.88, 0.88];
  for (const sx of sOffsets) {
    for (const sz of sOffsets) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  // Cordas / tábuas de andaime cruzadas no chão
  const plankGeo = new THREE.BoxGeometry(1.65, 0.04, 0.12);
  const plank1 = new THREE.Mesh(plankGeo, stakeMat);
  plank1.position.set(0, 0.1, -0.7);
  plank1.rotation.y = 0.08;
  siteGroup.add(plank1);
  const plank2 = new THREE.Mesh(plankGeo, stakeMat);
  plank2.position.set(-0.7, 0.1, 0);
  plank2.rotation.y = Math.PI / 2 + 0.05;
  siteGroup.add(plank2);

  // Pilha de pedras / tijolos no canteiro
  const stonePile = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, 0.22, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 })
  );
  stonePile.position.set(0.45, 0.15, 0.45);
  stonePile.rotation.y = 0.4;
  stonePile.castShadow = true;
  siteGroup.add(stonePile);

  // 2. Barra de Progresso 3D sobre a fundação
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.6, 0);
  progressGroup.rotation.y = Math.PI / 4; // voltada para câmera isométrica

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.04);
  const barBgMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
  const barBg = new THREE.Mesh(barBgGeo, barBgMat);
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.05);
  const barFillMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
  const progressBarMesh = new THREE.Mesh(barFillGeo, barFillMat);
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 3. Quartel Finalizado (BARRACKS)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const barracksStoneMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85 });
  const barracksWoodMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.75 });
  const barracksRoofMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.65, flatShading: true });

  // Base e paredes de alvenaria de pedra
  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const barracksSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.86, 1.2, 1.86),
    barracksStoneMat
  );
  barracksSkirt.position.y = -0.58;
  barracksSkirt.receiveShadow = true;
  finishedGroup.add(barracksSkirt);

  const stoneBase = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.65, 1.82), barracksStoneMat);
  stoneBase.position.y = 0.325;
  stoneBase.castShadow = true;
  stoneBase.receiveShadow = true;
  finishedGroup.add(stoneBase);

  // Paredes superiores de madeira
  const timberWalls = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.6, 1.68), barracksWoodMat);
  timberWalls.position.y = 0.95;
  timberWalls.castShadow = true;
  timberWalls.receiveShadow = true;
  finishedGroup.add(timberWalls);

  // Porta de carvalho reforçada voltada para frente (+Z)
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.7, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x271810, roughness: 0.9 })
  );
  door.position.set(0, 0.45, 0.88);
  finishedGroup.add(door);

  // Telhado inclinado clássico medieval (piramidal de 4 águas)
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.42, 0.9, 4), barracksRoofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 1.25 + 0.45;
  roof.castShadow = true;
  finishedGroup.add(roof);

  // Emblema no frontão: Escudo heraldico com espadas cruzadas
  const shield = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.36, 0.04),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, metalness: 0.2, roughness: 0.4 })
  );
  shield.position.set(0, 1.5, 0.88);
  finishedGroup.add(shield);

  // Borda dourada do escudo
  const shieldBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.3, 0.36, 0.04)),
    new THREE.LineBasicMaterial({ color: 0xfbbf24 })
  );
  shield.add(shieldBorder);

  // Espadas cruzadas atrás do escudo
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.8, roughness: 0.2 });
  const sword1 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.52, 6), bladeMat);
  sword1.rotation.z = Math.PI / 4;
  sword1.position.set(0, 1.5, 0.86);
  finishedGroup.add(sword1);

  const sword2 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.52, 6), bladeMat);
  sword2.rotation.z = -Math.PI / 4;
  sword2.position.set(0, 1.5, 0.86);
  finishedGroup.add(sword2);

  // Mastro com flâmula vermelha militar
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), barracksWoodMat);
  pole.position.set(-0.7, 1.9, -0.7);
  finishedGroup.add(pole);

  const pennant = new THREE.Mesh(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.15, 0),
      new THREE.Vector3(0.35, 0.07, 0),
      new THREE.Vector3(0, 0, 0)
    ]),
    new THREE.MeshBasicMaterial({ color: 0xdc2626, side: THREE.DoubleSide })
  );
  pennant.position.set(-0.7, 2.1, -0.7);
  finishedGroup.add(pennant);

  // 4. Anel / Marcador de Seleção do Edifício (visível ao selecionar o Quartel)
  const selPlaneGeo = new THREE.PlaneGeometry(2.1, 2.1);
  const selPlaneEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(selPlaneGeo),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
  );
  selPlaneEdges.rotation.x = -Math.PI / 2;
  selPlaneEdges.position.y = 0.02;
  const selectionMesh = new THREE.Mesh(
    selPlaneGeo,
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.015;
  selectionMesh.add(selPlaneEdges);
  selectionMesh.visible = false;

  // 5. Barra 3D de Progresso de Treinamento sobre o Quartel (visível durante produção)
  const trainingProgressGroup = new THREE.Group();
  trainingProgressGroup.position.set(0, 2.35, 0);
  trainingProgressGroup.visible = false;

  const tBarBgGeo = new THREE.BoxGeometry(1.3, 0.14, 0.04);
  const tBarBg = new THREE.Mesh(tBarBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  trainingProgressGroup.add(tBarBg);

  const tBarBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(tBarBgGeo),
    new THREE.LineBasicMaterial({ color: 0x38bdf8 })
  );
  tBarBg.add(tBarBorder);

  const tBarFillGeo = new THREE.BoxGeometry(1.26, 0.1, 0.05);
  const trainingProgressBarMesh = new THREE.Mesh(tBarFillGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
  trainingProgressBarMesh.position.x = -0.63;
  trainingProgressBarMesh.scale.x = 0.01;
  trainingProgressGroup.add(trainingProgressBarMesh);

  return {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  };
}

/**
 * Cria a fundação da construção e bloqueia as 4 células correspondentes no grid
 */
function createBarracksFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  } = createBarracksModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);
  group.add(trainingProgressGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia as 4 células do grid (walkable = false)
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `barracks_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'BARRACKS',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  };

  buildingsList.push(building);

  // Mapeia todas as 4 células ao objeto de construção
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

/**
 * Modelo 3D do Campo de Tiro com Arco (Archery Range) - 2x2 células
 * Estrutura rústica de madeira e pedra com telhado inclinado e 2 alvos circulares
 * coloridos (branco/vermelho/azul) no pátio de treinamento lateral.
 */
function createArcheryRangeModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
  trainingProgressGroup: THREE.Group;
  trainingProgressBarMesh: THREE.Mesh;
} {
  // 1. Canteiro de Obras (CONSTRUCTION_SITE)
  const siteGroup = new THREE.Group();

  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 1.2, 1.94),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const dirtGeo = new THREE.BoxGeometry(1.92, 0.08, 1.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  // 4 estacas nos cantos
  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  for (const sx of [-0.88, 0.88]) {
    for (const sz of [-0.88, 0.88]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  // Tábuas de madeira e esteios cruzados
  const plank = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.12), stakeMat);
  plank.position.set(-0.2, 0.1, -0.4);
  plank.rotation.y = 0.2;
  siteGroup.add(plank);

  const targetDummy = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 12), stakeMat);
  targetDummy.position.set(0.5, 0.2, 0.4);
  targetDummy.rotation.x = Math.PI / 2;
  siteGroup.add(targetDummy);

  // 2. Barra de Progresso 3D da Construção
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.65, 0);
  progressGroup.rotation.y = Math.PI / 4;

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.04);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  progressGroup.add(barBg);
  barBg.add(new THREE.LineSegments(new THREE.EdgesGeometry(barBgGeo), new THREE.LineBasicMaterial({ color: 0x475569 })));

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.05);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 3. Estrutura Finalizada (FINISHED)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85 });
  const woodWallMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.75 });
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.65, flatShading: true });
  const targetWoodMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.7 });

  // Saia de pedra no desnível
  const archerySkirt = new THREE.Mesh(new THREE.BoxGeometry(1.86, 1.2, 1.86), stoneMat);
  archerySkirt.position.y = -0.58;
  archerySkirt.receiveShadow = true;
  finishedGroup.add(archerySkirt);

  // Piso base de pedra e terra batida
  const stoneBase = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.12, 1.84), stoneMat);
  stoneBase.position.y = 0.06;
  stoneBase.receiveShadow = true;
  finishedGroup.add(stoneBase);

  // Cabana / Alojamento rústico no lado esquerdo (x: -0.42)
  const cabinWidth = 0.95;
  const cabinDepth = 1.68;
  const lowerWall = new THREE.Mesh(new THREE.BoxGeometry(cabinWidth, 0.55, cabinDepth), stoneMat);
  lowerWall.position.set(-0.42, 0.35, 0);
  lowerWall.castShadow = true;
  lowerWall.receiveShadow = true;
  finishedGroup.add(lowerWall);

  const upperWall = new THREE.Mesh(new THREE.BoxGeometry(cabinWidth - 0.04, 0.65, cabinDepth - 0.04), woodWallMat);
  upperWall.position.set(-0.42, 0.92, 0);
  upperWall.castShadow = true;
  upperWall.receiveShadow = true;
  finishedGroup.add(upperWall);

  // 4 Pilares de madeira grossa nos cantos da cabana
  for (const cz of [-0.78, 0.78]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 1.35, 8), darkWoodMat);
    post.position.set(-0.84, 0.72, cz);
    post.castShadow = true;
    finishedGroup.add(post);

    const postInner = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 1.35, 8), darkWoodMat);
    postInner.position.set(0.02, 0.72, cz);
    postInner.castShadow = true;
    finishedGroup.add(postInner);
  }

  // Telhado Inclinado de Madeira / Telhas (Pitched Shed Roof)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.09, 1.82), roofMat);
  roof.position.set(-0.38, 1.42, 0);
  roof.rotation.z = -0.22; // caimento suave para a esquerda
  roof.castShadow = true;
  finishedGroup.add(roof);

  // Beiral de reforço no topo do telhado
  const roofRidge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 1.84), darkWoodMat);
  roofRidge.position.set(0.18, 1.55, 0);
  finishedGroup.add(roofRidge);

  // Porta / Vão de entrada arqueado
  const doorHole = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.65, 0.45), new THREE.MeshBasicMaterial({ color: 0x111827 }));
  doorHole.position.set(0.06, 0.42, 0);
  finishedGroup.add(doorHole);

  // Prateleira de Arcos / Racks na parede lateral externa
  const rackPlank = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.75), darkWoodMat);
  rackPlank.position.set(-0.88, 0.75, 0);
  finishedGroup.add(rackPlank);

  // Barril de Flechas no pátio próximo à cabana
  const barrelGeo = new THREE.CylinderGeometry(0.12, 0.1, 0.36, 10);
  const barrel = new THREE.Mesh(barrelGeo, darkWoodMat);
  barrel.position.set(0.1, 0.24, 0.65);
  barrel.castShadow = true;
  finishedGroup.add(barrel);

  // Flechas saindo do barril
  const barrelFletchMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  for (let bIdx = 0; bIdx < 4; bIdx++) {
    const fShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.22, 4), targetWoodMat);
    fShaft.position.set(0.08 + (bIdx % 2) * 0.04 - 0.02, 0.46, 0.63 + Math.floor(bIdx / 2) * 0.04);
    fShaft.rotation.z = (bIdx - 1.5) * 0.15;
    finishedGroup.add(fShaft);

    const fFeather = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.01), barrelFletchMat);
    fFeather.position.copy(fShaft.position).setY(fShaft.position.y + 0.08);
    finishedGroup.add(fFeather);
  }

  // --- PÁTIO DE TREINAMENTO LATERAL (Target Practice Yard - Lado Direito x = +0.52) ---
  const sandStrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.02, 1.68),
    new THREE.MeshStandardMaterial({ color: 0x92613b, roughness: 0.95 })
  );
  sandStrip.position.set(0.52, 0.12, 0);
  sandStrip.receiveShadow = true;
  finishedGroup.add(sandStrip);

  // Função auxiliar para instanciar Alvo Circular Colorido (Branco / Azul / Vermelho) em cavalete
  function createTargetStand(zPos: number): THREE.Group {
    const tg = new THREE.Group();
    tg.position.set(0.52, 0.12, zPos);

    // Tripé / Cavalete de madeira (A-frame)
    const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.82, 6);
    const legL = new THREE.Mesh(legGeo, targetWoodMat);
    legL.position.set(-0.14, 0.38, -0.05);
    legL.rotation.z = 0.22;
    legL.rotation.x = -0.25;
    tg.add(legL);

    const legR = new THREE.Mesh(legGeo, targetWoodMat);
    legR.position.set(0.14, 0.38, -0.05);
    legR.rotation.z = -0.22;
    legR.rotation.x = -0.25;
    tg.add(legR);

    const legBack = new THREE.Mesh(legGeo, targetWoodMat);
    legBack.position.set(0, 0.38, 0.18);
    legBack.rotation.x = 0.36;
    tg.add(legBack);

    // Barra horizontal do cavalete
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.03), targetWoodMat);
    bar.position.set(0, 0.32, -0.02);
    tg.add(bar);

    // Alvo Circular: 3 anéis concêntricos (Branco exterior, Azul intermediário, Vermelho centro)
    const targetFace = new THREE.Group();
    targetFace.position.set(0, 0.52, -0.04);
    targetFace.rotation.x = -0.25; // levemente inclinado para cima

    // Base de palha/madeira do alvo
    const backing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, 0.04, 24),
      new THREE.MeshStandardMaterial({ color: 0xca8a04, roughness: 0.85 })
    );
    backing.rotation.x = Math.PI / 2;
    targetFace.add(backing);

    // 1. Círculo Externo Branco
    const ringWhite = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 0.045, 24),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 })
    );
    ringWhite.rotation.x = Math.PI / 2;
    targetFace.add(ringWhite);

    // 2. Círculo Intermediário Azul
    const ringBlue = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.5 })
    );
    ringBlue.rotation.x = Math.PI / 2;
    targetFace.add(ringBlue);

    // 3. Centro / Bullseye Vermelho
    const bullseye = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.055, 20),
      new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4 })
    );
    bullseye.rotation.x = Math.PI / 2;
    targetFace.add(bullseye);

    // Flecha cravada no alvo!
    const stuckArrow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.01, 0.26, 4),
      targetWoodMat
    );
    stuckArrow.position.set(0.02, 0.02, -0.12);
    stuckArrow.rotation.x = Math.PI / 2 + 0.1;
    stuckArrow.rotation.y = 0.08;
    targetFace.add(stuckArrow);

    const arrowFletch = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.06, 0.01),
      new THREE.MeshBasicMaterial({ color: 0xef4444 })
    );
    arrowFletch.position.set(0.02, 0.02, -0.24);
    arrowFletch.rotation.x = Math.PI / 2;
    targetFace.add(arrowFletch);

    tg.add(targetFace);
    return tg;
  }

  // 2 Alvos Circulares Coloridos no Pátio Lateral
  finishedGroup.add(createTargetStand(-0.42));
  finishedGroup.add(createTargetStand(0.42));

  // Estandarte militar verde no poste da cabana
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6), darkWoodMat);
  flagPole.position.set(-0.84, 1.8, -0.84);
  finishedGroup.add(flagPole);

  const pennantGeo = new THREE.BufferGeometry();
  pennantGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      0, 0, 0,
      0, -0.28, 0,
      0.35, -0.14, 0
    ], 3)
  );
  pennantGeo.computeVertexNormals();
  const pennant = new THREE.Mesh(
    pennantGeo,
    new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide })
  );
  pennant.position.set(-0.84, 2.45, -0.84);
  finishedGroup.add(pennant);

  // 4. Marcador de Seleção do Edifício
  const selPlaneGeo = new THREE.PlaneGeometry(2.1, 2.1);
  const selPlaneEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(selPlaneGeo),
    new THREE.LineBasicMaterial({ color: 0x34d399, linewidth: 2 })
  );
  selPlaneEdges.rotation.x = -Math.PI / 2;
  selPlaneEdges.position.y = 0.02;
  const selectionMesh = new THREE.Mesh(
    selPlaneGeo,
    new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.015;
  selectionMesh.add(selPlaneEdges);
  selectionMesh.visible = false;

  // 5. Barra 3D de Progresso de Treinamento sobre o Campo de Tiro com Arco
  const trainingProgressGroup = new THREE.Group();
  trainingProgressGroup.position.set(0, 2.4, 0);
  trainingProgressGroup.visible = false;

  const tBarBgGeo = new THREE.BoxGeometry(1.3, 0.14, 0.04);
  const tBarBg = new THREE.Mesh(tBarBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  trainingProgressGroup.add(tBarBg);

  const tBarBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(tBarBgGeo),
    new THREE.LineBasicMaterial({ color: 0x34d399 })
  );
  tBarBg.add(tBarBorder);

  const tBarFillGeo = new THREE.BoxGeometry(1.26, 0.1, 0.05);
  const trainingProgressBarMesh = new THREE.Mesh(tBarFillGeo, new THREE.MeshBasicMaterial({ color: 0x34d399 }));
  trainingProgressBarMesh.position.x = -0.63;
  trainingProgressBarMesh.scale.x = 0.01;
  trainingProgressGroup.add(trainingProgressBarMesh);

  return {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  };
}

export function createArcheryRangeMesh(): THREE.Group {
  return createArcheryRangeModel().finishedGroup;
}

function createArcheryRangeFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  } = createArcheryRangeModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);
  group.add(trainingProgressGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia as 4 células do grid (walkable = false)
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `archery_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'ARCHERY_RANGE',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup,
    trainingProgressBarMesh
  };

  buildingsList.push(building);

  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

/**
 * Cria o modelo 3D da Torre de Vigia (Canteiro 1x1 + Torre Finalizada)
 */
function createTowerModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  const siteGroup = new THREE.Group();
  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(0.94, 1.2, 0.94),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  // Fundação de terra/pedra batida (0.92 x 0.08 x 0.92)
  const dirtGeo = new THREE.BoxGeometry(0.92, 0.08, 0.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  siteGroup.add(dirtMesh);

  // 4 estacas/postes de andaime nos cantos
  const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 });
  const corners = [
    [-0.38, -0.38],
    [0.38, -0.38],
    [-0.38, 0.38],
    [0.38, 0.38]
  ];
  corners.forEach(([cx, cz]) => {
    const post = new THREE.Mesh(postGeo, woodMat);
    post.position.set(cx, 0.7, cz);
    post.castShadow = true;
    siteGroup.add(post);
  });

  const beamGeo = new THREE.BoxGeometry(0.8, 0.04, 0.04);
  const b1 = new THREE.Mesh(beamGeo, woodMat);
  b1.position.set(0, 0.85, 0.38);
  siteGroup.add(b1);
  const b2 = new THREE.Mesh(beamGeo, woodMat);
  b2.position.set(0, 0.85, -0.38);
  siteGroup.add(b2);

  // 2. Modelo Finalizado da Torre de Vigia (Stone Watch Tower)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const masonryMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9, flatShading: true });

  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const towerSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(0.86, 1.2, 0.86),
    masonryMat
  );
  towerSkirt.position.y = -0.58;
  towerSkirt.receiveShadow = true;
  finishedGroup.add(towerSkirt);

  // Base reforçada de alvenaria
  const basePlinthGeo = new THREE.BoxGeometry(0.82, 0.35, 0.82);
  const basePlinth = new THREE.Mesh(basePlinthGeo, masonryMat);
  basePlinth.position.y = 0.175;
  basePlinth.castShadow = true;
  basePlinth.receiveShadow = true;
  finishedGroup.add(basePlinth);

  // Corpo principal da torre (shaft de pedra cinza-ardósia)
  const shaftGeo = new THREE.BoxGeometry(0.72, 1.6, 0.72);
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85, flatShading: true });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.y = 1.15;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  finishedGroup.add(shaft);

  // Frestas para flechas (arrow slits)
  const slitGeo = new THREE.BoxGeometry(0.06, 0.28, 0.74);
  const slitMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
  const slit1 = new THREE.Mesh(slitGeo, slitMat);
  slit1.position.y = 1.25;
  finishedGroup.add(slit1);

  // Plataforma de observação em madeira
  const deckGeo = new THREE.BoxGeometry(0.96, 0.14, 0.96);
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = 2.02;
  deck.castShadow = true;
  finishedGroup.add(deck);

  // Parapeitos/corrimãos nos 4 cantos
  const crenGeo = new THREE.BoxGeometry(0.12, 0.32, 0.12);
  corners.forEach(([cx, cz]) => {
    const cren = new THREE.Mesh(crenGeo, deckMat);
    cren.position.set(cx * 1.05, 2.22, cz * 1.05);
    cren.castShadow = true;
    finishedGroup.add(cren);
  });

  // Telhado piramidal
  const roofGeo = new THREE.ConeGeometry(0.72, 0.55, 4);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.75 });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.48;
  roof.castShadow = true;
  finishedGroup.add(roof);

  // Mastro e bandeira azul
  const poleGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.45, 6);
  const pole = new THREE.Mesh(poleGeo, woodMat);
  pole.position.y = 2.85;
  finishedGroup.add(pole);

  const flagGeo = new THREE.BufferGeometry();
  const flagVertices = new Float32Array([
    0, 2.98, 0,
    0.22, 2.90, 0,
    0, 2.82, 0
  ]);
  flagGeo.setAttribute('position', new THREE.BufferAttribute(flagVertices, 3));
  flagGeo.computeVertexNormals();
  const flagMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, side: THREE.DoubleSide });
  const flag = new THREE.Mesh(flagGeo, flagMat);
  finishedGroup.add(flag);

  // Anel de seleção
  const selectionGeo = new THREE.RingGeometry(0.62, 0.72, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  // Barra de progresso 3D suspensa
  const progressGroup = new THREE.Group();
  progressGroup.position.y = 2.15;

  const barBgGeo = new THREE.BoxGeometry(0.9, 0.12, 0.06);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x22c55e })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(0.86, 0.08, 0.07);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.43;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh };
}

/**
 * Cria a fundação da Torre de Vigia e bloqueia a célula 1x1 correspondente no grid
 */
function createTowerFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 1);
  const worldCenter = new THREE.Vector3(gridX + 0.5, elevation, gridZ + 0.5);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createTowerModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 1 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);
  setCellWalkable(gridX, gridZ, false);

  const building: ConstructionBuilding = {
    id: `tower_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'TOWER',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 1,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0
  };

  buildingsList.push(building);
  buildingsGridMap.set(cellKey(gridX, gridZ), building);

  return building;
}

/**
 * Cria o modelo 3D da Madeireira (Lumber Camp)
 * Visual: cabana de troncos com pilhas de toras serradas nas laterais, serrote e machado decorativo fincado no cepo
 */
function createLumberCampModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  // 1. Canteiro de Obras (CONSTRUCTION_SITE)
  const siteGroup = new THREE.Group();

  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 1.2, 1.94),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const dirtGeo = new THREE.BoxGeometry(1.92, 0.08, 1.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  const sOffsets = [-0.88, 0.88];
  for (const sx of sOffsets) {
    for (const sz of sOffsets) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  // Tábuas e toras soltas no canteiro
  const plankGeo = new THREE.BoxGeometry(1.5, 0.05, 0.15);
  const plank = new THREE.Mesh(plankGeo, stakeMat);
  plank.position.set(-0.2, 0.1, 0.3);
  plank.rotation.y = 0.25;
  siteGroup.add(plank);

  const siteLog = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 8), stakeMat);
  siteLog.rotation.z = Math.PI / 2;
  siteLog.position.set(0.3, 0.12, -0.4);
  siteGroup.add(siteLog);

  // 2. Barra de Progresso 3D
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.6, 0);
  progressGroup.rotation.y = Math.PI / 4;

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.04);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.05);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 3. Madeireira Finalizada (LUMBER_CAMP)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const woodDeckMat = new THREE.MeshStandardMaterial({ color: 0x5c3214, roughness: 0.9 });
  const logWallsMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.82 });
  const logCutMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.75 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9a3412, roughness: 0.68, flatShading: true });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.75 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 });
  const sawdustMat = new THREE.MeshStandardMaterial({ color: 0xfde047, roughness: 0.95 });

  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const lumberSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.90, 1.2, 1.90),
    stoneMat
  );
  lumberSkirt.position.y = -0.58;
  lumberSkirt.receiveShadow = true;
  finishedGroup.add(lumberSkirt);

  // Base de toras batidas / deque
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.08, 1.88), woodDeckMat);
  deck.position.y = 0.04;
  deck.receiveShadow = true;
  finishedGroup.add(deck);

  // Cabana de troncos (deslocada para o fundo-esquerda)
  const cabinGroup = new THREE.Group();
  cabinGroup.position.set(-0.24, 0, -0.22);

  // Bloco principal de paredes da cabana
  const cabinBody = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.76, 1.05), logWallsMat);
  cabinBody.position.y = 0.42;
  cabinBody.castShadow = true;
  cabinBody.receiveShadow = true;
  cabinGroup.add(cabinBody);

  // Troncos decorativos nas pontas simulando encaixe clássico de log cabin
  const cornerLogGeo = new THREE.CylinderGeometry(0.065, 0.065, 1.28, 8);
  for (let y = 0.15; y <= 0.72; y += 0.28) {
    const clX = new THREE.Mesh(cornerLogGeo, logWallsMat);
    clX.rotation.z = Math.PI / 2;
    clX.position.set(0, y, -0.5);
    cabinGroup.add(clX);

    const clZ = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1.15, 8), logWallsMat);
    clZ.rotation.x = Math.PI / 2;
    clZ.position.set(-0.57, y + 0.14, 0);
    cabinGroup.add(clZ);
  }

  // Telhado de duas águas (Gabled roof)
  const roofLeft = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.06, 1.2), roofMat);
  roofLeft.rotation.z = 0.58;
  roofLeft.position.set(-0.28, 0.98, 0);
  roofLeft.castShadow = true;
  cabinGroup.add(roofLeft);

  const roofRight = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.06, 1.2), roofMat);
  roofRight.rotation.z = -0.58;
  roofRight.position.set(0.28, 0.98, 0);
  roofRight.castShadow = true;
  cabinGroup.add(roofRight);

  // Cumeeira central
  const roofRidge = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 1.24), logWallsMat);
  roofRidge.position.set(0, 1.18, 0);
  cabinGroup.add(roofRidge);

  // Chaminé rústica de pedra
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.45, 0.2), stoneMat);
  chimney.position.set(-0.35, 1.05, -0.3);
  chimney.castShadow = true;
  cabinGroup.add(chimney);

  // Porta da cabana
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.45, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.85 })
  );
  door.position.set(0, 0.26, 0.53);
  cabinGroup.add(door);

  finishedGroup.add(cabinGroup);

  // Pilhas de toras serradas nas laterais (Pirâmide de toras 3-2-1)
  const logPileGroup = new THREE.Group();
  logPileGroup.position.set(0.55, 0, -0.15);

  const logLength = 0.82;
  const logRadius = 0.09;
  const logGeo = new THREE.CylinderGeometry(logRadius, logRadius, logLength, 10);
  const logCapGeo = new THREE.CircleGeometry(logRadius * 0.95, 10);

  // Camada 1: 3 toras na base
  const tier1Positions = [
    { x: -0.18, y: logRadius + 0.04 },
    { x: 0,     y: logRadius + 0.04 },
    { x: 0.18,  y: logRadius + 0.04 }
  ];
  // Camada 2: 2 toras no meio
  const tier2Positions = [
    { x: -0.09, y: logRadius * 2.6 + 0.04 },
    { x: 0.09,  y: logRadius * 2.6 + 0.04 }
  ];
  // Camada 3: 1 tora no topo
  const tier3Positions = [
    { x: 0,     y: logRadius * 4.2 + 0.04 }
  ];

  const allLogs = [...tier1Positions, ...tier2Positions, ...tier3Positions];
  for (const lp of allLogs) {
    const lg = new THREE.Mesh(logGeo, logWallsMat);
    lg.rotation.x = Math.PI / 2;
    lg.position.set(lp.x, lp.y, 0);
    lg.castShadow = true;
    logPileGroup.add(lg);

    // Tampas claras das pontas das toras com anéis de madeira
    const capFront = new THREE.Mesh(logCapGeo, logCutMat);
    capFront.position.set(lp.x, lp.y, logLength / 2 + 0.005);
    logPileGroup.add(capFront);

    const capBack = new THREE.Mesh(logCapGeo, logCutMat);
    capBack.rotation.y = Math.PI;
    capBack.position.set(lp.x, lp.y, -logLength / 2 - 0.005);
    logPileGroup.add(capBack);
  }
  finishedGroup.add(logPileGroup);

  // Cepo de corte (chopping block) com machado fincado
  const stumpGroup = new THREE.Group();
  stumpGroup.position.set(0.42, 0, 0.55);

  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.32, 12), logWallsMat);
  stump.position.y = 0.16;
  stump.castShadow = true;
  stumpGroup.add(stump);

  const stumpCap = new THREE.Mesh(new THREE.CircleGeometry(0.17, 12), logCutMat);
  stumpCap.rotation.x = -Math.PI / 2;
  stumpCap.position.y = 0.321;
  stumpGroup.add(stumpCap);

  // Machado cravado no cepo
  const axeGroup = new THREE.Group();
  axeGroup.position.set(0.02, 0.32, 0);
  axeGroup.rotation.z = -0.35; // inclinado

  // Cabo do machado
  const axeHandle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.02, 0.38, 8),
    new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.75 })
  );
  axeHandle.position.y = 0.18;
  axeHandle.castShadow = true;
  axeGroup.add(axeHandle);

  // Lâmina de ferro do machado
  const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.13), ironMat);
  axeHead.position.set(0, 0.32, 0.04);
  axeHead.castShadow = true;
  axeGroup.add(axeHead);

  stumpGroup.add(axeGroup);
  finishedGroup.add(stumpGroup);

  // Serrote de traçador (Two-man crosscut saw) apoiado no cavalete
  const sawGroup = new THREE.Group();
  sawGroup.position.set(-0.25, 0, 0.62);

  // Cavalete de madeira em X
  const sawhorseLegMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
  const legGeo = new THREE.BoxGeometry(0.04, 0.38, 0.04);
  const leg1 = new THREE.Mesh(legGeo, sawhorseLegMat);
  leg1.rotation.z = 0.38;
  leg1.position.set(-0.06, 0.18, 0);
  sawGroup.add(leg1);

  const leg2 = new THREE.Mesh(legGeo, sawhorseLegMat);
  leg2.rotation.z = -0.38;
  leg2.position.set(0.06, 0.18, 0);
  sawGroup.add(leg2);

  const sawhorseBar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.45), sawhorseLegMat);
  sawhorseBar.position.set(0, 0.3, 0);
  sawGroup.add(sawhorseBar);

  // Lâmina longa de ferro do serrote inclinada
  const sawBlade = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.07, 0.015), ironMat);
  sawBlade.rotation.set(0.12, 0.25, -0.45);
  sawBlade.position.set(0.05, 0.22, 0.04);
  sawBlade.castShadow = true;
  sawGroup.add(sawBlade);

  // Cabos de madeira nas pontas do serrote
  const sawHandle1 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 6), sawhorseLegMat);
  sawHandle1.position.set(-0.22, 0.35, 0.05);
  sawGroup.add(sawHandle1);

  const sawHandle2 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 6), sawhorseLegMat);
  sawHandle2.position.set(0.32, 0.1, 0.03);
  sawGroup.add(sawHandle2);

  finishedGroup.add(sawGroup);

  // Montículos de serragem dourada no chão
  const dust1 = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.07, 8), sawdustMat);
  dust1.position.set(0.38, 0.05, 0.4);
  finishedGroup.add(dust1);

  const dust2 = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.05, 8), sawdustMat);
  dust2.position.set(-0.25, 0.05, 0.48);
  finishedGroup.add(dust2);

  // 4. Mesh de Seleção (2x2)
  const selGeo = new THREE.PlaneGeometry(1.95, 1.95);
  const selEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(selGeo),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
  );
  selEdges.rotation.x = -Math.PI / 2;
  selEdges.position.y = 0.02;
  const selectionMesh = new THREE.Mesh(
    selGeo,
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.015;
  selectionMesh.add(selEdges);
  selectionMesh.visible = false;

  return {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  };
}

/**
 * Cria a fundação da Madeireira e bloqueia as 4 células 2x2 correspondentes
 */
function createLumberCampFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createLumberCampModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia as 4 células do grid
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `lumber_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'LUMBER_CAMP',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

/**
 * Cria o modelo 3D do Campo de Mineração (Mining Camp)
 * Visual: galpão aberto com estrutura de vigas rústicas, carrinho de mão de madeira e pilhas de pedregulhos
 */
function createMiningCampModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  // 1. Canteiro de Obras (CONSTRUCTION_SITE)
  const siteGroup = new THREE.Group();

  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 1.2, 1.94),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const gravelGeo = new THREE.BoxGeometry(1.92, 0.08, 1.92);
  const gravelMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
  const gravelMesh = new THREE.Mesh(gravelGeo, gravelMat);
  gravelMesh.position.y = 0.04;
  gravelMesh.receiveShadow = true;
  siteGroup.add(gravelMesh);

  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  const sOffsets = [-0.88, 0.88];
  for (const sx of sOffsets) {
    for (const sz of sOffsets) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  // Pilha de pedregulhos no canteiro
  const stoneCluster = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.28, 0),
    new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9, flatShading: true })
  );
  stoneCluster.position.set(0.35, 0.18, 0.35);
  stoneCluster.castShadow = true;
  siteGroup.add(stoneCluster);

  // 2. Barra de Progresso 3D
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.6, 0);
  progressGroup.rotation.y = Math.PI / 4;

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.04);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.05);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 3. Campo de Mineração Finalizado (MINING_CAMP)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 });
  const timberMat = new THREE.MeshStandardMaterial({ color: 0x713f12, roughness: 0.85 });
  const awningMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.75, flatShading: true });
  const stoneMat1 = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9, flatShading: true });
  const stoneMat2 = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.88, flatShading: true });
  const stoneMat3 = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.85, flatShading: true });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.7 });

  // Fundação com "Saia de Pedra" estendida para baixo no relevo
  const miningSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.90, 1.2, 1.90),
    floorMat
  );
  miningSkirt.position.y = -0.58;
  miningSkirt.receiveShadow = true;
  finishedGroup.add(miningSkirt);

  // Piso de brita e cascalho escuro batido
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.08, 1.88), floorMat);
  floor.position.y = 0.04;
  floor.receiveShadow = true;
  finishedGroup.add(floor);

  // Galpão aberto rústico (Open-air timber post shed)
  const shedGroup = new THREE.Group();
  shedGroup.position.set(-0.25, 0, -0.2);

  // 4 pilares/vigas mestras verticais de tronco
  const postGeo = new THREE.CylinderGeometry(0.065, 0.075, 1.15, 8);
  const postCoords = [
    { x: -0.5, z: -0.45 },
    { x: 0.5,  z: -0.45 },
    { x: -0.5, z: 0.45 },
    { x: 0.5,  z: 0.45 }
  ];
  for (const pc of postCoords) {
    const post = new THREE.Mesh(postGeo, timberMat);
    post.position.set(pc.x, 0.58, pc.z);
    post.castShadow = true;
    shedGroup.add(post);
  }

  // Vigas horizontais de amarração superior
  const beamXGeo = new THREE.BoxGeometry(1.15, 0.08, 0.08);
  const beamFront = new THREE.Mesh(beamXGeo, timberMat);
  beamFront.position.set(0, 1.12, 0.45);
  beamFront.castShadow = true;
  shedGroup.add(beamFront);

  const beamBack = new THREE.Mesh(beamXGeo, timberMat);
  beamBack.position.set(0, 1.18, -0.45);
  beamBack.castShadow = true;
  shedGroup.add(beamBack);

  const beamZGeo = new THREE.BoxGeometry(0.08, 0.08, 0.98);
  const beamLeft = new THREE.Mesh(beamZGeo, timberMat);
  beamLeft.position.set(-0.5, 1.15, 0);
  shedGroup.add(beamLeft);

  const beamRight = new THREE.Mesh(beamZGeo, timberMat);
  beamRight.position.set(0.5, 1.15, 0);
  shedGroup.add(beamRight);

  // Telhado rústico inclinado / toldo de tábuas de madeira
  const awning = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.05, 1.15), awningMat);
  awning.rotation.x = -0.12; // inclinado escoando para trás
  awning.position.set(0, 1.22, 0);
  awning.castShadow = true;
  shedGroup.add(awning);

  // Bancada de triagem de minério sob o galpão
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.35), timberMat);
  bench.position.set(0, 0.22, -0.2);
  bench.castShadow = true;
  shedGroup.add(bench);

  finishedGroup.add(shedGroup);

  // Carrinho de mão de madeira (Handcart / Wheelbarrow) com minério
  const cartGroup = new THREE.Group();
  cartGroup.position.set(0.48, 0, 0.42);
  cartGroup.rotation.y = -Math.PI / 4 + 0.2;

  // Caixa de carga do carrinho
  const cartBox = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.32), timberMat);
  cartBox.position.set(0, 0.22, 0);
  cartBox.rotation.x = 0.08;
  cartBox.castShadow = true;
  cartGroup.add(cartBox);

  // Roda de madeira frontal
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 12), timberMat);
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(0, 0.12, 0.24);
  wheel.castShadow = true;
  cartGroup.add(wheel);

  // Braços / cabos de empurrar
  const handleGeo = new THREE.BoxGeometry(0.035, 0.035, 0.48);
  const handleL = new THREE.Mesh(handleGeo, timberMat);
  handleL.position.set(-0.14, 0.22, -0.22);
  handleL.rotation.x = 0.18;
  cartGroup.add(handleL);

  const handleR = new THREE.Mesh(handleGeo, timberMat);
  handleR.position.set(0.14, 0.22, -0.22);
  handleR.rotation.x = 0.18;
  cartGroup.add(handleR);

  // Pedaços de rocha dentro do carrinho
  const cartOre1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09, 0), stoneMat1);
  cartOre1.position.set(-0.06, 0.34, -0.02);
  cartGroup.add(cartOre1);

  const cartOre2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08, 0), stoneMat3);
  cartOre2.position.set(0.07, 0.33, 0.04);
  cartGroup.add(cartOre2);

  finishedGroup.add(cartGroup);

  // Pilhas de pedregulhos e rochas extraídas (pilhas ao lado do galpão)
  const rockPileGroup = new THREE.Group();
  rockPileGroup.position.set(0.52, 0, -0.32);

  const rockConfigs = [
    { x: -0.15, y: 0.18, z: -0.12, r: 0.22, mat: stoneMat1 },
    { x: 0.14,  y: 0.16, z: -0.08, r: 0.2,  mat: stoneMat2 },
    { x: 0,     y: 0.19, z: 0.15,  r: 0.24, mat: stoneMat3 },
    { x: -0.05, y: 0.32, z: 0.02,  r: 0.16, mat: stoneMat1 },
    { x: 0.12,  y: 0.28, z: 0.08,  r: 0.14, mat: stoneMat2 },
    { x: 0.25,  y: 0.1,  z: 0.22,  r: 0.12, mat: stoneMat3 },
    { x: -0.26, y: 0.09, z: 0.18,  r: 0.13, mat: stoneMat2 }
  ];

  for (const rc of rockConfigs) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rc.r, 0), rc.mat);
    rock.position.set(rc.x, rc.y, rc.z);
    rock.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    rock.castShadow = true;
    rockPileGroup.add(rock);
  }
  finishedGroup.add(rockPileGroup);

  // Picaretas decorativas encostadas no pilar de madeira
  const pickaxeGroup = new THREE.Group();
  pickaxeGroup.position.set(-0.25, 0, 0.38);

  const pickHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.52, 8), timberMat);
  pickHandle.position.set(0, 0.25, 0);
  pickHandle.rotation.set(0.25, 0, 0.18);
  pickHandle.castShadow = true;
  pickaxeGroup.add(pickHandle);

  const pickHead = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.24, 6), ironMat);
  pickHead.rotation.x = Math.PI / 2;
  pickHead.position.set(0.05, 0.44, 0.07);
  pickHead.castShadow = true;
  pickaxeGroup.add(pickHead);

  finishedGroup.add(pickaxeGroup);

  // Balde de madeira com cascalho
  const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.09, 0.18, 8), timberMat);
  bucket.position.set(-0.62, 0.12, 0.42);
  bucket.castShadow = true;
  finishedGroup.add(bucket);

  // 4. Mesh de Seleção (2x2)
  const selGeo = new THREE.PlaneGeometry(1.95, 1.95);
  const selEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(selGeo),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
  );
  selEdges.rotation.x = -Math.PI / 2;
  selEdges.position.y = 0.02;
  const selectionMesh = new THREE.Mesh(
    selGeo,
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.015;
  selectionMesh.add(selEdges);
  selectionMesh.visible = false;

  return {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  };
}

/**
 * Cria a fundação do Campo de Mineração e bloqueia as 4 células 2x2 correspondentes
 */
function createMiningCampFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createMiningCampModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia as 4 células do grid
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `mining_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'MINING_CAMP',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

/**
 * Cria o modelo 3D da Casa / Habitação (House - 1x1)
 * Visual: chalé rústico com chaminé de pedra, telhado inclinado de telhas/palha, vigas enxaimel e janelas acolhedoras
 */
function createHouseModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  // 1. Canteiro de Obras (CONSTRUCTION_SITE)
  const siteGroup = new THREE.Group();

  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(0.86, 1.2, 0.86),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const gravelGeo = new THREE.BoxGeometry(0.88, 0.08, 0.88);
  const gravelMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
  const gravelMesh = new THREE.Mesh(gravelGeo, gravelMat);
  gravelMesh.position.y = 0.04;
  gravelMesh.receiveShadow = true;
  siteGroup.add(gravelMesh);

  // 4 estacas nos cantos
  const stakeGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.5, 6);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  const sOffsets = [-0.38, 0.38];
  for (const sx of sOffsets) {
    for (const sz of sOffsets) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.25, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  // Pilha de tábuas de madeira na obra
  const plankGeo = new THREE.BoxGeometry(0.35, 0.06, 0.18);
  const plankMat = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.8 });
  const planks = new THREE.Mesh(plankGeo, plankMat);
  planks.position.set(0.15, 0.1, 0.15);
  planks.rotation.y = 0.25;
  planks.castShadow = true;
  siteGroup.add(planks);

  // 2. Barra de Progresso 3D
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.35, 0);
  progressGroup.rotation.y = Math.PI / 4;

  const barBgGeo = new THREE.BoxGeometry(0.9, 0.1, 0.03);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  progressGroup.add(barBg);

  const progressBarGeo = new THREE.BoxGeometry(0.86, 0.07, 0.04);
  const progressBarMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
  const progressBarMesh = new THREE.Mesh(progressBarGeo, progressBarMat);
  progressBarMesh.scale.x = 0.01;
  progressBarMesh.position.x = -0.43;
  progressGroup.add(progressBarMesh);

  // 3. Modelo Finalizado da Casa (Rustic House / Chalet)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const woodTimberMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.85 });
  const wallPlasterMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.9 });
  const roofTerracottaMat = new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.8, flatShading: true });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9, flatShading: true });
  const windowGlowMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfef08a, emissiveIntensity: 0.65, roughness: 0.3 });

  // Saia estendida para relevo
  const houseSkirt = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.2, 0.86), stoneMat);
  houseSkirt.position.y = -0.58;
  houseSkirt.receiveShadow = true;
  finishedGroup.add(houseSkirt);

  // Plinto / Fundação de pedra
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.16, 0.84), stoneMat);
  plinth.position.y = 0.08;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  finishedGroup.add(plinth);

  // Corpo das paredes do chalé (reboco rústico claro)
  const walls = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.58, 0.74), wallPlasterMat);
  walls.position.y = 0.37;
  walls.castShadow = true;
  walls.receiveShadow = true;
  finishedGroup.add(walls);

  // Vigas de madeira nos 4 cantos (estilo enxaimel)
  const postGeo = new THREE.BoxGeometry(0.06, 0.58, 0.06);
  for (const px of [-0.34, 0.34]) {
    for (const pz of [-0.34, 0.34]) {
      const post = new THREE.Mesh(postGeo, woodTimberMat);
      post.position.set(px, 0.37, pz);
      post.castShadow = true;
      finishedGroup.add(post);
    }
  }

  // Viga horizontal de amarração
  const beamFront = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.04, 0.05), woodTimberMat);
  beamFront.position.set(0, 0.37, 0.36);
  finishedGroup.add(beamFront);

  // Porta rústica de tábuas de madeira
  const doorGeo = new THREE.BoxGeometry(0.22, 0.42, 0.04);
  const door = new THREE.Mesh(doorGeo, woodTimberMat);
  door.position.set(0, 0.29, 0.375);
  door.castShadow = true;
  finishedGroup.add(door);

  // Maçaneta de ferro da porta
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8 }));
  knob.position.set(0.07, 0.28, 0.40);
  finishedGroup.add(knob);

  // Janela acolhedora iluminada (fachada frontal)
  const winGeo = new THREE.BoxGeometry(0.14, 0.14, 0.03);
  const winFront = new THREE.Mesh(winGeo, windowGlowMat);
  winFront.position.set(-0.22, 0.42, 0.375);
  finishedGroup.add(winFront);

  // Moldura da janela frontal
  const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.02), woodTimberMat);
  winFrame.position.set(-0.22, 0.42, 0.365);
  finishedGroup.add(winFrame);

  // Janela lateral esquerda
  const winSide = new THREE.Mesh(winGeo, windowGlowMat);
  winSide.rotation.y = Math.PI / 2;
  winSide.position.set(-0.375, 0.42, 0);
  finishedGroup.add(winSide);

  // Beiral do telhado
  const eaveGeo = new THREE.BoxGeometry(0.88, 0.06, 0.88);
  const eave = new THREE.Mesh(eaveGeo, woodTimberMat);
  eave.position.y = 0.67;
  eave.castShadow = true;
  finishedGroup.add(eave);

  // Telhado chalé (peaked/gable roof inclinado em 45 graus)
  const roofGeo = new THREE.ConeGeometry(0.66, 0.52, 4);
  const roof = new THREE.Mesh(roofGeo, roofTerracottaMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.94;
  roof.castShadow = true;
  finishedGroup.add(roof);

  // Cumeeira de acabamento
  const ridgeGeo = new THREE.BoxGeometry(0.06, 0.06, 0.92);
  const ridge = new THREE.Mesh(ridgeGeo, woodTimberMat);
  ridge.position.set(0, 1.18, 0);
  finishedGroup.add(ridge);

  // Chaminé de pedra
  const chimneyGroup = new THREE.Group();
  chimneyGroup.position.set(0.25, 0.62, -0.18);

  const chimneyShaft = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.76, 0.14), stoneMat);
  chimneyShaft.position.y = 0.38;
  chimneyShaft.castShadow = true;
  chimneyGroup.add(chimneyShaft);

  const chimneyCap = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.18), new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9 }));
  chimneyCap.position.y = 0.77;
  chimneyGroup.add(chimneyCap);

  // Penacho de fumaça sutil estilizado
  const smokeMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.45 });
  const puff1 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), smokeMat);
  puff1.position.set(0, 0.83, 0);
  chimneyGroup.add(puff1);

  const puff2 = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), smokeMat);
  puff2.position.set(0.02, 0.91, -0.01);
  chimneyGroup.add(puff2);

  finishedGroup.add(chimneyGroup);

  // Pilha de lenha para a lareira encostada na parede lateral direita
  const woodpileMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
  const logSmallGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.28, 6);
  for (const ly of [0.06, 0.12]) {
    for (const lz of [-0.08, 0.08]) {
      const logPiece = new THREE.Mesh(logSmallGeo, woodpileMat);
      logPiece.rotation.z = Math.PI / 2;
      logPiece.position.set(0.38, ly, lz);
      logPiece.castShadow = true;
      finishedGroup.add(logPiece);
    }
  }

  // Barrilzinho rústico de carvalho perto da porta
  const barrelGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.18, 8);
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 });
  const barrel = new THREE.Mesh(barrelGeo, barrelMat);
  barrel.position.set(0.24, 0.14, 0.38);
  barrel.castShadow = true;
  finishedGroup.add(barrel);

  // Anel de seleção (1x1)
  const selectionGeo = new THREE.RingGeometry(0.62, 0.72, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh };
}

function createHouseFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 1);
  const worldCenter = new THREE.Vector3(gridX + 0.5, elevation, gridZ + 0.5);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createHouseModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 1 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia 1 célula no grid
  setCellWalkable(gridX, gridZ, false);

  const building: ConstructionBuilding = {
    id: `house_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'HOUSE',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 1,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0
  };

  buildingsList.push(building);
  buildingsGridMap.set(cellKey(gridX, gridZ), building);

  return building;
}

/**
 * Cria o modelo 3D do Moinho (Mill) - Edifício 2x2
 * Visual: Torre rústica com base de pedra, corpo em tábuas de madeira, telhado inclinado e hélices rotativas de moinho com velas de lona.
 * Inclui sacos de farinha e barris na varanda frontal para enfatizar o papel de depósito de alimentos.
 */
function createMillModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
  windmillBlades: THREE.Group;
} {
  const siteGroup = new THREE.Group();

  // Saia de pedra para relevos irregulares
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.94, 1.2, 1.94),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.58;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const dirtMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.92, 0.08, 1.92),
    new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 })
  );
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  // Estacas de obra
  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  for (const sx of [-0.88, 0.88]) {
    for (const sz of [-0.88, 0.88]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      siteGroup.add(stake);
    }
  }

  // 2. Edifício Concluído (FINISHED)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const finishedSkirt = siteSkirt.clone();
  finishedGroup.add(finishedSkirt);

  // Materiais refinados
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 });
  const woodTimberMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const woodWallMat = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.88 });
  const sailClothMat = new THREE.MeshStandardMaterial({ color: 0xfef9c3, roughness: 0.9, side: THREE.DoubleSide });
  const sackMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.95 });

  // Base térrea em cantaria de pedra (1.7 x 0.65 x 1.7)
  const lowerBase = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.65, 1.7), stoneMat);
  lowerBase.position.y = 0.325;
  lowerBase.castShadow = true;
  lowerBase.receiveShadow = true;
  finishedGroup.add(lowerBase);

  // Faixa de madeira separadora de pavimentos
  const floorTrim = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.08, 1.76), woodTimberMat);
  floorTrim.position.y = 0.66;
  floorTrim.castShadow = true;
  finishedGroup.add(floorTrim);

  // Torre superior de madeira (1.38 x 1.1 x 1.38)
  const upperTower = new THREE.Mesh(new THREE.BoxGeometry(1.38, 1.1, 1.38), woodWallMat);
  upperTower.position.y = 1.25;
  upperTower.castShadow = true;
  finishedGroup.add(upperTower);

  // Vigas verticais nos 4 cantos da torre superior
  const pillarGeo = new THREE.BoxGeometry(0.1, 1.1, 0.1);
  for (const px of [-0.67, 0.67]) {
    for (const pz of [-0.67, 0.67]) {
      const pillar = new THREE.Mesh(pillarGeo, woodTimberMat);
      pillar.position.set(px, 1.25, pz);
      pillar.castShadow = true;
      finishedGroup.add(pillar);
    }
  }

  // Beiral do telhado do moinho
  const roofEave = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.06, 1.58), woodTimberMat);
  roofEave.position.y = 1.82;
  roofEave.castShadow = true;
  finishedGroup.add(roofEave);

  // Telhado piramidal de telhas de palha/terracota
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.2, 0.85, 4), roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.26;
  roof.castShadow = true;
  finishedGroup.add(roof);

  // Porta frontal térrea
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.54, 0.06), woodTimberMat);
  door.position.set(0, 0.28, 0.86);
  finishedGroup.add(door);

  // Alpendre frontal (ponto de recepção e descarga de cereais)
  const porchFloor = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.52), woodTimberMat);
  porchFloor.position.set(0, 0.06, 1.12);
  porchFloor.castShadow = true;
  finishedGroup.add(porchFloor);

  const porchAwning = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.58), roofMat);
  porchAwning.rotation.x = 0.2;
  porchAwning.position.set(0, 0.88, 1.1);
  porchAwning.castShadow = true;
  finishedGroup.add(porchAwning);

  const porchPostGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.82, 6);
  for (const posx of [-0.56, 0.56]) {
    const post = new THREE.Mesh(porchPostGeo, woodTimberMat);
    post.position.set(posx, 0.44, 1.34);
    post.castShadow = true;
    finishedGroup.add(post);
  }

  // Sacas de grão / farinha empilhadas na varanda
  const sackGeo = new THREE.SphereGeometry(0.11, 8, 8);
  const sack1 = new THREE.Mesh(sackGeo, sackMat);
  sack1.scale.set(1, 0.75, 1);
  sack1.position.set(-0.35, 0.14, 1.12);
  sack1.castShadow = true;
  finishedGroup.add(sack1);

  const sack2 = new THREE.Mesh(sackGeo, sackMat);
  sack2.scale.set(1, 0.72, 1);
  sack2.position.set(-0.2, 0.14, 1.22);
  sack2.castShadow = true;
  finishedGroup.add(sack2);

  const sack3 = new THREE.Mesh(sackGeo, sackMat);
  sack3.scale.set(0.95, 0.7, 0.95);
  sack3.position.set(-0.28, 0.26, 1.16);
  sack3.castShadow = true;
  finishedGroup.add(sack3);

  // Barril de cereais do lado direito
  const barrelGeo = new THREE.CylinderGeometry(0.09, 0.1, 0.24, 8);
  const barrel = new THREE.Mesh(barrelGeo, woodTimberMat);
  barrel.position.set(0.38, 0.18, 1.14);
  barrel.castShadow = true;
  finishedGroup.add(barrel);

  // Lanterna na parede
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), new THREE.MeshBasicMaterial({ color: 0xfef08a }));
  lantern.position.set(0.42, 0.52, 0.88);
  finishedGroup.add(lantern);

  // --- HÉLICES GIRATÓRIAS DO MOINHO (WINDMILL SAILS) ---
  const axleHousing = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.25), woodTimberMat);
  axleHousing.position.set(0, 1.52, 0.75);
  finishedGroup.add(axleHousing);

  const windmillBlades = new THREE.Group();
  windmillBlades.position.set(0, 1.52, 0.92);

  // Cubo central da hélice
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.7 }));
  hub.rotation.x = Math.PI / 2;
  windmillBlades.add(hub);

  // 2 Mastros cruzados de suporte das pás (2.1m de ponta a ponta)
  const spar1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.1, 0.04), woodTimberMat);
  spar1.castShadow = true;
  windmillBlades.add(spar1);

  const spar2 = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.06, 0.04), woodTimberMat);
  spar2.castShadow = true;
  windmillBlades.add(spar2);

  // 4 Velas de tecido de linho / lona estendidas sobre os mastros
  const sailTop = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.82), sailClothMat);
  sailTop.position.set(0.14, 0.54, 0.02);
  windmillBlades.add(sailTop);

  const sailBottom = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.82), sailClothMat);
  sailBottom.position.set(-0.14, -0.54, 0.02);
  windmillBlades.add(sailBottom);

  const sailRight = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.24), sailClothMat);
  sailRight.position.set(0.54, -0.14, 0.02);
  windmillBlades.add(sailRight);

  const sailLeft = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.24), sailClothMat);
  sailLeft.position.set(-0.54, 0.14, 0.02);
  windmillBlades.add(sailLeft);

  finishedGroup.add(windmillBlades);

  // 3. Barra de Progresso de Construção (2x2)
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 2.7, 0);

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.1);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.07);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 4. Anel de Seleção 2x2
  const selectionGeo = new THREE.RingGeometry(1.25, 1.42, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh, windmillBlades };
}

function createMillFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    windmillBlades
  } = createMillModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia 4 células (2x2) no grid
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `mill_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'MILL',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0,
    windmillBlades
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

/**
 * Cria o modelo 3D da Fazenda Agrícola (Farm) - Estrutura plana 2x2 no solo
 * Visual: Ladrilho arado com linhas de cultivo, terra escura sulcada com camalhões e tufos densos de trigo dourado.
 * Inclui cerca de estacas rústicas e espantalho tradicional no canto.
 */
function createFarmModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
  cropMeshes: THREE.Object3D[];
} {
  const siteGroup = new THREE.Group();

  // Fundação do canteiro de obras da fazenda
  const siteBed = new THREE.Mesh(
    new THREE.BoxGeometry(1.96, 0.08, 1.96),
    new THREE.MeshStandardMaterial({ color: 0x582f0e, roughness: 0.98 })
  );
  siteBed.position.y = 0.04;
  siteBed.receiveShadow = true;
  siteGroup.add(siteBed);

  const stakeGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.45, 6);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
  for (const sx of [-0.9, 0.9]) {
    for (const sz of [-0.9, 0.9]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.22, sz);
      siteGroup.add(stake);
    }
  }

  // Linhas de solo recém-arado no canteiro de obras
  const furrowSiteMat = new THREE.MeshStandardMaterial({ color: 0x3d2314, roughness: 0.95 });
  for (const fx of [-0.6, -0.2, 0.2, 0.6]) {
    const fRidge = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 1.8), furrowSiteMat);
    fRidge.position.set(fx, 0.09, 0);
    siteGroup.add(fRidge);
  }

  // 2. Edifício Concluído (FINISHED)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  const soilBedMat = new THREE.MeshStandardMaterial({ color: 0x3a2012, roughness: 0.96 });
  const furrowMat = new THREE.MeshStandardMaterial({ color: 0x27150a, roughness: 0.98 });
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x713f12, roughness: 0.85 });
  const wheatMat = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.82 });
  const wheatTipMat = new THREE.MeshStandardMaterial({ color: 0xfde047, roughness: 0.78 });

  // Base plana de terra preta arada (1.96 x 0.06 x 1.96)
  const soilBase = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.06, 1.96), soilBedMat);
  soilBase.position.y = 0.03;
  soilBase.receiveShadow = true;
  finishedGroup.add(soilBase);

  // 4 Camalhões / Sulcos de plantio longitudinais (Z)
  const furrowXs = [-0.64, -0.21, 0.21, 0.64];
  for (const fx of furrowXs) {
    const furrowRidge = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 1.86), furrowMat);
    furrowRidge.position.set(fx, 0.07, 0);
    furrowRidge.receiveShadow = true;
    finishedGroup.add(furrowRidge);
  }

  // Cerca rústica parcial de estacas de madeira nos cantos e fundos
  const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.32, 6);
  for (const px of [-0.92, 0.92]) {
    for (const pz of [-0.92, 0.92]) {
      const post = new THREE.Mesh(postGeo, fenceMat);
      post.position.set(px, 0.16, pz);
      post.castShadow = true;
      finishedGroup.add(post);
    }
  }

  // Trilho de cerca no fundo (-Z)
  const fenceRail = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.03, 0.03), fenceMat);
  fenceRail.position.set(0, 0.22, -0.92);
  fenceRail.castShadow = true;
  finishedGroup.add(fenceRail);

  // Espantalho tradicional no canto da fazenda (-0.78, 0.28, -0.78)
  const scarecrowGroup = new THREE.Group();
  scarecrowGroup.position.set(-0.78, 0.03, -0.78);

  const scShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.65, 6), fenceMat);
  scShaft.position.y = 0.32;
  scarecrowGroup.add(scShaft);

  const scArms = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.46, 6), fenceMat);
  scArms.rotation.z = Math.PI / 2;
  scArms.position.y = 0.46;
  scarecrowGroup.add(scArms);

  const scHat = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.12, 6),
    new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.9 })
  );
  scHat.position.y = 0.66;
  scarecrowGroup.add(scHat);
  finishedGroup.add(scarecrowGroup);

  // Tufos de trigo dourado nos camalhões (5 tufos por camalhão = 20 tufos)
  const cropMeshes: THREE.Object3D[] = [];
  const wheatGeo = new THREE.ConeGeometry(0.12, 0.36, 5);
  const wheatTipGeo = new THREE.SphereGeometry(0.055, 5, 5);

  const zPositions = [-0.7, -0.35, 0, 0.35, 0.7];
  for (const fx of furrowXs) {
    for (const fz of zPositions) {
      const tuftGroup = new THREE.Group();
      tuftGroup.position.set(fx + (Math.random() - 0.5) * 0.05, 0.08, fz + (Math.random() - 0.5) * 0.05);

      const wheatTuft = new THREE.Mesh(wheatGeo, wheatMat);
      wheatTuft.position.y = 0.18;
      wheatTuft.rotation.y = Math.random() * Math.PI;
      wheatTuft.castShadow = true;
      tuftGroup.add(wheatTuft);

      const wheatTip = new THREE.Mesh(wheatTipGeo, wheatTipMat);
      wheatTip.position.y = 0.36;
      tuftGroup.add(wheatTip);

      finishedGroup.add(tuftGroup);
      cropMeshes.push(tuftGroup);
    }
  }

  // 3. Barra de Progresso de Construção (2x2)
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.2, 0);

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.1);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.07);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 4. Anel de Seleção 2x2
  const selectionGeo = new THREE.RingGeometry(1.25, 1.42, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh, cropMeshes };
}

function createFarmFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    cropMeshes
  } = createFarmModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia 4 células (2x2) no grid
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `farm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'FARM',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0,
    farmFood: FARM_FOOD_CAPACITY,
    maxFarmFood: FARM_FOOD_CAPACITY,
    isDepleted: false,
    assignedFarmerId: null,
    cropMeshes
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

function isFarmAlive(farm: ConstructionBuilding | null | undefined): boolean {
  if (!farm) return false;
  return farm.type === 'FARM' && farm.isCompleted && !farm.isDepleted && (farm.farmFood ?? 0) > 0;
}

function updateFarmVisuals(farm: ConstructionBuilding) {
  if (!farm.cropMeshes) return;
  const food = farm.farmFood ?? 0;
  const max = farm.maxFarmFood ?? FARM_FOOD_CAPACITY;
  const ratio = Math.max(0, food / max);

  farm.cropMeshes.forEach((tuft) => {
    if (farm.isDepleted || food <= 0) {
      tuft.visible = false;
    } else {
      tuft.visible = true;
      const s = 0.35 + 0.65 * ratio;
      tuft.scale.set(s, s, s);
    }
  });

  if (selectedBuilding === farm) {
    updateFarmHUD();
  }
}

function depleteFarm(farm: ConstructionBuilding) {
  farm.isDepleted = true;
  farm.farmFood = 0;
  farm.assignedFarmerId = null;

  // 1. Free the 2x2 grid cells and remove from buildingsGridMap
  const sX = farm.sizeX || farm.size || 2;
  const sZ = farm.sizeZ || farm.size || 2;
  for (let dx = 0; dx < sX; dx++) {
    for (let dz = 0; dz < sZ; dz++) {
      const cx = farm.gridX + dx;
      const cz = farm.gridZ + dz;
      setCellWalkable(cx, cz, true);
      if (buildingsGridMap.get(cellKey(cx, cz)) === farm) {
        buildingsGridMap.delete(cellKey(cx, cz));
      }
    }
  }

  // 2. If this farm was currently selected, deselect it
  if (selectedBuilding === farm) {
    deselectBuilding();
  }

  // 3. Remove the farm mesh from the 3D scene and from buildingsList
  if (farm.group && farm.group.parent) {
    scene.remove(farm.group);
  }
  const idx = buildingsList.indexOf(farm);
  if (idx !== -1) {
    buildingsList.splice(idx, 1);
  }

  spawnFloatingText(
    farm.worldCenter.clone().setY(1.4),
    '🌾 Fazenda Esgotada! Terreno livre para novo plantio.',
    '#f59e0b'
  );
  console.log(`[RTS Farm] Farm at (${farm.gridX}, ${farm.gridZ}) depleted and land cleared.`);
}

function reseedFarm(farm: ConstructionBuilding) {
  if (resources.wood < FARM_COST_WOOD) {
    console.log(`[RTS Fazenda] Madeira insuficiente para renovar (${resources.wood}/${FARM_COST_WOOD} 🪵).`);
    spawnFloatingText(farm.worldCenter.clone().setY(1.4), `⚠️ Requer ${FARM_COST_WOOD} 🪵 para renovar`, '#f87171');
    return;
  }

  resources.wood -= FARM_COST_WOOD;
  farm.farmFood = FARM_FOOD_CAPACITY;
  farm.maxFarmFood = FARM_FOOD_CAPACITY;
  farm.isDepleted = false;
  updateFarmVisuals(farm);
  updateResourceHUD(true);
  spawnFloatingText(farm.worldCenter.clone().setY(1.5), `🌾 Fazenda Renovada! (+${FARM_FOOD_CAPACITY} 🍖)`, '#22c55e');
  spawnFloatingText(farm.worldCenter.clone().setY(2.0), `-${FARM_COST_WOOD} 🪵`, '#fbbf24');
  console.log(`[RTS Fazenda] Fazenda em (${farm.gridX}, ${farm.gridZ}) renovada com sucesso!`);
  updateFarmHUD();
}

function pickFarmGatherCell(unit: RTSUnit, farm: ConstructionBuilding): THREE.Vector2 {
  const perim = getBuildingPerimeterCells(farm);
  if (perim.length === 0) {
    return findClosestWalkableCell(new THREE.Vector2(farm.gridX + 1, farm.gridZ + 1), unitCell(unit));
  }

  const pos = unit.group.position;
  let best = perim[0];
  let bestDist = Infinity;

  for (const c of perim) {
    const dist = Math.hypot(c.x + 0.5 - pos.x, c.y + 0.5 - pos.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

function commandFarm(unit: RTSUnit, farm: ConstructionBuilding) {
  resetChopPose(unit);
  unit.state = 'MOVING_TO_RESOURCE';
  unit.carriedResourceType = 'FOOD';
  unit.targetFarm = farm;
  unit.targetBerryBush = null;
  unit.targetTree = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;

  // Garante exclusividade de 1 agricultor por fazenda
  if (farm.assignedFarmerId && farm.assignedFarmerId !== unit.id) {
    const prev = unitsList.find((u) => u.id === farm.assignedFarmerId && !u.isDying && u.targetFarm === farm);
    if (prev) {
      prev.targetFarm = null;
      goIdle(prev);
    }
  }
  farm.assignedFarmerId = unit.id;

  unit.gatherCell = pickFarmGatherCell(unit, farm);
  setUnitPath(unit, unit.gatherCell);
  if (selectedBuilding === farm) updateFarmHUD();
}

// Células do perímetro de uma construção (para os operários alcançarem de qualquer lado)
function getBuildingPerimeterCells(building: ConstructionBuilding): THREE.Vector2[] {
  const cells: THREE.Vector2[] = [];
  const sX = building.sizeX || building.size;
  const sZ = building.sizeZ || building.size;
  const minX = building.gridX - 1;
  const maxX = building.gridX + sX;
  const minZ = building.gridZ - 1;
  const maxZ = building.gridZ + sZ;

  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const inside = x >= building.gridX && x < building.gridX + sX &&
                     z >= building.gridZ && z < building.gridZ + sZ;
      if (!inside && isCellInside(x, z) && isCellWalkable(x, z)) {
        cells.push(new THREE.Vector2(x, z));
      }
    }
  }
  return cells;
}

function pickBuildCell(unit: RTSUnit, building: ConstructionBuilding): THREE.Vector2 {
  const perim = getBuildingPerimeterCells(building);
  if (perim.length === 0) {
    return findClosestWalkableCell(new THREE.Vector2(building.gridX, building.gridZ), unitCell(unit));
  }

  const pos = unit.group.position;
  let best = perim[0];
  let bestScore = Infinity;

  for (const c of perim) {
    const claims = unitsList.filter(
      (u) => u !== unit && u.buildCell && u.buildCell.x === c.x && u.buildCell.y === c.y
    ).length;
    const dist = Math.hypot(c.x + 0.5 - pos.x, c.y + 0.5 - pos.z);
    const score = dist + claims * 3.5;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// --- SISTEMA DA ESCOLA (SCHOOL 2x2) ---
function createSchoolModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  const siteGroup = new THREE.Group();

  // 1. Canteiro de Obras: Saia de fundação + terra arada + estacas nos cantos + andaimes de madeira
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.8, 1.7),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.4;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const dirtMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 0.08, 1.72),
    new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 })
  );
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  // Estacas de obra nos 4 cantos
  const stakeGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.65, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  for (const sx of [-0.78, 0.78]) {
    for (const sz of [-0.78, 0.78]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.32, sz);
      siteGroup.add(stake);
    }
  }

  // Vigas e andaimes no canteiro
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const scaffoldBeam = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.08), beamMat);
  scaffoldBeam.position.set(0, 0.42, -0.6);
  siteGroup.add(scaffoldBeam);
  const scaffoldPost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.08), beamMat);
  scaffoldPost.position.set(0.6, 0.4, -0.6);
  siteGroup.add(scaffoldPost);

  // 2. Edifício Concluído (FINISHED)
  const finishedGroup = new THREE.Group();
  finishedGroup.visible = false;

  // Saia subterrânea de pedra para assentar perfeitamente em desníveis de terreno
  const finishedSkirt = siteSkirt.clone();
  finishedGroup.add(finishedSkirt);

  // Materiais arquitetônicos medievais nobres da Escola
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x5a6268, roughness: 0.9 }); // Pedra acinzentada
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xe8dec8, roughness: 0.85 }); // Reboco claro / marfim
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x5c2e0b, roughness: 0.75 }); // Vigas de madeira escura
  const doorWoodMat = new THREE.MeshStandardMaterial({ color: 0x3b1d06, roughness: 0.8 }); // Porta de madeira maciça
  const terracottaRoofMat = new THREE.MeshStandardMaterial({ color: 0x8b3a2b, roughness: 0.8 }); // Telhas cerâmicas terracota
  const amberGlassMat = new THREE.MeshStandardMaterial({
    color: 0xffcc66,
    roughness: 0.35,
    emissive: 0x78350f,
    emissiveIntensity: 0.25
  }); // Vidro âmbar acolhedor
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.25, metalness: 0.85 }); // Sino e detalhes dourados
  const clockFaceMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.4 }); // Mostrador do relógio

  // A. Base de Fundação (Pedra Rústica 1.7 x 0.25 x 1.7)
  const baseStone = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 1.7), stoneMat);
  baseStone.position.y = 0.125;
  baseStone.castShadow = true;
  baseStone.receiveShadow = true;
  finishedGroup.add(baseStone);

  // Soleira / Escadaria de entrada na frente (face +Z)
  const entryStep = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.3), stoneMat);
  entryStep.position.set(0, 0.05, 0.75);
  entryStep.receiveShadow = true;
  finishedGroup.add(entryStep);

  // B. Corpo Principal da Escola (Alvenaria / Enxaimel 1.4 x 0.8 x 1.3)
  const mainBody = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 1.3), plasterMat);
  mainBody.position.set(0, 0.65, 0);
  mainBody.castShadow = true;
  mainBody.receiveShadow = true;
  finishedGroup.add(mainBody);

  // 4 Colunas finas de madeira nas quinas do corpo principal
  const cornerPostGeo = new THREE.BoxGeometry(0.08, 0.8, 0.08);
  for (const cx of [-0.67, 0.67]) {
    for (const cz of [-0.62, 0.62]) {
      const col = new THREE.Mesh(cornerPostGeo, darkWoodMat);
      col.position.set(cx, 0.65, cz);
      finishedGroup.add(col);
    }
  }

  // Viga superior de arremate / beiral de apoio
  const topLintel = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.05, 1.32), darkWoodMat);
  topLintel.position.set(0, 1.05, 0);
  finishedGroup.add(topLintel);

  // C. Telhado Principal Limpo e Harmonioso (Piramidal de 4 águas simétricas)
  // ConeGeometry(1.15, 0.6, 4) rotacionado em Y a 45° alinha perfeitamente com a caixa
  const mainRoof = new THREE.Mesh(new THREE.ConeGeometry(1.15, 0.6, 4), terracottaRoofMat);
  mainRoof.rotation.y = Math.PI / 4;
  mainRoof.position.set(0, 1.35, 0);
  mainRoof.castShadow = true;
  finishedGroup.add(mainRoof);

  // D. Torre do Relógio / Sino (Topo Central)
  // Base da torre sobre o cume do telhado
  const towerBase = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.42), plasterMat);
  towerBase.position.set(0, 1.75, 0);
  towerBase.castShadow = true;
  finishedGroup.add(towerBase);

  // Vigas verticais nos 4 cantos da torre
  const towerPostGeo = new THREE.BoxGeometry(0.05, 0.55, 0.05);
  for (const tx of [-0.19, 0.19]) {
    for (const tz of [-0.19, 0.19]) {
      const tPost = new THREE.Mesh(towerPostGeo, darkWoodMat);
      tPost.position.set(tx, 1.75, tz);
      finishedGroup.add(tPost);
    }
  }

  // Sino de latão no interior da torre
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.14, 8), brassMat);
  bell.position.set(0, 1.68, 0);
  bell.castShadow = true;
  finishedGroup.add(bell);

  // Mostrador do relógio na face frontal da torre
  const clockFace = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16), clockFaceMat);
  clockFace.rotation.x = Math.PI / 2;
  clockFace.position.set(0, 1.82, 0.22);
  finishedGroup.add(clockFace);

  // Aro dourado em volta do relógio
  const clockRim = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.015, 8, 16), brassMat);
  clockRim.position.set(0, 1.82, 0.235);
  finishedGroup.add(clockRim);

  // Ponteiros pretos do relógio
  const clockHands = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.015, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x0f172a })
  );
  clockHands.rotation.z = Math.PI / 4;
  clockHands.position.set(0, 1.82, 0.245);
  finishedGroup.add(clockHands);

  // Cúpula / Pináculo da torre (Piramidal de 4 águas)
  const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.45, 4), terracottaRoofMat);
  towerRoof.rotation.y = Math.PI / 4;
  towerRoof.position.set(0, 2.25, 0);
  towerRoof.castShadow = true;
  finishedGroup.add(towerRoof);

  // Esfera dourada no topo da torre
  const finialBall = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), brassMat);
  finialBall.position.set(0, 2.535, 0);
  finishedGroup.add(finialBall);

  // E. Detalhes Frontais (Porta e Janelas)
  // Porta de entrada de madeira escura na face frontal (+Z)
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.45, 0.06), doorWoodMat);
  door.position.set(0, 0.475, 0.67);
  door.castShadow = true;
  finishedGroup.add(door);

  // Maçaneta dourada da porta
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), brassMat);
  knob.position.set(0.08, 0.475, 0.71);
  finishedGroup.add(knob);

  // Moldura superior da porta
  const doorArch = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.08), darkWoodMat);
  doorArch.position.set(0, 0.725, 0.67);
  finishedGroup.add(doorArch);

  // Duas janelas com vidro âmbar nas laterais da porta
  for (const wx of [-0.42, 0.42]) {
    const windowGlass = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.04), amberGlassMat);
    windowGlass.position.set(wx, 0.62, 0.66);
    finishedGroup.add(windowGlass);

    const windowFrame = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.02), darkWoodMat);
    windowFrame.position.set(wx, 0.62, 0.655);
    finishedGroup.add(windowFrame);
  }

  // Janelas nas laterais do edifício (leste e oeste)
  for (const sideX of [-0.71, 0.71]) {
    const sideWin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.32), amberGlassMat);
    sideWin.position.set(sideX, 0.65, 0);
    finishedGroup.add(sideWin);

    const sideFrame = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.36), darkWoodMat);
    sideFrame.position.set(sideX, 0.65, 0);
    finishedGroup.add(sideFrame);
  }

  // 3. Barra de Progresso de Construção 3D (2x2)
  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 2.8, 0);

  const barBgGeo = new THREE.BoxGeometry(1.3, 0.12, 0.1);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
  progressGroup.add(barBg);

  const barBorder = new THREE.LineSegments(
    new THREE.EdgesGeometry(barBgGeo),
    new THREE.LineBasicMaterial({ color: 0x475569 })
  );
  barBg.add(barBorder);

  const barFillGeo = new THREE.BoxGeometry(1.26, 0.08, 0.07);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.63;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  // 4. Anel de Seleção 2x2
  const selectionGeo = new THREE.RingGeometry(1.25, 1.42, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x818cf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh };
}

function createSchoolFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 1.0);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createSchoolModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia 4 células (2x2) no grid
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `school_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'SCHOOL',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0,
    enrolledStudents: [],
    maxStudents: SCHOOL_MAX_STUDENTS,
    hp: 200,
    maxHp: 200
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

// --- SISTEMA DA FACULDADE (COLLEGE / UNIVERSITY 3x3) ---
function createCollegeModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  const siteGroup = new THREE.Group();

  // 1. Canteiro de Obras 3x3: Saia de fundação + estacas e andaimes
  const siteSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(2.7, 0.8, 2.7),
    new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 })
  );
  siteSkirt.position.y = -0.4;
  siteSkirt.receiveShadow = true;
  siteGroup.add(siteSkirt);

  const siteGround = new THREE.Mesh(
    new THREE.BoxGeometry(2.65, 0.12, 2.65),
    new THREE.MeshStandardMaterial({ color: 0x785338, roughness: 0.9 })
  );
  siteGround.position.y = 0.06;
  siteGroup.add(siteGround);

  // Pilhas de mármore e madeira de obra
  const marbleBlockMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
  const blockGeo = new THREE.BoxGeometry(0.5, 0.35, 0.45);
  const mBlock1 = new THREE.Mesh(blockGeo, marbleBlockMat);
  mBlock1.position.set(-0.8, 0.22, 0.8);
  siteGroup.add(mBlock1);
  const mBlock2 = new THREE.Mesh(blockGeo, marbleBlockMat);
  mBlock2.position.set(-0.7, 0.22, -0.7);
  siteGroup.add(mBlock2);

  // Andaimes em torno do canteiro
  const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6);
  const woodScaffoldMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.85 });
  const scaffoldOffsets = [
    [-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1],
    [0, -1.15], [0, 1.15]
  ];
  scaffoldOffsets.forEach(([px, pz]) => {
    const post = new THREE.Mesh(postGeo, woodScaffoldMat);
    post.position.set(px, 0.7, pz);
    siteGroup.add(post);
  });

  // 2. Modelo Finalizado da Faculdade (Arquitetura Neoclássica/Acadêmica Imponente 3x3)
  const finishedGroup = new THREE.Group();

  // Saia de ancoragem de terreno
  const skirtMesh = new THREE.Mesh(
    new THREE.BoxGeometry(2.7, 1.2, 2.7),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 })
  );
  skirtMesh.position.y = -0.6;
  finishedGroup.add(skirtMesh);

  // Estilóbato / Plinto de mármore branco em 2 degraus
  const stepMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.65 });
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(2.68, 0.16, 2.68), stepMat);
  step1.position.y = 0.08;
  step1.receiveShadow = true;
  finishedGroup.add(step1);

  const step2 = new THREE.Mesh(new THREE.BoxGeometry(2.46, 0.14, 2.46), stepMat);
  step2.position.y = 0.22;
  step2.receiveShadow = true;
  finishedGroup.add(step2);

  // Edifício Principal (Grande Salão Acadêmico)
  const hallMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });
  const mainHall = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.7), hallMat);
  mainHall.position.set(0, 0.75, -0.2);
  mainHall.castShadow = true;
  mainHall.receiveShadow = true;
  finishedGroup.add(mainHall);

  // Telhado do Grande Salão
  const hallRoofMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.55 });
  const hallRoof = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 4), hallRoofMat);
  hallRoof.rotation.y = Math.PI / 4;
  hallRoof.position.set(0, 1.55, -0.2);
  finishedGroup.add(hallRoof);

  // Périclo / Pórtico Frontal com 4 Colunas Clássicas
  const columnGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.95, 12);
  const columnMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
  const columnPositions = [-0.75, -0.25, 0.25, 0.75];
  columnPositions.forEach((cx) => {
    const col = new THREE.Mesh(columnGeo, columnMat);
    col.position.set(cx, 0.76, 0.85);
    col.castShadow = true;
    finishedGroup.add(col);
  });

  // Entablamento e Frontão Triangular Clássico
  const entablature = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.15, 0.6), stepMat);
  entablature.position.set(0, 1.28, 0.85);
  entablature.castShadow = true;
  finishedGroup.add(entablature);

  const pedimentGeo = new THREE.ConeGeometry(1.15, 0.45, 4);
  const pediment = new THREE.Mesh(pedimentGeo, stepMat);
  pediment.rotation.y = Math.PI / 4;
  pediment.position.set(0, 1.55, 0.85);
  finishedGroup.add(pediment);

  // Brasão Dourado no Frontão
  const crestGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16);
  const goldCrestMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, metalness: 0.8 });
  const crest = new THREE.Mesh(crestGeo, goldCrestMat);
  crest.rotation.x = Math.PI / 2;
  crest.position.set(0, 1.48, 1.15);
  finishedGroup.add(crest);

  // Rotunda Central / Observatório com Cúpula
  const rotundaDrum = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.55, 16),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6 })
  );
  rotundaDrum.position.set(0, 1.7, -0.2);
  rotundaDrum.castShadow = true;
  finishedGroup.add(rotundaDrum);

  const domeGeo = new THREE.SphereGeometry(0.56, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.4, metalness: 0.6 }); // Cobre oxidado imperial
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.set(0, 1.95, -0.2);
  finishedGroup.add(dome);

  // Pináculo / Esfera Armilar Astronômica Dourada
  const finialGeo = new THREE.SphereGeometry(0.1, 12, 12);
  const finial = new THREE.Mesh(finialGeo, goldCrestMat);
  finial.position.set(0, 2.58, -0.2);
  finishedGroup.add(finial);

  const finialSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.2, 8), goldCrestMat);
  finialSpire.position.set(0, 2.45, -0.2);
  finishedGroup.add(finialSpire);

  // Porta Dupla de Carvalho com Detalhes Dourados
  const doorGeo = new THREE.BoxGeometry(0.48, 0.55, 0.05);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.75 });
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.position.set(0, 0.55, 0.64);
  finishedGroup.add(door);

  // Estandartes Acadêmicos Azul e Ouro
  const bannerMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.65 });
  for (const bx of [-0.95, 0.95]) {
    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.45, 0.02), bannerMat);
    banner.position.set(bx, 0.8, 0.64);
    finishedGroup.add(banner);
  }

  finishedGroup.visible = false;

  // 3. Barra de Progresso 3D da Construção
  const progressGroup = new THREE.Group();
  const trackGeo = new THREE.BoxGeometry(1.6, 0.12, 0.08);
  const trackMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
  const trackMesh = new THREE.Mesh(trackGeo, trackMat);
  progressGroup.add(trackMesh);

  const barGeo = new THREE.BoxGeometry(1.56, 0.09, 0.09);
  const barMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  const progressBarMesh = new THREE.Mesh(barGeo, barMat);
  progressBarMesh.position.x = -0.78;
  progressGroup.add(progressBarMesh);

  progressGroup.position.set(0, 2.8, 0);

  // 4. Anel de Seleção 3x3 no Chão
  const selectionGeo = new THREE.RingGeometry(1.95, 2.18, 32);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95
  });
  const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
  selectionMesh.rotation.x = -Math.PI / 2;
  selectionMesh.position.y = 0.02;
  selectionMesh.visible = false;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh };
}

function createCollegeFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 3);
  const worldCenter = new THREE.Vector3(gridX + 1.5, elevation, gridZ + 1.5);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createCollegeModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 3 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);

  // Bloqueia 9 células (3x3) no grid
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      setCellWalkable(gridX + dx, gridZ + dz, false);
    }
  }

  const building: ConstructionBuilding = {
    id: `college_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'COLLEGE',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 3,
    worldCenter,
    isCompleted: false,
    progress: 0,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0,
    enrolledStudents: [],
    maxStudents: COLLEGE_MAX_STUDENTS,
    selectedCollegeCourse: 'ARCHITECT',
    hp: 400,
    maxHp: 400
  };

  buildingsList.push(building);
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      buildingsGridMap.set(cellKey(gridX + dx, gridZ + dz), building);
    }
  }

  return building;
}

// =========================================================================
// SISTEMA DE FORTIFICAÇÕES: MURALHAS DE PEDRA & PORTÕES FUNCIONAIS
// =========================================================================

export function createWallMesh(_gridX: number = 0, _gridZ: number = 0): THREE.Group {
  const group = new THREE.Group();

  const stoneWallMat = new THREE.MeshStandardMaterial({
    color: 0x7c858d,
    roughness: 0.85,
    metalness: 0.1
  });
  const stoneWallDarkMat = new THREE.MeshStandardMaterial({
    color: 0x57534e,
    roughness: 0.9,
    metalness: 0.1
  });
  const edgeLineMat = new THREE.LineBasicMaterial({
    color: 0x292524,
    transparent: true,
    opacity: 0.4
  });

  // 1. Base subterrânea / saia de ancoragem contra desníveis do terreno
  const skirtGeo = new THREE.BoxGeometry(0.96, 1.0, 0.96);
  const skirt = new THREE.Mesh(skirtGeo, stoneWallDarkMat);
  skirt.position.y = -0.5;
  skirt.receiveShadow = true;
  group.add(skirt);

  // 2. Bloco principal sólido 1x1 com base nivelada no chão (y de 0 a 0.9)
  const blockGeo = new THREE.BoxGeometry(0.95, 0.9, 0.95);
  blockGeo.translate(0, 0.45, 0); // Mantém o pivô exatamente na superfície do solo
  const block = new THREE.Mesh(blockGeo, stoneWallMat);
  block.castShadow = true;
  block.receiveShadow = true;
  block.add(new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), edgeLineMat));
  group.add(block);

  // 3. Ameias / merlões medievais no topo (4 blocos nos cantos superiores)
  const merlonGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
  const merlonOffsets = [
    [-0.35, 1.0, -0.35],
    [0.35, 1.0, -0.35],
    [-0.35, 1.0, 0.35],
    [0.35, 1.0, 0.35]
  ];
  for (const [mx, my, mz] of merlonOffsets) {
    const merlon = new THREE.Mesh(merlonGeo, stoneWallDarkMat);
    merlon.position.set(mx, my, mz);
    merlon.castShadow = true;
    merlon.receiveShadow = true;
    group.add(merlon);
  }

  return group;
}

function isWallOrGateAt(gx: number, gz: number): boolean {
  if (!isCellInside(gx, gz)) return false;
  const b = buildingsGridMap.get(cellKey(gx, gz));
  if (b !== undefined && (b.type === 'WALL' || b.type === 'GATE')) return true;
  const wl = wallsList.find(w => w.gridX === gx && w.gridZ === gz);
  if (wl) return true;
  return false;
}

function rebuildWallMesh(building: ConstructionBuilding): void {
  if (!building || !building.finishedGroup) return;

  try {
    while (building.finishedGroup.children.length > 0) {
      const child = building.finishedGroup.children[0];
      building.finishedGroup.remove(child);
    }

    const gx = building.gridX;
    const gz = building.gridZ;
    const hasN = isWallOrGateAt(gx, gz - 1);
    const hasS = isWallOrGateAt(gx, gz + 1);
    const hasE = isWallOrGateAt(gx + 1, gz);
    const hasW = isWallOrGateAt(gx - 1, gz);

    const stoneWallMat = new THREE.MeshStandardMaterial({ color: 0x7c858d, roughness: 0.85, metalness: 0.1 });
    const stoneWallDarkMat = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.9, metalness: 0.1 });
    const edgeLineMat = new THREE.LineBasicMaterial({ color: 0x292524, transparent: true, opacity: 0.4 });

    // 1. Saia de ancoragem estendida para baixo no relevo
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.96, 1.0, 0.96), stoneWallDarkMat);
    skirt.position.y = -0.5;
    skirt.receiveShadow = true;
    building.finishedGroup.add(skirt);

    // 2. Coluna central / Pilar de quina
    const coreGeo = new THREE.BoxGeometry(0.56, 1.1, 0.56);
    const core = new THREE.Mesh(coreGeo, stoneWallMat);
    core.position.y = 0.55;
    core.castShadow = true;
    core.receiveShadow = true;
    core.add(new THREE.LineSegments(new THREE.EdgesGeometry(coreGeo), edgeLineMat));
    building.finishedGroup.add(core);

    // 3. Conexões dinâmicas de Auto-Tiling ortogonal
    if (hasN) {
      const connNGeo = new THREE.BoxGeometry(0.54, 1.06, 0.48);
      const connN = new THREE.Mesh(connNGeo, stoneWallMat);
      connN.position.set(0, 0.53, -0.26);
      connN.castShadow = true;
      connN.receiveShadow = true;
      connN.add(new THREE.LineSegments(new THREE.EdgesGeometry(connNGeo), edgeLineMat));
      building.finishedGroup.add(connN);
    }

    if (hasS) {
      const connSGeo = new THREE.BoxGeometry(0.54, 1.06, 0.48);
      const connS = new THREE.Mesh(connSGeo, stoneWallMat);
      connS.position.set(0, 0.53, 0.26);
      connS.castShadow = true;
      connS.receiveShadow = true;
      connS.add(new THREE.LineSegments(new THREE.EdgesGeometry(connSGeo), edgeLineMat));
      building.finishedGroup.add(connS);
    }

    if (hasE) {
      const connEGeo = new THREE.BoxGeometry(0.48, 1.06, 0.54);
      const connE = new THREE.Mesh(connEGeo, stoneWallMat);
      connE.position.set(0.26, 0.53, 0);
      connE.castShadow = true;
      connE.receiveShadow = true;
      connE.add(new THREE.LineSegments(new THREE.EdgesGeometry(connEGeo), edgeLineMat));
      building.finishedGroup.add(connE);
    }

    if (hasW) {
      const connWGeo = new THREE.BoxGeometry(0.48, 1.06, 0.54);
      const connW = new THREE.Mesh(connWGeo, stoneWallMat);
      connW.position.set(-0.26, 0.53, 0);
      connW.castShadow = true;
      connW.receiveShadow = true;
      connW.add(new THREE.LineSegments(new THREE.EdgesGeometry(connWGeo), edgeLineMat));
      building.finishedGroup.add(connW);
    }

    // 4. Bloco de baluarte para muralhas isoladas
    if (!hasN && !hasS && !hasE && !hasW) {
      const blockGeo = new THREE.BoxGeometry(0.95, 0.9, 0.95);
      blockGeo.translate(0, 0.45, 0);
      const block = new THREE.Mesh(blockGeo, stoneWallMat);
      block.castShadow = true;
      block.receiveShadow = true;
      block.add(new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), edgeLineMat));
      building.finishedGroup.add(block);
    }

    // 5. Ameias e merlões medievais clássicos (Crenelations)
    const merlonGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
    const addMerlon = (mx: number, my: number, mz: number) => {
      const m = new THREE.Mesh(merlonGeo, stoneWallDarkMat);
      m.position.set(mx, my, mz);
      m.castShadow = true;
      m.receiveShadow = true;
      building.finishedGroup.add(m);
    };

    if (!hasN && !hasS && !hasE && !hasW) {
      addMerlon(-0.35, 1.0, -0.35);
      addMerlon(0.35, 1.0, -0.35);
      addMerlon(-0.35, 1.0, 0.35);
      addMerlon(0.35, 1.0, 0.35);
    } else {
      addMerlon(0, 1.15, 0);
      if (!hasN) addMerlon(0, 1.15, -0.35);
      if (!hasS) addMerlon(0, 1.15, 0.35);
      if (!hasE) addMerlon(0.35, 1.15, 0);
      if (!hasW) addMerlon(-0.35, 1.15, 0);
    }

    // 6. Decoração reforçada se o Arquiteto desbloqueou muralhas reforçadas
    if (isStoneWallReinforced) {
      const shieldMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.8, roughness: 0.25 });
      const crestMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.3 });

      if (!hasS) {
        const shieldS = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.38, 0.06), shieldMat);
        shieldS.position.set(0, 0.72, 0.48);
        shieldS.castShadow = true;
        building.finishedGroup.add(shieldS);

        const crestS = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 8), crestMat);
        crestS.rotation.x = Math.PI / 2;
        crestS.position.set(0, 0.72, 0.52);
        building.finishedGroup.add(crestS);
      }
      if (!hasN) {
        const shieldN = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.38, 0.06), shieldMat);
        shieldN.position.set(0, 0.72, -0.48);
        shieldN.castShadow = true;
        building.finishedGroup.add(shieldN);
      }
    }
  } catch (err) {
    console.error('[Wall] Erro ao reconstruir malha da muralha:', err);
    // Fallback de segurança garantido: nunca deixa a muralha sem malha
    if (building.finishedGroup.children.length === 0) {
      const fallbackMesh = createWallMesh(building.gridX, building.gridZ);
      building.finishedGroup.add(fallbackMesh);
    }
  }

  // Se concluído, assegura visibilidade e escala corretas
  if (building.isCompleted) {
    building.finishedGroup.visible = true;
    building.group.visible = true;
    building.finishedGroup.scale.set(1, 1, 1);
  }
}

function rebuildWallNeighbors(gx: number, gz: number): void {
  const neighbors = [
    [gx, gz - 1],
    [gx, gz + 1],
    [gx + 1, gz],
    [gx - 1, gz]
  ];
  for (const [nx, nz] of neighbors) {
    const b = buildingsGridMap.get(cellKey(nx, nz));
    if (b && b.type === 'WALL') {
      try {
        rebuildWallMesh(b);
      } catch (err) {
        console.error('[Wall] Falha ao reconstruir vizinho de muralha:', err);
      }
    }
  }
}

export function updateWallConnections(building: ConstructionBuilding): void {
  try {
    rebuildWallMesh(building);
    rebuildWallNeighbors(building.gridX, building.gridZ);
  } catch (err) {
    console.error('[Wall] Erro ao atualizar conexões de muralha:', err);
    if (building.finishedGroup && building.finishedGroup.children.length === 0) {
      building.finishedGroup.add(createWallMesh(building.gridX, building.gridZ));
    }
  }
}

function createWallModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
} {
  const siteGroup = new THREE.Group();
  const dirtGeo = new THREE.BoxGeometry(0.92, 0.08, 0.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  const stakeGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.6, 6);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  for (const sx of [-0.4, 0.4]) {
    for (const sz of [-0.4, 0.4]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.3, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  const stoneBlockGeo = new THREE.BoxGeometry(0.35, 0.2, 0.35);
  const stoneBlockMat = new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 });
  const stones = new THREE.Mesh(stoneBlockGeo, stoneBlockMat);
  stones.position.set(0, 0.14, 0);
  stones.castShadow = true;
  siteGroup.add(stones);

  // Inicializa com malha sólida de muralha (nunca vazia!)
  const finishedGroup = createWallMesh();
  finishedGroup.visible = false;

  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 1.45, 0);
  const barBgGeo = new THREE.BoxGeometry(0.88, 0.1, 0.08);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
  progressGroup.add(barBg);
  barBg.add(new THREE.LineSegments(new THREE.EdgesGeometry(barBgGeo), new THREE.LineBasicMaterial({ color: 0x22c55e })));

  const barFillGeo = new THREE.BoxGeometry(0.84, 0.08, 0.07);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.42;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  const selGeo = new THREE.BoxGeometry(1.0, 1.3, 1.0);
  const selMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, visible: false });
  const selectionMesh = new THREE.Mesh(selGeo, selMat);
  selectionMesh.position.y = 0.65;

  return { siteGroup, finishedGroup, progressGroup, progressBarMesh, selectionMesh };
}

function createWallFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 1);
  const worldCenter = new THREE.Vector3(gridX + 0.5, elevation, gridZ + 0.5);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh
  } = createWallModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 1 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);
  setWallCellOccupancy(gridX, gridZ, true);

  const isArchitect = hasLivingArchitect();
  const maxHp = isArchitect ? Math.round(WALL_HP * 1.3) : WALL_HP;

  const building: ConstructionBuilding = {
    id: `wall_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'WALL',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 1,
    sizeX: 1,
    sizeZ: 1,
    worldCenter,
    isCompleted: false,
    progress: 0,
    hp: maxHp,
    maxHp,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0
  };

  buildingsList.push(building);
  buildingsGridMap.set(cellKey(gridX, gridZ), building);

  // Conecta dinamicamente com paredes vizinhas
  updateWallConnections(building);

  return building;
}

function createGateModel(): {
  siteGroup: THREE.Group;
  finishedGroup: THREE.Group;
  progressGroup: THREE.Group;
  progressBarMesh: THREE.Mesh;
  selectionMesh: THREE.Mesh;
  leftGateLeaf: THREE.Object3D;
  rightGateLeaf: THREE.Object3D;
  portcullisMesh: THREE.Object3D;
} {
  const siteGroup = new THREE.Group();
  const dirtGeo = new THREE.BoxGeometry(1.92, 0.08, 0.92);
  const dirtMat = new THREE.MeshStandardMaterial({ color: 0x784928, roughness: 0.95 });
  const dirtMesh = new THREE.Mesh(dirtGeo, dirtMat);
  dirtMesh.position.y = 0.04;
  dirtMesh.receiveShadow = true;
  siteGroup.add(dirtMesh);

  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.8, 8);
  const stakeMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85 });
  for (const sx of [-0.88, 0.88]) {
    for (const sz of [-0.38, 0.38]) {
      const stake = new THREE.Mesh(stakeGeo, stakeMat);
      stake.position.set(sx, 0.4, sz);
      stake.castShadow = true;
      siteGroup.add(stake);
    }
  }

  const finishedGroup = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.88 });
  const stoneDarkMat = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.92 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.8 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.3 });

  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.96, 1.0, 0.96), stoneDarkMat);
  skirt.position.y = -0.5;
  skirt.receiveShadow = true;
  finishedGroup.add(skirt);

  const towerLeftGeo = new THREE.BoxGeometry(0.74, 1.85, 0.92);
  const towerLeft = new THREE.Mesh(towerLeftGeo, stoneMat);
  towerLeft.position.set(-0.62, 0.925, 0);
  towerLeft.castShadow = true;
  towerLeft.receiveShadow = true;
  finishedGroup.add(towerLeft);

  const towerRightGeo = new THREE.BoxGeometry(0.74, 1.85, 0.92);
  const towerRight = new THREE.Mesh(towerRightGeo, stoneMat);
  towerRight.position.set(0.62, 0.925, 0);
  towerRight.castShadow = true;
  towerRight.receiveShadow = true;
  finishedGroup.add(towerRight);

  const merlonGeo = new THREE.BoxGeometry(0.18, 0.28, 0.18);
  const addTowerMerlons = (baseX: number) => {
    for (const mx of [-0.25, 0.25]) {
      for (const mz of [-0.35, 0.35]) {
        const m = new THREE.Mesh(merlonGeo, stoneDarkMat);
        m.position.set(baseX + mx, 1.95, mz);
        m.castShadow = true;
        finishedGroup.add(m);
      }
    }
  };
  addTowerMerlons(-0.62);
  addTowerMerlons(0.62);

  const archGeo = new THREE.BoxGeometry(1.05, 0.35, 0.92);
  const arch = new THREE.Mesh(archGeo, stoneMat);
  arch.position.set(0, 1.72, 0);
  arch.castShadow = true;
  arch.receiveShadow = true;
  finishedGroup.add(arch);

  const archMerlon1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.12), stoneDarkMat);
  archMerlon1.position.set(0, 1.98, -0.4);
  archMerlon1.castShadow = true;
  finishedGroup.add(archMerlon1);

  const archMerlon2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.12), stoneDarkMat);
  archMerlon2.position.set(0, 1.98, 0.4);
  archMerlon2.castShadow = true;
  finishedGroup.add(archMerlon2);

  // Folha de madeira esquerda
  const leftDoorPivot = new THREE.Group();
  leftDoorPivot.position.set(-0.35, 0.65, 0);
  const doorLeftGeo = new THREE.BoxGeometry(0.35, 1.3, 0.08);
  const doorLeft = new THREE.Mesh(doorLeftGeo, woodMat);
  doorLeft.position.set(0.175, 0, 0);
  doorLeft.castShadow = true;
  leftDoorPivot.add(doorLeft);

  const ironBandLeft = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.09), ironMat);
  ironBandLeft.position.set(0.175, 0.3, 0);
  leftDoorPivot.add(ironBandLeft);
  const ironBandLeft2 = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.09), ironMat);
  ironBandLeft2.position.set(0.175, -0.3, 0);
  leftDoorPivot.add(ironBandLeft2);
  finishedGroup.add(leftDoorPivot);

  // Folha de madeira direita
  const rightDoorPivot = new THREE.Group();
  rightDoorPivot.position.set(0.35, 0.65, 0);
  const doorRightGeo = new THREE.BoxGeometry(0.35, 1.3, 0.08);
  const doorRight = new THREE.Mesh(doorRightGeo, woodMat);
  doorRight.position.set(-0.175, 0, 0);
  doorRight.castShadow = true;
  rightDoorPivot.add(doorRight);

  const ironBandRight = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.09), ironMat);
  ironBandRight.position.set(-0.175, 0.3, 0);
  rightDoorPivot.add(ironBandRight);
  const ironBandRight2 = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.09), ironMat);
  ironBandRight2.position.set(-0.175, -0.3, 0);
  rightDoorPivot.add(ironBandRight2);
  finishedGroup.add(rightDoorPivot);

  // Grade de Ferro (Portcullis)
  const portcullisGroup = new THREE.Group();
  portcullisGroup.position.set(0, 0.65, 0.08);
  for (let bx = -0.25; bx <= 0.25; bx += 0.12) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.25, 6), ironMat);
    bar.position.set(bx, 0, 0);
    bar.castShadow = true;
    portcullisGroup.add(bar);
  }
  for (let by = -0.45; by <= 0.45; by += 0.3) {
    const horizBar = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.035, 0.035), ironMat);
    horizBar.position.set(0, by, 0);
    portcullisGroup.add(horizBar);
  }
  finishedGroup.add(portcullisGroup);

  finishedGroup.visible = false;

  const progressGroup = new THREE.Group();
  progressGroup.position.set(0, 2.3, 0);
  const barBgGeo = new THREE.BoxGeometry(1.2, 0.12, 0.1);
  const barBg = new THREE.Mesh(barBgGeo, new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
  progressGroup.add(barBg);
  barBg.add(new THREE.LineSegments(new THREE.EdgesGeometry(barBgGeo), new THREE.LineBasicMaterial({ color: 0x22c55e })));

  const barFillGeo = new THREE.BoxGeometry(1.16, 0.09, 0.08);
  const progressBarMesh = new THREE.Mesh(barFillGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  progressBarMesh.position.x = -0.58;
  progressBarMesh.scale.x = 0.01;
  progressGroup.add(progressBarMesh);

  const selGeo = new THREE.BoxGeometry(2.0, 2.2, 1.0);
  const selMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, visible: false });
  const selectionMesh = new THREE.Mesh(selGeo, selMat);
  selectionMesh.position.y = 1.0;

  return {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    leftGateLeaf: leftDoorPivot,
    rightGateLeaf: rightDoorPivot,
    portcullisMesh: portcullisGroup
  };
}

function createGateFoundation(gridX: number, gridZ: number, faction: UnitFaction = 'PLAYER'): ConstructionBuilding {
  const elevation = getBuildingPlacementHeight(gridX, gridZ, 2);
  const worldCenter = new THREE.Vector3(gridX + 1.0, elevation, gridZ + 0.5);
  const group = new THREE.Group();
  group.position.copy(worldCenter);

  const {
    siteGroup,
    finishedGroup,
    progressGroup,
    progressBarMesh,
    selectionMesh,
    leftGateLeaf,
    rightGateLeaf,
    portcullisMesh
  } = createGateModel();

  group.add(selectionMesh);
  group.add(siteGroup);
  group.add(progressGroup);
  group.add(finishedGroup);

  if (faction === 'ENEMY') {
    const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX, gridZ, size: 2, sizeX: 2, sizeZ: 1 });
    group.visible = isDiscovered;
    group.traverse((c: any) => { if (c.isMesh) c.castShadow = isDiscovered; });
  }

  scene.add(group);
  setCellWalkable(gridX, gridZ, false);
  setCellWalkable(gridX + 1, gridZ, false);
  setWallCellOccupancy(gridX, gridZ, true);
  setWallCellOccupancy(gridX + 1, gridZ, true);

  const isArchitect = hasLivingArchitect();
  const maxHp = isArchitect ? Math.round(GATE_HP * 1.3) : GATE_HP;

  const building: ConstructionBuilding = {
    id: `gate_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'GATE',
    faction,
    isEnemy: faction === 'ENEMY',
    gridX,
    gridZ,
    size: 2,
    sizeX: 2,
    sizeZ: 1,
    worldCenter,
    isCompleted: false,
    progress: 0,
    hp: maxHp,
    maxHp,
    group,
    mesh: group,
    siteGroup,
    finishedGroup,
    progressBarMesh,
    progressGroup,
    trainingQueue: [],
    trainingTimer: 0,
    selectionMesh,
    trainingProgressGroup: new THREE.Group(),
    trainingProgressBarMesh: new THREE.Mesh(),
    lastAttackTime: 0,
    gateState: 'CLOSED',
    gateOpenProgress: 0,
    leftGateLeaf,
    rightGateLeaf,
    portcullisMesh
  };

  buildingsList.push(building);
  buildingsGridMap.set(cellKey(gridX, gridZ), building);
  buildingsGridMap.set(cellKey(gridX + 1, gridZ), building);

  return building;
}

function createGhostWall(): THREE.Group {
  const g = new THREE.Group();

  const planeGeo = new THREE.PlaneGeometry(0.96, 0.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  const skirtGeo = new THREE.BoxGeometry(0.94, 0.8, 0.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  const wallGeo = new THREE.BoxGeometry(0.88, 1.1, 0.88);
  const wallMesh = new THREE.Mesh(wallGeo, ghostMatValid);
  wallMesh.position.y = 0.55;
  g.add(wallMesh);
  ghostMeshes.push(wallMesh);

  const wallEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo), ghostEdgeMatValid);
  wallEdges.position.y = 0.55;
  g.add(wallEdges);
  ghostEdges.push(wallEdges);

  for (const mx of [-0.3, 0.3]) {
    for (const mz of [-0.3, 0.3]) {
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), ghostMatValid);
      merlon.position.set(mx, 1.18, mz);
      g.add(merlon);
      ghostMeshes.push(merlon);
    }
  }

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostGate(): THREE.Group {
  const g = new THREE.Group();

  const planeGeo = new THREE.PlaneGeometry(1.96, 0.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  for (const tx of [-0.6, 0.6]) {
    const towerGeo = new THREE.BoxGeometry(0.74, 1.85, 0.88);
    const tower = new THREE.Mesh(towerGeo, ghostMatValid);
    tower.position.set(tx, 0.925, 0);
    g.add(tower);
    ghostMeshes.push(tower);

    const towerEdges = new THREE.LineSegments(new THREE.EdgesGeometry(towerGeo), ghostEdgeMatValid);
    towerEdges.position.set(tx, 0.925, 0);
    g.add(towerEdges);
    ghostEdges.push(towerEdges);
  }

  const archGeo = new THREE.BoxGeometry(1.05, 0.35, 0.88);
  const arch = new THREE.Mesh(archGeo, ghostMatValid);
  arch.position.set(0, 1.72, 0);
  g.add(arch);
  ghostMeshes.push(arch);

  const archEdges = new THREE.LineSegments(new THREE.EdgesGeometry(archGeo), ghostEdgeMatValid);
  archEdges.position.set(0, 1.72, 0);
  g.add(archEdges);
  ghostEdges.push(archEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function updateGates(delta: number): void {
  const GATE_OPEN_RADIUS = 3.5;

  for (const b of buildingsList) {
    if (b.type !== 'GATE' || !b.isCompleted) continue;

    if (b.hp !== undefined && b.hp <= 0) {
      destroyGate(b);
      continue;
    }

    const gateCenter = b.worldCenter;

    // Filtra APENAS unidades vivas pertencentes à mesma facção do portão
    const hasFriendlyNearby = unitsList.some((u) => {
      if (u.isDying || u.hp <= 0) return false;
      const dist = Math.hypot(u.group.position.x - gateCenter.x, u.group.position.z - gateCenter.z);
      if (dist > GATE_OPEN_RADIUS) return false;

      // Portão aliado só abre para aliados; portão inimigo só abre para inimigos
      return (
        u.faction === b.faction ||
        (b.faction === 'PLAYER' && u.faction !== 'ENEMY') ||
        (b.faction === 'ENEMY' && u.faction === 'ENEMY')
      );
    });

    const targetProgress = hasFriendlyNearby ? 1.0 : 0.0;
    if (b.gateOpenProgress === undefined) b.gateOpenProgress = 0;

    const prevProgress = b.gateOpenProgress;
    if (b.gateOpenProgress < targetProgress) {
      b.gateOpenProgress = Math.min(targetProgress, b.gateOpenProgress + delta * 3.8);
    } else if (b.gateOpenProgress > targetProgress) {
      b.gateOpenProgress = Math.max(targetProgress, b.gateOpenProgress - delta * 3.8);
    }

    if (b.leftGateLeaf) {
      b.leftGateLeaf.rotation.y = -b.gateOpenProgress * 1.4;
    }
    if (b.rightGateLeaf) {
      b.rightGateLeaf.rotation.y = b.gateOpenProgress * 1.4;
    }
    if (b.portcullisMesh) {
      b.portcullisMesh.position.y = 0.65 + b.gateOpenProgress * 1.1;
    }

    const isNowOpen = b.gateOpenProgress >= 0.5;
    const wasOpen = prevProgress >= 0.5;
    if (isNowOpen !== wasOpen) {
      setCellWalkable(b.gridX, b.gridZ, isNowOpen);
      setCellWalkable(b.gridX + 1, b.gridZ, isNowOpen);
      setWallCellOccupancy(b.gridX, b.gridZ, !isNowOpen);
      setWallCellOccupancy(b.gridX + 1, b.gridZ, !isNowOpen);
    }
  }
}

function destroyWall(wall: ConstructionBuilding): void {
  scene.remove(wall.group);
  setCellWalkable(wall.gridX, wall.gridZ, true);
  setWallCellOccupancy(wall.gridX, wall.gridZ, false);
  buildingsGridMap.delete(cellKey(wall.gridX, wall.gridZ));
  const idx = buildingsList.indexOf(wall);
  if (idx !== -1) buildingsList.splice(idx, 1);
  spawnParticles(wall.worldCenter.clone().setY(0.6), 25, 0x78716c);
  spawnFloatingText(wall.worldCenter.clone().setY(1.8), '💥 Muralha Destruída!', '#ef4444');
  soundManager.buildingComplete();
  rebuildWallNeighbors(wall.gridX, wall.gridZ);
  if (selectedBuilding === wall) deselectBuilding();
}

function destroyGate(gate: ConstructionBuilding): void {
  scene.remove(gate.group);
  setCellWalkable(gate.gridX, gate.gridZ, true);
  setCellWalkable(gate.gridX + 1, gate.gridZ, true);
  setWallCellOccupancy(gate.gridX, gate.gridZ, false);
  setWallCellOccupancy(gate.gridX + 1, gate.gridZ, false);
  buildingsGridMap.delete(cellKey(gate.gridX, gate.gridZ));
  buildingsGridMap.delete(cellKey(gate.gridX + 1, gate.gridZ));
  const idx = buildingsList.indexOf(gate);
  if (idx !== -1) buildingsList.splice(idx, 1);
  spawnParticles(gate.worldCenter.clone().setY(0.8), 35, 0x78716c);
  spawnFloatingText(gate.worldCenter.clone().setY(2.2), '💥 Portão Destruído!', '#ef4444');
  soundManager.buildingComplete();
  rebuildWallNeighbors(gate.gridX - 1, gate.gridZ);
  rebuildWallNeighbors(gate.gridX + 2, gate.gridZ);
  if (selectedBuilding === gate) deselectBuilding();
}

function createGhostCollege(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 3x3
  const planeGeo = new THREE.PlaneGeometry(2.94, 2.94);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia de fundação
  const skirtGeo = new THREE.BoxGeometry(2.7, 0.8, 2.7);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Base plinto
  const baseGeo = new THREE.BoxGeometry(2.46, 0.25, 2.46);
  const baseMesh = new THREE.Mesh(baseGeo, ghostMatValid);
  baseMesh.position.y = 0.125;
  g.add(baseMesh);
  ghostMeshes.push(baseMesh);

  const baseEdges = new THREE.LineSegments(new THREE.EdgesGeometry(baseGeo), ghostEdgeMatValid);
  baseEdges.position.y = 0.125;
  g.add(baseEdges);
  ghostEdges.push(baseEdges);

  // Corpo principal
  const wallsGeo = new THREE.BoxGeometry(2.2, 1.0, 1.7);
  const walls = new THREE.Mesh(wallsGeo, ghostMatValid);
  walls.position.set(0, 0.75, -0.2);
  g.add(walls);
  ghostMeshes.push(walls);

  const wallsEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallsGeo), ghostEdgeMatValid);
  wallsEdges.position.set(0, 0.75, -0.2);
  g.add(wallsEdges);
  ghostEdges.push(wallsEdges);

  // Cúpula central
  const domeGeo = new THREE.ConeGeometry(0.7, 0.65, 8);
  const dome = new THREE.Mesh(domeGeo, ghostMatValid);
  dome.position.set(0, 1.7, -0.2);
  g.add(dome);
  ghostMeshes.push(dome);

  const domeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(domeGeo), ghostEdgeMatValid);
  domeEdges.position.set(0, 1.7, -0.2);
  g.add(domeEdges);
  ghostEdges.push(domeEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

// --- 10. GHOST BUILDING (MODELO HOLOGRÁFICO 2x2) ---
const ghostMatValid = new THREE.MeshBasicMaterial({
  color: 0x22c55e,
  transparent: true,
  opacity: 0.6,
  depthWrite: false
});
const ghostMatInvalid = new THREE.MeshBasicMaterial({
  color: 0xef4444,
  transparent: true,
  opacity: 0.6,
  depthWrite: false
});
const ghostEdgeMatValid = new THREE.LineBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.9 });
const ghostEdgeMatInvalid = new THREE.LineBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.9 });

type PlacementBuildingType = 'BARRACKS' | 'TOWER' | 'LUMBER_CAMP' | 'MINING_CAMP' | 'HOUSE' | 'MILL' | 'FARM' | 'SCHOOL' | 'COLLEGE' | 'WALL' | 'GATE' | 'ARCHERY_RANGE';
let currentPlacementType: PlacementBuildingType = 'BARRACKS';

let ghostGroup: THREE.Group;
let ghostTowerGroup: THREE.Group;
let ghostLumberGroup: THREE.Group;
let ghostMiningGroup: THREE.Group;
let ghostHouseGroup: THREE.Group;
let ghostMillGroup: THREE.Group;
let ghostFarmGroup: THREE.Group;
let ghostSchoolGroup: THREE.Group;
let ghostCollegeGroup: THREE.Group;
let ghostWallGroup: THREE.Group;
let ghostGateGroup: THREE.Group;
let ghostArcheryGroup: THREE.Group;
let ghostMeshes: THREE.Mesh[] = [];
let ghostEdges: THREE.LineSegments[] = [];

function createGhostBuilding(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia holográfica da fundação descendo no relevo
  const skirtGeo = new THREE.BoxGeometry(1.94, 0.8, 1.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Silhueta das paredes
  const wallsGeo = new THREE.BoxGeometry(1.8, 1.1, 1.8);
  const walls = new THREE.Mesh(wallsGeo, ghostMatValid);
  walls.position.y = 0.55;
  g.add(walls);
  ghostMeshes.push(walls);

  const wallsEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallsGeo), ghostEdgeMatValid);
  wallsEdges.position.y = 0.55;
  g.add(wallsEdges);
  ghostEdges.push(wallsEdges);

  // Silhueta do telhado piramidal
  const roofGeo = new THREE.ConeGeometry(1.4, 0.85, 4);
  const roof = new THREE.Mesh(roofGeo, ghostMatValid);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 1.1 + 0.42;
  g.add(roof);
  ghostMeshes.push(roof);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.y = 1.1 + 0.42;
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostTower(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 1x1
  const planeGeo = new THREE.PlaneGeometry(0.96, 0.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia holográfica da fundação descendo no relevo
  const skirtGeo = new THREE.BoxGeometry(0.94, 0.8, 0.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Silhueta do shaft da torre
  const shaftGeo = new THREE.BoxGeometry(0.72, 1.7, 0.72);
  const shaft = new THREE.Mesh(shaftGeo, ghostMatValid);
  shaft.position.y = 0.9;
  g.add(shaft);
  ghostMeshes.push(shaft);

  const shaftEdges = new THREE.LineSegments(new THREE.EdgesGeometry(shaftGeo), ghostEdgeMatValid);
  shaftEdges.position.y = 0.9;
  g.add(shaftEdges);
  ghostEdges.push(shaftEdges);

  // Balcão de observação
  const deckGeo = new THREE.BoxGeometry(0.94, 0.15, 0.94);
  const deck = new THREE.Mesh(deckGeo, ghostMatValid);
  deck.position.y = 1.82;
  g.add(deck);
  ghostMeshes.push(deck);

  const deckEdges = new THREE.LineSegments(new THREE.EdgesGeometry(deckGeo), ghostEdgeMatValid);
  deckEdges.position.y = 1.82;
  g.add(deckEdges);
  ghostEdges.push(deckEdges);

  // Silhueta do telhado piramidal
  const roofGeo = new THREE.ConeGeometry(0.68, 0.55, 4);
  const roof = new THREE.Mesh(roofGeo, ghostMatValid);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.18;
  g.add(roof);
  ghostMeshes.push(roof);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.y = 2.18;
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostLumberCamp(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia holográfica da fundação descendo no relevo
  const skirtGeo = new THREE.BoxGeometry(1.94, 0.8, 1.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Silhueta da cabana de troncos
  const cabinGeo = new THREE.BoxGeometry(1.2, 0.8, 1.05);
  const cabin = new THREE.Mesh(cabinGeo, ghostMatValid);
  cabin.position.set(-0.24, 0.42, -0.22);
  g.add(cabin);
  ghostMeshes.push(cabin);

  const cabinEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cabinGeo), ghostEdgeMatValid);
  cabinEdges.position.set(-0.24, 0.42, -0.22);
  g.add(cabinEdges);
  ghostEdges.push(cabinEdges);

  // Silhueta do telhado de duas águas
  const roofGeo = new THREE.ConeGeometry(1.0, 0.6, 4);
  const roof = new THREE.Mesh(roofGeo, ghostMatValid);
  roof.rotation.y = Math.PI / 4;
  roof.position.set(-0.24, 1.05, -0.22);
  g.add(roof);
  ghostMeshes.push(roof);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.set(-0.24, 1.05, -0.22);
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  // Silhueta da pilha de toras
  const logsGeo = new THREE.BoxGeometry(0.5, 0.35, 0.8);
  const logs = new THREE.Mesh(logsGeo, ghostMatValid);
  logs.position.set(0.55, 0.2, -0.15);
  g.add(logs);
  ghostMeshes.push(logs);

  const logsEdges = new THREE.LineSegments(new THREE.EdgesGeometry(logsGeo), ghostEdgeMatValid);
  logsEdges.position.set(0.55, 0.2, -0.15);
  g.add(logsEdges);
  ghostEdges.push(logsEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostMiningCamp(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia holográfica da fundação descendo no relevo
  const skirtGeo = new THREE.BoxGeometry(1.94, 0.8, 1.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Silhueta do galpão aberto com 4 vigas mestras
  const shedGeo = new THREE.BoxGeometry(1.25, 0.95, 1.15);
  const shed = new THREE.Mesh(shedGeo, ghostMatValid);
  shed.position.set(-0.25, 0.5, -0.2);
  g.add(shed);
  ghostMeshes.push(shed);

  const shedEdges = new THREE.LineSegments(new THREE.EdgesGeometry(shedGeo), ghostEdgeMatValid);
  shedEdges.position.set(-0.25, 0.5, -0.2);
  g.add(shedEdges);
  ghostEdges.push(shedEdges);

  // Silhueta do toldo / cobertura rústica
  const awningGeo = new THREE.BoxGeometry(1.3, 0.08, 1.2);
  const awning = new THREE.Mesh(awningGeo, ghostMatValid);
  awning.rotation.x = -0.12;
  awning.position.set(-0.25, 1.05, -0.2);
  g.add(awning);
  ghostMeshes.push(awning);

  const awningEdges = new THREE.LineSegments(new THREE.EdgesGeometry(awningGeo), ghostEdgeMatValid);
  awningEdges.rotation.x = -0.12;
  awningEdges.position.set(-0.25, 1.05, -0.2);
  g.add(awningEdges);
  ghostEdges.push(awningEdges);

  // Silhueta do carrinho / pilha de pedras
  const cartGeo = new THREE.BoxGeometry(0.5, 0.35, 0.45);
  const cart = new THREE.Mesh(cartGeo, ghostMatValid);
  cart.position.set(0.48, 0.2, 0.35);
  g.add(cart);
  ghostMeshes.push(cart);

  const cartEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cartGeo), ghostEdgeMatValid);
  cartEdges.position.set(0.48, 0.2, 0.35);
  g.add(cartEdges);
  ghostEdges.push(cartEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostHouse(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 1x1
  const planeGeo = new THREE.PlaneGeometry(0.96, 0.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia holográfica da fundação descendo no relevo
  const skirtGeo = new THREE.BoxGeometry(0.88, 0.8, 0.88);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Corpo do chalé
  const bodyGeo = new THREE.BoxGeometry(0.74, 0.58, 0.74);
  const bodyMesh = new THREE.Mesh(bodyGeo, ghostMatValid);
  bodyMesh.position.y = 0.37;
  g.add(bodyMesh);
  ghostMeshes.push(bodyMesh);

  const bodyEdges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), ghostEdgeMatValid);
  bodyEdges.position.y = 0.37;
  g.add(bodyEdges);
  ghostEdges.push(bodyEdges);

  // Telhado chalé
  const roofGeo = new THREE.ConeGeometry(0.66, 0.52, 4);
  const roof = new THREE.Mesh(roofGeo, ghostMatValid);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.94;
  g.add(roof);
  ghostMeshes.push(roof);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.y = 0.94;
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  // Chaminé
  const chimGeo = new THREE.BoxGeometry(0.14, 0.5, 0.14);
  const chim = new THREE.Mesh(chimGeo, ghostMatValid);
  chim.position.set(0.25, 0.9, -0.18);
  g.add(chim);
  ghostMeshes.push(chim);

  const chimEdges = new THREE.LineSegments(new THREE.EdgesGeometry(chimGeo), ghostEdgeMatValid);
  chimEdges.position.set(0.25, 0.9, -0.18);
  g.add(chimEdges);
  ghostEdges.push(chimEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostMill(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia de pedra
  const skirtGeo = new THREE.BoxGeometry(1.94, 0.8, 1.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Base de alvenaria
  const baseGeo = new THREE.BoxGeometry(1.7, 0.65, 1.7);
  const baseMesh = new THREE.Mesh(baseGeo, ghostMatValid);
  baseMesh.position.y = 0.325;
  g.add(baseMesh);
  ghostMeshes.push(baseMesh);

  const baseEdges = new THREE.LineSegments(new THREE.EdgesGeometry(baseGeo), ghostEdgeMatValid);
  baseEdges.position.y = 0.325;
  g.add(baseEdges);
  ghostEdges.push(baseEdges);

  // Torre superior
  const towerGeo = new THREE.BoxGeometry(1.38, 1.1, 1.38);
  const towerMesh = new THREE.Mesh(towerGeo, ghostMatValid);
  towerMesh.position.y = 1.25;
  g.add(towerMesh);
  ghostMeshes.push(towerMesh);

  const towerEdges = new THREE.LineSegments(new THREE.EdgesGeometry(towerGeo), ghostEdgeMatValid);
  towerEdges.position.y = 1.25;
  g.add(towerEdges);
  ghostEdges.push(towerEdges);

  // Telhado cônico/piramidal
  const roofGeo = new THREE.ConeGeometry(1.2, 0.85, 4);
  const roofMesh = new THREE.Mesh(roofGeo, ghostMatValid);
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.position.y = 2.26;
  g.add(roofMesh);
  ghostMeshes.push(roofMesh);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.y = 2.26;
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  // Aspas cruzadas do moinho
  const spar1Geo = new THREE.BoxGeometry(0.06, 2.1, 0.04);
  const spar1Mesh = new THREE.Mesh(spar1Geo, ghostMatValid);
  spar1Mesh.position.set(0, 1.52, 0.92);
  g.add(spar1Mesh);
  ghostMeshes.push(spar1Mesh);

  const spar2Geo = new THREE.BoxGeometry(2.1, 0.06, 0.04);
  const spar2Mesh = new THREE.Mesh(spar2Geo, ghostMatValid);
  spar2Mesh.position.set(0, 1.52, 0.92);
  g.add(spar2Mesh);
  ghostMeshes.push(spar2Mesh);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostFarm(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Solo arado
  const bedGeo = new THREE.BoxGeometry(1.96, 0.06, 1.96);
  const bedMesh = new THREE.Mesh(bedGeo, ghostMatValid);
  bedMesh.position.y = 0.03;
  g.add(bedMesh);
  ghostMeshes.push(bedMesh);

  const bedEdges = new THREE.LineSegments(new THREE.EdgesGeometry(bedGeo), ghostEdgeMatValid);
  bedEdges.position.y = 0.03;
  g.add(bedEdges);
  ghostEdges.push(bedEdges);

  // 4 Linhas de cultivo / camalhões
  for (const fx of [-0.64, -0.21, 0.21, 0.64]) {
    const ridgeGeo = new THREE.BoxGeometry(0.28, 0.04, 1.86);
    const ridgeMesh = new THREE.Mesh(ridgeGeo, ghostMatValid);
    ridgeMesh.position.set(fx, 0.07, 0);
    g.add(ridgeMesh);
    ghostMeshes.push(ridgeMesh);

    const ridgeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(ridgeGeo), ghostEdgeMatValid);
    ridgeEdges.position.set(fx, 0.07, 0);
    g.add(ridgeEdges);
    ghostEdges.push(ridgeEdges);
  }

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostSchool(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Saia de fundação
  const skirtGeo = new THREE.BoxGeometry(1.7, 0.8, 1.7);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  ghostMeshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  ghostEdges.push(skirtEdges);

  // Base de pedra
  const baseGeo = new THREE.BoxGeometry(1.7, 0.25, 1.7);
  const baseMesh = new THREE.Mesh(baseGeo, ghostMatValid);
  baseMesh.position.y = 0.125;
  g.add(baseMesh);
  ghostMeshes.push(baseMesh);

  const baseEdges = new THREE.LineSegments(new THREE.EdgesGeometry(baseGeo), ghostEdgeMatValid);
  baseEdges.position.y = 0.125;
  g.add(baseEdges);
  ghostEdges.push(baseEdges);

  // Corpo principal
  const wallsGeo = new THREE.BoxGeometry(1.4, 0.8, 1.3);
  const walls = new THREE.Mesh(wallsGeo, ghostMatValid);
  walls.position.y = 0.65;
  g.add(walls);
  ghostMeshes.push(walls);

  const wallsEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallsGeo), ghostEdgeMatValid);
  wallsEdges.position.y = 0.65;
  g.add(wallsEdges);
  ghostEdges.push(wallsEdges);

  // Telhado piramidal simétrico
  const roofGeo = new THREE.ConeGeometry(1.15, 0.6, 4);
  const roof = new THREE.Mesh(roofGeo, ghostMatValid);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 1.35;
  g.add(roof);
  ghostMeshes.push(roof);

  const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), ghostEdgeMatValid);
  roofEdges.rotation.y = Math.PI / 4;
  roofEdges.position.y = 1.35;
  g.add(roofEdges);
  ghostEdges.push(roofEdges);

  // Torre do relógio
  const towerGeo = new THREE.BoxGeometry(0.42, 0.55, 0.42);
  const tower = new THREE.Mesh(towerGeo, ghostMatValid);
  tower.position.y = 1.75;
  g.add(tower);
  ghostMeshes.push(tower);

  const towerEdges = new THREE.LineSegments(new THREE.EdgesGeometry(towerGeo), ghostEdgeMatValid);
  towerEdges.position.y = 1.75;
  g.add(towerEdges);
  ghostEdges.push(towerEdges);

  // Cúpula da torre
  const cupolaGeo = new THREE.ConeGeometry(0.32, 0.45, 4);
  const cupola = new THREE.Mesh(cupolaGeo, ghostMatValid);
  cupola.rotation.y = Math.PI / 4;
  cupola.position.y = 2.25;
  g.add(cupola);
  ghostMeshes.push(cupola);

  const cupolaEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cupolaGeo), ghostEdgeMatValid);
  cupolaEdges.rotation.y = Math.PI / 4;
  cupolaEdges.position.y = 2.25;
  g.add(cupolaEdges);
  ghostEdges.push(cupolaEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

function createGhostArcheryRange(): THREE.Group {
  const g = new THREE.Group();

  // Plano base 2x2
  const planeGeo = new THREE.PlaneGeometry(1.96, 1.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  ghostMeshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  ghostEdges.push(planeEdges);

  // Cabana
  const cabinGeo = new THREE.BoxGeometry(0.95, 1.2, 1.68);
  const cabin = new THREE.Mesh(cabinGeo, ghostMatValid);
  cabin.position.set(-0.42, 0.6, 0);
  g.add(cabin);
  ghostMeshes.push(cabin);

  const cabinEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cabinGeo), ghostEdgeMatValid);
  cabinEdges.position.set(-0.42, 0.6, 0);
  g.add(cabinEdges);
  ghostEdges.push(cabinEdges);

  // Alvo circular holográfico
  const targetGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.04, 16);
  const target = new THREE.Mesh(targetGeo, ghostMatValid);
  target.position.set(0.52, 0.6, 0);
  target.rotation.x = Math.PI / 2;
  g.add(target);
  ghostMeshes.push(target);

  const targetEdges = new THREE.LineSegments(new THREE.EdgesGeometry(targetGeo), ghostEdgeMatValid);
  targetEdges.position.set(0.52, 0.6, 0);
  targetEdges.rotation.x = Math.PI / 2;
  g.add(targetEdges);
  ghostEdges.push(targetEdges);

  g.visible = false;
  scene.add(g);
  return g;
}

ghostGroup = createGhostBuilding();
ghostTowerGroup = createGhostTower();
ghostLumberGroup = createGhostLumberCamp();
ghostMiningGroup = createGhostMiningCamp();
ghostHouseGroup = createGhostHouse();
ghostMillGroup = createGhostMill();
ghostFarmGroup = createGhostFarm();
ghostSchoolGroup = createGhostSchool();
ghostCollegeGroup = createGhostCollege();
ghostWallGroup = createGhostWall();
ghostGateGroup = createGhostGate();
ghostArcheryGroup = createGhostArcheryRange();

let isPlacementMode = false;
let ghostGridX = 0;
let ghostGridZ = 0;
export let isGhostValid = false;

export function getBuildingDimensions(type: string): { width: number; height: number } {
  switch (type) {
    case 'TOWN_CENTER':
    case 'COLLEGE':
      return { width: 3, height: 3 };
    case 'BARRACKS':
    case 'ARCHERY_RANGE':
    case 'MILL':
    case 'LUMBER_CAMP':
    case 'MINING_CAMP':
    case 'FARM':
    case 'SCHOOL':
      return { width: 2, height: 2 };
    case 'GATE':
      return { width: 2, height: 1 };
    case 'HOUSE':
    case 'WALL':
    case 'STONE_WALL':
    case 'TOWER':
    case 'WATCHTOWER':
      return { width: 1, height: 1 };
    default:
      return { width: 1, height: 1 };
  }
}

export function isCellOccupiedByBuilding(gridX: number, gridZ: number): boolean {
  const gx = Math.round(gridX);
  const gz = Math.round(gridZ);

  // 1. Town Center Aliado (3x3)
  if (tcCoord && gx >= tcCoord.minX && gx <= tcCoord.maxX && gz >= tcCoord.minZ && gz <= tcCoord.maxZ) {
    if (!townCenterState || !townCenterState.isDestroyed) {
      return true;
    }
  }

  // 2. Acampamento / Town Center Inimigo (3x3)
  if (hasEnemyFaction && enemyCampCoord) {
    const ecSize = enemyCampCoord.size || 3;
    if (gx >= enemyCampCoord.x && gx < enemyCampCoord.x + ecSize &&
        gz >= enemyCampCoord.z && gz < enemyCampCoord.z + ecSize) {
      if (!enemyCampState || !enemyCampState.isTentDestroyed) {
        return true;
      }
    }
  }

  // 3. Mapeamento direto em buildingsGridMap (O(1))
  const mapped = buildingsGridMap.get(cellKey(gx, gz));
  if (mapped && !mapped.isDepleted && (mapped.hp === undefined || mapped.hp > 0) && mapped.group?.parent !== null) {
    return true;
  }

  // 4. Tiles de muralhas / portões bloqueados
  if (blockedGridTiles.has(`${gx},${gz}`)) {
    return true;
  }

  // 5. Varredura completa em buildingsList (prontos e em obras, aliados e inimigos)
  for (const b of buildingsList) {
    if (b.isDepleted) continue;
    if (b.hp !== undefined && b.hp <= 0) continue;
    if (b.group && b.group.parent === null) continue;

    const dims = getBuildingDimensions(b.type);
    const width = b.sizeX || (b.size && b.type !== 'GATE' && b.type !== 'HOUSE' ? b.size : dims.width);
    const height = b.sizeZ || (b.size && b.type !== 'GATE' && b.type !== 'HOUSE' ? b.size : dims.height);
    const bx = Math.round(b.gridX);
    const bz = Math.round(b.gridZ);

    if (gx >= bx && gx < bx + width && gz >= bz && gz < bz + height) {
      return true;
    }
  }

  return false;
}

export function isCellOccupiedByResource(gridX: number, gridZ: number): boolean {
  const k = cellKey(Math.round(gridX), Math.round(gridZ));
  const tree = treesMap.get(k);
  if (tree && tree.wood > 0 && !tree.depleting) return true;
  const bush = berryBushesMap.get(k);
  if (bush && bush.food > 0) return true;
  const stone = stoneMinesMap.get(k);
  if (stone && stone.stone > 0) return true;
  const gold = goldMinesMap.get(k);
  if (gold && gold.gold > 0) return true;
  return false;
}

export function isValidBuildingPlacement(targetX: number, targetZ: number, buildingType: string): boolean {
  const dims = getBuildingDimensions(buildingType);
  const startX = Math.round(targetX);
  const startZ = Math.round(targetZ);

  // 1. Limites do mapa
  for (let dx = 0; dx < dims.width; dx++) {
    for (let dz = 0; dz < dims.height; dz++) {
      const cx = startX + dx;
      const cz = startZ + dz;
      if (!isCellInside(cx, cz)) {
        return false;
      }
    }
  }

  // 2. Itera por TODAS as células da pegada do novo edifício
  for (let dx = 0; dx < dims.width; dx++) {
    for (let dz = 0; dz < dims.height; dz++) {
      const cx = startX + dx;
      const cz = startZ + dz;

      // a) Verifica se há outro edifício (pronto ou em obras, aliado ou inimigo) ocupando esta célula
      if (isCellOccupiedByBuilding(cx, cz)) {
        return false;
      }

      // b) Verifica se há recursos naturais bloqueantes (árvores, minas, pedras, arbustos)
      if (isCellOccupiedByResource(cx, cz)) {
        return false;
      }

      // c) Verifica se a célula é terreno andável (não é penhasco, água ou terreno inválido)
      if (!isCellWalkable(cx, cz)) {
        return false;
      }

      // d) Verifica se há unidade viva ocupando a célula
      if (isCellOccupiedByUnit(cx, cz)) {
        if (buildingType === 'FARM') {
          // Permite que o agricultor/aldeão que acabou de colher esteja sobre o ladrilho
          const onlyFriendlyVillager = unitsList
            .filter((u) => Math.floor(u.group.position.x) === cx && Math.floor(u.group.position.z) === cz && !u.isDying && u.hp > 0)
            .every((u) => u.faction === 'PLAYER' && u.unitType === 'VILLAGER');
          if (!onlyFriendlyVillager) {
            return false;
          }
        } else {
          return false;
        }
      }
    }
  }

  return true;
}

function isCellOccupiedByUnit(gx: number, gz: number): boolean {
  for (const u of unitsList) {
    const ux = Math.floor(u.group.position.x);
    const uz = Math.floor(u.group.position.z);
    if (ux === gx && uz === gz) return true;
  }
  return false;
}

function isPlacementValid(gx: number, gz: number, sizeX = 2, sizeZ = sizeX): boolean {
  for (let dx = 0; dx < sizeX; dx++) {
    for (let dz = 0; dz < sizeZ; dz++) {
      const cx = gx + dx;
      const cz = gz + dz;
      if (!isCellInside(cx, cz)) return false;
      if (isCellOccupiedByBuilding(cx, cz)) return false;
      if (isCellOccupiedByResource(cx, cz)) return false;
      if (!isCellWalkable(cx, cz)) return false;
      if (isCellOccupiedByUnit(cx, cz)) return false;
    }
  }
  return true;
}

function setGhostValidity(valid: boolean) {
  isGhostValid = valid;
  const mat = valid ? ghostMatValid : ghostMatInvalid;
  const edgeMat = valid ? ghostEdgeMatValid : ghostEdgeMatInvalid;
  for (const m of ghostMeshes) m.material = mat;
  for (const e of ghostEdges) e.material = edgeMat;
}

// --- SISTEMA DE CONSTRUÇÃO DE MURALHAS POR ARRASTO (DRAG-TO-BUILD) ---
const wallDragTooltipEl = document.getElementById('wall-drag-tooltip');

export let isDraggingWall = false;
export let wallDragStart: { x: number; z: number } | null = null;
export let wallPreviewCells: Array<{ x: number; z: number; isValid: boolean }> = [];

interface WallPreviewMeshItem {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  edges: THREE.LineSegments[];
}

const wallPreviewPool: WallPreviewMeshItem[] = [];

function createWallPreviewMeshItem(): WallPreviewMeshItem {
  const g = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const edges: THREE.LineSegments[] = [];

  const planeGeo = new THREE.PlaneGeometry(0.96, 0.96);
  const planeMesh = new THREE.Mesh(planeGeo, ghostMatValid);
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.015;
  g.add(planeMesh);
  meshes.push(planeMesh);

  const planeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), ghostEdgeMatValid);
  planeEdges.rotation.x = -Math.PI / 2;
  planeEdges.position.y = 0.016;
  g.add(planeEdges);
  edges.push(planeEdges);

  const skirtGeo = new THREE.BoxGeometry(0.94, 0.8, 0.94);
  const skirtMesh = new THREE.Mesh(skirtGeo, ghostMatValid);
  skirtMesh.position.y = -0.4;
  g.add(skirtMesh);
  meshes.push(skirtMesh);

  const skirtEdges = new THREE.LineSegments(new THREE.EdgesGeometry(skirtGeo), ghostEdgeMatValid);
  skirtEdges.position.y = -0.4;
  g.add(skirtEdges);
  edges.push(skirtEdges);

  const wallGeo = new THREE.BoxGeometry(0.88, 1.1, 0.88);
  const wallMesh = new THREE.Mesh(wallGeo, ghostMatValid);
  wallMesh.position.y = 0.55;
  g.add(wallMesh);
  meshes.push(wallMesh);

  const wallEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo), ghostEdgeMatValid);
  wallEdges.position.y = 0.55;
  g.add(wallEdges);
  edges.push(wallEdges);

  for (const mx of [-0.3, 0.3]) {
    for (const mz of [-0.3, 0.3]) {
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), ghostMatValid);
      merlon.position.set(mx, 1.18, mz);
      g.add(merlon);
      meshes.push(merlon);
    }
  }

  g.visible = false;
  scene.add(g);
  return { group: g, meshes, edges };
}

function getWallPreviewItem(index: number): WallPreviewMeshItem {
  while (wallPreviewPool.length <= index) {
    wallPreviewPool.push(createWallPreviewMeshItem());
  }
  return wallPreviewPool[index];
}

function setWallPreviewItemValidity(item: WallPreviewMeshItem, isValid: boolean) {
  const meshMat = isValid ? ghostMatValid : ghostMatInvalid;
  const edgeMat = isValid ? ghostEdgeMatValid : ghostEdgeMatInvalid;
  for (const m of item.meshes) {
    m.material = meshMat;
  }
  for (const e of item.edges) {
    e.material = edgeMat;
  }
}

export function hideAllWallPreviews() {
  for (const item of wallPreviewPool) {
    item.group.visible = false;
  }
}

/** Calcula a linha ortogonal ("L" ou reta) entre start e end, percorrendo primeiro o eixo maior */
export function computeOrthogonalWallLine(
  start: { x: number; z: number },
  end: { x: number; z: number }
): { x: number; z: number }[] {
  const cells: { x: number; z: number }[] = [];
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const absDx = Math.abs(dx);
  const absDz = Math.abs(dz);

  const signX = dx >= 0 ? 1 : -1;
  const signZ = dz >= 0 ? 1 : -1;

  if (absDx >= absDz) {
    // Eixo maior é X: percorre X primeiro e depois Z
    for (let x = start.x; (signX > 0 ? x <= end.x : x >= end.x); x += signX) {
      cells.push({ x, z: start.z });
    }
    for (let z = start.z + signZ; (signZ > 0 ? z <= end.z : z >= end.z); z += signZ) {
      cells.push({ x: end.x, z });
    }
  } else {
    // Eixo maior é Z: percorre Z primeiro e depois X
    for (let z = start.z; (signZ > 0 ? z <= end.z : z >= end.z); z += signZ) {
      cells.push({ x: start.x, z });
    }
    for (let x = start.x + signX; (signX > 0 ? x <= end.x : x >= end.x); x += signX) {
      cells.push({ x, z: end.z });
    }
  }

  return cells;
}

export function updateWallDrag(currentGridX: number, currentGridZ: number, clientX: number, clientY: number): void {
  if (!wallDragStart) return;

  const lineCoords = computeOrthogonalWallLine(wallDragStart, { x: currentGridX, z: currentGridZ });
  wallPreviewCells = [];

  let remainingStone = resources.stone;
  let validCount = 0;

  // Oculta o ghostWallGroup padrão único enquanto arrasta
  ghostWallGroup.visible = false;

  for (let i = 0; i < lineCoords.length; i++) {
    const c = lineCoords[i];
    const canPlaceOnCell = isPlacementValid(c.x, c.z, 1, 1);
    const afford = canPlaceOnCell && remainingStone >= WALL_COST_STONE;

    if (afford) {
      remainingStone -= WALL_COST_STONE;
      validCount++;
      wallPreviewCells.push({ x: c.x, z: c.z, isValid: true });
    } else {
      wallPreviewCells.push({ x: c.x, z: c.z, isValid: false });
    }

    const item = getWallPreviewItem(i);
    const gh = getBuildingPlacementHeight(c.x, c.z, 1);
    item.group.position.set(c.x + 0.5, gh, c.z + 0.5);
    setWallPreviewItemValidity(item, afford);
    item.group.visible = true;
  }

  // Oculta itens excedentes da pool
  for (let k = lineCoords.length; k < wallPreviewPool.length; k++) {
    wallPreviewPool[k].group.visible = false;
  }

  // Atualiza Tooltip flutuante próximo ao cursor
  const totalCost = validCount * WALL_COST_STONE;
  const tooltipText = `🧱 ${validCount} Muralha${validCount !== 1 ? 's' : ''} (${totalCost} Pedra)`;
  if (wallDragTooltipEl) {
    wallDragTooltipEl.textContent = tooltipText;
    wallDragTooltipEl.style.left = `${clientX}px`;
    wallDragTooltipEl.style.top = `${clientY}px`;
    wallDragTooltipEl.style.display = 'block';
  }

  setWalkableLabel(tooltipText, validCount > 0 ? '#22c55e' : '#ef4444');
  const bannerText = document.getElementById('placement-banner-text');
  if (bannerText) {
    bannerText.textContent = `Modo Construção: ${tooltipText} • Solte para Confirmar`;
  }
}

export function finishWallDrag(shiftKey: boolean = false): void {
  if (!isDraggingWall) return;
  isDraggingWall = false;

  if (wallDragTooltipEl) {
    wallDragTooltipEl.style.display = 'none';
  }

  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
      '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
      '#ef4444'
    );
    hideAllWallPreviews();
    wallDragStart = null;
    wallPreviewCells = [];
    exitPlacementMode();
    return;
  }

  const createdWalls: ConstructionBuilding[] = [];
  let totalStoneSpent = 0;

  for (const cell of wallPreviewCells) {
    if (!cell.isValid) continue;
    if (resources.stone < WALL_COST_STONE) break;
    if (!isPlacementValid(cell.x, cell.z, 1, 1)) continue;

    resources.stone -= WALL_COST_STONE;
    totalStoneSpent += WALL_COST_STONE;

    const wall = createWallFoundation(cell.x, cell.z);
    createdWalls.push(wall);
    spawnFloatingText(new THREE.Vector3(cell.x + 0.5, 1.4, cell.z + 0.5), `-${WALL_COST_STONE} 🪨`);
  }

  if (totalStoneSpent > 0) {
    updateResourceHUD(true);
    soundManager.orderMove();
  }

  // Envia os aldeões selecionados para construir o primeiro bloco da fileira
  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0 && createdWalls.length > 0) {
    console.log(`[RTS Muralhas] ${selected.length} aldeão(ões) enviados para construir a fileira de ${createdWalls.length} muralha(s).`);
    selected.forEach((u) => commandBuild(u, createdWalls[0]));
  }

  hideAllWallPreviews();
  wallDragStart = null;
  wallPreviewCells = [];

  // Suporte à tecla Shift: se mantida e tiver pedra e arquiteto, permanece no modo
  if (shiftKey && resources.stone >= WALL_COST_STONE && hasLivingArchitect()) {
    isPlacementMode = true;
    ghostWallGroup.visible = true;
  } else {
    exitPlacementMode();
  }
}

export function cancelWallDrag(): void {
  isDraggingWall = false;
  wallDragStart = null;
  wallPreviewCells = [];
  hideAllWallPreviews();
  if (wallDragTooltipEl) {
    wallDragTooltipEl.style.display = 'none';
  }
}

/** Verifica se o jogador possui recursos para erguer determinada estrutura */
export function canAffordBuilding(type: PlacementBuildingType): boolean {
  if (type === 'WALL') return resources.stone >= WALL_COST_STONE && hasLivingArchitect();
  if (type === 'GATE') return resources.stone >= GATE_COST_STONE && resources.wood >= GATE_COST_WOOD && hasLivingArchitect();
  if (type === 'BARRACKS') return resources.wood >= BARRACKS_COST_WOOD;
  if (type === 'TOWER') return resources.stone >= TOWER_COST_STONE && resources.wood >= TOWER_COST_WOOD;
  if (type === 'LUMBER_CAMP') return resources.wood >= LUMBER_CAMP_COST_WOOD;
  if (type === 'MINING_CAMP') return resources.wood >= MINING_CAMP_COST_WOOD;
  if (type === 'HOUSE') return resources.wood >= HOUSE_COST_WOOD;
  if (type === 'MILL') return resources.wood >= MILL_COST_WOOD;
  if (type === 'FARM') return resources.wood >= FARM_COST_WOOD;
  if (type === 'SCHOOL') return resources.wood >= SCHOOL_COST_WOOD && resources.stone >= SCHOOL_COST_STONE;
  if (type === 'COLLEGE') return resources.wood >= COLLEGE_COST_WOOD && resources.stone >= COLLEGE_COST_STONE && resources.gold >= COLLEGE_COST_GOLD;
  if (type === 'ARCHERY_RANGE') return resources.wood >= ARCHERY_RANGE_COST_WOOD && resources.stone >= ARCHERY_RANGE_COST_STONE;
  return false;
}

/** Conclui a colocação de uma estrutura respeitando o suporte à tecla Shift para construções consecutivas */
export function finalizeBuildingPlacement(type: PlacementBuildingType, shiftKey: boolean = false): void {
  if (shiftKey && canAffordBuilding(type)) {
    isPlacementMode = true;
    currentPlacementType = type;
    updateHoverMarker(mousePos.x, mousePos.y);
  } else {
    exitPlacementMode();
  }
}

/** Encontra outro canteiro incompleto aliado no raio de até 4 células (priorizando muralhas) para encadeamento de obras */
export function findNearbyUnfinishedConstructionSite(
  origin: { x: number; y?: number; z?: number },
  faction: UnitFaction,
  maxRadius: number = 4.5
): ConstructionBuilding | null {
  const ox = origin.x;
  const oz = origin.z !== undefined ? origin.z : (origin.y !== undefined ? origin.y : 0);

  let bestBuilding: ConstructionBuilding | null = null;
  let bestScore = Infinity;

  for (const b of buildingsList) {
    if (b.faction !== faction) continue;
    if (b.isCompleted || b.progress >= 100) continue;
    if (b.hp !== undefined && b.hp <= 0) continue;

    const d = Math.hypot(b.worldCenter.x - ox, b.worldCenter.z - oz);
    if (d <= maxRadius) {
      // Prioriza muralhas adjacentes (peso 0 para WALL, 2 para GATE, 8 para outras obras)
      const priorityWeight = b.type === 'WALL' ? 0 : (b.type === 'GATE' ? 2 : 8);
      const score = d + priorityWeight;
      if (score < bestScore) {
        bestScore = score;
        bestBuilding = b;
      }
    }
  }

  return bestBuilding;
}

const btnBuildBarracks = document.getElementById('btn-build-barracks');
const btnBuildTower = document.getElementById('btn-build-tower');
const btnBuildLumber = document.getElementById('btn-build-lumber');
const btnBuildMining = document.getElementById('btn-build-mining');
const btnBuildHouse = document.getElementById('btn-build-house');
const btnBuildMill = document.getElementById('btn-build-mill');
const btnBuildFarm = document.getElementById('btn-build-farm');
const btnBuildSchool = document.getElementById('btn-build-school');
const btnBuildCollege = document.getElementById('btn-build-college');
const btnBuildWall = document.getElementById('btn-build-wall');
const btnBuildGate = document.getElementById('btn-build-gate');
const btnBuildArchery = document.getElementById('btn-build-archery');

const archeryPanelEl = document.getElementById('archery-panel');
const btnCloseArchery = document.getElementById('btn-close-archery');
const btnTrainArcher = document.getElementById('btn-train-archer');
const archeryQueueStatusTextEl = document.getElementById('archery-queue-status-text');
const archeryQueueProgressTrackEl = document.getElementById('archery-queue-progress-track');
const archeryQueueProgressFillEl = document.getElementById('archery-queue-progress-fill');
const archeryQueueTimerLabelEl = document.getElementById('archery-queue-timer-label');

const farmHudPanelEl = document.getElementById('farm-hud-panel');
const millHudPanelEl = document.getElementById('mill-hud-panel');
const farmFoodValEl = document.getElementById('farm-food-val');
const farmFoodBarEl = document.getElementById('farm-food-bar');
const farmFarmerValEl = document.getElementById('farm-farmer-val');
const btnReseedFarm = document.getElementById('btn-reseed-farm');
const btnCloseFarm = document.getElementById('btn-close-farm');
const btnCloseMill = document.getElementById('btn-close-mill');
const placementBannerEl = document.getElementById('placement-banner');

// Painel da Escola (#school-panel)
const schoolPanelEl = document.getElementById('school-panel');
const btnCloseSchool = document.getElementById('btn-close-school');
const schoolCapacityValEl = document.getElementById('school-capacity-val');
const schoolStudentsListEl = document.getElementById('school-students-list');
const btnEjectStudents = document.getElementById('btn-eject-students');

// Painel da Faculdade (#college-hud-panel)
const collegeHudPanelEl = document.getElementById('college-hud-panel');
const btnCloseCollege = document.getElementById('btn-close-college');
const collegeCapacityValEl = document.getElementById('college-capacity-val');
const collegeStudentsListEl = document.getElementById('college-students-list');
const btnEjectCollegeStudents = document.getElementById('btn-eject-college-students');
const btnEnrollCollegeAuto = document.getElementById('btn-enroll-college-auto');
const btnCourseArchitect = document.getElementById('btn-course-architect');
const btnCourseAgronomist = document.getElementById('btn-course-agronomist');
const btnCourseArmorer = document.getElementById('btn-course-armorer');
const btnCourseAlchemist = document.getElementById('btn-course-alchemist');
const courseDescIconEl = document.getElementById('course-desc-icon');
const courseDescTextEl = document.getElementById('course-desc-text');
const collegeDurationInfoEl = document.getElementById('college-duration-info');

// Card de Unidade Selecionada (#unit-card-panel)
const unitCardPanelEl = document.getElementById('unit-card-panel');
const unitCardAvatarEl = document.getElementById('unit-card-avatar');
const unitCardNameEl = document.getElementById('unit-card-name');
const unitCardEducationBadgeEl = document.getElementById('unit-card-education-badge');
const unitCardRoleEl = document.getElementById('unit-card-role');
const unitCardHpFillEl = document.getElementById('unit-card-hp-fill');
const unitCardHpTextEl = document.getElementById('unit-card-hp-text');
const unitCardCarryTextEl = document.getElementById('unit-card-carry-text');
const unitCardPerksEl = document.getElementById('unit-card-perks');

// Painel de Seleção Múltipla (#multi-selection-panel)
const multiSelectionPanelEl = document.getElementById('multi-selection-panel');
const multiSelectionTotalCountEl = document.getElementById('multi-selection-total-count');
const multiSubgroupsGridEl = document.getElementById('multi-subgroups-grid');
const btnMultiDeselectAll = document.getElementById('btn-multi-deselect-all');

btnMultiDeselectAll?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectAllUnits();
  deselectBuilding();
  deselectTownCenter();
  updateDeselectButtonVisibility();
  soundManager.uiClick();
});

function enterPlacementMode(type: PlacementBuildingType = 'BARRACKS') {
  if (isGameOver) return;

  // Verificação obrigatória de Arquiteto vivo para fortificações (Muralha e Portão)
  if (type === 'WALL' || type === 'GATE') {
    if (!hasLivingArchitect()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
        '#ef4444'
      );
      console.warn('[RTS Construção] Bloqueado: Fortificações requerem um Arquiteto vivo formado na Faculdade.');
      return;
    }
  }

  // Verificação obrigatória de Arquiteto vivo para Torre de Vigia
  if (type === 'TOWER') {
    if (!hasLivingArchitect()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Arquiteto para projetar Torres de Vigia!',
        '#ef4444'
      );
      console.warn('[RTS Construção] Bloqueado: Torres de Vigia requerem um Arquiteto vivo formado na Faculdade.');
      return;
    }
  }

  // Verificação obrigatória de Agrônomo vivo para Fazendas
  if (type === 'FARM') {
    if (!hasLivingAgronomist()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Agrônomo para planejar terras cultiváveis!',
        '#ef4444'
      );
      console.warn('[RTS Construção] Bloqueado: Fazendas requerem um Agrônomo vivo formado na Faculdade.');
      return;
    }
  }

  if (type === 'WALL') {
    if (resources.stone < WALL_COST_STONE) {
      console.log(`[RTS Construção] Pedra insuficiente para Muralha (${resources.stone}/${WALL_COST_STONE} 🪨).`);
      return;
    }
  } else if (type === 'GATE') {
    if (resources.stone < GATE_COST_STONE || resources.wood < GATE_COST_WOOD) {
      console.log(`[RTS Construção] Recursos insuficientes para Portão (${resources.stone}/${GATE_COST_STONE} 🪨, ${resources.wood}/${GATE_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'BARRACKS') {
    if (resources.wood < BARRACKS_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente (${resources.wood}/${BARRACKS_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'TOWER') {
    if (resources.stone < TOWER_COST_STONE || resources.wood < TOWER_COST_WOOD) {
      console.log(`[RTS Construção] Recursos insuficientes para Torre (${resources.stone}/${TOWER_COST_STONE} 🪨, ${resources.wood}/${TOWER_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'LUMBER_CAMP') {
    if (resources.wood < LUMBER_CAMP_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente para Madeireira (${resources.wood}/${LUMBER_CAMP_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'MINING_CAMP') {
    if (resources.wood < MINING_CAMP_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente para Campo de Mineração (${resources.wood}/${MINING_CAMP_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'HOUSE') {
    if (resources.wood < HOUSE_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente para Casa (${resources.wood}/${HOUSE_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'MILL') {
    if (resources.wood < MILL_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente para Moinho (${resources.wood}/${MILL_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'FARM') {
    if (resources.wood < FARM_COST_WOOD) {
      console.log(`[RTS Construção] Madeira insuficiente para Fazenda (${resources.wood}/${FARM_COST_WOOD} 🪵).`);
      return;
    }
  } else if (type === 'SCHOOL') {
    if (resources.wood < SCHOOL_COST_WOOD || resources.stone < SCHOOL_COST_STONE) {
      console.log(`[RTS Construção] Recursos insuficientes para Escola (${resources.wood}/${SCHOOL_COST_WOOD} 🪵, ${resources.stone}/${SCHOOL_COST_STONE} 🪨).`);
      return;
    }
  } else if (type === 'COLLEGE') {
    if (resources.wood < COLLEGE_COST_WOOD || resources.stone < COLLEGE_COST_STONE || resources.gold < COLLEGE_COST_GOLD) {
      console.log(`[RTS Construção] Recursos insuficientes para Faculdade (${resources.wood}/${COLLEGE_COST_WOOD} 🪵, ${resources.stone}/${COLLEGE_COST_STONE} 🪨, ${resources.gold}/${COLLEGE_COST_GOLD} 🪙).`);
      return;
    }
  } else if (type === 'ARCHERY_RANGE') {
    if (resources.wood < ARCHERY_RANGE_COST_WOOD || resources.stone < ARCHERY_RANGE_COST_STONE) {
      console.log(`[RTS Construção] Recursos insuficientes para Campo de Tiro com Arco (${resources.wood}/${ARCHERY_RANGE_COST_WOOD} 🪵, ${resources.stone}/${ARCHERY_RANGE_COST_STONE} 🪨).`);
      return;
    }
  }

  currentPlacementType = type;
  isPlacementMode = true;

  // Oculta todos os fantasmas inicialmente
  ghostGroup.visible = false;
  ghostTowerGroup.visible = false;
  ghostLumberGroup.visible = false;
  ghostMiningGroup.visible = false;
  ghostHouseGroup.visible = false;
  ghostMillGroup.visible = false;
  ghostFarmGroup.visible = false;
  ghostSchoolGroup.visible = false;
  ghostCollegeGroup.visible = false;
  ghostWallGroup.visible = false;
  ghostGateGroup.visible = false;
  ghostArcheryGroup.visible = false;

  btnBuildBarracks?.classList.remove('active');
  btnBuildTower?.classList.remove('active');
  btnBuildLumber?.classList.remove('active');
  btnBuildMining?.classList.remove('active');
  btnBuildHouse?.classList.remove('active');
  btnBuildMill?.classList.remove('active');
  btnBuildFarm?.classList.remove('active');
  btnBuildSchool?.classList.remove('active');
  btnBuildCollege?.classList.remove('active');
  btnBuildWall?.classList.remove('active');
  btnBuildGate?.classList.remove('active');
  btnBuildArchery?.classList.remove('active');

  const bannerText = document.getElementById('placement-banner-text');
  if (type === 'WALL') {
    ghostWallGroup.visible = true;
    btnBuildWall?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Muralha de Pedra [1x1] (5 🪨)';
  } else if (type === 'GATE') {
    ghostGateGroup.visible = true;
    btnBuildGate?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Portão Fortificado [2x1] (20 🪨 + 20 🪵)';
  } else if (type === 'TOWER') {
    ghostTowerGroup.visible = true;
    btnBuildTower?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Torre de Vigia [1x1]';
  } else if (type === 'LUMBER_CAMP') {
    ghostLumberGroup.visible = true;
    btnBuildLumber?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Madeireira [2x2]';
  } else if (type === 'MINING_CAMP') {
    ghostMiningGroup.visible = true;
    btnBuildMining?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Campo de Mineração [2x2]';
  } else if (type === 'HOUSE') {
    ghostHouseGroup.visible = true;
    btnBuildHouse?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Casa [1x1] (+5 População)';
  } else if (type === 'MILL') {
    ghostMillGroup.visible = true;
    btnBuildMill?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Moinho [2x2] (Depósito de Alimento)';
  } else if (type === 'FARM') {
    ghostFarmGroup.visible = true;
    btnBuildFarm?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Fazenda Agrícola [2x2] (175 Alimento)';
  } else if (type === 'SCHOOL') {
    ghostSchoolGroup.visible = true;
    btnBuildSchool?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Escola da Vila [2x2] (80 🪵 + 40 🪨)';
  } else if (type === 'COLLEGE') {
    ghostCollegeGroup.visible = true;
    btnBuildCollege?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Real Faculdade [3x3] (150 🪵 + 120 🪨 + 80 🪙)';
  } else if (type === 'ARCHERY_RANGE') {
    ghostArcheryGroup.visible = true;
    btnBuildArchery?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Campo de Tiro com Arco [2x2] (100 🪵 + 50 🪨)';
  } else {
    ghostGroup.visible = true;
    btnBuildBarracks?.classList.add('active');
    if (bannerText) bannerText.textContent = 'Modo Construção: Quartel [2x2]';
  }

  markerGroup.visible = false;
  if (placementBannerEl) placementBannerEl.style.display = 'flex';
  const nameLabel =
    type === 'WALL' ? 'Muralha de Pedra [1x1]' :
    type === 'GATE' ? 'Portão Fortificado [2x1]' :
    type === 'TOWER' ? 'Torre de Vigia [1x1]' :
    type === 'LUMBER_CAMP' ? 'Madeireira [2x2]' :
    type === 'MINING_CAMP' ? 'Campo de Mineração [2x2]' :
    type === 'HOUSE' ? 'Casa [1x1]' :
    type === 'MILL' ? 'Moinho [2x2]' :
    type === 'FARM' ? 'Fazenda [2x2]' :
    type === 'SCHOOL' ? 'Escola da Vila [2x2]' :
    type === 'COLLEGE' ? 'Real Faculdade [3x3]' :
    type === 'ARCHERY_RANGE' ? 'Campo de Tiro com Arco [2x2]' :
    'Quartel [2x2]';
  console.log(`[RTS Construção] Modo de posicionamento ativo: ${nameLabel}. [LMB] Posicionar • [RMB/Esc] Cancelar`);
}

function exitPlacementMode() {
  cancelWallDrag();
  isPlacementMode = false;
  ghostGroup.visible = false;
  ghostTowerGroup.visible = false;
  ghostLumberGroup.visible = false;
  ghostMiningGroup.visible = false;
  ghostHouseGroup.visible = false;
  ghostMillGroup.visible = false;
  ghostFarmGroup.visible = false;
  ghostSchoolGroup.visible = false;
  ghostCollegeGroup.visible = false;
  ghostWallGroup.visible = false;
  ghostGateGroup.visible = false;
  ghostArcheryGroup.visible = false;
  btnBuildBarracks?.classList.remove('active');
  btnBuildTower?.classList.remove('active');
  btnBuildLumber?.classList.remove('active');
  btnBuildMining?.classList.remove('active');
  btnBuildHouse?.classList.remove('active');
  btnBuildMill?.classList.remove('active');
  btnBuildFarm?.classList.remove('active');
  btnBuildSchool?.classList.remove('active');
  btnBuildCollege?.classList.remove('active');
  btnBuildWall?.classList.remove('active');
  btnBuildGate?.classList.remove('active');
  btnBuildArchery?.classList.remove('active');
  if (placementBannerEl) placementBannerEl.style.display = 'none';
  renderer.domElement.style.cursor = 'default';
  console.log('[RTS Construção] Modo de posicionamento cancelado.');
}

function placeArcheryRange(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'ARCHERY_RANGE')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < ARCHERY_RANGE_COST_WOOD || resources.stone < ARCHERY_RANGE_COST_STONE) {
    console.log('[RTS Construção] Recursos insuficientes para Campo de Tiro com Arco!');
    exitPlacementMode();
    return;
  }

  // Subtrai 100 madeira e 50 pedra do estoque
  resources.wood -= ARCHERY_RANGE_COST_WOOD;
  resources.stone -= ARCHERY_RANGE_COST_STONE;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${ARCHERY_RANGE_COST_WOOD} 🪵 -${ARCHERY_RANGE_COST_STONE} 🪨`);

  // Posiciona o Canteiro de Obras nas 4 células
  const building = createArcheryRangeFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro de obras do Campo de Tiro com Arco posicionado em (${gx}, ${gz}). Progresso: 0%`);

  // Se aldeões estiverem selecionados ao posicionar, direciona-os para a obra
  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) selecionados enviados para construir a obra.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('ARCHERY_RANGE', shiftKey);
}

function placeBarracks(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'BARRACKS')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < BARRACKS_COST_WOOD) {
    console.log('[RTS Construção] Madeira insuficiente para fundação!');
    exitPlacementMode();
    return;
  }

  // Subtrai 50 madeira do estoque
  resources.wood -= BARRACKS_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${BARRACKS_COST_WOOD} 🪵`);

  // Posiciona o Canteiro de Obras nas 4 células
  const building = createBarracksFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro de obras do Quartel posicionado em (${gx}, ${gz}). Progresso: 0%`);

  // Se aldeões estiverem selecionados ao posicionar, direciona-os para a obra
  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) selecionados enviados para construir a obra.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('BARRACKS', shiftKey);
}

function placeTower(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'TOWER')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 0.5, 2.0, gz + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(gx + 0.5, 2.2, gz + 0.5),
      '⚠️ Você precisa de um Arquiteto para projetar Torres de Vigia!',
      '#ef4444'
    );
    exitPlacementMode();
    return;
  }

  if (resources.stone < TOWER_COST_STONE || resources.wood < TOWER_COST_WOOD) {
    console.log('[RTS Construção] Recursos insuficientes para Torre de Vigia!');
    exitPlacementMode();
    return;
  }

  // Subtrai 70 pedra e 30 madeira
  resources.stone -= TOWER_COST_STONE;
  resources.wood -= TOWER_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 0.5, 1.4, gz + 0.5), `-${TOWER_COST_STONE} 🪨 -${TOWER_COST_WOOD} 🪵`);

  // Posiciona o Canteiro da Torre na célula 1x1
  const tower = createTowerFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Torre de Vigia posicionado em (${gx}, ${gz}). Progresso: 0%`);

  // Se aldeões estiverem selecionados ao posicionar, direciona-os para a obra
  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) selecionados enviados para construir a torre.`);
    selected.forEach((u) => commandBuild(u, tower));
  }

  finalizeBuildingPlacement('TOWER', shiftKey);
}

function placeLumberCamp(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'LUMBER_CAMP')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < LUMBER_CAMP_COST_WOOD) {
    console.log('[RTS Construção] Madeira insuficiente para Madeireira!');
    exitPlacementMode();
    return;
  }

  // Subtrai 100 madeira
  resources.wood -= LUMBER_CAMP_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${LUMBER_CAMP_COST_WOOD} 🪵`);

  const building = createLumberCampFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Madeireira posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Madeireira.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('LUMBER_CAMP', shiftKey);
}

function placeMiningCamp(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'MINING_CAMP')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < MINING_CAMP_COST_WOOD) {
    console.log('[RTS Construção] Madeira insuficiente para Campo de Mineração!');
    exitPlacementMode();
    return;
  }

  // Subtrai 100 madeira
  resources.wood -= MINING_CAMP_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${MINING_CAMP_COST_WOOD} 🪵`);

  const building = createMiningCampFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro do Campo de Mineração posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir o Campo de Mineração.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('MINING_CAMP', shiftKey);
}

function placeHouse(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'HOUSE')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 0.5, 2.0, gz + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < HOUSE_COST_WOOD) {
    console.log('[RTS Construção] Madeira insuficiente para Casa!');
    exitPlacementMode();
    return;
  }

  // Subtrai 30 madeira
  resources.wood -= HOUSE_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 0.5, 1.4, gz + 0.5), `-${HOUSE_COST_WOOD} 🪵`);

  const building = createHouseFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Casa posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Casa.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('HOUSE', shiftKey);
}

function placeMill(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'MILL')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < MILL_COST_WOOD) {
    console.log(`[RTS Construção] Madeira insuficiente para Moinho (${resources.wood}/${MILL_COST_WOOD} 🪵)!`);
    exitPlacementMode();
    return;
  }

  // Subtrai 70 madeira
  resources.wood -= MILL_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${MILL_COST_WOOD} 🪵`);

  const building = createMillFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro do Moinho posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir o Moinho.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('MILL', shiftKey);
}

function placeFarm(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'FARM')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (!hasLivingAgronomist()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(gx + 1, 2.2, gz + 1),
      '⚠️ Você precisa de um Agrônomo para planejar terras cultiváveis!',
      '#ef4444'
    );
    exitPlacementMode();
    return;
  }

  if (resources.wood < FARM_COST_WOOD) {
    console.log(`[RTS Construção] Madeira insuficiente para Fazenda (${resources.wood}/${FARM_COST_WOOD} 🪵)!`);
    exitPlacementMode();
    return;
  }

  // Subtrai 60 madeira
  resources.wood -= FARM_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${FARM_COST_WOOD} 🪵`);

  const building = createFarmFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Fazenda posicionado em (${gx}, ${gz}). Progresso: 0%`);

  // Move aldeões que estiverem sobre os blocos da fazenda para uma célula adjacente livre
  for (const u of unitsList) {
    if (u.faction === 'PLAYER' && !u.isDying && u.hp > 0) {
      const ux = Math.floor(u.group.position.x);
      const uz = Math.floor(u.group.position.z);
      if (ux >= gx && ux < gx + 2 && uz >= gz && uz < gz + 2) {
        const perimeterCell = findClosestWalkableCell(new THREE.Vector2(gx + 1, gz + 1), unitCell(u));
        commandMove(u, perimeterCell);
      }
    }
  }

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Fazenda.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('FARM', shiftKey);
}

function placeSchool(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'SCHOOL')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1, 2.0, gz + 1), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < SCHOOL_COST_WOOD || resources.stone < SCHOOL_COST_STONE) {
    console.log(`[RTS Construção] Recursos insuficientes para Escola (${resources.wood}/${SCHOOL_COST_WOOD} 🪵, ${resources.stone}/${SCHOOL_COST_STONE} 🪨)!`);
    exitPlacementMode();
    return;
  }

  // Subtrai 80 madeira e 40 pedra
  resources.wood -= SCHOOL_COST_WOOD;
  resources.stone -= SCHOOL_COST_STONE;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1, 1.4, gz + 1), `-${SCHOOL_COST_WOOD} 🪵 -${SCHOOL_COST_STONE} 🪨`);

  const building = createSchoolFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Escola posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Escola.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('SCHOOL', shiftKey);
}

function placeCollege(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'COLLEGE')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1.5, 2.0, gz + 1.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (resources.wood < COLLEGE_COST_WOOD || resources.stone < COLLEGE_COST_STONE || resources.gold < COLLEGE_COST_GOLD) {
    console.log(`[RTS Construção] Recursos insuficientes para Faculdade (${resources.wood}/${COLLEGE_COST_WOOD} 🪵, ${resources.stone}/${COLLEGE_COST_STONE} 🪨, ${resources.gold}/${COLLEGE_COST_GOLD} 🪙)!`);
    exitPlacementMode();
    return;
  }

  // Subtrai 150 madeira, 120 pedra e 80 ouro
  resources.wood -= COLLEGE_COST_WOOD;
  resources.stone -= COLLEGE_COST_STONE;
  resources.gold -= COLLEGE_COST_GOLD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1.5, 1.6, gz + 1.5), `-${COLLEGE_COST_WOOD} 🪵 -${COLLEGE_COST_STONE} 🪨 -${COLLEGE_COST_GOLD} 🪙`);

  const building = createCollegeFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Real Faculdade posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Faculdade.`);
    selected.forEach((u) => commandBuild(u, building));
  }

  finalizeBuildingPlacement('COLLEGE', shiftKey);
}

function placeWall(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'WALL')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 0.5, 2.0, gz + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(gx + 0.5, 1.4, gz + 0.5),
      '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
      '#ef4444'
    );
    exitPlacementMode();
    return;
  }

  if (resources.stone < WALL_COST_STONE) {
    console.log('[RTS Construção] Pedra insuficiente para Muralha!');
    exitPlacementMode();
    return;
  }

  resources.stone -= WALL_COST_STONE;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 0.5, 1.4, gz + 0.5), `-${WALL_COST_STONE} 🪨`);

  const wall = createWallFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro da Muralha de Pedra posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir a Muralha.`);
    selected.forEach((u) => commandBuild(u, wall));
  }

  finalizeBuildingPlacement('WALL', shiftKey);
}

function placeGate(gx: number, gz: number, shiftKey: boolean = false) {
  if (!isValidBuildingPlacement(gx, gz, 'GATE')) {
    soundManager.popCappedAlert();
    spawnFloatingText(new THREE.Vector3(gx + 1.0, 2.0, gz + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
    return;
  }

  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(gx + 1.0, 1.4, gz + 0.5),
      '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
      '#ef4444'
    );
    exitPlacementMode();
    return;
  }

  if (resources.stone < GATE_COST_STONE || resources.wood < GATE_COST_WOOD) {
    console.log('[RTS Construção] Recursos insuficientes para Portão Fortificado!');
    exitPlacementMode();
    return;
  }

  resources.stone -= GATE_COST_STONE;
  resources.wood -= GATE_COST_WOOD;
  updateResourceHUD(true);
  spawnFloatingText(new THREE.Vector3(gx + 1.0, 1.4, gz + 0.5), `-${GATE_COST_STONE} 🪨 -${GATE_COST_WOOD} 🪵`);

  const gate = createGateFoundation(gx, gz);
  console.log(`[RTS Construção] Canteiro do Portão Fortificado posicionado em (${gx}, ${gz}). Progresso: 0%`);

  const selected = getSelectedUnits().filter((u) => u.unitType === 'VILLAGER');
  if (selected.length > 0) {
    console.log(`[RTS Construção] ${selected.length} aldeão(ões) enviados para construir o Portão.`);
    selected.forEach((u) => commandBuild(u, gate));
  }

  finalizeBuildingPlacement('GATE', shiftKey);
}

// --- SELEÇÃO DE EDIFÍCIOS & FILA DE PRODUÇÃO ---
const barracksHudPanelEl = document.getElementById('barracks-hud-panel');
const btnTrainSwordsman = document.getElementById('btn-train-swordsman');
const btnCloseBarracks = document.getElementById('btn-close-barracks');
const queueStatusTextEl = document.getElementById('queue-status-text');
const queueProgressTrackEl = document.getElementById('queue-progress-track');
const queueProgressFillEl = document.getElementById('queue-progress-fill');
const queueTimerLabelEl = document.getElementById('queue-timer-label');

// Town Center HUD
const tcHudPanelEl = document.getElementById('tc-hud-panel');
const btnTrainVillager = document.getElementById('btn-train-villager');
const btnCloseTc = document.getElementById('btn-close-tc');
const tcQueueStatusTextEl = document.getElementById('tc-queue-status-text');
const tcQueueProgressTrackEl = document.getElementById('tc-queue-progress-track');
const tcQueueProgressFillEl = document.getElementById('tc-queue-progress-fill');
const tcQueueTimerLabelEl = document.getElementById('tc-queue-timer-label');
const btnRepairTc = document.getElementById('btn-repair-tc');

// Generic Building HUD & Repair
const buildingHudPanelEl = document.getElementById('building-hud-panel');
const btnCloseBuilding = document.getElementById('btn-close-building');
const btnRepairGeneric = document.getElementById('btn-repair-generic');

let selectedBuilding: ConstructionBuilding | null = null;
export let isTownCenterSelected = false;

// --- BALÕES FLUTUANTES (POPOVERS) DO HUD ---
const btnToggleEngineSettings = (document.getElementById('btn-open-settings') || document.getElementById('btn-toggle-engine-settings')) as HTMLButtonElement | null;
const engineSettingsPopoverEl = document.getElementById('engine-settings-popover');
const btnCloseEnginePopover = document.getElementById('btn-close-engine-popover');
const triggerMapSizeBadgeEl = document.getElementById('trigger-map-size-badge');

const btnToggleControls = document.getElementById('btn-toggle-controls') as HTMLButtonElement | null;
const controlsPopoverEl = document.getElementById('shortcuts-popover') || document.getElementById('controls-popover');
const btnCloseControlsPopover = document.getElementById('btn-close-controls-popover');
const pauseIndicatorEl = document.getElementById('pause-indicator');

export let isEnginePopoverOpen = false;
export let isControlsPopoverOpen = false;

// --- SISTEMA DE PAUSA E RETOMADA DA SIMULAÇÃO RTS ---
export function toggleGamePause(forceState?: boolean): boolean {
  if (isGameOver || isMatchConfigModalOpen || currentGameState === 'MENU') return isGamePaused;

  isGamePaused = forceState !== undefined ? forceState : !isGamePaused;
  const pIndicator = document.getElementById('pause-indicator');
  const pauseModal = document.getElementById('pause-menu-modal');

  if (isGamePaused) {
    if (pauseModal) pauseModal.style.display = 'flex';
    if (pIndicator) {
      pIndicator.style.display = 'none';
      pIndicator.classList.add('hidden');
    }
  } else {
    if (pauseModal) pauseModal.style.display = 'none';
    if (pIndicator) {
      pIndicator.style.display = 'none';
      pIndicator.classList.add('hidden');
    }
  }

  if (isGamePaused) {
    pauseStartTime = performance.now();
  } else {
    if (pauseStartTime > 0) {
      const pauseDuration = performance.now() - pauseStartTime;
      gameStats.startTime += pauseDuration;
      lastEnemyAiCheck += pauseDuration;
      lastInvasionWaveTime += pauseDuration;
      for (const anim of activeDeathAnimations) {
        anim.startTime += pauseDuration;
      }
      for (const m of activeMoveMarkers) {
        m.createdAt += pauseDuration;
      }
      for (const b of buildingsList) {
        if (b.lastAttackTime) b.lastAttackTime += pauseDuration;
      }
      pauseStartTime = 0;
    }
  }

  try {
    soundManager.uiClick();
  } catch (err) {
    console.warn('[Pause] Erro ao reproduzir clique de áudio:', err);
  }

  (window as any).isGamePaused = isGamePaused;
  return isGamePaused;
}

(window as any).toggleGamePause = toggleGamePause;
(window as any).isGamePaused = isGamePaused;

pauseIndicatorEl?.addEventListener('click', () => {
  toggleGamePause();
});

export function openEnginePopover(): void {
  isEnginePopoverOpen = true;
  if (engineSettingsPopoverEl) engineSettingsPopoverEl.style.display = 'flex';
  btnToggleEngineSettings?.classList.add('active');
  btnToggleEngineSettings?.setAttribute('aria-expanded', 'true');
}

export function closeEnginePopover(): void {
  isEnginePopoverOpen = false;
  if (engineSettingsPopoverEl) engineSettingsPopoverEl.style.display = 'none';
  btnToggleEngineSettings?.classList.remove('active');
  btnToggleEngineSettings?.setAttribute('aria-expanded', 'false');
}

export function toggleEnginePopover(): void {
  if (isEnginePopoverOpen) {
    closeEnginePopover();
  } else {
    closeControlsPopover();
    openEnginePopover();
  }
}

export function openControlsPopover(): void {
  isControlsPopoverOpen = true;
  if (controlsPopoverEl) controlsPopoverEl.style.display = 'flex';
  btnToggleControls?.classList.add('active');
  btnToggleControls?.setAttribute('aria-expanded', 'true');
}

export function closeControlsPopover(): void {
  isControlsPopoverOpen = false;
  if (controlsPopoverEl) controlsPopoverEl.style.display = 'none';
  btnToggleControls?.classList.remove('active');
  btnToggleControls?.setAttribute('aria-expanded', 'false');
}

export function toggleControlsPopover(): void {
  if (isControlsPopoverOpen) {
    closeControlsPopover();
  } else {
    closeEnginePopover();
    openControlsPopover();
  }
}

// Eventos de clique para abrir/fechar balões e configurações
btnToggleEngineSettings?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  openMatchConfigModal();
});

btnCloseEnginePopover?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  closeEnginePopover();
});

btnToggleControls?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  toggleControlsPopover();
});

btnCloseControlsPopover?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  closeControlsPopover();
});

// --- SISTEMA DE ÁUDIO & CONFIGURAÇÕES DE INTERFACE ---
const btnToggleAudioMute = document.getElementById('btn-toggle-audio-mute') as HTMLButtonElement | null;
const audioMuteIconEl = document.getElementById('audio-mute-icon');
const audioMuteLabelEl = document.getElementById('audio-mute-label');

const cfgSoundEnabled = document.getElementById('cfg-sound-enabled') as HTMLInputElement | null;
const valCfgSoundStatus = document.getElementById('val-cfg-sound-status');
const lblSoundEnabled = document.getElementById('lbl-sound-enabled');
const cfgSoundVolume = document.getElementById('cfg-sound-volume') as HTMLInputElement | null;
const valCfgSoundVolume = document.getElementById('val-cfg-sound-volume');
const popoverChkSound = document.getElementById('popover-chk-sound') as HTMLInputElement | null;

// Controles dedicados no Modal de Configurações
const btnToggleSoundSettings = document.getElementById('btn-toggle-sound-settings') as HTMLButtonElement | null;
const settingsSoundIcon = document.getElementById('settings-sound-icon');
const settingsSoundLabel = document.getElementById('settings-sound-label');
const valSettingsSoundStatus = document.getElementById('val-settings-sound-status');
const settingsVolumeSlider = document.getElementById('settings-volume-slider') as HTMLInputElement | null;
const valSettingsVolume = document.getElementById('val-settings-volume');

const cfgTelemetryEnabled = document.getElementById('cfg-telemetry-enabled') as HTMLInputElement | null;
const valCfgTelemetryStatus = document.getElementById('val-cfg-telemetry-status');
const popoverChkTelemetry = document.getElementById('popover-chk-telemetry') as HTMLInputElement | null;

export function updateAudioSettingsUI(): void {
  const isMuted = soundManager.getIsMuted();
  const masterVol = soundManager.getMasterVolume();
  const volPct = Math.round(masterVol * 100);

  if (btnToggleSoundSettings) {
    btnToggleSoundSettings.classList.toggle('is-muted', isMuted);
    btnToggleSoundSettings.title = isMuted ? 'Áudio Mudo (Clique para Ativar Som)' : 'Áudio Ativo (Clique para Mutar)';
  }
  if (settingsSoundIcon) {
    settingsSoundIcon.textContent = isMuted ? '🔈' : '🔊';
  }
  if (settingsSoundLabel) {
    settingsSoundLabel.textContent = isMuted ? 'Efeitos Sonoros: Desativado' : 'Efeitos Sonoros: Ativado';
  }
  if (valSettingsSoundStatus) {
    valSettingsSoundStatus.textContent = isMuted ? 'Desativado' : 'Ativado';
  }
  if (settingsVolumeSlider) {
    settingsVolumeSlider.value = String(masterVol);
  }
  if (valSettingsVolume) {
    valSettingsVolume.textContent = isMuted ? '0% (Mudo)' : `${volPct}%`;
  }
}

function updateAudioMuteUI() {
  const isMuted = soundManager.getIsMuted();
  if (btnToggleAudioMute) {
    btnToggleAudioMute.classList.toggle('is-muted', isMuted);
    btnToggleAudioMute.title = isMuted ? 'Áudio Mudo (Clique para Ativar Som)' : 'Áudio Ativo (Clique para Mutar)';
  }
  if (audioMuteIconEl) {
    audioMuteIconEl.textContent = isMuted ? '🔈' : '🔊';
  }
  if (audioMuteLabelEl) {
    audioMuteLabelEl.textContent = isMuted ? 'Mudo' : 'Som';
  }
  if (cfgSoundEnabled) {
    cfgSoundEnabled.checked = !isMuted;
  }
  if (popoverChkSound) {
    popoverChkSound.checked = !isMuted;
  }
  if (valCfgSoundStatus) {
    valCfgSoundStatus.textContent = isMuted ? 'Mudo' : 'Ativado';
  }
  if (lblSoundEnabled) {
    lblSoundEnabled.textContent = isMuted ? '🔈 Áudio Mutado (Silencioso)' : '🔊 Efeitos Sonoros Ativos';
  }
  const volPct = Math.round(soundManager.getMasterVolume() * 100);
  if (cfgSoundVolume) {
    cfgSoundVolume.value = String(volPct);
  }
  if (valCfgSoundVolume) {
    valCfgSoundVolume.textContent = `${volPct}%`;
  }
  updateAudioSettingsUI();
}

updateAudioMuteUI();

btnToggleAudioMute?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.toggleMute();
  updateAudioMuteUI();
});

btnToggleSoundSettings?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.toggleMute();
  updateAudioMuteUI();
});

settingsVolumeSlider?.addEventListener('input', (e) => {
  e.stopPropagation();
  if (!settingsVolumeSlider) return;
  const vol = parseFloat(settingsVolumeSlider.value);
  soundManager.setMasterVolume(vol);
  if (soundManager.getIsMuted() && vol > 0) {
    soundManager.setMuted(false);
  }
  updateAudioMuteUI();
});

cfgSoundEnabled?.addEventListener('change', () => {
  soundManager.setMuted(!cfgSoundEnabled.checked);
  updateAudioMuteUI();
});

popoverChkSound?.addEventListener('change', () => {
  soundManager.setMuted(!popoverChkSound.checked);
  updateAudioMuteUI();
});

cfgSoundVolume?.addEventListener('input', () => {
  if (!cfgSoundVolume) return;
  const vol = Number(cfgSoundVolume.value) / 100;
  soundManager.setMasterVolume(vol);
  if (valCfgSoundVolume) valCfgSoundVolume.textContent = `${cfgSoundVolume.value}%`;
  if (soundManager.getIsMuted() && vol > 0) {
    soundManager.setMuted(false);
  }
  updateAudioMuteUI();
});

export function setTelemetryActive(active: boolean): void {
  document.body.classList.toggle('show-telemetry-on-demand', active);
  const p = document.getElementById('telemetry-panel');
  if (active && p) {
    p.classList.remove('is-collapsed');
  }
  if (cfgTelemetryEnabled) cfgTelemetryEnabled.checked = active;
  if (popoverChkTelemetry) popoverChkTelemetry.checked = active;
  if (valCfgTelemetryStatus) valCfgTelemetryStatus.textContent = active ? 'Visível' : 'Oculto';
  try {
    localStorage.setItem('rts_telemetry_visible', String(active));
  } catch {}
}

cfgTelemetryEnabled?.addEventListener('change', () => {
  if (cfgTelemetryEnabled) setTelemetryActive(cfgTelemetryEnabled.checked);
});

popoverChkTelemetry?.addEventListener('change', () => {
  if (popoverChkTelemetry) setTelemetryActive(popoverChkTelemetry.checked);
});

// Desbloqueia e inicializa o AudioContext no primeiro gesto do usuário
const unlockAudio = () => {
  soundManager.ensureAudioContext();
  if (soundManager.ctx && soundManager.ctx.state === 'suspended') {
    soundManager.ctx.resume().catch(() => {});
  }
  window.removeEventListener('pointerdown', unlockAudio, true);
  window.removeEventListener('keydown', unlockAudio, true);
  window.removeEventListener('click', unlockAudio, true);
  document.removeEventListener('pointerdown', unlockAudio, true);
  document.removeEventListener('keydown', unlockAudio, true);
  document.removeEventListener('click', unlockAudio, true);
};
window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
window.addEventListener('keydown', unlockAudio, { once: true, capture: true });
window.addEventListener('click', unlockAudio, { once: true, capture: true });
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
document.addEventListener('keydown', unlockAudio, { once: true, capture: true });
document.addEventListener('click', unlockAudio, { once: true, capture: true });

// Impede que cliques dentro dos balões propaguem para o canvas 3D
engineSettingsPopoverEl?.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});
engineSettingsPopoverEl?.addEventListener('click', (e) => {
  e.stopPropagation();
});

controlsPopoverEl?.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});
controlsPopoverEl?.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Fechar balões ao clicar fora
window.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  if (isEnginePopoverOpen && !target.closest('#settings-dock')) {
    closeEnginePopover();
  }

  if (isControlsPopoverOpen && !target.closest('#controls-trigger-container')) {
    closeControlsPopover();
  }
});

// --- SISTEMA DE REPARO DE EDIFÍCIOS & BARRAS DE HP BILLBOARD ---
export function ensureBuildingHp(building: ConstructionBuilding): void {
  if (building.maxHp === undefined || building.maxHp <= 0) {
    if (building.type === 'TOWER') building.maxHp = 250;
    else if (building.type === 'WALL') building.maxHp = WALL_HP;
    else if (building.type === 'GATE') building.maxHp = GATE_HP;
    else if (building.type === 'COLLEGE') building.maxHp = 400;
    else if (building.size === 3) building.maxHp = 400;
    else if (building.size === 2) building.maxHp = 300;
    else building.maxHp = 150;
  }
  if (building.hp === undefined) {
    building.hp = building.maxHp;
  }
}

export function getBuildingDisplayName(type: string): string {
  switch (type) {
    case 'TOWN_CENTER': return 'Centro da Cidade';
    case 'BARRACKS': return 'Quartel';
    case 'ARCHERY_RANGE': return 'Campo de Tiro com Arco';
    case 'HOUSE': return 'Casa';
    case 'MILL': return 'Moinho';
    case 'FARM': return 'Fazenda';
    case 'LUMBER_CAMP': return 'Madeireira';
    case 'MINING_CAMP': return 'Campo de Mineração';
    case 'TOWER': return 'Torre de Vigia';
    case 'WALL': return 'Muralha de Pedra';
    case 'GATE': return 'Portão Fortificado';
    case 'SCHOOL': return 'Escola da Vila';
    case 'COLLEGE': return 'Real Faculdade';
    default: return 'Estrutura';
  }
}

export function getRepairCostRates(type: string, maxHp: number): { woodPerHp: number; stonePerHp: number } {
  let woodCost = 0;
  let stoneCost = 0;
  switch (type) {
    case 'TOWN_CENTER': woodCost = 280; stoneCost = 0; break;
    case 'BARRACKS': woodCost = BARRACKS_COST_WOOD; stoneCost = 0; break;
    case 'ARCHERY_RANGE': woodCost = ARCHERY_RANGE_COST_WOOD; stoneCost = ARCHERY_RANGE_COST_STONE; break;
    case 'HOUSE': woodCost = HOUSE_COST_WOOD; stoneCost = 0; break;
    case 'MILL': woodCost = MILL_COST_WOOD; stoneCost = 0; break;
    case 'FARM': woodCost = FARM_COST_WOOD; stoneCost = 0; break;
    case 'LUMBER_CAMP': woodCost = LUMBER_CAMP_COST_WOOD; stoneCost = 0; break;
    case 'MINING_CAMP': woodCost = MINING_CAMP_COST_WOOD; stoneCost = 0; break;
    case 'TOWER': woodCost = TOWER_COST_WOOD; stoneCost = TOWER_COST_STONE; break;
    case 'WALL': woodCost = 0; stoneCost = WALL_COST_STONE; break;
    case 'GATE': woodCost = GATE_COST_WOOD; stoneCost = GATE_COST_STONE; break;
    case 'SCHOOL': woodCost = SCHOOL_COST_WOOD; stoneCost = SCHOOL_COST_STONE; break;
    case 'COLLEGE': woodCost = COLLEGE_COST_WOOD; stoneCost = COLLEGE_COST_STONE; break;
    default: woodCost = 50; stoneCost = 0; break;
  }
  const effectiveMaxHp = Math.max(1, maxHp);
  return {
    woodPerHp: (woodCost * 0.5) / effectiveMaxHp,
    stonePerHp: (stoneCost * 0.5) / effectiveMaxHp
  };
}

export function createBuildingHpBar(building: ConstructionBuilding): { group: THREE.Group; fillMesh: THREE.Mesh } {
  const group = new THREE.Group();
  let height = 2.4;
  let barWidth = 1.6;
  if (building.type === 'TOWER') { height = 4.2; barWidth = 1.6; }
  else if (building.type === 'COLLEGE') { height = 3.8; barWidth = 2.2; }
  else if (building.type === 'GATE') { height = 3.5; barWidth = 2.0; }
  else if (building.type === 'SCHOOL' || building.type === 'MILL') { height = 3.2; barWidth = 1.8; }
  else if (building.type === 'BARRACKS' || building.type === 'ARCHERY_RANGE') { height = 3.0; barWidth = 1.8; }
  else if (building.type === 'WALL') { height = 2.0; barWidth = 1.2; }
  else if (building.type === 'FARM') { height = 1.5; barWidth = 1.6; }
  else if (building.size === 3) { height = 3.8; barWidth = 2.2; }
  else if (building.size === 2) { height = 3.0; barWidth = 1.8; }

  group.position.set(0, height, 0);

  const bgGeo = new THREE.PlaneGeometry(barWidth, 0.18);
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x090d16, side: THREE.DoubleSide });
  const bg = new THREE.Mesh(bgGeo, bgMat);
  group.add(bg);

  const fillWidth = barWidth - 0.08;
  const fillGeo = new THREE.PlaneGeometry(fillWidth, 0.12);
  const fillMat = new THREE.MeshBasicMaterial({ color: building.faction === 'ENEMY' ? 0xef4444 : 0x22c55e, side: THREE.DoubleSide });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.z = 0.005;
  group.add(fill);

  group.visible = false;
  building.group.add(group);
  building.hpBarGroup = group;
  building.hpBarFillMesh = fill;

  return { group, fillMesh: fill };
}

export function updateBuildingHpBar(building: ConstructionBuilding, now?: number): void {
  if (!building.hpBarGroup || !building.hpBarFillMesh) {
    createBuildingHpBar(building);
  }
  ensureBuildingHp(building);

  const pct = THREE.MathUtils.clamp((building.hp ?? building.maxHp ?? 1) / (building.maxHp ?? 1), 0, 1);
  building.hpBarFillMesh!.scale.x = Math.max(0.001, pct);

  let barWidth = 1.6;
  if (building.type === 'TOWER') { barWidth = 1.6; }
  else if (building.type === 'COLLEGE') { barWidth = 2.2; }
  else if (building.type === 'GATE') { barWidth = 2.0; }
  else if (building.type === 'SCHOOL' || building.type === 'MILL' || building.type === 'BARRACKS' || building.type === 'ARCHERY_RANGE') { barWidth = 1.8; }
  else if (building.type === 'WALL') { barWidth = 1.2; }
  else if (building.size === 3) { barWidth = 2.2; }
  else if (building.size === 2) { barWidth = 1.8; }

  const fillWidth = barWidth - 0.08;
  const halfW = fillWidth / 2;
  building.hpBarFillMesh!.position.x = -halfW * (1 - pct);

  const mat = building.hpBarFillMesh!.material as THREE.MeshBasicMaterial;
  if (building.faction === 'ENEMY') {
    mat.color.setHex(0xef4444);
  } else {
    if (pct > 0.5) {
      mat.color.setHex(0x22c55e);
    } else if (pct > 0.25) {
      mat.color.setHex(0xf59e0b);
    } else {
      mat.color.setHex(0xef4444);
    }
  }

  const isDamaged = (building.hp ?? 0) < (building.maxHp ?? 1);
  const isSelected = selectedBuilding === building;
  const showTemporary = now !== undefined && building.hpBarShowUntil !== undefined && building.hpBarShowUntil > now;

  if (building.isCompleted && (isDamaged || isSelected || showTemporary)) {
    building.hpBarGroup!.visible = true;
  } else {
    building.hpBarGroup!.visible = false;
  }
}

export function isTownCenterDamaged(): boolean {
  return !townCenterState.isDestroyed && townCenterState.hp < townCenterState.maxHp;
}

export function pickTownCenterPerimeterCell(unit: RTSUnit): THREE.Vector2 {
  const perim: THREE.Vector2[] = [];
  for (let x = tcCoord.minX - 1; x <= tcCoord.maxX + 1; x++) {
    for (let z = tcCoord.minZ - 1; z <= tcCoord.maxZ + 1; z++) {
      if (x >= tcCoord.minX && x <= tcCoord.maxX && z >= tcCoord.minZ && z <= tcCoord.maxZ) {
        continue;
      }
      if (isCellWalkable(x, z)) {
        perim.push(new THREE.Vector2(x, z));
      }
    }
  }
  if (perim.length === 0) {
    return findClosestWalkableCell(new THREE.Vector2(0, 0), unitCell(unit));
  }
  const pos = unit.group.position;
  let best = perim[0];
  let bestDist = Infinity;
  for (const c of perim) {
    const dist = Math.hypot(c.x + 0.5 - pos.x, c.y + 0.5 - pos.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

export function findNearbyDamagedBuilding(
  pos: THREE.Vector3,
  faction: UnitFaction,
  maxRadius = 5.0
): ConstructionBuilding | null {
  let best: ConstructionBuilding | null = null;
  let bestDist = maxRadius;

  for (const b of buildingsList) {
    if (b.isDepleted) continue;
    if (b.faction !== faction) continue;
    if (!b.isCompleted || b.progress < 100) continue;
    ensureBuildingHp(b);
    if ((b.hp ?? 0) >= (b.maxHp ?? 1)) continue;

    const d = pos.distanceTo(b.worldCenter);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

export function dispatchNearbyIdleVillagerToRepair(target: ConstructionBuilding | 'TOWN_CENTER'): boolean {
  const targetPos = target === 'TOWN_CENTER' ? TC_WORLD_CENTER : target.worldCenter;
  let nearestVillager: RTSUnit | null = null;
  let nearestDist = 12.0;

  for (const u of unitsList) {
    if (u.faction !== 'PLAYER' || u.isDying || u.unitType !== 'VILLAGER') continue;
    if (u.state !== 'IDLE') continue;
    const d = u.group.position.distanceTo(targetPos);
    if (d <= nearestDist) {
      nearestDist = d;
      nearestVillager = u;
    }
  }

  if (nearestVillager) {
    if (target === 'TOWN_CENTER') {
      commandRepairTownCenter(nearestVillager);
      spawnFloatingText(TC_WORLD_CENTER.clone().setY(2.6), '🔧 Aldeão despachado para reparar!', '#38bdf8');
    } else {
      commandRepairBuilding(nearestVillager, target);
      spawnFloatingText(target.worldCenter.clone().setY(2.6), '🔧 Aldeão despachado para reparar!', '#38bdf8');
    }
    soundManager.orderMove();
    return true;
  } else {
    spawnFloatingText(targetPos.clone().setY(2.6), '⚠️ Nenhum aldeão ocioso por perto (raio 12)!', '#f87171');
    soundManager.popCappedAlert();
    return false;
  }
}

export function updateTownCenterSelectedHUD() {
  const tcHpValEl = document.getElementById('tc-hp-val');
  const tcHpFillEl = document.getElementById('tc-hp-fill');
  const btnRepairTcEl = document.getElementById('btn-repair-tc') as HTMLButtonElement | null;
  if (!tcHpValEl || !tcHpFillEl) return;

  const hp = Math.floor(townCenterState.hp);
  const max = townCenterState.maxHp;
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));

  tcHpValEl.textContent = `${hp} / ${max} HP`;
  tcHpFillEl.style.width = `${pct}%`;
  tcHpFillEl.style.background = pct > 50 ? 'linear-gradient(90deg, #10b981, #22c55e)' : (pct > 25 ? 'linear-gradient(90deg, #f59e0b, #eab308)' : 'linear-gradient(90deg, #ef4444, #dc2626)');

  if (btnRepairTcEl) {
    btnRepairTcEl.style.display = hp < max ? 'flex' : 'none';
  }
}

export function updateBuildingSelectedHUD(building: ConstructionBuilding) {
  ensureBuildingHp(building);
  const hp = Math.floor(building.hp ?? building.maxHp ?? 1);
  const max = building.maxHp ?? 1;
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));
  const isDamaged = hp < max;

  if (selectedBuilding === building) {
    const bldTitleEl = document.getElementById('bld-panel-title');
    const bldBadgeEl = document.getElementById('bld-panel-badge');
    const bldHpValEl = document.getElementById('bld-hp-val');
    const bldHpFillEl = document.getElementById('bld-hp-fill');
    const btnRepairGeneric = document.getElementById('btn-repair-generic') as HTMLButtonElement | null;

    if (bldTitleEl) {
      const icon =
        building.type === 'HOUSE' ? '🏠' :
        building.type === 'TOWER' ? '🏹' :
        building.type === 'WALL' ? '🧱' :
        building.type === 'GATE' ? '🚪' :
        building.type === 'LUMBER_CAMP' ? '🪵' :
        building.type === 'MINING_CAMP' ? '🪨' : '🏛️';
      bldTitleEl.textContent = `${icon} ${getBuildingDisplayName(building.type)}`;
    }
    if (bldBadgeEl) {
      bldBadgeEl.textContent = building.type;
    }
    if (bldHpValEl) {
      bldHpValEl.textContent = `${hp} / ${max} HP`;
    }
    if (bldHpFillEl) {
      bldHpFillEl.style.width = `${pct}%`;
      bldHpFillEl.style.background = pct > 50 ? 'linear-gradient(90deg, #10b981, #22c55e)' : (pct > 25 ? 'linear-gradient(90deg, #f59e0b, #eab308)' : 'linear-gradient(90deg, #ef4444, #dc2626)');
    }
    if (btnRepairGeneric) {
      btnRepairGeneric.style.display = isDamaged ? 'flex' : 'none';
    }

    let specificPrefix = '';
    if (building.type === 'BARRACKS') specificPrefix = 'barracks';
    else if (building.type === 'ARCHERY_RANGE') specificPrefix = 'archery';
    else if (building.type === 'FARM') specificPrefix = 'farm';
    else if (building.type === 'MILL') specificPrefix = 'mill';
    else if (building.type === 'SCHOOL') specificPrefix = 'school';
    else if (building.type === 'COLLEGE') specificPrefix = 'college';

    if (specificPrefix) {
      const sValEl = document.getElementById(`${specificPrefix}-hp-val`);
      const sFillEl = document.getElementById(`${specificPrefix}-hp-fill`);
      const sBtnRepair = document.querySelector(`#${specificPrefix}-hud-panel .btn-repair-action`) as HTMLButtonElement | null;

      if (sValEl) sValEl.textContent = `${hp} / ${max} HP`;
      if (sFillEl) {
        sFillEl.style.width = `${pct}%`;
        sFillEl.style.background = pct > 50 ? 'linear-gradient(90deg, #10b981, #22c55e)' : (pct > 25 ? 'linear-gradient(90deg, #f59e0b, #eab308)' : 'linear-gradient(90deg, #ef4444, #dc2626)');
      }
      if (sBtnRepair) {
        sBtnRepair.style.display = isDamaged ? 'flex' : 'none';
      }
    }
  }
}

function updateDeselectButtonVisibility(): void {
  const btn = document.getElementById('btn-deselect-current');
  if (!btn) return;
  let hasUnits = false;
  try {
    if (typeof unitsList !== 'undefined' && Array.isArray(unitsList)) {
      hasUnits = unitsList.some((u) => u.isSelected);
    }
  } catch (_) {
    hasUnits = false;
  }
  const hasSelection = hasUnits || selectedBuilding !== null || isTownCenterSelected;
  btn.style.display = hasSelection ? 'inline-flex' : 'none';
}

function selectTownCenter() {
  soundManager.uiClick();
  deselectAllUnits();
  if (selectedBuilding) {
    if (selectedBuilding.selectionMesh) selectedBuilding.selectionMesh.visible = false;
    updateBuildingHpBar(selectedBuilding);
    selectedBuilding = null;
  }
  if (barracksHudPanelEl) barracksHudPanelEl.style.display = 'none';
  if (buildingHudPanelEl) buildingHudPanelEl.style.display = 'none';

  isTownCenterSelected = true;
  if (tcHudPanelEl) tcHudPanelEl.style.display = 'flex';
  updateTownCenterHUD();
  updateTownCenterSelectedHUD();
  updateTownCenterRallyHUD();
  updateRallyPointVisuals();
  updateDeselectButtonVisibility();
}

function deselectTownCenter() {
  isTownCenterSelected = false;
  if (tcHudPanelEl) tcHudPanelEl.style.display = 'none';
  updateRallyPointVisuals();
  updateDeselectButtonVisibility();
}

function selectBuilding(building: ConstructionBuilding) {
  soundManager.uiClick();
  deselectAllUnits();
  deselectTownCenter();
  if (selectedBuilding && selectedBuilding !== building) {
    if (selectedBuilding.selectionMesh) selectedBuilding.selectionMesh.visible = false;
    updateBuildingHpBar(selectedBuilding);
  }
  selectedBuilding = building;
  if (building.selectionMesh) building.selectionMesh.visible = true;

  if (barracksHudPanelEl) barracksHudPanelEl.style.display = 'none';
  if (archeryPanelEl) archeryPanelEl.style.display = 'none';
  if (farmHudPanelEl) farmHudPanelEl.style.display = 'none';
  if (millHudPanelEl) millHudPanelEl.style.display = 'none';
  if (schoolPanelEl) schoolPanelEl.style.display = 'none';
  if (collegeHudPanelEl) collegeHudPanelEl.style.display = 'none';
  if (buildingHudPanelEl) buildingHudPanelEl.style.display = 'none';

  if (building.type === 'BARRACKS' && building.isCompleted) {
    if (barracksHudPanelEl) barracksHudPanelEl.style.display = 'flex';
    updateBarracksHUD();
  } else if (building.type === 'ARCHERY_RANGE' && building.isCompleted) {
    if (archeryPanelEl) archeryPanelEl.style.display = 'flex';
    updateArcheryHUD();
  } else if (building.type === 'FARM' && building.isCompleted) {
    if (farmHudPanelEl) farmHudPanelEl.style.display = 'flex';
    updateFarmHUD();
  } else if (building.type === 'MILL' && building.isCompleted) {
    if (millHudPanelEl) millHudPanelEl.style.display = 'flex';
  } else if (building.type === 'SCHOOL' && building.isCompleted) {
    if (schoolPanelEl) schoolPanelEl.style.display = 'flex';
    updateSchoolHUD();
  } else if (building.type === 'COLLEGE' && building.isCompleted) {
    if (collegeHudPanelEl) collegeHudPanelEl.style.display = 'flex';
    updateCollegeHUD();
  } else if (building.isCompleted) {
    if (buildingHudPanelEl) buildingHudPanelEl.style.display = 'flex';
  }
  updateBuildingSelectedHUD(building);
  updateBuildingHpBar(building);
  updateBuildingRallyHUD(building);
  updateRallyPointVisuals();
  updateDeselectButtonVisibility();
}

function deselectBuilding() {
  if (selectedBuilding) {
    if (selectedBuilding.selectionMesh) selectedBuilding.selectionMesh.visible = false;
    updateBuildingHpBar(selectedBuilding);
    selectedBuilding = null;
  }
  if (barracksHudPanelEl) barracksHudPanelEl.style.display = 'none';
  if (archeryPanelEl) archeryPanelEl.style.display = 'none';
  if (farmHudPanelEl) farmHudPanelEl.style.display = 'none';
  if (millHudPanelEl) millHudPanelEl.style.display = 'none';
  if (schoolPanelEl) schoolPanelEl.style.display = 'none';
  if (collegeHudPanelEl) collegeHudPanelEl.style.display = 'none';
  if (buildingHudPanelEl) buildingHudPanelEl.style.display = 'none';
  deselectTownCenter();
  updateRallyPointVisuals();
  updateDeselectButtonVisibility();
}

function updateFarmHUD() {
  if (!selectedBuilding || selectedBuilding.type !== 'FARM' || !farmHudPanelEl) return;
  const food = selectedBuilding.farmFood ?? 0;
  const max = selectedBuilding.maxFarmFood ?? FARM_FOOD_CAPACITY;
  const pct = Math.max(0, Math.min(100, (food / max) * 100));

  if (farmFoodValEl) {
    farmFoodValEl.textContent = selectedBuilding.isDepleted
      ? `Esgotada (0 / ${max} 🍖)`
      : `${Math.ceil(food)} / ${max} 🍖`;
    farmFoodValEl.style.color = selectedBuilding.isDepleted ? '#f87171' : '#facc15';
  }
  if (farmFoodBarEl) {
    farmFoodBarEl.style.width = `${pct}%`;
    farmFoodBarEl.style.background = selectedBuilding.isDepleted
      ? '#ef4444'
      : 'linear-gradient(90deg, #ca8a04, #eab308)';
  }
  if (farmFarmerValEl) {
    const activeFarmer = selectedBuilding.assignedFarmerId
      ? unitsList.find((u) => u.id === selectedBuilding?.assignedFarmerId && !u.isDying && u.targetFarm === selectedBuilding)
      : null;
    farmFarmerValEl.textContent = activeFarmer ? '1 Aldeão Ativo (Agricultor)' : 'Nenhum';
  }
  if (btnReseedFarm) {
    if (resources.wood >= FARM_COST_WOOD) {
      btnReseedFarm.classList.remove('disabled');
      btnReseedFarm.title = selectedBuilding.isDepleted
        ? 'Renovar Fazenda (Custo: 60 Madeira) • Restaura 175 Alimento'
        : 'Reabastecer Safra (Custo: 60 Madeira) • Restaura 175 Alimento';
    } else {
      btnReseedFarm.classList.add('disabled');
      btnReseedFarm.title = `Madeira insuficiente (Requer 60 🪵 • Você tem ${resources.wood} 🪵)`;
    }
  }
}

function updateSchoolHUD() {
  if (!selectedBuilding || selectedBuilding.type !== 'SCHOOL' || !schoolPanelEl) return;
  const students = selectedBuilding.enrolledStudents ?? [];
  const max = selectedBuilding.maxStudents ?? SCHOOL_MAX_STUDENTS;
  const studyDuration = currentMatchConfig.schoolStudyDurationSec || 120;

  if (schoolCapacityValEl) {
    schoolCapacityValEl.textContent = `Alunos: ${students.length} / ${max}`;
    schoolCapacityValEl.style.color = students.length >= max ? '#f87171' : '#38bdf8';
  }

  if (btnEjectStudents) {
    if (students.length > 0) {
      btnEjectStudents.classList.remove('disabled');
      btnEjectStudents.title = 'Liberar todos os alunos matriculados';
    } else {
      btnEjectStudents.classList.add('disabled');
      btnEjectStudents.title = 'Nenhum aluno matriculado na Escola';
    }
  }

  if (schoolStudentsListEl) {
    if (students.length === 0) {
      schoolStudentsListEl.innerHTML = `
        <div class="student-empty-state" id="school-empty-state">
          <span class="empty-icon">📖</span>
          <p>Nenhum aluno matriculado.<br>Selecione aldeões comuns e clique com botão direito na Escola para estudar!</p>
        </div>
      `;
    } else {
      let html = '';
      students.forEach((s) => {
        const u = unitsList.find((unit) => unit.id === s.unitId);
        const rawId = s.unitId.split('_').pop() ?? '1';
        const name = u ? `Aldeão #${rawId}` : 'Aldeão';
        const pct = Math.min(100, Math.floor((s.progressSec / studyDuration) * 100));
        const remTime = Math.max(0, Math.ceil(studyDuration - s.progressSec));
        html += `
          <div class="student-item" data-unit-id="${s.unitId}">
            <div class="student-info-row">
              <span class="student-name">👨‍🌾 ${name}</span>
              <span class="student-pct">${pct}% (${remTime}s)</span>
              <button class="btn-eject-single" title="Desmatricular este aluno" data-unit-id="${s.unitId}">✕</button>
            </div>
            <div class="student-progress-track">
              <div class="student-progress-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        `;
      });
      schoolStudentsListEl.innerHTML = html;

      const singleEjectButtons = schoolStudentsListEl.querySelectorAll('.btn-eject-single');
      singleEjectButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const uid = (btn as HTMLElement).dataset.unitId;
          if (uid && selectedBuilding) {
            ejectStudent(uid, selectedBuilding);
          }
        });
      });
    }
  }
}

function updateSchoolHUDProgressOnly() {
  if (!selectedBuilding || selectedBuilding.type !== 'SCHOOL' || !schoolPanelEl || !schoolStudentsListEl) return;
  const students = selectedBuilding.enrolledStudents ?? [];
  const studyDuration = currentMatchConfig.schoolStudyDurationSec || 120;
  students.forEach((s) => {
    const item = schoolStudentsListEl?.querySelector(`.student-item[data-unit-id="${s.unitId}"]`);
    if (item) {
      const pct = Math.min(100, Math.floor((s.progressSec / studyDuration) * 100));
      const remTime = Math.max(0, Math.ceil(studyDuration - s.progressSec));
      const pctEl = item.querySelector('.student-pct');
      if (pctEl) pctEl.textContent = `${pct}% (${remTime}s)`;
      const fillEl = item.querySelector('.student-progress-fill') as HTMLElement | null;
      if (fillEl) fillEl.style.width = `${pct}%`;
    }
  });
}

function ejectStudent(unitId: string, school: ConstructionBuilding) {
  if (!school.enrolledStudents) return;
  const idx = school.enrolledStudents.findIndex((s) => s.unitId === unitId);
  if (idx === -1) return;
  school.enrolledStudents.splice(idx, 1);

  const unit = unitsList.find((u) => u.id === unitId);
  if (unit) {
    const perim = getBuildingPerimeterCells(school);
    const freeCell = perim.find(
      (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
    ) ?? findClosestWalkableCell(new THREE.Vector2(school.gridX + 1, school.gridZ + 1), new THREE.Vector2(school.gridX + 1, school.gridZ + 1));

    unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
    unit.group.visible = true;
    unit.isGarrisoned = false;
    unit.state = 'IDLE';
    unit.waypoints = [];
    spawnFloatingText(unit.group.position.clone().setY(1.8), 'Aluno Liberado 🏃', '#f59e0b');
    console.log(`[RTS Escola] Aldeão ${unit.id} desmatriculado da Escola.`);
  }
  updateSchoolHUD();
}

function ejectAllStudents(school: ConstructionBuilding) {
  if (!school.enrolledStudents || school.enrolledStudents.length === 0) return;
  const list = [...school.enrolledStudents];
  school.enrolledStudents = [];

  for (const s of list) {
    const unit = unitsList.find((u) => u.id === s.unitId);
    if (unit) {
      const perim = getBuildingPerimeterCells(school);
      const freeCell = perim.find(
        (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
      ) ?? findClosestWalkableCell(new THREE.Vector2(school.gridX + 1, school.gridZ + 1), new THREE.Vector2(school.gridX + 1, school.gridZ + 1));

      unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
      unit.group.visible = true;
      unit.isGarrisoned = false;
      unit.state = 'IDLE';
      unit.waypoints = [];
      spawnFloatingText(unit.group.position.clone().setY(1.8), 'Aluno Liberado 🏃', '#f59e0b');
    }
  }
  console.log(`[RTS Escola] Todos os alunos foram liberados da Escola (${school.gridX}, ${school.gridZ}).`);
  updateSchoolHUD();
}

function graduateStudent(unit: RTSUnit, school: ConstructionBuilding) {
  const perim = getBuildingPerimeterCells(school);
  const freeCell = perim.find(
    (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
  ) ?? findClosestWalkableCell(new THREE.Vector2(school.gridX + 1, school.gridZ + 1), new THREE.Vector2(school.gridX + 1, school.gridZ + 1));

  unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
  unit.group.visible = true;
  unit.isGarrisoned = false;
  unit.state = 'IDLE';
  unit.waypoints = [];

  // Concede graduação nível 1 de educação
  unit.educationLevel = 1;
  unit.carryCapacity = 20;
  unit.canEnrollInCollege = true;

  // Ativa detalhe estético distintivo na malha 3D (mochila de couro de estudante)
  if (unit.backpackMesh) {
    unit.backpackMesh.visible = true;
  }

  // Feedback audiovisual
  spawnFloatingText(unit.group.position.clone().setY(2.2), '🎓 Formado na Escola!', '#22c55e');
  spawnParticles(unit.group.position.clone().setY(1.0), 16, 0x38bdf8);
  console.log(`[RTS Formatura] Parabéns! Aldeão ${unit.id} formou-se na Escola! Agora é Cidadão Instruído (Nível 1).`);

  if (unit.isSelected) {
    updateUnitHUD();
  }
  applyRallyPointOrder(unit, school.rallyPoint);
}

function updateSchools(delta: number) {
  const studyDuration = currentMatchConfig.schoolStudyDurationSec || 120;
  for (const b of buildingsList) {
    if (b.type !== 'SCHOOL') continue;

    // Se a Escola sofrer destruição militar (HP <= 0), todos os alunos matriculados são ejetados com 50% de HP
    if (b.hp !== undefined && b.hp <= 0) {
      destroySchool(b);
      continue;
    }

    if (!b.isCompleted || !b.enrolledStudents || b.enrolledStudents.length === 0) continue;

    for (let i = b.enrolledStudents.length - 1; i >= 0; i--) {
      const student = b.enrolledStudents[i];
      student.progressSec += delta;

      if (student.progressSec >= studyDuration) {
        b.enrolledStudents.splice(i, 1);
        const unit = unitsList.find((u) => u.id === student.unitId);
        if (unit) {
          graduateStudent(unit, b);
        }
        updateSchoolHUD();
      }
    }
  }

  if (selectedBuilding && selectedBuilding.type === 'SCHOOL' && schoolPanelEl && schoolPanelEl.style.display !== 'none') {
    updateSchoolHUDProgressOnly();
  }
}

function destroySchool(school: ConstructionBuilding) {
  if (school.enrolledStudents && school.enrolledStudents.length > 0) {
    for (const student of school.enrolledStudents) {
      const unit = unitsList.find((u) => u.id === student.unitId);
      if (unit) {
        const perim = getBuildingPerimeterCells(school);
        const freeCell = perim.find(
          (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
        ) ?? findClosestWalkableCell(new THREE.Vector2(school.gridX + 1, school.gridZ + 1), new THREE.Vector2(school.gridX + 1, school.gridZ + 1));

        unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
        unit.group.visible = true;
        unit.isGarrisoned = false;
        unit.state = 'IDLE';
        unit.waypoints = [];
        unit.hp = Math.max(1, Math.round(unit.maxHp * 0.5)); // Ejetado com 50% de HP
        spawnFloatingText(unit.group.position.clone().setY(1.8), '⚠️ Ejeção de Emergência! (50% HP)', '#ef4444');
      }
    }
    school.enrolledStudents = [];
  }
  if (selectedBuilding === school) {
    deselectBuilding();
  }
}

function commandEnrollInSchool(unit: RTSUnit, school: ConstructionBuilding) {
  unit.state = 'MOVING_TO_SCHOOL';
  unit.targetSchool = school;
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetFarm = null;
  unit.dropoffBuilding = null;
  unit.dropoffTarget = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;

  // Célula da porta de entrada frontal (z + 2) ou adjacente livre
  const perim = getBuildingPerimeterCells(school);
  const frontDoorCell = perim.find((c) => c.y === school.gridZ + 2 && isCellWalkable(c.x, c.y))
    ?? perim.find((c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y))
    ?? findClosestWalkableCell(new THREE.Vector2(school.gridX + 1, school.gridZ + 2), unitCell(unit));

  setUnitPath(unit, frontDoorCell);
}

// --- MÉTODOS DA REAL FACULDADE (COLLEGE / UNIVERSITY) ---
function setCollegeCourse(course: EliteCourse) {
  if (selectedBuilding && selectedBuilding.type === 'COLLEGE') {
    selectedBuilding.selectedCollegeCourse = course;
  }
  btnCourseArchitect?.classList.toggle('active', course === 'ARCHITECT');
  btnCourseAgronomist?.classList.toggle('active', course === 'AGRONOMIST');
  btnCourseArmorer?.classList.toggle('active', course === 'ARMORER');
  btnCourseAlchemist?.classList.toggle('active', course === 'ALCHEMIST');

  if (courseDescIconEl && courseDescTextEl) {
    if (course === 'ARCHITECT') {
      courseDescIconEl.textContent = '📐';
      courseDescTextEl.innerHTML = '<strong>Arquiteto Mestre:</strong> Desbloqueia Torres de Vigia, Muralhas de pedra e Portões, e confere +30% de HP a construções.';
    } else if (course === 'AGRONOMIST') {
      courseDescIconEl.textContent = '🌾';
      courseDescTextEl.innerHTML = '<strong>Agrônomo Real:</strong> Desbloqueia Fazendas e confere +20% de velocidade de colheita de alimento em todas as fazendas.';
    } else if (course === 'ARMORER') {
      courseDescIconEl.textContent = '🛡️';
      courseDescTextEl.innerHTML = '<strong>Mestre Armeiro:</strong> Forja armaduras pesadas que concedem +30 HP a Espadachins e reduzem em 25% todo dano físico sofrido por soldados aliados.';
    } else {
      courseDescIconEl.textContent = '⚗️';
      courseDescTextEl.innerHTML = '<strong>Mestre Alquimista:</strong> Gera ouro passivo contínuo (+1 🪙/3s de trabalho) e desbloqueia armas incendiárias.';
    }
  }
}

btnCourseArchitect?.addEventListener('click', () => setCollegeCourse('ARCHITECT'));
btnCourseAgronomist?.addEventListener('click', () => setCollegeCourse('AGRONOMIST'));
btnCourseArmorer?.addEventListener('click', () => setCollegeCourse('ARMORER'));
btnCourseAlchemist?.addEventListener('click', () => setCollegeCourse('ALCHEMIST'));
btnCloseCollege?.addEventListener('click', () => deselectBuilding());
btnEjectCollegeStudents?.addEventListener('click', () => {
  if (selectedBuilding && selectedBuilding.type === 'COLLEGE') {
    ejectAllCollegeStudents(selectedBuilding);
  }
});

btnEnrollCollegeAuto?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedBuilding || selectedBuilding.type !== 'COLLEGE') return;
  const college = selectedBuilding;
  const currentEnrolled = college.enrolledStudents ? college.enrolledStudents.length : 0;
  const headingCount = unitsList.filter(
    (u) => u.state === 'MOVING_TO_COLLEGE' && u.targetCollege === college
  ).length;
  if (currentEnrolled + headingCount >= (college.maxStudents || COLLEGE_MAX_STUDENTS)) {
    spawnFloatingText(college.worldCenter.clone().setY(2.6), 'Faculdade Lotada! (3/3) 🏛️', '#f59e0b');
    soundManager.popCappedAlert();
    return;
  }

  // Busca o aldeão graduado nível 1 (Cidadão Instruído) mais próximo
  const candidates = unitsList.filter(
    (u) => u.unitType === 'VILLAGER' && u.faction === college.faction && u.educationLevel === 1 && !u.isGarrisoned && u.state !== 'MOVING_TO_COLLEGE' && u.state !== 'STUDYING' && !u.isDying
  );

  if (candidates.length === 0) {
    spawnFloatingText(college.worldCenter.clone().setY(2.6), '⚠️ Nenhum Cidadão Nível 1 disponível! Forme na Escola.', '#ef4444');
    soundManager.popCappedAlert();
    return;
  }

  candidates.sort((a, b) => {
    return a.group.position.distanceToSquared(college.worldCenter) - b.group.position.distanceToSquared(college.worldCenter);
  });

  const chosen = candidates[0];
  commandEnrollInCollege(chosen, college);
  spawnFloatingText(chosen.group.position.clone().setY(1.8), 'Convocado para Especialização! 📜', '#facc15');
  spawnFloatingText(college.worldCenter.clone().setY(2.6), '+1 Aluno Convocado! 🎓', '#38bdf8');
  soundManager.uiClick();
  updateCollegeHUD();
});

function updateCollegeHUD() {
  if (!selectedBuilding || selectedBuilding.type !== 'COLLEGE' || !collegeHudPanelEl) return;
  const students = selectedBuilding.enrolledStudents ?? [];
  const max = selectedBuilding.maxStudents ?? COLLEGE_MAX_STUDENTS;
  const studyDuration = currentMatchConfig.collegeStudyDurationSec || 240;

  if (collegeCapacityValEl) {
    collegeCapacityValEl.textContent = `Especializandos: ${students.length} / ${max}`;
    collegeCapacityValEl.style.color = students.length >= max ? '#f87171' : '#38bdf8';
  }

  if (collegeDurationInfoEl) {
    collegeDurationInfoEl.textContent = `⏱️ ${studyDuration}s de estudo`;
  }

  const activeCourse = selectedBuilding.selectedCollegeCourse || 'ARCHITECT';
  setCollegeCourse(activeCourse);

  if (btnEjectCollegeStudents) {
    if (students.length > 0) {
      btnEjectCollegeStudents.classList.remove('disabled');
      btnEjectCollegeStudents.title = 'Liberar todos os alunos matriculados na Faculdade';
    } else {
      btnEjectCollegeStudents.classList.add('disabled');
      btnEjectCollegeStudents.title = 'Nenhum mestrando em pós-graduação';
    }
  }

  if (collegeStudentsListEl) {
    if (students.length === 0) {
      collegeStudentsListEl.innerHTML = `
        <div class="student-empty-state" id="college-empty-state">
          <span class="empty-icon">📜</span>
          <p>Nenhum aluno em especialização.<br>Envie <strong>Cidadãos Instruídos (Nível 1)</strong> com botão direito!</p>
        </div>
      `;
    } else {
      let html = '';
      students.forEach((s) => {
        const u = unitsList.find((unit) => unit.id === s.unitId);
        const rawId = s.unitId.split('_').pop() ?? '1';
        const name = u ? `Cidadão #${rawId}` : 'Cidadão';
        const pct = Math.min(100, Math.floor((s.progressSec / studyDuration) * 100));
        const remTime = Math.max(0, Math.ceil(studyDuration - s.progressSec));
        const courseLabel =
          s.chosenCourse === 'ARCHITECT' ? '📐 Arquiteto' :
          s.chosenCourse === 'AGRONOMIST' ? '🌾 Agrônomo' :
          s.chosenCourse === 'ARMORER' ? '🛡️ Armeiro' : '⚗️ Alquimista';
        html += `
          <div class="student-item" data-unit-id="${s.unitId}">
            <div class="student-info-row">
              <span class="student-name">🎓 ${name}</span>
              <span class="student-course-tag">${courseLabel}</span>
              <span class="student-pct">${pct}% (${remTime}s)</span>
              <button class="btn-eject-single" title="Desmatricular este aluno" data-unit-id="${s.unitId}">✕</button>
            </div>
            <div class="student-progress-track">
              <div class="student-progress-fill college-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        `;
      });
      collegeStudentsListEl.innerHTML = html;

      const singleEjectButtons = collegeStudentsListEl.querySelectorAll('.btn-eject-single');
      singleEjectButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const uid = (btn as HTMLElement).dataset.unitId;
          if (uid && selectedBuilding) {
            ejectCollegeStudent(uid, selectedBuilding);
          }
        });
      });
    }
  }
}

function updateCollegeHUDProgressOnly() {
  if (!selectedBuilding || selectedBuilding.type !== 'COLLEGE' || !collegeHudPanelEl || !collegeStudentsListEl) return;
  const students = selectedBuilding.enrolledStudents ?? [];
  const studyDuration = currentMatchConfig.collegeStudyDurationSec || 240;
  students.forEach((s) => {
    const item = collegeStudentsListEl?.querySelector(`.student-item[data-unit-id="${s.unitId}"]`);
    if (item) {
      const pct = Math.min(100, Math.floor((s.progressSec / studyDuration) * 100));
      const remTime = Math.max(0, Math.ceil(studyDuration - s.progressSec));
      const pctEl = item.querySelector('.student-pct');
      if (pctEl) pctEl.textContent = `${pct}% (${remTime}s)`;
      const fillEl = item.querySelector('.student-progress-fill') as HTMLElement | null;
      if (fillEl) fillEl.style.width = `${pct}%`;
    }
  });
}

function ejectCollegeStudent(unitId: string, college: ConstructionBuilding) {
  if (!college.enrolledStudents) return;
  const idx = college.enrolledStudents.findIndex((s) => s.unitId === unitId);
  if (idx === -1) return;
  college.enrolledStudents.splice(idx, 1);

  const unit = unitsList.find((u) => u.id === unitId);
  if (unit) {
    const perim = getBuildingPerimeterCells(college);
    const freeCell = perim.find(
      (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
    ) ?? findClosestWalkableCell(new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5), new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5));

    unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
    unit.group.visible = true;
    unit.isGarrisoned = false;
    unit.state = 'IDLE';
    unit.waypoints = [];
    spawnFloatingText(unit.group.position.clone().setY(1.8), 'Mestrando Liberado 🏃', '#f59e0b');
    console.log(`[RTS Faculdade] Aldeão ${unit.id} desmatriculado da Faculdade.`);
  }
  updateCollegeHUD();
}

function ejectAllCollegeStudents(college: ConstructionBuilding) {
  if (!college.enrolledStudents || college.enrolledStudents.length === 0) return;
  const list = [...college.enrolledStudents];
  college.enrolledStudents = [];

  for (const s of list) {
    const unit = unitsList.find((u) => u.id === s.unitId);
    if (unit) {
      const perim = getBuildingPerimeterCells(college);
      const freeCell = perim.find(
        (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
      ) ?? findClosestWalkableCell(new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5), new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5));

      unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
      unit.group.visible = true;
      unit.isGarrisoned = false;
      unit.state = 'IDLE';
      unit.waypoints = [];
      spawnFloatingText(unit.group.position.clone().setY(1.8), 'Mestrando Liberado 🏃', '#f59e0b');
    }
  }
  console.log(`[RTS Faculdade] Todos os alunos foram liberados da Faculdade (${college.gridX}, ${college.gridZ}).`);
  updateCollegeHUD();
}

function graduateCollegeStudent(unit: RTSUnit, college: ConstructionBuilding, course: EliteCourse = 'ARCHITECT') {
  const perim = getBuildingPerimeterCells(college);
  const freeCell = perim.find(
    (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
  ) ?? findClosestWalkableCell(new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5), new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5));

  unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
  unit.group.visible = true;
  unit.isGarrisoned = false;
  unit.state = 'IDLE';
  unit.waypoints = [];

  // Concede graduação nível 2 de elite
  unit.educationLevel = 2;
  unit.eliteSpecialization = course;
  unit.specialization = course;
  unit.canEnrollInCollege = false;

  // Se Arquiteto: desbloqueia muralhas de pedra reforçadas com brasões e ameias
  if (course === 'ARCHITECT' && !isStoneWallReinforced) {
    reinforceStoneWalls();
    spawnFloatingText(college.worldCenter.clone().setY(3.2), '🛡️ Muralhas de Pedra Reforçadas Desbloqueadas!', '#38bdf8');
  }

  // Ativa itens visuais distintivos: Capelo Cerimonial, Beca Acadêmica / Avental e Aura Dourada
  if (unit.academicCapGroup) {
    unit.academicCapGroup.visible = true;
  }
  if (course === 'ARMORER') {
    if (unit.armorerEquipmentGroup) {
      unit.armorerEquipmentGroup.visible = true;
    }
    if (unit.academicGownMesh) {
      unit.academicGownMesh.visible = false;
    }
  } else {
    if (unit.academicGownMesh) {
      unit.academicGownMesh.visible = true;
    }
    if (unit.armorerEquipmentGroup) {
      unit.armorerEquipmentGroup.visible = false;
    }
  }
  if (unit.auraRingMesh && unit.isSelected) {
    unit.auraRingMesh.visible = true;
  }

  // Feedback audiovisual de elite
  const title =
    course === 'ARCHITECT' ? '📐 Arquiteto de Elite!' :
    course === 'AGRONOMIST' ? '🌾 Agrônomo Real!' :
    course === 'ARMORER' ? '🛡️ Armeiro / Mestre Forjador!' : '⚗️ Mestre Alquimista!';
  spawnFloatingText(unit.group.position.clone().setY(2.4), `🌟 Formado: ${title}`, '#facc15');
  spawnParticles(unit.group.position.clone().setY(1.2), 30, 0xfacc15);
  soundManager.buildingComplete();

  updateSwordsmenArmorerBuff();

  console.log(`[RTS Formatura Elite] Parabéns! Aldeão ${unit.id} concluiu a Faculdade e agora é ${title}`);

  if (unit.isSelected) {
    updateUnitHUD();
  }
  updateResourceHUD();
  applyRallyPointOrder(unit, college.rallyPoint);
}

function updateColleges(delta: number) {
  const studyDuration = currentMatchConfig.collegeStudyDurationSec || 240;
  for (const b of buildingsList) {
    if (b.type !== 'COLLEGE') continue;

    // Destruição militar da Faculdade (HP <= 0): ejeta alunos
    if (b.hp !== undefined && b.hp <= 0) {
      destroyCollege(b);
      continue;
    }

    if (!b.isCompleted || !b.enrolledStudents || b.enrolledStudents.length === 0) continue;

    for (let i = b.enrolledStudents.length - 1; i >= 0; i--) {
      const student = b.enrolledStudents[i];
      student.progressSec += delta;

      if (student.progressSec >= studyDuration) {
        b.enrolledStudents.splice(i, 1);
        const unit = unitsList.find((u) => u.id === student.unitId);
        if (unit) {
          graduateCollegeStudent(unit, b, student.chosenCourse || b.selectedCollegeCourse || 'ARCHITECT');
        }
        updateCollegeHUD();
      }
    }
  }

  if (selectedBuilding && selectedBuilding.type === 'COLLEGE' && collegeHudPanelEl && collegeHudPanelEl.style.display !== 'none') {
    updateCollegeHUDProgressOnly();
  }
}

function destroyCollege(college: ConstructionBuilding) {
  if (college.enrolledStudents && college.enrolledStudents.length > 0) {
    for (const student of college.enrolledStudents) {
      const unit = unitsList.find((u) => u.id === student.unitId);
      if (unit) {
        const perim = getBuildingPerimeterCells(college);
        const freeCell = perim.find(
          (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
        ) ?? findClosestWalkableCell(new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5), new THREE.Vector2(college.gridX + 1.5, college.gridZ + 1.5));

        unit.group.position.set(freeCell.x + 0.5, getTerrainHeight(freeCell.x + 0.5, freeCell.y + 0.5), freeCell.y + 0.5);
        unit.group.visible = true;
        unit.isGarrisoned = false;
        unit.state = 'IDLE';
        unit.waypoints = [];
        unit.hp = Math.max(1, Math.round(unit.maxHp * 0.5));
        spawnFloatingText(unit.group.position.clone().setY(1.8), '⚠️ Ejeção de Emergência! (50% HP)', '#ef4444');
      }
    }
    college.enrolledStudents = [];
  }
  if (selectedBuilding === college) {
    deselectBuilding();
  }
}

function commandEnrollInCollege(unit: RTSUnit, college: ConstructionBuilding) {
  // Requisito estrito de Matrícula: Aceita APENAS aldeões que já possuam a graduação de nível 1 (Cidadão Instruído formado na Escola)
  if (unit.educationLevel !== 1) {
    if (unit.educationLevel === 0) {
      soundManager.popCappedAlert();
      spawnFloatingText(unit.group.position.clone().setY(1.8), '⚠️ Requer Cidadão Instruído (Escola Nível 1)!', '#ef4444');
    } else if (unit.educationLevel >= 2) {
      spawnFloatingText(unit.group.position.clone().setY(1.8), '🌟 Já possui Especialização de Elite!', '#facc15');
    }
    return;
  }

  unit.state = 'MOVING_TO_COLLEGE';
  unit.targetCollege = college;
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetFarm = null;
  unit.targetSchool = null;
  unit.dropoffBuilding = null;
  unit.dropoffTarget = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;

  // Célula da porta frontal clássica (z + 3) ou adjacente livre
  const perim = getBuildingPerimeterCells(college);
  const frontDoorCell = perim.find((c) => c.y === college.gridZ + 3 && isCellWalkable(c.x, c.y))
    ?? perim.find((c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y))
    ?? findClosestWalkableCell(new THREE.Vector2(college.gridX + 1.5, college.gridZ + 3), unitCell(unit));

  setUnitPath(unit, frontDoorCell);
}

// Estado do card no mobile: pílula compacta (padrão) ou expandido sob demanda
let isUnitCardExpandedMobile: boolean = false;
let unitCardLastUnit: unknown = null;
const unitCardMobileMQ = window.matchMedia('(max-width: 900px), (max-height: 600px)');

function applyUnitCardMobileState() {
  if (!unitCardPanelEl) return;
  const mobile = unitCardMobileMQ.matches;
  unitCardPanelEl.classList.toggle('mobile-collapsed', mobile && !isUnitCardExpandedMobile);
  unitCardPanelEl.classList.toggle('mobile-expanded', mobile && isUnitCardExpandedMobile);
  const toggleBtn = document.getElementById('btn-toggle-unit-card');
  if (toggleBtn) {
    toggleBtn.textContent = isUnitCardExpandedMobile ? '▾' : 'ℹ️';
    toggleBtn.setAttribute('aria-expanded', String(isUnitCardExpandedMobile));
  }
}

unitCardPanelEl?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('#btn-close-unit-card') || target.closest('.btn-action')) return;
  if (!unitCardMobileMQ.matches) return;
  isUnitCardExpandedMobile = !isUnitCardExpandedMobile;
  applyUnitCardMobileState();
});
unitCardMobileMQ.addEventListener('change', applyUnitCardMobileState);

function getUnitTypeMeta(unitType: string): { name: string; icon: string } {
  switch (unitType) {
    case 'VILLAGER':
      return { name: 'Aldeões', icon: '🧑' };
    case 'SWORDSMAN':
      return { name: 'Guerreiros', icon: '⚔️' };
    case 'ARCHER':
      return { name: 'Arqueiros', icon: '🏹' };
    case 'DOCTOR':
    case 'MEDIC':
      return { name: 'Médicos', icon: '⚕️' };
    case 'ARCHITECT':
      return { name: 'Arquitetos', icon: '📐' };
    case 'AGRONOMIST':
      return { name: 'Agrônomos', icon: '🌾' };
    case 'ARMORER':
      return { name: 'Armeiros', icon: '🛡️' };
    case 'ALCHEMIST':
      return { name: 'Alquimistas', icon: '⚗️' };
    default:
      return { name: 'Unidades', icon: '🛡️' };
  }
}

function getUnitGroupKey(u: RTSUnit): string {
  if (u.unitType === 'VILLAGER') {
    if (u.educationLevel >= 2 && u.eliteSpecialization) {
      return u.eliteSpecialization;
    }
    return 'VILLAGER';
  }
  return u.unitType;
}

function updateUnitSelectionRings(): void {
  for (const u of unitsList) {
    const isSelectedAndAlive = u.isSelected && !u.isDying && !u.isGarrisoned && u.hp > 0;
    u.selectionRing.visible = isSelectedAndAlive;
    if (u.auraRingMesh) {
      u.auraRingMesh.visible = isSelectedAndAlive && u.educationLevel >= 2;
    }
  }
}

function isolateSelectionToType(targetType: string): void {
  for (const u of unitsList) {
    if (u.isSelected) {
      const match = (getUnitGroupKey(u) === targetType || u.unitType === targetType) && !u.isDying && u.hp > 0 && !u.isGarrisoned;
      if (!match) {
        u.isSelected = false;
        u.selectionRing.visible = false;
        if (u.auraRingMesh) {
          u.auraRingMesh.visible = false;
        }
      }
    }
  }

  updateUnitSelectionRings();
  soundManager.playSelectionClick();
  updateTelemetrySelectionCount();
  updateUnitHUD();
}

function renderSingleUnitCard(unit: RTSUnit): void {
  if (!unitCardPanelEl) return;

  if (unitCardLastUnit !== unit) {
    unitCardLastUnit = unit;
    isUnitCardExpandedMobile = false;
    applyUnitCardMobileState();
  }
  unitCardPanelEl.style.display = 'flex';
  if (unitCardAvatarEl) {
    if (unit.unitType === 'SWORDSMAN') {
      unitCardAvatarEl.textContent = '⚔️';
    } else if (unit.unitType === 'ARCHER') {
      unitCardAvatarEl.textContent = '🏹';
    } else if (unit.educationLevel >= 2) {
      unitCardAvatarEl.textContent =
        unit.eliteSpecialization === 'ARCHITECT' ? '📐' :
        unit.eliteSpecialization === 'AGRONOMIST' ? '🌾' :
        unit.eliteSpecialization === 'ARMORER' ? '🛡️' : '⚗️';
    } else if (unit.educationLevel >= 1) {
      unitCardAvatarEl.textContent = '🎓';
    } else {
      unitCardAvatarEl.textContent = '👨‍🌾';
    }
  }

  if (unitCardNameEl) {
    if (unit.unitType === 'SWORDSMAN') {
      unitCardNameEl.textContent = 'Espadachim';
    } else if (unit.unitType === 'ARCHER') {
      unitCardNameEl.textContent = 'Arqueiro';
    } else if (unit.educationLevel >= 2) {
      unitCardNameEl.textContent =
        unit.eliteSpecialization === 'ARCHITECT' ? 'Arquiteto Real' :
        unit.eliteSpecialization === 'AGRONOMIST' ? 'Agrônomo Real' :
        unit.eliteSpecialization === 'ARMORER' ? 'Mestre Armeiro' : 'Mestre Alquimista';
    } else if (unit.educationLevel >= 1) {
      unitCardNameEl.textContent = 'Cidadão Instruído';
    } else {
      unitCardNameEl.textContent = 'Aldeão';
    }
  }

  if (unitCardEducationBadgeEl) {
    if (unit.educationLevel >= 2) {
      unitCardEducationBadgeEl.style.display = 'inline-flex';
      unitCardEducationBadgeEl.className = 'badge-education badge-elite';
      unitCardEducationBadgeEl.textContent = '🌟 Elite';
    } else if (unit.educationLevel >= 1) {
      unitCardEducationBadgeEl.style.display = 'inline-flex';
      unitCardEducationBadgeEl.className = 'badge-education';
      unitCardEducationBadgeEl.textContent = '🎓 Graduado';
    } else {
      unitCardEducationBadgeEl.style.display = 'none';
    }
  }

  if (unitCardRoleEl) {
    if (unit.state === 'REPAIRING') {
      unitCardRoleEl.textContent = '🔧 Reparando Estrutura';
    } else if (unit.state === 'MOVING_TO_REPAIR') {
      unitCardRoleEl.textContent = '🚶 Indo Reparar Estrutura';
    } else if (unit.unitType === 'SWORDSMAN') {
      unitCardRoleEl.textContent = 'Infantaria Militar Aliada';
    } else if (unit.unitType === 'ARCHER') {
      unitCardRoleEl.textContent = 'Atirador de Precisão Aliado';
    } else if (unit.educationLevel >= 2) {
      const specName =
        unit.eliteSpecialization === 'ARCHITECT' ? '📐 Arquiteto Mestre (Fortificações & Torres)' :
        unit.eliteSpecialization === 'AGRONOMIST' ? '🌾 Agrônomo Real (Fazendas & +20% Safra)' :
        unit.eliteSpecialization === 'ARMORER' ? '🛡️ Armeiro / Mestre Forjador (+30 HP & -25% Dano)' :
        '⚗️ Mestre Alquimista (+1 🪙/3s)';
      unitCardRoleEl.textContent = specName;
    } else if (unit.educationLevel >= 1) {
      unitCardRoleEl.textContent = '🎓 Cidadão Instruído (Nível 1)';
    } else {
      unitCardRoleEl.textContent = 'Aldeão Comum (Nível 0)';
    }
  }

  if (unitCardHpFillEl) {
    const hpPct = Math.max(0, Math.min(100, (unit.hp / unit.maxHp) * 100));
    unitCardHpFillEl.style.width = `${hpPct}%`;
  }

  if (unitCardHpTextEl) {
    unitCardHpTextEl.textContent = `${Math.ceil(unit.hp)} / ${unit.maxHp} HP`;
  }

  if (unitCardCarryTextEl) {
    if (unit.unitType === 'VILLAGER') {
      const cap = unit.carryCapacity || 10;
      const resIcon =
        unit.carriedResourceType === 'WOOD' ? '🪵' :
        unit.carriedResourceType === 'FOOD' ? '🍖' :
        unit.carriedResourceType === 'STONE' ? '🪨' :
        unit.carriedResourceType === 'GOLD' ? '🪙' : '📦';
      unitCardCarryTextEl.textContent = `Carga: ${unit.carrying} / ${cap} ${resIcon}`;
    } else {
      unitCardCarryTextEl.textContent = `Ataque: ${unit.damage} Dano`;
    }
  }

  if (unitCardPerksEl) {
    if (unit.unitType === 'VILLAGER' && unit.educationLevel >= 2) {
      unitCardPerksEl.style.display = 'flex';
      if (unit.eliteSpecialization === 'ARCHITECT') {
        unitCardPerksEl.innerHTML = `
          <span class="perk-tag tag-architect-special" title="Habilita a colocação de Torres de Vigia, Muralhas e Portões">📐 Mestre Construtor de Fortificações</span>
          <span class="perk-tag" title="Capacidade de carga expandida para 20">📦 Carga: 20</span>
          <span class="perk-tag" title="Velocidade recorde de construção">🔨 Obras: +60%</span>
          <span class="perk-tag" title="+30% de HP às obras construídas">🛡️ Fortificações: +30% HP</span>
        `;
      } else if (unit.eliteSpecialization === 'AGRONOMIST') {
        unitCardPerksEl.innerHTML = `
          <span class="perk-tag tag-armorer-special" title="Especialista em botânica, solo e rotação de culturas">🌾 Agrônomo Real</span>
          <span class="perk-tag" title="Capacidade de carga expandida para 20">📦 Carga: 20</span>
          <span class="perk-tag" title="+20% de velocidade de colheita em todas as fazendas">🌾 Colheita: +20%</span>
          <span class="perk-tag" title="Dobra o rendimento de fazendas ao redor">✨ Aura Agrícola (2x)</span>
        `;
      } else if (unit.eliteSpecialization === 'ARMORER') {
        unitCardPerksEl.innerHTML = `
          <span class="perk-tag tag-armorer-special" title="Mestre da metalurgia bélica e armaduras pesadas">🛡️ Mestre Armeiro</span>
          <span class="perk-tag" title="+30 HP para tropas de infantaria">❤️ Soldados: +30 HP</span>
          <span class="perk-tag" title="-25% de dano físico recebido por soldados">🛡️ Armadura Temperada: -25% Dano</span>
          <span class="perk-tag" title="Capacidade de carga expandida para 20">📦 Carga: 20</span>
        `;
      } else {
        unitCardPerksEl.innerHTML = `
          <span class="perk-tag" title="Capacidade de carga expandida para 20">📦 Carga: 20</span>
          <span class="perk-tag" title="Gera +1 ouro a cada 3s de trabalho contínuo">🪙 Ouro Passivo</span>
          <span class="perk-tag" title="Ataques aplicam fogo e chamas alquímicas">🔥 Ataque Ígneo</span>
        `;
      }
    } else if (unit.unitType === 'VILLAGER' && unit.educationLevel >= 1) {
      unitCardPerksEl.style.display = 'flex';
      unitCardPerksEl.innerHTML = `
        <span class="perk-tag" title="Capacidade de carga expandida de 10 para 20">📦 Carga: 20</span>
        <span class="perk-tag" title="Velocidade de construção aumentada em +40%">🔨 Obras: +40%</span>
        <span class="perk-tag" title="Velocidade de coleta de todos os recursos aumentada em +25%">⛏️ Coleta: +25%</span>
      `;
    } else if (((unit.faction as string) === 'ALLIED' || !unit.isEnemy) && unit.unitType === 'SWORDSMAN' && hasLivingArmorer()) {
      unitCardPerksEl.style.display = 'flex';
      unitCardPerksEl.innerHTML = `
        <span class="perk-tag tag-armorer-shield" title="Armadura reforçada pelo Mestre Armeiro">🛡️ Armadura de Aço Reforçada (-25% dano)</span>
        <span class="perk-tag tag-armorer-buff" title="+30 de Vida Máxima concedido pelo Armeiro">❤️ Vitalidade de Ferro (+30 HP)</span>
      `;
    } else {
      unitCardPerksEl.style.display = 'none';
    }
  }
}

let lastMultiSelectionSignature: string = '';

function renderMultiSelectionPanel(activeUnits: RTSUnit[]): void {
  if (!multiSelectionPanelEl) return;
  multiSelectionPanelEl.classList.remove('hidden');
  multiSelectionPanelEl.style.display = 'block';

  if (multiSelectionTotalCountEl) {
    multiSelectionTotalCountEl.textContent = `${activeUnits.length} Unidades Selecionadas`;
  }

  if (!multiSubgroupsGridEl) return;

  // Agrupa unidades por categoria
  const groupsMap = new Map<string, RTSUnit[]>();
  for (const u of activeUnits) {
    const key = getUnitGroupKey(u);
    const list = groupsMap.get(key) || [];
    list.push(u);
    groupsMap.set(key, list);
  }

  // Assinatura para evitar recriação contínua do DOM
  const sigParts: string[] = [];
  groupsMap.forEach((units, key) => {
    const totalHp = units.reduce((acc, u) => acc + Math.ceil(u.hp), 0);
    sigParts.push(`${key}:${units.length}:${totalHp}`);
  });
  const currentSig = sigParts.join('|');

  if (currentSig === lastMultiSelectionSignature) {
    return;
  }
  lastMultiSelectionSignature = currentSig;

  multiSubgroupsGridEl.innerHTML = '';

  groupsMap.forEach((unitsOfGroup, typeKey) => {
    const meta = getUnitTypeMeta(typeKey);
    const totalHp = unitsOfGroup.reduce((acc, u) => acc + u.hp, 0);
    const totalMaxHp = unitsOfGroup.reduce((acc, u) => acc + u.maxHp, 0);
    const hpPercent = totalMaxHp > 0 ? Math.max(0, Math.min(100, Math.round((totalHp / totalMaxHp) * 100))) : 0;

    const card = document.createElement('div');
    card.className = 'subgroup-card';
    card.title = `Clique para selecionar apenas ${meta.name} (${unitsOfGroup.length})`;
    card.setAttribute('data-unit-type', typeKey);
    card.innerHTML = `
      <div class="subgroup-header-row">
        <span class="subgroup-icon">${meta.icon}</span>
        <span class="subgroup-count">${unitsOfGroup.length}</span>
      </div>
      <span class="subgroup-name">${meta.name}</span>
      <div class="subgroup-hp-bar">
        <div class="subgroup-hp-fill" style="width: ${hpPercent}%;"></div>
      </div>
    `;

    // Filtro Rápido ao Clicar no Subgrupo (Sub-selection Filter)
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      isolateSelectionToType(typeKey);
    });

    multiSubgroupsGridEl.appendChild(card);
  });
}

function updateUnitHUD(): void {
  updateDeselectButtonVisibility();
  const activeUnits = getSelectedUnits().filter((u) => !u.isDying && !u.isGarrisoned && u.hp > 0);

  // Caso 0: Nenhuma unidade selecionada
  if (activeUnits.length === 0) {
    if (unitCardPanelEl) unitCardPanelEl.style.display = 'none';
    if (multiSelectionPanelEl) {
      multiSelectionPanelEl.classList.add('hidden');
      multiSelectionPanelEl.style.display = 'none';
    }
    unitCardLastUnit = null;
    lastMultiSelectionSignature = '';
    return;
  }

  // Caso 1: Apenas 1 unidade selecionada -> Mostra o card individual clássico
  if (activeUnits.length === 1) {
    if (multiSelectionPanelEl) {
      multiSelectionPanelEl.classList.add('hidden');
      multiSelectionPanelEl.style.display = 'none';
    }
    lastMultiSelectionSignature = '';
    renderSingleUnitCard(activeUnits[0]);
    return;
  }

  // Caso 2: Múltiplas unidades selecionadas (2 ou mais) -> Ativa o painel de subgrupos
  if (unitCardPanelEl) unitCardPanelEl.style.display = 'none';
  unitCardLastUnit = null;
  renderMultiSelectionPanel(activeUnits);
}

export const updateMultiSelectionHUD = updateUnitHUD;
export const renderSelectionPanels = updateUnitHUD;

function trainVillagerAtTownCenter() {
  if (isGameOver || townCenterState.isDestroyed) return;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();

  if (currentPop + queuedPop >= popCap) {
    soundManager.popCappedAlert();
    console.log(`[RTS TC] Limite populacional atingido (${currentPop}/${popCap})! Construa Casas [H].`);
    spawnFloatingText(TC_WORLD_CENTER.clone().setY(2.8), `⚠️ Limite de População (${currentPop}/${popCap})! Construa Casas [H]`, '#f87171');
    bumpElement(resPopEl);
    return;
  }

  if (resources.food < VILLAGER_COST_FOOD) {
    console.log(`[RTS TC] Alimento insuficiente (${resources.food}/${VILLAGER_COST_FOOD} 🍖).`);
    return;
  }
  if (tcTrainingQueue.length >= 5) {
    console.log('[RTS TC] Fila de produção cheia (máximo 5).');
    return;
  }

  soundManager.uiClick();
  resources.food -= VILLAGER_COST_FOOD;
  updateResourceHUD(true);
  spawnFloatingText(TC_WORLD_CENTER.clone().setY(2.8), `-${VILLAGER_COST_FOOD} 🍖`);

  tcTrainingQueue.push({
    id: `vil_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    unitType: 'VILLAGER',
    totalDuration: VILLAGER_TRAIN_TIME
  });

  console.log(`[RTS TC] Aldeão adicionado à fila (${tcTrainingQueue.length}/5).`);
  updateTownCenterHUD();
}

function updateTownCenterHUD() {
  if (!tcHudPanelEl || !isTownCenterSelected) return;

  const isTraining = tcTrainingQueue.length > 0;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();
  const isCapped = currentPop + queuedPop >= popCap;

  if (btnTrainVillager) {
    if (resources.food >= VILLAGER_COST_FOOD && tcTrainingQueue.length < 5 && !townCenterState.isDestroyed && !isCapped) {
      btnTrainVillager.classList.remove('disabled');
      btnTrainVillager.title = 'Treinar Aldeão (Custo: 50 Alimento) • Atalho V';
    } else {
      btnTrainVillager.classList.add('disabled');
      if (isCapped) {
        btnTrainVillager.title = `Limite Populacional atingido (${currentPop}/${popCap}) • Construa Casas [H]`;
      } else if (tcTrainingQueue.length >= 5) {
        btnTrainVillager.title = 'Fila de produção cheia (5/5)';
      } else {
        btnTrainVillager.title = `Requer 50 Alimento (você tem ${resources.food})`;
      }
    }
  }

  if (tcQueueStatusTextEl) {
    tcQueueStatusTextEl.textContent = isTraining ? `${tcTrainingQueue.length}/5 Unidades` : 'Vazia (0/5)';
  }

  for (let i = 0; i < 5; i++) {
    const slotEl = document.getElementById(`tc-q-slot-${i}`);
    if (slotEl) {
      if (i < tcTrainingQueue.length) {
        slotEl.className = 'queue-slot active' + (i === 0 ? ' training' : '');
        slotEl.textContent = '👨‍🌾';
      } else {
        slotEl.className = 'queue-slot empty';
        slotEl.textContent = '';
      }
    }
  }

  if (tcQueueProgressTrackEl && tcQueueProgressFillEl && tcQueueTimerLabelEl) {
    if (isTraining) {
      tcQueueProgressTrackEl.style.display = 'block';
      tcQueueTimerLabelEl.style.display = 'block';
      const pct = (tcTrainingTimer / VILLAGER_TRAIN_TIME) * 100;
      tcQueueProgressFillEl.style.width = `${pct}%`;
      tcQueueTimerLabelEl.textContent = `${tcTrainingTimer.toFixed(1)}s / ${VILLAGER_TRAIN_TIME.toFixed(1)}s`;
    } else {
      tcQueueProgressTrackEl.style.display = 'none';
      tcQueueTimerLabelEl.style.display = 'none';
      tcQueueProgressFillEl.style.width = '0%';
    }
  }
}

function trainSwordsman(building: ConstructionBuilding) {
  if (isGameOver) return;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();

  if (currentPop + queuedPop >= popCap) {
    soundManager.popCappedAlert();
    console.log(`[RTS Quartel] Limite populacional atingido (${currentPop}/${popCap})! Construa Casas [H].`);
    spawnFloatingText(building.worldCenter.clone().setY(2.2), `⚠️ Limite de População (${currentPop}/${popCap})! Construa Casas [H]`, '#f87171');
    bumpElement(resPopEl);
    return;
  }

  if (resources.wood < SWORDSMAN_COST_WOOD || resources.gold < SWORDSMAN_COST_GOLD) {
    console.log(`[RTS Quartel] Recursos insuficientes: requer ${SWORDSMAN_COST_WOOD} 🪵 e ${SWORDSMAN_COST_GOLD} 🪙.`);
    return;
  }
  if (building.trainingQueue.length >= 5) {
    console.log('[RTS Quartel] Fila de produção cheia (máximo 5).');
    return;
  }

  soundManager.uiClick();
  resources.wood -= SWORDSMAN_COST_WOOD;
  resources.gold -= SWORDSMAN_COST_GOLD;
  updateResourceHUD(true);
  spawnFloatingText(building.worldCenter.clone().setY(2.2), `-${SWORDSMAN_COST_WOOD} 🪵 -${SWORDSMAN_COST_GOLD} 🪙`, '#facc15');

  building.trainingQueue.push({
    id: `sword_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    unitType: 'SWORDSMAN',
    totalDuration: getSwordsmanTrainTime()
  });

  console.log(`[RTS Quartel] Espadachim adicionado à fila (${building.trainingQueue.length}/5).`);
  updateBarracksHUD();
}

function updateBarracksHUD() {
  if (!selectedBuilding || !barracksHudPanelEl) return;

  const q = selectedBuilding.trainingQueue;
  const isTraining = q.length > 0;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();
  const isCapped = currentPop + queuedPop >= popCap;

  if (btnTrainSwordsman) {
    const canAfford = resources.wood >= SWORDSMAN_COST_WOOD && resources.gold >= SWORDSMAN_COST_GOLD;
    if (canAfford && q.length < 5 && !isCapped) {
      btnTrainSwordsman.classList.remove('disabled');
      btnTrainSwordsman.title = `Treinar Espadachim (Custo: ${SWORDSMAN_COST_WOOD} Madeira + ${SWORDSMAN_COST_GOLD} Ouro) • Atalho T`;
    } else {
      btnTrainSwordsman.classList.add('disabled');
      if (isCapped) {
        btnTrainSwordsman.title = `Limite Populacional atingido (${currentPop}/${popCap}) • Construa Casas [H]`;
      } else if (q.length >= 5) {
        btnTrainSwordsman.title = 'Fila de produção cheia (5/5)';
      } else {
        btnTrainSwordsman.title = `Requer ${SWORDSMAN_COST_WOOD} Madeira e ${SWORDSMAN_COST_GOLD} Ouro (você tem ${resources.wood} 🪵 / ${resources.gold} 🪙)`;
      }
    }
  }

  if (queueStatusTextEl) {
    queueStatusTextEl.textContent = isTraining ? `${q.length}/5 Unidades` : 'Vazia (0/5)';
  }

  for (let i = 0; i < 5; i++) {
    const slotEl = document.getElementById(`q-slot-${i}`);
    if (slotEl) {
      if (i < q.length) {
        slotEl.className = 'queue-slot active' + (i === 0 ? ' training' : '');
        slotEl.textContent = '🗡️';
      } else {
        slotEl.className = 'queue-slot empty';
        slotEl.textContent = '';
      }
    }
  }

  if (queueProgressTrackEl && queueProgressFillEl && queueTimerLabelEl) {
    if (isTraining) {
      queueProgressTrackEl.style.display = 'block';
      queueTimerLabelEl.style.display = 'block';
      const duration = getSwordsmanTrainTime();
      const pct = (selectedBuilding.trainingTimer / duration) * 100;
      queueProgressFillEl.style.width = `${pct}%`;
      queueTimerLabelEl.textContent = `${selectedBuilding.trainingTimer.toFixed(1)}s / ${duration.toFixed(1)}s`;
    } else {
      queueProgressTrackEl.style.display = 'none';
      queueTimerLabelEl.style.display = 'none';
      queueProgressFillEl.style.width = '0%';
    }
  }
}

function trainArcher(building: ConstructionBuilding) {
  if (isGameOver) return;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();

  if (currentPop + queuedPop >= popCap) {
    soundManager.popCappedAlert();
    console.log(`[RTS Tiro com Arco] Limite populacional atingido (${currentPop}/${popCap})! Construa Casas [H].`);
    spawnFloatingText(building.worldCenter.clone().setY(2.2), `⚠️ Limite de População (${currentPop}/${popCap})! Construa Casas [H]`, '#f87171');
    bumpElement(resPopEl);
    return;
  }

  if (resources.wood < ARCHER_COST_WOOD || resources.gold < ARCHER_COST_GOLD) {
    console.log(`[RTS Tiro com Arco] Recursos insuficientes: requer ${ARCHER_COST_WOOD} 🪵 e ${ARCHER_COST_GOLD} 🪙.`);
    return;
  }
  if (building.trainingQueue.length >= 5) {
    console.log('[RTS Tiro com Arco] Fila de produção cheia (máximo 5).');
    return;
  }

  soundManager.uiClick();
  resources.wood -= ARCHER_COST_WOOD;
  resources.gold -= ARCHER_COST_GOLD;
  updateResourceHUD(true);
  spawnFloatingText(building.worldCenter.clone().setY(2.2), `-${ARCHER_COST_WOOD} 🪵 -${ARCHER_COST_GOLD} 🪙`, '#facc15');

  building.trainingQueue.push({
    id: `archer_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    unitType: 'ARCHER',
    totalDuration: ARCHER_TRAIN_TIME_SEC
  });

  console.log(`[RTS Tiro com Arco] Arqueiro adicionado à fila (${building.trainingQueue.length}/5).`);
  updateArcheryHUD();
}

function updateArcheryHUD() {
  if (!selectedBuilding || selectedBuilding.type !== 'ARCHERY_RANGE' || !archeryPanelEl) return;

  const q = selectedBuilding.trainingQueue;
  const isTraining = q.length > 0;
  const currentPop = getCurrentPlayerPopulation();
  const queuedPop = getTotalQueuedPlayerUnits();
  const popCap = getPopulationCap();
  const isCapped = currentPop + queuedPop >= popCap;

  if (btnTrainArcher) {
    const canAfford = resources.wood >= ARCHER_COST_WOOD && resources.gold >= ARCHER_COST_GOLD;
    if (canAfford && q.length < 5 && !isCapped) {
      btnTrainArcher.classList.remove('disabled');
      btnTrainArcher.title = `🏹 Treinar Arqueiro (Custo: ${ARCHER_COST_WOOD} Madeira + ${ARCHER_COST_GOLD} Ouro) • Atalho R`;
    } else {
      btnTrainArcher.classList.add('disabled');
      if (isCapped) {
        btnTrainArcher.title = `Limite Populacional atingido (${currentPop}/${popCap}) • Construa Casas [H]`;
      } else if (q.length >= 5) {
        btnTrainArcher.title = 'Fila de produção cheia (5/5)';
      } else {
        btnTrainArcher.title = `Requer ${ARCHER_COST_WOOD} Madeira e ${ARCHER_COST_GOLD} Ouro (você tem ${resources.wood} 🪵 / ${resources.gold} 🪙)`;
      }
    }
  }

  if (archeryQueueStatusTextEl) {
    archeryQueueStatusTextEl.textContent = isTraining ? `${q.length}/5 Unidades` : 'Vazia (0/5)';
  }

  for (let i = 0; i < 5; i++) {
    const slotEl = document.getElementById(`archery-q-slot-${i}`);
    if (slotEl) {
      if (i < q.length) {
        slotEl.className = 'queue-slot active' + (i === 0 ? ' training' : '');
        slotEl.textContent = '🏹';
      } else {
        slotEl.className = 'queue-slot empty';
        slotEl.textContent = '';
      }
    }
  }

  if (archeryQueueProgressTrackEl && archeryQueueProgressFillEl && archeryQueueTimerLabelEl) {
    if (isTraining) {
      archeryQueueProgressTrackEl.style.display = 'block';
      archeryQueueTimerLabelEl.style.display = 'block';
      const duration = ARCHER_TRAIN_TIME_SEC;
      const pct = Math.min(100, (selectedBuilding.trainingTimer / duration) * 100);
      archeryQueueProgressFillEl.style.width = `${pct}%`;
      archeryQueueTimerLabelEl.textContent = `${selectedBuilding.trainingTimer.toFixed(1)}s / ${duration.toFixed(1)}s`;
    } else {
      archeryQueueProgressTrackEl.style.display = 'none';
      archeryQueueTimerLabelEl.style.display = 'none';
      archeryQueueProgressFillEl.style.width = '0%';
    }
  }
}

// --- 11. RAYCASTING & GRID CURSOR ---
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2(-999, -999);
const groundIntersect = new THREE.Vector3();

const markerGroup = new THREE.Group();
markerGroup.visible = false;
scene.add(markerGroup);

const markerPlaneGeo = new THREE.PlaneGeometry(0.98, 0.98);
const markerPlaneMat = new THREE.MeshBasicMaterial({
  color: 0x38bdf8,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
  depthWrite: false
});
const markerPlane = new THREE.Mesh(markerPlaneGeo, markerPlaneMat);
markerPlane.rotation.x = -Math.PI / 2;
markerPlane.position.y = 0.015;
markerGroup.add(markerPlane);

const markerEdgesMat = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9 });
const markerEdges = new THREE.LineSegments(new THREE.EdgesGeometry(markerPlaneGeo), markerEdgesMat);
markerEdges.rotation.x = -Math.PI / 2;
markerEdges.position.y = 0.016;
markerGroup.add(markerEdges);

function createCornerAccents(): THREE.LineSegments {
  const points: THREE.Vector3[] = [];
  const s = 0.48;
  const l = 0.16;
  for (const [cx, cz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
    points.push(new THREE.Vector3(cx, 0.018, cz), new THREE.Vector3(cx - Math.sign(cx) * l, 0.018, cz));
    points.push(new THREE.Vector3(cx, 0.018, cz), new THREE.Vector3(cx, 0.018, cz - Math.sign(cz) * l));
  }
  return new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0x38bdf8 })
  );
}
markerGroup.add(createCornerAccents());

function setPointerNDC(clientX: number, clientY: number) {
  const rect = renderer.domElement.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || window.innerHeight;
  pointerNDC.x = ((clientX - rect.left) / width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
}

function raycastGridCell(clientX: number, clientY: number): { gridX: number; gridZ: number; isInside: boolean; walkable: boolean } | null {
  setPointerNDC(clientX, clientY);
  const hits = raycaster.intersectObject(groundMesh, false);
  if (hits.length > 0) {
    const pt = hits[0].point;
    const gridX = Math.floor(pt.x);
    const gridZ = Math.floor(pt.z);
    return { gridX, gridZ, isInside: isCellInside(gridX, gridZ), walkable: isCellWalkable(gridX, gridZ) };
  }
  if (!raycaster.ray.intersectPlane(groundPlane, groundIntersect)) return null;

  const gridX = Math.floor(groundIntersect.x);
  const gridZ = Math.floor(groundIntersect.z);
  return { gridX, gridZ, isInside: isCellInside(gridX, gridZ), walkable: isCellWalkable(gridX, gridZ) };
}

function getTreeUnderCursor(clientX: number, clientY: number): TreeResource | null {
  setPointerNDC(clientX, clientY);
  const groups: THREE.Object3D[] = [];
  treesMap.forEach((t) => {
    if (!t.depleting) groups.push(t.group);
  });

  const hits = raycaster.intersectObjects(groups, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj && obj.userData.treeKey === undefined) obj = obj.parent;
    if (obj) {
      const tree = treesMap.get(obj.userData.treeKey as number);
      if (tree && !tree.depleting) return tree;
    }
  }

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    const tree = treesMap.get(cellKey(cell.gridX, cell.gridZ));
    if (tree && !tree.depleting) return tree;
  }
  return null;
}

function getBuildingUnderCursor(clientX: number, clientY: number): ConstructionBuilding | null {
  setPointerNDC(clientX, clientY);
  const groups: THREE.Object3D[] = buildingsList
    .filter((b) => b.group.visible)
    .map((b) => b.group);
  const hits = raycaster.intersectObjects(groups, true);

  if (hits.length > 0) {
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !buildingsList.some((b) => b.group === obj)) obj = obj.parent;
    if (obj) {
      const b = buildingsList.find((b) => b.group === obj) ?? null;
      if (b) {
        if ((b.faction === 'ENEMY' || b.isEnemy) && !isBuildingDiscovered(b)) return null;
        return b;
      }
    }
  }

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    const b = buildingsGridMap.get(cellKey(cell.gridX, cell.gridZ)) ?? null;
    if (b) {
      if ((b.faction === 'ENEMY' || b.isEnemy) && !isBuildingDiscovered(b)) return null;
      return b;
    }
  }
  return null;
}

function getBerryBushUnderCursor(clientX: number, clientY: number): BerryBushResource | null {
  setPointerNDC(clientX, clientY);
  const groups: THREE.Object3D[] = [];
  berryBushesMap.forEach((b) => {
    if (!b.depleting) groups.push(b.group);
  });

  const hits = raycaster.intersectObjects(groups, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj && obj.userData.berryKey === undefined) obj = obj.parent;
    if (obj) {
      const bush = berryBushesMap.get(obj.userData.berryKey as number);
      if (bush && !bush.depleting) return bush;
    }
  }

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    const bush = berryBushesMap.get(cellKey(cell.gridX, cell.gridZ));
    if (bush && !bush.depleting) return bush;
  }
  return null;
}

function getStoneMineUnderCursor(clientX: number, clientY: number): StoneMineResource | null {
  setPointerNDC(clientX, clientY);
  const groups: THREE.Object3D[] = [];
  stoneMinesMap.forEach((m) => {
    if (!m.depleting) groups.push(m.group);
  });

  const hits = raycaster.intersectObjects(groups, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj && obj.userData.stoneKey === undefined) obj = obj.parent;
    if (obj) {
      const mine = stoneMinesMap.get(obj.userData.stoneKey as number);
      if (mine && !mine.depleting) return mine;
    }
  }

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    const mine = stoneMinesMap.get(cellKey(cell.gridX, cell.gridZ));
    if (mine && !mine.depleting) return mine;
  }
  return null;
}

function getGoldMineUnderCursor(clientX: number, clientY: number): GoldMineResource | null {
  setPointerNDC(clientX, clientY);
  const groups: THREE.Object3D[] = [];
  goldMinesMap.forEach((m) => {
    if (!m.depleting) groups.push(m.group);
  });

  const hits = raycaster.intersectObjects(groups, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj && obj.userData.goldKey === undefined) obj = obj.parent;
    if (obj) {
      const mine = goldMinesMap.get(obj.userData.goldKey as number);
      if (mine && !mine.depleting) return mine;
    }
  }

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    const mine = goldMinesMap.get(cellKey(cell.gridX, cell.gridZ));
    if (mine && !mine.depleting) return mine;
  }
  return null;
}

function isTownCenterUnderCursor(clientX: number, clientY: number): boolean {
  setPointerNDC(clientX, clientY);
  const hits = raycaster.intersectObjects([townCenter], true);
  if (hits.length > 0) return true;

  const cell = raycastGridCell(clientX, clientY);
  if (cell && cell.isInside) {
    return cell.gridX >= tcCoord.minX && cell.gridX <= tcCoord.maxX && cell.gridZ >= tcCoord.minZ && cell.gridZ <= tcCoord.maxZ;
  }
  return false;
}

// --- 12. RECURSOS (HUD) ---
const resources = { wood: currentMatchConfig.initialWood, food: 0, gold: 0, stone: 0 };

const resWoodEl = document.getElementById('res-wood-value');
const resFoodEl = document.getElementById('res-food-value');
const resGoldEl = document.getElementById('res-gold-value');
const resStoneEl = document.getElementById('res-stone-value');
const resPopEl = document.getElementById('res-pop-value');

function bumpElement(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function updateResourceHUD(bump = false) {
  if (resWoodEl) {
    resWoodEl.textContent = `${resources.wood}`;
    if (bump) bumpElement(resWoodEl);
  }

  if (resFoodEl) {
    resFoodEl.textContent = `${resources.food}`;
    if (bump) bumpElement(resFoodEl);
  }

  if (resGoldEl) {
    resGoldEl.textContent = `${resources.gold}`;
    if (bump) bumpElement(resGoldEl);
  }

  if (resStoneEl) {
    resStoneEl.textContent = `${resources.stone}`;
    if (bump) bumpElement(resStoneEl);
  }

  // Atualiza disponibilidade do botão de Construção (Quartel - 50 Madeira)
  if (btnBuildBarracks) {
    if (resources.wood >= BARRACKS_COST_WOOD) {
      btnBuildBarracks.classList.remove('disabled');
      btnBuildBarracks.title = 'Construir Quartel (Atalho B)';
    } else {
      btnBuildBarracks.classList.add('disabled');
      btnBuildBarracks.title = `Construir Quartel (Requer 50 Madeira • Você tem ${resources.wood})`;
    }
  }

  const hasArchitect = hasLivingArchitect();
  const hasAgronomist = hasLivingAgronomist();

  // Atualiza disponibilidade do botão de Construção (Torre de Vigia - 70 Pedra + 30 Madeira, Requer Arquiteto Vivo)
  if (btnBuildTower) {
    if (!hasArchitect) {
      btnBuildTower.classList.add('btn-locked');
      btnBuildTower.classList.add('disabled');
      btnBuildTower.title = '🔒 Requer um Arquiteto vivo formado na Faculdade!';
    } else {
      btnBuildTower.classList.remove('btn-locked');
      if (resources.stone >= TOWER_COST_STONE && resources.wood >= TOWER_COST_WOOD) {
        btnBuildTower.classList.remove('disabled');
        btnBuildTower.title = 'Construir Torre de Vigia (Atalho W) — 70 Pedra + 30 Madeira';
      } else {
        btnBuildTower.classList.add('disabled');
        btnBuildTower.title = `Construir Torre (Requer 70 Pedra, 30 Madeira • Você tem ${resources.stone} 🪨, ${resources.wood} 🪵)`;
      }
    }
  }

  // Atualiza disponibilidade do botão de Construção (Madeireira - 100 Madeira)
  if (btnBuildLumber) {
    if (resources.wood >= LUMBER_CAMP_COST_WOOD) {
      btnBuildLumber.classList.remove('disabled');
      btnBuildLumber.title = 'Construir Madeireira (Atalho L)';
    } else {
      btnBuildLumber.classList.add('disabled');
      btnBuildLumber.title = `Construir Madeireira (Requer 100 Madeira • Você tem ${resources.wood} 🪵)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Campo de Mineração - 100 Madeira)
  if (btnBuildMining) {
    if (resources.wood >= MINING_CAMP_COST_WOOD) {
      btnBuildMining.classList.remove('disabled');
      btnBuildMining.title = 'Construir Campo de Mineração (Atalho M)';
    } else {
      btnBuildMining.classList.add('disabled');
      btnBuildMining.title = `Construir Campo de Mineração (Requer 100 Madeira • Você tem ${resources.wood} 🪵)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Casa - 30 Madeira)
  if (btnBuildHouse) {
    if (resources.wood >= HOUSE_COST_WOOD) {
      btnBuildHouse.classList.remove('disabled');
      btnBuildHouse.title = 'Construir Casa (Atalho H) — Requer 30 Madeira (+5 População)';
    } else {
      btnBuildHouse.classList.add('disabled');
      btnBuildHouse.title = `Construir Casa (Requer 30 Madeira • Você tem ${resources.wood} 🪵)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Moinho - 70 Madeira)
  if (btnBuildMill) {
    if (resources.wood >= MILL_COST_WOOD) {
      btnBuildMill.classList.remove('disabled');
      btnBuildMill.title = 'Construir Moinho (Atalho I) — Requer 70 Madeira (Depósito de Alimento)';
    } else {
      btnBuildMill.classList.add('disabled');
      btnBuildMill.title = `Construir Moinho (Requer 70 Madeira • Você tem ${resources.wood} 🪵)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Fazenda - 60 Madeira, Requer Agrônomo Vivo)
  if (btnBuildFarm) {
    if (!hasAgronomist) {
      btnBuildFarm.classList.add('btn-locked');
      btnBuildFarm.classList.add('disabled');
      btnBuildFarm.title = '🔒 Requer um Agrônomo vivo formado na Faculdade!';
    } else {
      btnBuildFarm.classList.remove('btn-locked');
      if (resources.wood >= FARM_COST_WOOD) {
        btnBuildFarm.classList.remove('disabled');
        btnBuildFarm.title = 'Construir Fazenda (Atalho F) — Requer 60 Madeira (175 Alimento)';
      } else {
        btnBuildFarm.classList.add('disabled');
        btnBuildFarm.title = `Construir Fazenda (Requer 60 Madeira • Você tem ${resources.wood} 🪵)`;
      }
    }
  }

  // Atualiza disponibilidade do botão de Construção (Escola - 80 Madeira + 40 Pedra)
  if (btnBuildSchool) {
    if (resources.wood >= SCHOOL_COST_WOOD && resources.stone >= SCHOOL_COST_STONE) {
      btnBuildSchool.classList.remove('disabled');
      btnBuildSchool.title = 'Construir Escola (Atalho E) — Requer 80 Madeira + 40 Pedra (Especialização de Aldeões)';
    } else {
      btnBuildSchool.classList.add('disabled');
      btnBuildSchool.title = `Construir Escola (Requer 80 Madeira, 40 Pedra • Você tem ${resources.wood} 🪵, ${resources.stone} 🪨)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Faculdade - 150 Madeira + 120 Pedra + 80 Ouro)
  if (btnBuildCollege) {
    if (resources.wood >= COLLEGE_COST_WOOD && resources.stone >= COLLEGE_COST_STONE && resources.gold >= COLLEGE_COST_GOLD) {
      btnBuildCollege.classList.remove('disabled');
      btnBuildCollege.title = 'Construir Faculdade (Atalho C) — Requer 150 Madeira + 120 Pedra + 80 Ouro (Especializações de Elite)';
    } else {
      btnBuildCollege.classList.add('disabled');
      btnBuildCollege.title = `Construir Faculdade (Requer 150 Madeira, 120 Pedra, 80 Ouro • Você tem ${resources.wood} 🪵, ${resources.stone} 🪨, ${resources.gold} 🪙)`;
    }
  }

  // Atualiza disponibilidade do botão de Construção (Muralha de Pedra - 5 Pedra, Requer Arquiteto Vivo)
  if (btnBuildWall) {
    if (!hasArchitect) {
      btnBuildWall.classList.add('btn-locked');
      btnBuildWall.classList.add('disabled');
      btnBuildWall.title = 'Requer um Arquiteto vivo formado na Faculdade!';
    } else {
      btnBuildWall.classList.remove('btn-locked');
      if (resources.stone >= WALL_COST_STONE) {
        btnBuildWall.classList.remove('disabled');
        btnBuildWall.title = 'Construir Muralha de Pedra (Atalho P) — 5 Pedra (250 HP)';
      } else {
        btnBuildWall.classList.add('disabled');
        btnBuildWall.title = `Construir Muralha (Requer 5 Pedra • Você tem ${resources.stone} 🪨)`;
      }
    }
  }

  // Atualiza disponibilidade do botão de Construção (Portão Fortificado - 20 Pedra + 20 Madeira, Requer Arquiteto Vivo)
  if (btnBuildGate) {
    if (!hasArchitect) {
      btnBuildGate.classList.add('btn-locked');
      btnBuildGate.classList.add('disabled');
      btnBuildGate.title = 'Requer um Arquiteto vivo formado na Faculdade!';
    } else {
      btnBuildGate.classList.remove('btn-locked');
      if (resources.stone >= GATE_COST_STONE && resources.wood >= GATE_COST_WOOD) {
        btnBuildGate.classList.remove('disabled');
        btnBuildGate.title = 'Construir Portão Fortificado — 20 Pedra + 20 Madeira (350 HP)';
      } else {
        btnBuildGate.classList.add('disabled');
        btnBuildGate.title = `Construir Portão (Requer 20 Pedra, 20 Madeira • Você tem ${resources.stone} 🪨, ${resources.wood} 🪵)`;
      }
    }
  }

  // Atualiza disponibilidade do botão de Construção (Campo de Tiro com Arco - 100 Madeira + 50 Pedra)
  if (btnBuildArchery) {
    if (resources.wood >= ARCHERY_RANGE_COST_WOOD && resources.stone >= ARCHERY_RANGE_COST_STONE) {
      btnBuildArchery.classList.remove('disabled');
      btnBuildArchery.title = 'Construir Campo de Tiro com Arco (Atalho A) — Requer 100 Madeira + 50 Pedra';
    } else {
      btnBuildArchery.classList.add('disabled');
      btnBuildArchery.title = `Construir Campo de Tiro (Requer 100 Madeira, 50 Pedra • Você tem ${resources.wood} 🪵, ${resources.stone} 🪨)`;
    }
  }

  updateBarracksHUD();
  updateArcheryHUD();
  updateTownCenterHUD();
  updateFarmHUD();
  updateSchoolHUD();
  updateCollegeHUD();
  updateTelemetryUnitsCount();
}

function spawnFloatingText(worldPos: THREE.Vector3, text: string, color?: string) {
  if (!currentMatchConfig.revealWholeMap) {
    const gx = Math.floor(worldPos.x);
    const gz = Math.floor(worldPos.z);
    if (isCellInside(gx, gz) && getFogStateAt(gx, gz) === FogState.UNEXPLORED) {
      return;
    }
  }
  const p = worldPos.clone().project(camera);
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  if (color) el.style.color = color;
  el.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
  el.style.top = `${((-p.y + 1) / 2) * window.innerHeight}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1150);
}

// --- 13. ALDEÕES & SOLDADOS: DADOS, ARQUÉTIPOS & COMBATE ---
export type UnitType = 'VILLAGER' | 'SWORDSMAN' | 'ARCHER';

type UnitState =
  | 'IDLE'
  | 'MOVING'
  | 'MOVING_TO_RESOURCE'
  | 'GATHERING'
  | 'MINING_GOLD'
  | 'RETURNING_TO_BASE'
  | 'DEPOSITING'
  | 'MOVING_TO_BUILD'
  | 'BUILDING'
  | 'MOVING_TO_REPAIR'
  | 'REPAIRING'
  | 'ATTACKING'
  | 'ATTACKING_STRUCTURE'
  | 'MOVING_TO_SCHOOL'
  | 'MOVING_TO_COLLEGE'
  | 'STUDYING';

export interface RTSUnit {
  id: string;
  unitType: UnitType;
  faction: UnitFaction;
  isEnemy: boolean;
  maxHp: number;
  hp: number;
  damage: number;
  attackRange: number;
  attackCooldown: number;
  lastAttackTime: number;
  targetEnemy: RTSUnit | null;
  targetStructure: 'TENT' | 'TOWN_CENTER' | 'BUILDING' | null;
  lastPursuitTargetCell: THREE.Vector2 | null;
  group: THREE.Group;
  mesh?: THREE.Group;
  gridX?: number;
  gridZ?: number;
  cylinderMesh: THREE.Mesh;
  selectionRing: THREE.Mesh;
  carryMesh: THREE.Group;
  woodCarryMesh: THREE.Group;
  berryCarryMesh: THREE.Group;
  stoneCarryMesh: THREE.Group;
  goldCarryMesh: THREE.Group;
  hpBarGroup: THREE.Group;
  hpBarMesh?: THREE.Group;
  hpBarFillMesh: THREE.Mesh;
  hpBarShowUntil: number;
  isSelected: boolean;
  waypoints: THREE.Vector3[];
  currentWaypointIndex: number;
  speed: number;
  state: UnitState;
  carriedResourceType: 'WOOD' | 'FOOD' | 'STONE' | 'GOLD' | null;
  targetTree: TreeResource | null;
  targetBerryBush: BerryBushResource | null;
  targetStoneMine: StoneMineResource | null;
  targetGoldMine: GoldMineResource | null;
  lastTreeCell: THREE.Vector2 | null;
  lastBerryCell: THREE.Vector2 | null;
  lastStoneCell: THREE.Vector2 | null;
  lastGoldCell: THREE.Vector2 | null;
  gatherCell: THREE.Vector2 | null;
  gatherTimer: number;
  depositTimer: number;
  carrying: number;
  targetBuilding: ConstructionBuilding | null;
  targetFarm: ConstructionBuilding | null;
  targetSchool?: ConstructionBuilding | null;
  targetCollege?: ConstructionBuilding | null;
  buildCell: THREE.Vector2 | null;
  dropoffTarget?: THREE.Vector3 | null;
  dropoffBuilding?: ConstructionBuilding | null;
  isDying: boolean;
  deathStartTime: number;

  // Propriedades do Sistema de Educação
  educationLevel: number; // 0: comum, 1: escola (cidadão), 2: faculdade (elite)
  carryCapacity: number;  // padrão 10, graduado: 20
  isGarrisoned: boolean;
  canEnrollInCollege?: boolean;
  eliteSpecialization?: EliteCourse | null;
  specialization?: EliteCourse | null;
  hasArmorerHpBuff?: boolean;
  armorerEquipmentGroup?: THREE.Group;
  armorerShieldRim?: THREE.Mesh;
  backpackMesh?: THREE.Group;
  academicCapGroup?: THREE.Group;
  academicGownMesh?: THREE.Group | THREE.Mesh;
  auraRingMesh?: THREE.Mesh;
  alchemistTimer?: number;

  // Propriedades de IA Ofensiva, Patrulha e Invasão Inimiga
  isEnemyInvader?: boolean;
  isEnemyPatrol?: boolean;
  patrolTargetCell?: THREE.Vector2 | null;
  patrolWaitUntil?: number;

  // Propriedades do Sistema de Reparo
  repairWoodSpent?: number;
  repairStoneSpent?: number;
  repairSoundTimer?: number;
}

const GATHER_AMOUNT = 10;
const DEPOSIT_TIME = 0.35;
const TREE_SEARCH_RADIUS = 14;
const BERRY_SEARCH_RADIUS = 14;

export const unitsList: RTSUnit[] = [];
export const units: RTSUnit[] = unitsList;

const unitCylinderGeo = new THREE.CylinderGeometry(0.3, 0.35, 0.8, 24);
const unitEdgesGeo = new THREE.EdgesGeometry(unitCylinderGeo, 25);
const unitEdgesMat = new THREE.LineBasicMaterial({ color: 0xbfdbfe, transparent: true, opacity: 0.7 });
const defaultRingGeo = new THREE.RingGeometry(0.36, 0.42, 24);
const selectionRingGeo = new THREE.RingGeometry(0.38, 0.48, 32);
const selectionRingMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });

const logGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8);
const logMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 });
const basketMat = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.85 });

function createCarryMesh(): {
  container: THREE.Group;
  woodMesh: THREE.Group;
  berryMesh: THREE.Group;
  stoneMesh: THREE.Group;
  goldMesh: THREE.Group;
} {
  const container = new THREE.Group();
  container.position.set(0, 0.95, -0.05);
  container.visible = false;

  // 1. Feixe de madeira
  const woodBundle = new THREE.Group();
  for (const [ox, oy] of [[-0.07, 0], [0.07, 0], [0, 0.11]]) {
    const log = new THREE.Mesh(logGeo, logMat);
    log.rotation.z = Math.PI / 2;
    log.position.set(0, oy, ox);
    log.castShadow = true;
    woodBundle.add(log);
  }
  woodBundle.visible = false;
  container.add(woodBundle);

  // 2. Cesta/trouxa com frutas vermelhas
  const berryBasket = new THREE.Group();
  const basketGeo = new THREE.CylinderGeometry(0.18, 0.12, 0.22, 10);
  const basketMesh = new THREE.Mesh(basketGeo, basketMat);
  basketMesh.position.y = 0.05;
  basketMesh.castShadow = true;
  berryBasket.add(basketMesh);

  // Frutas vermelhas dentro da cesta
  const miniBerryGeo = new THREE.SphereGeometry(0.055, 6, 6);
  for (const [bx, bz] of [[-0.06, -0.06], [0.06, -0.06], [-0.05, 0.06], [0.06, 0.06], [0, 0]]) {
    const b = new THREE.Mesh(miniBerryGeo, berryFruitMat);
    b.position.set(bx, 0.16, bz);
    berryBasket.add(b);
  }
  berryBasket.visible = false;
  container.add(berryBasket);

  // 3. Bloco de rocha cinza (Stone)
  const stoneCarry = new THREE.Group();
  const stoneBlockGeo = new THREE.DodecahedronGeometry(0.18, 0);
  const stoneBlockMesh = new THREE.Mesh(stoneBlockGeo, stoneMineMat);
  stoneBlockMesh.position.set(0, 0.1, 0);
  stoneBlockMesh.scale.set(1.1, 0.85, 0.95);
  stoneBlockMesh.castShadow = true;
  stoneCarry.add(stoneBlockMesh);
  stoneCarry.visible = false;
  container.add(stoneCarry);

  // 4. Pepita reluzente de Ouro (Gold)
  const goldCarry = new THREE.Group();
  const goldNuggetGeo = new THREE.DodecahedronGeometry(0.16, 0);
  const goldNuggetMat = new THREE.MeshStandardMaterial({
    color: 0xfacc15,
    emissive: 0xa16207,
    emissiveIntensity: 0.45,
    roughness: 0.16,
    metalness: 0.92,
    flatShading: true
  });
  const goldNuggetMesh = new THREE.Mesh(goldNuggetGeo, goldNuggetMat);
  goldNuggetMesh.position.set(0, 0.1, 0);
  goldNuggetMesh.scale.set(1.15, 0.9, 1.05);
  goldNuggetMesh.castShadow = true;
  goldCarry.add(goldNuggetMesh);

  // Pequenas fagulhas facetadas de ouro brilhante
  const miniGoldGeo = new THREE.OctahedronGeometry(0.06, 0);
  for (const [gx, gz] of [[-0.08, 0.08], [0.09, -0.07]]) {
    const mg = new THREE.Mesh(miniGoldGeo, goldNuggetMat);
    mg.position.set(gx, 0.16, gz);
    goldCarry.add(mg);
  }
  goldCarry.visible = false;
  container.add(goldCarry);

  return { container, woodMesh: woodBundle, berryMesh: berryBasket, stoneMesh: stoneCarry, goldMesh: goldCarry };
}

function createUnitHpBar(faction: UnitFaction): { group: THREE.Group; fillMesh: THREE.Mesh } {
  const group = new THREE.Group();
  group.position.y = 1.35;

  const bgGeo = new THREE.PlaneGeometry(0.64, 0.09);
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x090d16, side: THREE.DoubleSide });
  const bg = new THREE.Mesh(bgGeo, bgMat);
  group.add(bg);

  const fillGeo = new THREE.PlaneGeometry(0.6, 0.06);
  const fillMat = new THREE.MeshBasicMaterial({
    color: faction === 'ENEMY' ? 0xef4444 : 0x22c55e,
    side: THREE.DoubleSide
  });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.z = 0.002;
  group.add(fill);

  group.visible = false;
  return { group, fillMesh: fill };
}

function createSwordsmanEquipment(faction: UnitFaction): THREE.Group {
  const equip = new THREE.Group();

  if (faction === 'PLAYER') {
    // Capacete Metálico com viseira e crista dourada
    const helmMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });
    const crestMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.65, roughness: 0.35 });
    const helmDome = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.26, 16), helmMat);
    helmDome.position.y = 0.82;
    equip.add(helmDome);

    const crest = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.36), crestMat);
    crest.position.set(0, 0.98, 0);
    equip.add(crest);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.06), new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9 }));
    visor.position.set(0, 0.82, 0.25);
    equip.add(visor);

    // Espada na mão direita
    const swordMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.92, roughness: 0.15 });
    const guardMat = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.8, roughness: 0.3 });
    const swordGroup = new THREE.Group();
    swordGroup.position.set(0.38, 0.45, 0.1);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.58, 0.08), swordMat);
    blade.position.y = 0.28;
    swordGroup.add(blade);

    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.22), guardMat);
    swordGroup.add(guard);

    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 6), new THREE.MeshStandardMaterial({ color: 0x3b2f2f }));
    hilt.position.y = -0.09;
    swordGroup.add(hilt);

    equip.add(swordGroup);

    // Escudo redondo na mão esquerda
    const shieldGroup = new THREE.Group();
    shieldGroup.position.set(-0.36, 0.42, 0.05);

    const shieldBody = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.4 }));
    shieldBody.rotation.z = Math.PI / 2;
    shieldGroup.add(shieldBody);

    const shieldBoss = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), crestMat);
    shieldBoss.position.x = -0.025;
    shieldGroup.add(shieldBoss);

    // Borda de escudo reforçada com liga dourada forjada pelo Armeiro
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      metalness: 0.88,
      roughness: 0.2,
      emissive: 0x713f12,
      emissiveIntensity: 0.35
    });
    const rimMesh = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.025, 8, 24), rimMat);
    rimMesh.rotation.y = Math.PI / 2;
    rimMesh.name = 'armorerShieldRim';
    rimMesh.visible = false;
    shieldGroup.add(rimMesh);

    equip.add(shieldGroup);
  } else {
    // INIMIGO: Capacete de ferro escuro com chifres/espinhos
    const darkIronMat = new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.8, roughness: 0.35 });
    const helmDome = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.26, 16), darkIronMat);
    helmDome.position.y = 0.82;
    equip.add(helmDome);

    const hornGeo = new THREE.ConeGeometry(0.05, 0.22, 6);
    const hornMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.7 });
    const hornL = new THREE.Mesh(hornGeo, hornMat);
    hornL.position.set(-0.22, 0.96, 0);
    hornL.rotation.z = 0.5;
    equip.add(hornL);

    const hornR = new THREE.Mesh(hornGeo, hornMat);
    hornR.position.set(0.22, 0.96, 0);
    hornR.rotation.z = -0.5;
    equip.add(hornR);

    // Espada/Cutelo escuro
    const swordGroup = new THREE.Group();
    swordGroup.position.set(0.38, 0.45, 0.1);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.1), new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.85, roughness: 0.3 }));
    blade.position.y = 0.28;
    swordGroup.add(blade);

    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.2), darkIronMat);
    swordGroup.add(guard);

    equip.add(swordGroup);

    // Escudo pontiagudo vermelho
    const shieldGroup = new THREE.Group();
    shieldGroup.position.set(-0.36, 0.42, 0.05);

    const shieldBody = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.4 }));
    shieldBody.rotation.z = Math.PI / 2;
    shieldGroup.add(shieldBody);

    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 6), darkIronMat);
    spike.rotation.z = Math.PI / 2;
    spike.position.x = -0.06;
    shieldGroup.add(spike);

    equip.add(shieldGroup);
  }

  return equip;
}

/**
 * Equipamento 3D do Arqueiro (Archer):
 * Unidade com capuz/túnica de arqueiro, aljava de flechas nas costas e arco curvado nas mãos.
 */
function createArcherEquipment(faction: UnitFaction): THREE.Group {
  const equip = new THREE.Group();

  const isPlayer = faction === 'PLAYER';
  const hoodColor = isPlayer ? 0x059669 : 0x991b1b; // Verde arqueiro para aliado, vermelho escuro para inimigo
  const hoodMat = new THREE.MeshStandardMaterial({ color: hoodColor, roughness: 0.75 });
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.65 });
  const stringMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });

  // 1. Capuz de Arqueiro (Hood/Cowl) sobre a cabeça
  const hoodDome = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.25, 16), hoodMat);
  hoodDome.position.y = 0.82;
  equip.add(hoodDome);

  // Ponta do capuz caindo para trás
  const hoodTip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.26, 8), hoodMat);
  hoodTip.rotation.x = -1.1;
  hoodTip.position.set(0, 0.84, -0.22);
  equip.add(hoodTip);

  // Manto/gola de couro nos ombros
  const mantle = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.12, 16), leatherMat);
  mantle.position.y = 0.68;
  equip.add(mantle);

  // 2. Aljava de Flechas nas costas (Quiver)
  const quiverGroup = new THREE.Group();
  quiverGroup.position.set(0.08, 0.52, -0.22);
  quiverGroup.rotation.z = 0.32;
  quiverGroup.rotation.x = -0.22;

  const quiverBody = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.46, 8), leatherMat);
  quiverBody.castShadow = true;
  quiverGroup.add(quiverBody);

  // Faixa de couro da aljava no peito
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.32), leatherMat);
  strap.position.set(-0.02, 0.0, 0.15);
  strap.rotation.y = 0.3;
  quiverGroup.add(strap);

  // 4 Flechas aparecendo saindo da aljava com penacho colorido
  const arrowPositions = [
    [-0.02, 0.3, -0.02],
    [0.02, 0.33, 0.02],
    [-0.03, 0.32, 0.03],
    [0.03, 0.29, -0.03]
  ];
  const fletchMat = new THREE.MeshStandardMaterial({ color: isPlayer ? 0x38bdf8 : 0xf87171, roughness: 0.4 });
  for (const pos of arrowPositions) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6), woodMat);
    shaft.position.set(pos[0], pos[1], pos[2]);
    quiverGroup.add(shaft);

    const fletch = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.01), fletchMat);
    fletch.position.set(pos[0], pos[1] + 0.08, pos[2]);
    quiverGroup.add(fletch);
  }
  equip.add(quiverGroup);

  // 3. Arco Curvado nas mãos (Bow)
  const bowGroup = new THREE.Group();
  bowGroup.position.set(0.36, 0.46, 0.15);
  bowGroup.rotation.y = -0.3;

  // Empunhadura central
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), leatherMat);
  bowGroup.add(grip);

  // Lâmina superior do arco (curvada para trás)
  const upperLimb = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.015, 0.34, 6), woodMat);
  upperLimb.position.set(0, 0.2, 0.05);
  upperLimb.rotation.x = -0.35;
  bowGroup.add(upperLimb);

  const upperTip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.01, 0.14, 6), woodMat);
  upperTip.position.set(0, 0.38, 0.16);
  upperTip.rotation.x = -0.9;
  bowGroup.add(upperTip);

  // Lâmina inferior do arco (curvada para trás)
  const lowerLimb = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.015, 0.34, 6), woodMat);
  lowerLimb.position.set(0, -0.2, 0.05);
  lowerLimb.rotation.x = 0.35;
  bowGroup.add(lowerLimb);

  const lowerTip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.01, 0.14, 6), woodMat);
  lowerTip.position.set(0, -0.38, 0.16);
  lowerTip.rotation.x = 0.9;
  bowGroup.add(lowerTip);

  // Corda do arco (Bowstring) tensionada
  const stringGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.44, 0.22),
    new THREE.Vector3(0, 0, 0.08),
    new THREE.Vector3(0, -0.44, 0.22)
  ]);
  const bowstring = new THREE.Line(stringGeo, stringMat);
  bowGroup.add(bowstring);

  equip.add(bowGroup);

  return equip;
}

function createVillagerBackpack(): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0, 0.42, -0.32);

  // Mochila de couro nas costas
  const bagGeo = new THREE.BoxGeometry(0.24, 0.28, 0.14);
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
  const bagMesh = new THREE.Mesh(bagGeo, leatherMat);
  bagMesh.castShadow = true;
  g.add(bagMesh);

  // Aba superior da bolsa
  const flapGeo = new THREE.BoxGeometry(0.25, 0.10, 0.15);
  const flapMesh = new THREE.Mesh(flapGeo, new THREE.MeshStandardMaterial({ color: 0x5c2602, roughness: 0.75 }));
  flapMesh.position.y = 0.10;
  g.add(flapMesh);

  // Fivelas de latão dourado
  const buckleMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4, metalness: 0.75 });
  for (const bx of [-0.07, 0.07]) {
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), buckleMat);
    buckle.position.set(bx, 0.02, -0.075);
    g.add(buckle);
  }

  // Canudo de pergaminho / diploma enrolado com fita azul
  const scrollGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8);
  const scrollMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.6 });
  const scrollMesh = new THREE.Mesh(scrollGeo, scrollMat);
  scrollMesh.rotation.z = Math.PI / 2;
  scrollMesh.position.set(0, 0.17, 0);
  g.add(scrollMesh);

  const ribbonMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8),
    new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.5 })
  );
  ribbonMesh.rotation.z = Math.PI / 2;
  ribbonMesh.position.set(0, 0.17, 0);
  g.add(ribbonMesh);

  g.visible = false;
  return g;
}

// --- ITENS VISUAIS DE ESPECIALISTA DE ELITE (NÍVEL 2) ---
function createAcademicCap(): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0, 0.82, 0);

  // Faixa/Gorrinho circular de encaixe na cabeça
  const skullCapGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.1, 16);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.75 });
  const skullCap = new THREE.Mesh(skullCapGeo, capMat);
  skullCap.position.y = 0.05;
  g.add(skullCap);

  // Placa Quadrada Superior (Capelo tradicional 4 pontas)
  const boardGeo = new THREE.BoxGeometry(0.56, 0.03, 0.56);
  const board = new THREE.Mesh(boardGeo, capMat);
  board.position.y = 0.11;
  board.rotation.y = Math.PI / 4;
  g.add(board);

  // Botão central dourado
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, metalness: 0.85 });
  const buttonGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.04, 12);
  const button = new THREE.Mesh(buttonGeo, goldMat);
  button.position.y = 0.13;
  g.add(button);

  // Cordão e Borla / Franja cerimonial dourada caindo lateralmente
  const cordGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6);
  const cord = new THREE.Mesh(cordGeo, goldMat);
  cord.rotation.z = Math.PI / 3;
  cord.position.set(0.12, 0.1, 0.12);
  g.add(cord);

  const tasselGeo = new THREE.ConeGeometry(0.04, 0.12, 8);
  const tassel = new THREE.Mesh(tasselGeo, goldMat);
  tassel.rotation.x = Math.PI;
  tassel.position.set(0.2, 0.01, 0.2);
  g.add(tassel);

  g.visible = false;
  return g;
}

function createAcademicGown(): THREE.Group {
  const g = new THREE.Group();

  // Manto / Beca cerimonial acadêmica que veste o corpo cilíndrico
  const gownGeo = new THREE.CylinderGeometry(0.33, 0.38, 0.82, 24);
  const gownMat = new THREE.MeshStandardMaterial({
    color: 0x1e1b4b, // Azul imperial profundo / indigo acadêmico
    roughness: 0.65
  });
  const gownMesh = new THREE.Mesh(gownGeo, gownMat);
  gownMesh.position.y = 0.41;
  gownMesh.castShadow = true;
  g.add(gownMesh);

  // Faixa / Estola cerimonial dourada de formatura
  const stoleMat = new THREE.MeshStandardMaterial({
    color: 0xfacc15,
    roughness: 0.35,
    metalness: 0.75
  });
  const stoleLeft = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.62, 0.05), stoleMat);
  stoleLeft.position.set(-0.16, 0.42, 0.3);
  g.add(stoleLeft);

  const stoleRight = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.62, 0.05), stoleMat);
  stoleRight.position.set(0.16, 0.42, 0.3);
  g.add(stoleRight);

  // Colarinho cerimonial dourado
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.345, 0.08, 20), stoleMat);
  collar.position.y = 0.76;
  g.add(collar);

  g.visible = false;
  return g;
}

function createArmorerEquipment(): THREE.Group {
  const g = new THREE.Group();

  // Avental de couro escuro
  const apronMat = new THREE.MeshStandardMaterial({
    color: 0x2d1810, // Couro escuro
    roughness: 0.9,
    metalness: 0.05
  });
  const apronBody = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.52, 0.09), apronMat);
  apronBody.position.set(0, 0.38, 0.22);
  g.add(apronBody);

  // Alças do avental cruzadas nos ombros
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a0f0a, roughness: 0.95 });
  const strapL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.04), strapMat);
  strapL.position.set(-0.12, 0.68, 0.16);
  strapL.rotation.x = 0.2;
  g.add(strapL);

  const strapR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.04), strapMat);
  strapR.position.set(0.12, 0.68, 0.16);
  strapR.rotation.x = 0.2;
  g.add(strapR);

  // Marreta de Forja (Forge Hammer)
  const hammerGroup = new THREE.Group();
  hammerGroup.position.set(0.35, 0.38, 0.18);
  hammerGroup.rotation.x = Math.PI / 5;
  hammerGroup.rotation.z = -Math.PI / 12;

  const handleMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.7 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.44, 8), handleMat);
  handle.position.y = 0.12;
  hammerGroup.add(handle);

  const hammerHeadMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.85, roughness: 0.25 });
  const hammerHead = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.2), hammerHeadMat);
  hammerHead.position.set(0, 0.3, 0);
  hammerGroup.add(hammerHead);

  g.add(hammerGroup);
  g.visible = false;
  return g;
}

export function updateSwordsmenArmorerBuff() {
  const armorerAlive = hasLivingArmorer();
  for (const u of unitsList) {
    if (((u.faction as string) === 'ALLIED' || !u.isEnemy) && u.unitType === 'SWORDSMAN' && !u.isDying) {
      if (armorerAlive && !u.hasArmorerHpBuff) {
        u.hasArmorerHpBuff = true;
        u.maxHp += 30;
        u.hp += 30;
        updateUnitHpBar(u, performance.now());
      } else if (!armorerAlive && u.hasArmorerHpBuff) {
        u.hasArmorerHpBuff = false;
        u.maxHp = Math.max(1, u.maxHp - 30);
        u.hp = Math.min(u.hp, u.maxHp);
        updateUnitHpBar(u, performance.now());
      }
      if (u.armorerShieldRim) {
        u.armorerShieldRim.visible = armorerAlive;
      }
    }
  }
}

function createAuraRing(): THREE.Mesh {
  // Aura sutil dourada no chão para destacar especialistas de elite
  const auraGeo = new THREE.RingGeometry(0.52, 0.62, 32);
  const auraMat = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85
  });
  const auraMesh = new THREE.Mesh(auraGeo, auraMat);
  auraMesh.rotation.x = -Math.PI / 2;
  auraMesh.position.y = 0.025;
  auraMesh.visible = false;
  return auraMesh;
}

interface SpawnAnimation {
  group: THREE.Group;
  progress: number;
}
const activeSpawnAnimations: SpawnAnimation[] = [];

function createUnit(
  gridX: number,
  gridZ: number,
  unitType: UnitType = 'VILLAGER',
  faction: UnitFaction = 'PLAYER'
): RTSUnit {
  const id = `${unitType.toLowerCase()}_${faction.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const unitGroup = new THREE.Group();
  unitGroup.position.set(gridX + 0.5, getTerrainHeight(gridX + 0.5, gridZ + 0.5), gridZ + 0.5);

  let bodyColor = 0x2563eb;
  let maxHp = 30;
  let damage = 3;
  let attackRange = 1.2;
  let attackCooldown = 1.0;
  let speed = 4.2;

  let hasArmorerBuff = false;
  if (unitType === 'SWORDSMAN') {
    maxHp = currentMatchConfig.swordsmanHp;
    if ((faction === 'PLAYER' || (faction as string) === 'ALLIED') && hasLivingArmorer()) {
      maxHp += 30;
      hasArmorerBuff = true;
    }
    damage = currentMatchConfig.swordsmanDamage;
    bodyColor = faction === 'PLAYER' ? 0x1d4ed8 : 0xdc2626;
  } else if (unitType === 'ARCHER') {
    maxHp = ARCHER_HP;
    damage = ARCHER_DAMAGE;
    attackRange = ARCHER_ATTACK_RANGE;
    attackCooldown = ARCHER_ATTACK_COOLDOWN;
    speed = ARCHER_SPEED;
    bodyColor = faction === 'PLAYER' ? 0x059669 : 0x991b1b;
  } else {
    bodyColor = faction === 'PLAYER' ? 0x2563eb : 0xb91c1c;
  }

  const cylMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.25 });
  const cylinder = new THREE.Mesh(unitCylinderGeo, cylMat);
  cylinder.position.y = 0.4;
  cylinder.castShadow = true;
  cylinder.receiveShadow = true;
  cylinder.add(new THREE.LineSegments(unitEdgesGeo, unitEdgesMat));
  unitGroup.add(cylinder);

  const ringColor = faction === 'PLAYER' ? 0x60a5fa : 0xef4444;
  const dRingMat = new THREE.MeshBasicMaterial({ color: ringColor, side: THREE.DoubleSide, transparent: true, opacity: 0.65 });
  const defaultRing = new THREE.Mesh(defaultRingGeo, dRingMat);
  defaultRing.rotation.x = -Math.PI / 2;
  defaultRing.position.y = 0.008;
  unitGroup.add(defaultRing);

  const selectionRing = new THREE.Mesh(selectionRingGeo, selectionRingMat);
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.016;
  selectionRing.visible = false;
  unitGroup.add(selectionRing);

  const {
    container: carryMesh,
    woodMesh: woodCarryMesh,
    berryMesh: berryCarryMesh,
    stoneMesh: stoneCarryMesh,
    goldMesh: goldCarryMesh
  } = createCarryMesh();
  unitGroup.add(carryMesh);

  let armorerShieldRim: THREE.Mesh | undefined;
  if (unitType === 'SWORDSMAN') {
    const swordsmanEquip = createSwordsmanEquipment(faction);
    unitGroup.add(swordsmanEquip);
    armorerShieldRim = swordsmanEquip.getObjectByName('armorerShieldRim') as THREE.Mesh;
    if (armorerShieldRim && (faction === 'PLAYER' || (faction as string) === 'ALLIED')) {
      armorerShieldRim.visible = hasLivingArmorer();
    }
  } else if (unitType === 'ARCHER') {
    const archerEquip = createArcherEquipment(faction);
    unitGroup.add(archerEquip);
  }

  let backpackMesh: THREE.Group | undefined;
  let academicCapGroup: THREE.Group | undefined;
  let academicGownMesh: THREE.Group | THREE.Mesh | undefined;
  let armorerEquipmentGroup: THREE.Group | undefined;
  let auraRingMesh: THREE.Mesh | undefined;
  if (unitType === 'VILLAGER') {
    backpackMesh = createVillagerBackpack();
    unitGroup.add(backpackMesh);

    academicCapGroup = createAcademicCap();
    unitGroup.add(academicCapGroup);

    academicGownMesh = createAcademicGown();
    unitGroup.add(academicGownMesh);

    armorerEquipmentGroup = createArmorerEquipment();
    unitGroup.add(armorerEquipmentGroup);

    auraRingMesh = createAuraRing();
    unitGroup.add(auraRingMesh);
  }

  const { group: hpBarGroup, fillMesh: hpBarFillMesh } = createUnitHpBar(faction);
  unitGroup.add(hpBarGroup);

  if (faction === 'ENEMY') {
    const inDirectVision = currentMatchConfig.revealWholeMap || (isCellInside(gridX, gridZ) && getFogStateAt(gridX, gridZ) === FogState.VISIBLE);
    unitGroup.visible = inDirectVision;
    hpBarGroup.visible = inDirectVision;
    unitGroup.traverse((c: any) => { if (c.isMesh) c.castShadow = inDirectVision; });
  }

  unitGroup.scale.setScalar(0.01);
  scene.add(unitGroup);

  const unit: RTSUnit = {
    id,
    unitType,
    faction,
    isEnemy: faction === 'ENEMY',
    maxHp,
    hp: maxHp,
    damage,
    attackRange,
    attackCooldown,
    lastAttackTime: 0,
    targetEnemy: null,
    targetStructure: null,
    lastPursuitTargetCell: null,
    group: unitGroup,
    mesh: unitGroup,
    get gridX() { return unitGroup.position.x; },
    get gridZ() { return unitGroup.position.z; },
    cylinderMesh: cylinder,
    selectionRing,
    carryMesh,
    woodCarryMesh,
    berryCarryMesh,
    stoneCarryMesh,
    goldCarryMesh,
    hpBarGroup,
    hpBarMesh: hpBarGroup,
    hpBarFillMesh,
    hpBarShowUntil: 0,
    isSelected: false,
    waypoints: [],
    currentWaypointIndex: 0,
    speed,
    state: 'IDLE',
    carriedResourceType: null,
    targetTree: null,
    targetBerryBush: null,
    targetStoneMine: null,
    targetGoldMine: null,
    lastTreeCell: null,
    lastBerryCell: null,
    lastStoneCell: null,
    lastGoldCell: null,
    gatherCell: null,
    gatherTimer: 0,
    depositTimer: 0,
    carrying: 0,
    targetBuilding: null,
    targetFarm: null,
    targetSchool: null,
    targetCollege: null,
    buildCell: null,
    dropoffTarget: null,
    dropoffBuilding: null,
    isDying: false,
    deathStartTime: 0,

    // Propriedades de Educação
    educationLevel: 0,
    carryCapacity: 10,
    isGarrisoned: false,
    canEnrollInCollege: false,
    eliteSpecialization: null,
    specialization: null,
    hasArmorerHpBuff: hasArmorerBuff,
    armorerEquipmentGroup,
    armorerShieldRim,
    backpackMesh,
    academicCapGroup,
    academicGownMesh,
    auraRingMesh,

    // IA Ofensiva & Patrulha
    isEnemyInvader: false,
    isEnemyPatrol: faction === 'ENEMY' && (unitType === 'SWORDSMAN' || unitType === 'ARCHER'),
    patrolTargetCell: null,
    patrolWaitUntil: 0
  };

  unitsList.push(unit);
  activeSpawnAnimations.push({ group: unitGroup, progress: 0 });
  updateTelemetryUnitsCount();
  updateTelemetrySelectionCount();
  return unit;
}

function selectUnit(unit: RTSUnit) {
  if (unit.isGarrisoned) return;
  unit.isSelected = true;
  unit.selectionRing.visible = true;
  if (unit.educationLevel >= 2 && unit.auraRingMesh) {
    unit.auraRingMesh.visible = true;
  }
  updateTelemetrySelectionCount();
  updateUnitHUD();
}

function deselectUnit(unit: RTSUnit) {
  unit.isSelected = false;
  unit.selectionRing.visible = false;
  if (unit.auraRingMesh) {
    unit.auraRingMesh.visible = false;
  }
  updateTelemetrySelectionCount();
  updateUnitHUD();
}

function deselectAllUnits() {
  for (const u of unitsList) {
    u.isSelected = false;
    u.selectionRing.visible = false;
    if (u.auraRingMesh) {
      u.auraRingMesh.visible = false;
    }
  }
  updateTelemetrySelectionCount();
  updateUnitHUD();
}

function selectSingleUnit(unit: RTSUnit) {
  deselectAllUnits();
  selectUnit(unit);
}

function getSelectedUnits(): RTSUnit[] {
  return unitsList.filter((u) => u.isSelected);
}

/**
 * Busca por proximidade de coordenada no grid (Proximity Hit-Test)
 * Encontra a unidade mais próxima das coordenadas do solo até um raio configurado (padrão 0.85 células).
 */
export function findUnitNearGroundPoint(groundX: number, groundZ: number, maxRadius = 0.85): RTSUnit | null {
  let bestUnit: RTSUnit | null = null;
  let minDistance = maxRadius;

  const selectableUnits = unitsList.filter((u) => !u.isGarrisoned && !u.isDying && (u.faction === 'PLAYER' || u.group.visible));

  // 1. Prioriza unidades aliadas (PLAYER) vivas primeiro
  for (const unit of selectableUnits) {
    if (unit.faction !== 'PLAYER' || unit.hp <= 0 || unit.isDying) continue;
    const uX = unit.gridX ?? unit.group.position.x;
    const uZ = unit.gridZ ?? unit.group.position.z;
    const distPos = Math.hypot(unit.group.position.x - groundX, unit.group.position.z - groundZ);
    const distGrid = Math.hypot(uX - groundX, uZ - groundZ);
    const distTile = Math.hypot(Math.floor(unit.group.position.x) + 0.5 - groundX, Math.floor(unit.group.position.z) + 0.5 - groundZ);
    const dist = Math.min(distPos, distGrid, distTile);

    if (dist < minDistance) {
      minDistance = dist;
      bestUnit = unit;
    }
  }

  if (bestUnit) return bestUnit;

  // 2. Se não houver aliada no raio, verifica unidades inimigas visíveis
  for (const unit of selectableUnits) {
    if (unit.faction === 'PLAYER' || unit.hp <= 0 || unit.isDying) continue;
    const uX = unit.gridX ?? unit.group.position.x;
    const uZ = unit.gridZ ?? unit.group.position.z;
    const distPos = Math.hypot(unit.group.position.x - groundX, unit.group.position.z - groundZ);
    const distGrid = Math.hypot(uX - groundX, uZ - groundZ);
    const distTile = Math.hypot(Math.floor(unit.group.position.x) + 0.5 - groundX, Math.floor(unit.group.position.z) + 0.5 - groundZ);
    const dist = Math.min(distPos, distGrid, distTile);

    if (dist < minDistance) {
      minDistance = dist;
      bestUnit = unit;
    }
  }

  return bestUnit;
}

/**
 * Raycaster com tolerância expandida para unidades (Direct Raycast + Proximity Hit-Test)
 */
export function findUnitUnderPointer(clientX: number, clientY: number): RTSUnit | null {
  setPointerNDC(clientX, clientY);
  const selectableUnits = unitsList.filter((u) => !u.isGarrisoned && !u.isDying && (u.faction === 'PLAYER' || u.group.visible));
  if (selectableUnits.length === 0) return null;

  // 1. Raycast direto nas malhas dos cilindros das unidades
  const cylinderHits = raycaster.intersectObjects(selectableUnits.map((u) => u.cylinderMesh), false);
  if (cylinderHits.length > 0) {
    const hitUnit = selectableUnits.find((u) => u.cylinderMesh === cylinderHits[0].object);
    if (hitUnit) return hitUnit;
  }

  // 1.1 Raycast direto nas malhas dos grupos das unidades (corpo, ferramentas, chapéu)
  const groupHits = raycaster.intersectObjects(selectableUnits.map((u) => u.group), true);
  if (groupHits.length > 0) {
    for (const h of groupHits) {
      const hitUnit = selectableUnits.find(
        (u) => u.group === h.object || u.group.children.includes(h.object) || u.cylinderMesh === h.object
      );
      if (hitUnit) return hitUnit;
    }
  }

  // 2. Proximity Hit-Test expandido no chão para toque capacitivo (0.85 células de raio)
  let groundX = 0;
  let groundZ = 0;
  let hasGround = false;

  const groundHits = raycaster.intersectObject(groundMesh, false);
  if (groundHits.length > 0) {
    groundX = groundHits[0].point.x;
    groundZ = groundHits[0].point.z;
    hasGround = true;
  } else if (raycaster.ray.intersectPlane(groundPlane, groundIntersect)) {
    groundX = groundIntersect.x;
    groundZ = groundIntersect.z;
    hasGround = true;
  }

  if (hasGround) {
    return findUnitNearGroundPoint(groundX, groundZ, 0.85);
  }

  return null;
}

function clearAllUnits() {
  unitsList.forEach((u) => scene.remove(u.group));
  unitsList.length = 0;
  activeSpawnAnimations.length = 0;
  updateTelemetryUnitsCount();
  updateTelemetrySelectionCount();
}

function unitCell(unit: RTSUnit): THREE.Vector2 {
  return new THREE.Vector2(Math.floor(unit.group.position.x), Math.floor(unit.group.position.z));
}

function setUnitPath(unit: RTSUnit, targetCell: THREE.Vector2) {
  const nodes = findPath(unitCell(unit), targetCell, unit.faction);
  unit.waypoints = nodes.map((n) => new THREE.Vector3(n.x + 0.5, 0, n.y + 0.5));
  unit.currentWaypointIndex = 0;
}

function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  const d = ((((b - a + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  return a + d * t;
}

function faceTowards(unit: RTSUnit, x: number, z: number, t = 0.25) {
  const angle = Math.atan2(x - unit.group.position.x, z - unit.group.position.z);
  unit.group.rotation.y = lerpAngle(unit.group.rotation.y, angle, t);
}

function resolveWallCollision(unit: RTSUnit): void {
  const uPosX = unit.group.position.x;
  const uPosZ = unit.group.position.z;

  const minX = Math.floor(uPosX - 0.6);
  const maxX = Math.ceil(uPosX + 0.6);
  const minZ = Math.floor(uPosZ - 0.6);
  const maxZ = Math.ceil(uPosZ + 0.6);

  let collisionOccurred = false;

  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      // Verifica se a célula contém uma muralha de pedra
      const key = `${x},${z}`;
      const isWallTile = blockedGridTiles.has(key);
      const b = buildingsGridMap.get(cellKey(x, z));
      const isWallBuilding = b && b.type === 'WALL' && !b.isDepleted && (b.hp === undefined || b.hp > 0);
      const isStaticWall = wallsList.some((w) => w.gridX === x && w.gridZ === z);

      if (isWallTile || isWallBuilding || isStaticWall) {
        // Clamping de colisão: empurra a unidade para fora do bounding box da muralha (0.9x0.9)
        const cellCenterX = x + 0.5;
        const cellCenterZ = z + 0.5;
        const halfSize = 0.48;

        const clampedX = Math.max(cellCenterX - halfSize, Math.min(cellCenterX + halfSize, unit.group.position.x));
        const clampedZ = Math.max(cellCenterZ - halfSize, Math.min(cellCenterZ + halfSize, unit.group.position.z));

        const diffX = unit.group.position.x - clampedX;
        const diffZ = unit.group.position.z - clampedZ;
        const dist = Math.hypot(diffX, diffZ);
        const unitRadius = 0.32;

        if (dist < unitRadius && dist > 0.0001) {
          const overlap = unitRadius - dist;
          unit.group.position.x += (diffX / dist) * overlap;
          unit.group.position.z += (diffZ / dist) * overlap;
          collisionOccurred = true;
        } else if (dist <= 0.0001) {
          // Unidade está exatamente no centro ou na borda clamped: empurra para longe do centro da célula
          const pushX = unit.group.position.x - cellCenterX || 1;
          const pushZ = unit.group.position.z - cellCenterZ || 0;
          const pDist = Math.hypot(pushX, pushZ) || 1;
          unit.group.position.x += (pushX / pDist) * 0.1;
          unit.group.position.z += (pushZ / pDist) * 0.1;
          collisionOccurred = true;
        }
      }
    }
  }

  if (collisionOccurred) {
    unit.group.position.y = getTerrainHeight(unit.group.position.x, unit.group.position.z);
  }
}

function moveAlongPath(unit: RTSUnit, delta: number): boolean {
  if (unit.currentWaypointIndex >= unit.waypoints.length) return true;

  const wp = unit.waypoints[unit.currentWaypointIndex];
  const dx = wp.x - unit.group.position.x;
  const dz = wp.z - unit.group.position.z;
  const dist = Math.hypot(dx, dz);

  if (dist <= 0.12) {
    unit.currentWaypointIndex++;
    return unit.currentWaypointIndex >= unit.waypoints.length;
  }

  const step = Math.min(dist, unit.speed * delta);
  unit.group.position.x += (dx / dist) * step;
  unit.group.position.z += (dz / dist) * step;
  resolveWallCollision(unit);
  unit.group.position.y = getTerrainHeight(unit.group.position.x, unit.group.position.z);
  faceTowards(unit, wp.x, wp.z);
  return false;
}

function resetChopPose(unit: RTSUnit) {
  unit.cylinderMesh.rotation.x = 0;
}

function isTreeAlive(tree: TreeResource | null): tree is TreeResource {
  return !!tree && !tree.depleting && tree.wood > 0 && treesMap.has(tree.key);
}

function isBerryBushAlive(bush: BerryBushResource | null): bush is BerryBushResource {
  return !!bush && !bush.depleting && bush.food > 0 && berryBushesMap.has(bush.key);
}

function isStoneMineAlive(mine: StoneMineResource | null): mine is StoneMineResource {
  return !!mine && !mine.depleting && mine.stone > 0 && stoneMinesMap.has(mine.key);
}

function isGoldMineAlive(mine: GoldMineResource | null): mine is GoldMineResource {
  return !!mine && !mine.depleting && mine.gold > 0 && goldMinesMap.has(mine.key);
}

function findNearestTree(fromX: number, fromZ: number, maxDist = TREE_SEARCH_RADIUS): TreeResource | null {
  let best: TreeResource | null = null;
  let bestDist = maxDist;
  treesMap.forEach((t) => {
    if (!isTreeAlive(t)) return;
    const d = Math.hypot(t.gridX - fromX, t.gridZ - fromZ);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  });
  return best;
}

function findNearestBerryBush(fromX: number, fromZ: number, maxDist = BERRY_SEARCH_RADIUS): BerryBushResource | null {
  let best: BerryBushResource | null = null;
  let bestDist = maxDist;
  berryBushesMap.forEach((b) => {
    if (!isBerryBushAlive(b)) return;
    const d = Math.hypot(b.gridX - fromX, b.gridZ - fromZ);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  });
  return best;
}

function findNearestStoneMine(fromX: number, fromZ: number, maxDist = 24): StoneMineResource | null {
  let best: StoneMineResource | null = null;
  let bestDist = maxDist;
  stoneMinesMap.forEach((m) => {
    if (!isStoneMineAlive(m)) return;
    const d = Math.hypot(m.gridX - fromX, m.gridZ - fromZ);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  });
  return best;
}

function findNearestGoldMine(fromX: number, fromZ: number, maxDist = 28): GoldMineResource | null {
  let best: GoldMineResource | null = null;
  let bestDist = maxDist;
  goldMinesMap.forEach((m) => {
    if (!isGoldMineAlive(m)) return;
    const d = Math.hypot(m.gridX - fromX, m.gridZ - fromZ);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  });
  return best;
}

function pickGatherCell(unit: RTSUnit, target: { gridX: number; gridZ: number }): THREE.Vector2 {
  const pos = unit.group.position;
  let best: THREE.Vector2 | null = null;
  let bestScore = Infinity;

  for (const dir of DIRS) {
    const cx = target.gridX + dir.dx;
    const cz = target.gridZ + dir.dz;
    if (!isCellWalkable(cx, cz)) continue;

    const claims = unitsList.filter(
      (u) => u !== unit && u.gatherCell && u.gatherCell.x === cx && u.gatherCell.y === cz
    ).length;
    const score = Math.hypot(cx + 0.5 - pos.x, cz + 0.5 - pos.z) + claims * 4 + (dir.cost > 1 ? 0.3 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = new THREE.Vector2(cx, cz);
    }
  }

  return best ?? findClosestWalkableCell(new THREE.Vector2(target.gridX, target.gridZ), unitCell(unit));
}

export interface DropoffDestination {
  cell: THREE.Vector2;
  buildingCenter: THREE.Vector3;
  building: ConstructionBuilding | null;
}

/**
 * Lógica Dinâmica de Dropoff (Ponto de Entrega Mais Próximo):
 * - Town Center aceita TODOS os recursos (Madeira, Alimento, Pedra).
 * - Madeireira (Lumber Camp) aceita exclusivamente MADEIRA.
 * - Campo de Mineração (Mining Camp) aceita PEDRA.
 * - Encontra o edifício compatível mais próximo e seleciona a célula de borda livre com menor distância.
 */
export function findNearestDropoffPoint(
  target: RTSUnit | THREE.Vector3 | { x: number; z: number },
  resourceType?: 'WOOD' | 'FOOD' | 'STONE' | 'GOLD' | null,
  factionParam?: UnitFaction
): DropoffDestination | null {
  let villagerPos: { x: number; z: number };
  let resType: 'WOOD' | 'FOOD' | 'STONE' | 'GOLD' | null = resourceType ?? null;
  let faction: UnitFaction = factionParam ?? 'PLAYER';

  if ('faction' in target) {
    villagerPos = { x: target.group.position.x, z: target.group.position.z };
    resType = resourceType !== undefined ? resourceType : target.carriedResourceType;
    faction = factionParam ?? target.faction;
  } else if ('x' in target && 'z' in target) {
    villagerPos = target;
  } else {
    villagerPos = { x: 0, z: 0 };
  }

  let bestCell: THREE.Vector2 | null = null;
  let bestCenter: THREE.Vector3 | null = null;
  let bestBuilding: ConstructionBuilding | null = null;
  let bestDist = Infinity;

  if (faction === 'ENEMY') {
    // 1. Town Center Inimigo (3x3, apenas se vivo e não destruído)
    if (enemyCampState && !enemyCampState.isTentDestroyed) {
      const tcCenter = new THREE.Vector3(enemyCampCoord.x + 1.5, 0, enemyCampCoord.z + 1.5);
      for (let dx = -1; dx <= 3; dx++) {
        for (let dz = -1; dz <= 3; dz++) {
          if (dx === -1 || dx === 3 || dz === -1 || dz === 3) {
            const cx = enemyCampCoord.x + dx;
            const cz = enemyCampCoord.z + dz;
            if (isCellInside(cx, cz) && isCellWalkable(cx, cz)) {
              const d = Math.hypot(cx + 0.5 - villagerPos.x, cz + 0.5 - villagerPos.z);
              if (d < bestDist) {
                bestDist = d;
                bestCell = new THREE.Vector2(cx, cz);
                bestCenter = tcCenter;
                bestBuilding = null;
              }
            }
          }
        }
      }
    }

    // 2. Estruturas erguidas pela facção inimiga (b.faction === 'ENEMY' e b.isCompleted)
    for (const b of buildingsList) {
      if (!b.isCompleted || b.faction !== 'ENEMY') continue;

      let isCompatible = false;
      if (resType === 'WOOD' && b.type === 'LUMBER_CAMP') {
        isCompatible = true;
      } else if ((resType === 'STONE' || resType === 'GOLD') && b.type === 'MINING_CAMP') {
        isCompatible = true;
      } else if (resType === 'FOOD' && b.type === 'MILL') {
        isCompatible = true;
      }

      if (!isCompatible) continue;

      const perim = getBuildingPerimeterCells(b);
      for (const c of perim) {
        if (!isCellWalkable(c.x, c.y)) continue;
        const d = Math.hypot(c.x + 0.5 - villagerPos.x, c.y + 0.5 - villagerPos.z);
        if (d < bestDist) {
          bestDist = d;
          bestCell = c;
          bestCenter = b.worldCenter;
          bestBuilding = b;
        }
      }
    }
  } else {
    // Aldeões aliados (PLAYER) só podem entregar em:
    // 1. Town Center aliado (se não estiver destruído)
    if (!townCenterState.isDestroyed) {
      for (const c of dropoffCells) {
        if (!isCellWalkable(c.x, c.y)) continue;
        const d = Math.hypot(c.x + 0.5 - villagerPos.x, c.y + 0.5 - villagerPos.z);
        if (d < bestDist) {
          bestDist = d;
          bestCell = c;
          bestCenter = TC_WORLD_CENTER;
          bestBuilding = null;
        }
      }
    }

    // 2. Estruturas erguidas pela facção aliada (b.faction === 'PLAYER' e b.isCompleted)
    for (const b of buildingsList) {
      if (!b.isCompleted || b.faction !== 'PLAYER') continue;

      let isCompatible = false;
      if (resType === 'WOOD' && b.type === 'LUMBER_CAMP') {
        isCompatible = true;
      } else if ((resType === 'STONE' || resType === 'GOLD') && b.type === 'MINING_CAMP') {
        isCompatible = true;
      } else if (resType === 'FOOD' && b.type === 'MILL') {
        isCompatible = true;
      }

      if (!isCompatible) continue;

      const perim = getBuildingPerimeterCells(b);
      for (const c of perim) {
        if (!isCellWalkable(c.x, c.y)) continue;
        const d = Math.hypot(c.x + 0.5 - villagerPos.x, c.y + 0.5 - villagerPos.z);
        if (d < bestDist) {
          bestDist = d;
          bestCell = c;
          bestCenter = b.worldCenter;
          bestBuilding = b;
        }
      }
    }
  }

  if (!bestCell || !bestCenter) {
    return null;
  }

  return {
    cell: bestCell,
    buildingCenter: bestCenter,
    building: bestBuilding
  };
}

// --- Comandos ---
function clearUnitFarmTarget(unit: RTSUnit) {
  if (unit.targetFarm) {
    if (unit.targetFarm.assignedFarmerId === unit.id) {
      unit.targetFarm.assignedFarmerId = null;
      if (selectedBuilding === unit.targetFarm) updateFarmHUD();
    }
    unit.targetFarm = null;
  }
}

function commandMove(unit: RTSUnit, cell: THREE.Vector2) {
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING';
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.lastPursuitTargetCell = null;
  unit.gatherCell = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  setUnitPath(unit, cell);
}

function commandGather(unit: RTSUnit, tree: TreeResource) {
  if (unit.unitType !== 'VILLAGER') {
    const escortCell = findClosestWalkableCell(
      new THREE.Vector2(tree.gridX, tree.gridZ),
      unitCell(unit)
    );
    commandMove(unit, escortCell);
    return;
  }
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_RESOURCE';
  unit.carriedResourceType = 'WOOD';
  unit.targetTree = tree;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.lastTreeCell = new THREE.Vector2(tree.gridX, tree.gridZ);
  unit.gatherCell = pickGatherCell(unit, tree);
  setUnitPath(unit, unit.gatherCell);
}

function commandForage(unit: RTSUnit, bush: BerryBushResource) {
  if (unit.unitType !== 'VILLAGER') {
    const escortCell = findClosestWalkableCell(
      new THREE.Vector2(bush.gridX, bush.gridZ),
      unitCell(unit)
    );
    commandMove(unit, escortCell);
    return;
  }
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_RESOURCE';
  unit.carriedResourceType = 'FOOD';
  unit.targetBerryBush = bush;
  unit.targetTree = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.lastBerryCell = new THREE.Vector2(bush.gridX, bush.gridZ);
  unit.gatherCell = pickGatherCell(unit, bush);
  setUnitPath(unit, unit.gatherCell);
}

function commandMine(unit: RTSUnit, mine: StoneMineResource) {
  if (unit.unitType !== 'VILLAGER') {
    const escortCell = findClosestWalkableCell(
      new THREE.Vector2(mine.gridX, mine.gridZ),
      unitCell(unit)
    );
    commandMove(unit, escortCell);
    return;
  }
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_RESOURCE';
  unit.carriedResourceType = 'STONE';
  unit.targetStoneMine = mine;
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.lastStoneCell = new THREE.Vector2(mine.gridX, mine.gridZ);
  unit.gatherCell = pickGatherCell(unit, mine);
  setUnitPath(unit, unit.gatherCell);
}

function commandMineGold(unit: RTSUnit, mine: GoldMineResource) {
  if (unit.unitType !== 'VILLAGER') {
    const escortCell = findClosestWalkableCell(
      new THREE.Vector2(mine.gridX, mine.gridZ),
      unitCell(unit)
    );
    commandMove(unit, escortCell);
    return;
  }
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_RESOURCE';
  unit.carriedResourceType = 'GOLD';
  unit.targetGoldMine = mine;
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.lastGoldCell = new THREE.Vector2(mine.gridX, mine.gridZ);
  unit.gatherCell = pickGatherCell(unit, mine);
  setUnitPath(unit, unit.gatherCell);
}

function commandBuild(unit: RTSUnit, building: ConstructionBuilding) {
  if (unit.unitType !== 'VILLAGER') {
    const escortCell = findClosestWalkableCell(
      new THREE.Vector2(building.gridX, building.gridZ),
      unitCell(unit)
    );
    commandMove(unit, escortCell);
    return;
  }
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_BUILD';
  unit.targetBuilding = building;
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.gatherCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.buildCell = pickBuildCell(unit, building);
  setUnitPath(unit, unit.buildCell);
}

export function commandRepairBuilding(unit: RTSUnit, building: ConstructionBuilding) {
  if (unit.unitType !== 'VILLAGER') return;
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_REPAIR';
  unit.targetBuilding = building;
  unit.targetStructure = 'BUILDING';
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetEnemy = null;
  unit.gatherCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.repairWoodSpent = 0;
  unit.repairStoneSpent = 0;
  unit.repairSoundTimer = 0;
  unit.buildCell = pickBuildCell(unit, building);
  setUnitPath(unit, unit.buildCell);
}

export function commandRepairTownCenter(unit: RTSUnit) {
  if (unit.unitType !== 'VILLAGER') return;
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'MOVING_TO_REPAIR';
  unit.targetBuilding = null;
  unit.targetStructure = 'TOWN_CENTER';
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetEnemy = null;
  unit.gatherCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.repairWoodSpent = 0;
  unit.repairStoneSpent = 0;
  unit.repairSoundTimer = 0;
  unit.buildCell = pickTownCenterPerimeterCell(unit);
  setUnitPath(unit, unit.buildCell);
}

export function applyRallyPointOrder(unit: RTSUnit, rp: RallyPoint | null | undefined): void {
  if (!rp) return;

  // Caso 1: Rally Point sobre Recurso Natural ou Fazenda (apenas aldeões)
  if (unit.unitType === 'VILLAGER' && rp.targetType === 'RESOURCE') {
    // 1. Árvore
    if (rp.resourceType === 'WOOD' || rp.targetId !== undefined) {
      const treeKey = typeof rp.targetId === 'number' ? rp.targetId : cellKey(rp.x, rp.z);
      const tree = treesMap.get(treeKey);
      if (tree && !tree.depleting && tree.wood > 0) {
        commandGather(unit, tree);
        return;
      }
    }

    // 2. Arbusto de Frutas
    if (rp.resourceType === 'FOOD' || rp.targetId !== undefined) {
      const bushKey = typeof rp.targetId === 'number' ? rp.targetId : cellKey(rp.x, rp.z);
      const bush = berryBushesMap.get(bushKey);
      if (bush && !bush.depleting && bush.food > 0) {
        commandForage(unit, bush);
        return;
      }
    }

    // 3. Fazenda
    if (rp.resourceType === 'FOOD' || typeof rp.targetId === 'string') {
      const farm = buildingsList.find(
        (b) => (b.id === rp.targetId || (b.gridX === rp.x && b.gridZ === rp.z)) && b.type === 'FARM' && !b.isDepleted
      );
      if (farm) {
        commandFarm(unit, farm);
        return;
      }
    }

    // 4. Jazida de Pedra
    if (rp.resourceType === 'STONE' || rp.targetId !== undefined) {
      const stoneKey = typeof rp.targetId === 'number' ? rp.targetId : cellKey(rp.x, rp.z);
      const stoneMine = stoneMinesMap.get(stoneKey);
      if (stoneMine && !stoneMine.depleting && stoneMine.stone > 0) {
        commandMine(unit, stoneMine);
        return;
      }
    }

    // 5. Mina de Ouro
    if (rp.resourceType === 'GOLD' || rp.targetId !== undefined) {
      const goldKey = typeof rp.targetId === 'number' ? rp.targetId : cellKey(rp.x, rp.z);
      const goldMine = goldMinesMap.get(goldKey);
      if (goldMine && !goldMine.depleting && goldMine.gold > 0) {
        commandMineGold(unit, goldMine);
        return;
      }
    }
  }

  // Caso 2: Rally Point sobre Canteiro de Obras incompleto (apenas aldeões)
  if (unit.unitType === 'VILLAGER' && rp.targetType === 'BUILDING' && rp.targetId) {
    const bTarget = buildingsList.find(
      (b) => (b.id === rp.targetId || (b.gridX === rp.x && b.gridZ === rp.z)) && !b.isCompleted
    );
    if (bTarget) {
      commandBuild(unit, bTarget);
      return;
    }
  }

  // Caso 3: Marcha normal para a coordenada do Rally Point
  commandMove(unit, new THREE.Vector2(rp.x, rp.z));
}

function commandReturnToBase(unit: RTSUnit) {
  resetChopPose(unit);
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.gatherCell = null;
  unit.buildCell = null;
  const dropoff = findNearestDropoffPoint(unit, unit.carriedResourceType, unit.faction);
  if (!dropoff) {
    // Sem depósito compatível da própria facção: transiciona para IDLE retendo a carga
    unit.state = 'IDLE';
    unit.dropoffTarget = null;
    unit.dropoffBuilding = null;
    unit.waypoints = [];
    if (unit.faction === 'PLAYER') {
      spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem depósito disponível!', '#f87171');
    }
    return;
  }
  unit.state = 'RETURNING_TO_BASE';
  unit.dropoffTarget = dropoff.buildingCenter;
  unit.dropoffBuilding = dropoff.building;
  setUnitPath(unit, dropoff.cell);
}

function goIdle(unit: RTSUnit) {
  resetChopPose(unit);
  clearUnitFarmTarget(unit);
  unit.state = 'IDLE';
  unit.targetTree = null;
  unit.targetBerryBush = null;
  unit.targetStoneMine = null;
  unit.targetGoldMine = null;
  unit.targetBuilding = null;
  unit.targetEnemy = null;
  unit.targetStructure = null;
  unit.lastPursuitTargetCell = null;
  unit.gatherCell = null;
  unit.buildCell = null;
  unit.dropoffTarget = null;
  unit.dropoffBuilding = null;
  unit.repairWoodSpent = 0;
  unit.repairStoneSpent = 0;
  unit.repairSoundTimer = 0;
  unit.waypoints = [];
}

function retargetOrFinish(unit: RTSUnit) {
  if (unit.targetFarm) {
    if (isFarmAlive(unit.targetFarm)) {
      commandFarm(unit, unit.targetFarm);
    } else if (unit.carrying > 0) {
      commandReturnToBase(unit);
    } else {
      goIdle(unit);
    }
    return;
  }

  if (unit.carriedResourceType === 'FOOD') {
    const ref = unit.lastBerryCell ?? unitCell(unit);
    const next = findNearestBerryBush(ref.x, ref.y);
    if (unit.carrying > 0) {
      unit.targetBerryBush = next;
      commandReturnToBase(unit);
    } else if (next) {
      commandForage(unit, next);
    } else {
      goIdle(unit);
    }
  } else if (unit.carriedResourceType === 'STONE') {
    const ref = unit.lastStoneCell ?? unitCell(unit);
    const next = findNearestStoneMine(ref.x, ref.y);
    if (unit.carrying > 0) {
      unit.targetStoneMine = next;
      commandReturnToBase(unit);
    } else if (next) {
      commandMine(unit, next);
    } else {
      goIdle(unit);
    }
  } else if (unit.carriedResourceType === 'GOLD') {
    const ref = unit.lastGoldCell ?? unitCell(unit);
    const next = findNearestGoldMine(ref.x, ref.y);
    if (unit.carrying > 0) {
      unit.targetGoldMine = next;
      commandReturnToBase(unit);
    } else if (next) {
      commandMineGold(unit, next);
    } else {
      goIdle(unit);
    }
  } else {
    const ref = unit.lastTreeCell ?? unitCell(unit);
    const next = findNearestTree(ref.x, ref.y);
    if (unit.carrying > 0) {
      unit.targetTree = next;
      commandReturnToBase(unit);
    } else if (next) {
      commandGather(unit, next);
    } else {
      goIdle(unit);
    }
  }
}

function depleteTree(tree: TreeResource) {
  tree.depleting = true;
  tree.depleteProgress = 0;
  console.log(`[RTS Recursos] Árvore em (${tree.gridX}, ${tree.gridZ}) esgotada.`);
}

function depleteBerryBush(bush: BerryBushResource) {
  bush.depleting = true;
  bush.depleteProgress = 0;
  bush.foliageMeshes.forEach((mesh) => {
    (mesh.material as THREE.MeshLambertMaterial).color.setHex(0x784824);
  });
  bush.fruitMeshes.forEach((fruit) => {
    fruit.visible = false;
  });
  console.log(`[RTS Recursos] Arbusto de frutas em (${bush.gridX}, ${bush.gridZ}) esgotado.`);
}

function updateBerryBushVisuals(bush: BerryBushResource) {
  // Conforme o alimento diminui de 150 a 0, as esferas vermelhas encolhem/somem
  const pct = Math.max(0, bush.food / bush.maxFood);
  const totalBerries = bush.fruitMeshes.length;
  const visibleCount = Math.ceil(pct * totalBerries);

  bush.fruitMeshes.forEach((mesh, idx) => {
    if (idx < visibleCount) {
      mesh.visible = true;
      mesh.scale.setScalar(0.5 + 0.5 * pct);
    } else {
      mesh.visible = false;
    }
  });
}

function depleteStoneMine(mine: StoneMineResource) {
  mine.depleting = true;
  mine.depleteProgress = 0;
  spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.35, mine.gridZ + 0.5), 16, 0x64748b);
  console.log(`[RTS Recursos] Jazida de pedra em (${mine.gridX}, ${mine.gridZ}) esgotada.`);

  unitsList.forEach((u) => {
    if (u.targetStoneMine === mine) {
      if (u.carrying > 0) {
        commandReturnToBase(u);
      } else {
        retargetOrFinish(u);
      }
    }
  });
}

function updateStoneMineVisuals(mine: StoneMineResource) {
  // Conforme a jazida é minerada, diminua a escala vertical da rocha gradualmente
  const pct = Math.max(0.2, mine.stone / mine.maxStone);
  mine.bouldersGroup.scale.y = pct;
}

function depleteGoldMine(mine: GoldMineResource) {
  mine.depleting = true;
  mine.depleteProgress = 0;
  spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.35, mine.gridZ + 0.5), 18, 0xfacc15);
  spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.35, mine.gridZ + 0.5), 10, 0x1e293b);
  console.log(`[RTS Recursos] Mina de ouro em (${mine.gridX}, ${mine.gridZ}) esgotada.`);

  unitsList.forEach((u) => {
    if (u.targetGoldMine === mine) {
      if (u.carrying > 0) {
        commandReturnToBase(u);
      } else {
        retargetOrFinish(u);
      }
    }
  });
}

function updateGoldMineVisuals(mine: GoldMineResource) {
  // Conforme o ouro é extraído, diminua a escala vertical e atenue o brilho dos veios dourados
  const pct = Math.max(0.18, mine.gold / mine.maxGold);
  mine.bouldersGroup.scale.y = pct;
  mine.goldVeinsGroup.scale.set(0.35 + 0.65 * pct, pct, 0.35 + 0.65 * pct);
  for (const mat of mine.goldVeinMaterials) {
    mat.emissiveIntensity = 0.12 + 0.43 * pct;
  }
}

export function hasPlayerAlchemist(): boolean {
  return unitsList.some(
    (u) => u.unitType === 'VILLAGER' && u.faction === 'PLAYER' && u.educationLevel >= 2 && u.eliteSpecialization === 'ALCHEMIST' && !u.isDying
  );
}

function tickAlchemistPassiveGold(unit: RTSUnit, delta: number): void {
  if (unit.educationLevel >= 2 && unit.eliteSpecialization === 'ALCHEMIST' && unit.faction === 'PLAYER') {
    unit.alchemistTimer = (unit.alchemistTimer || 0) + delta;
    if (unit.alchemistTimer >= 3.0) {
      unit.alchemistTimer -= 3.0;
      resources.gold += 1;
      gameStats.goldCollectedTotal += 1;
      updateResourceHUD(true);
      spawnFloatingText(unit.group.position.clone().setY(2.1), '+1 🪙 (Transmutação)', '#facc15');
      spawnParticles(unit.group.position.clone().setY(0.9), 5, 0xfacc15);
    }
  }
}

/**
 * Atualiza o estado de cada aldeão no loop de renderização
 */
function updateUnitState(unit: RTSUnit, delta: number, now: number) {
  switch (unit.state) {
    case 'IDLE':
      break;

    case 'MOVING':
      if (moveAlongPath(unit, delta)) goIdle(unit);
      break;

    case 'MOVING_TO_RESOURCE': {
      if (unit.targetFarm) {
        if (!isFarmAlive(unit.targetFarm)) {
          retargetOrFinish(unit);
          break;
        }
      } else if (unit.carriedResourceType === 'FOOD') {
        if (!isBerryBushAlive(unit.targetBerryBush)) {
          retargetOrFinish(unit);
          break;
        }
      } else if (unit.carriedResourceType === 'STONE') {
        if (!isStoneMineAlive(unit.targetStoneMine)) {
          retargetOrFinish(unit);
          break;
        }
      } else if (unit.carriedResourceType === 'GOLD') {
        if (!isGoldMineAlive(unit.targetGoldMine)) {
          retargetOrFinish(unit);
          break;
        }
      } else {
        if (!isTreeAlive(unit.targetTree)) {
          retargetOrFinish(unit);
          break;
        }
      }
      if (moveAlongPath(unit, delta)) {
        unit.state = unit.carriedResourceType === 'GOLD' ? 'MINING_GOLD' : 'GATHERING';
        unit.gatherTimer = 0;
      }
      break;
    }

    case 'MINING_GOLD':
    case 'GATHERING': {
      // Bônus Passivo do Mestre Alquimista: +1 Ouro a cada 3 segundos de trabalho contínuo
      tickAlchemistPassiveGold(unit, delta);

      if (unit.carriedResourceType === 'GOLD') {
        const mine = unit.targetGoldMine;
        if (!isGoldMineAlive(mine)) {
          retargetOrFinish(unit);
          break;
        }

        faceTowards(unit, mine.gridX + 0.5, mine.gridZ + 0.5, 0.3);
        const aiRate = unit.faction === 'ENEMY' ? (currentAIDifficulty === 'EASY' ? 0.55 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0)) : 1.0;
        unit.gatherTimer += delta * (unit.educationLevel >= 1 ? 1.25 : 1.0) * aiRate;

        // Animação de picaretada vigorosa (balanço rápido de cima para baixo)
        const pickSwing = Math.sin(unit.gatherTimer * Math.PI * 3.5);
        unit.cylinderMesh.rotation.x = Math.max(0, pickSwing) * 0.44;

        if (pickSwing > 0.94) {
          mine.mineUntil = now + 140;
          soundManager.mineGold();
          // Faíscas douradas brilhantes no ponto de impacto da picareta
          if (Math.random() < 0.35) {
            const sparkPos = new THREE.Vector3(
              (unit.group.position.x + mine.gridX + 0.5) * 0.5,
              0.28,
              (unit.group.position.z + mine.gridZ + 0.5) * 0.5
            );
            spawnParticles(sparkPos, 4, 0xfacc15);
          }
        }

        if (unit.gatherTimer >= currentMatchConfig.goldMiningTime) {
          unit.cylinderMesh.rotation.x = 0;
          const cap = unit.carryCapacity || GATHER_AMOUNT;
          const amount = Math.min(cap, mine.gold);
          mine.gold -= amount;
          unit.carrying = amount;
          updateGoldMineVisuals(mine);

          unit.carryMesh.visible = true;
          unit.woodCarryMesh.visible = false;
          unit.berryCarryMesh.visible = false;
          unit.stoneCarryMesh.visible = false;
          unit.goldCarryMesh.visible = true;

          if (mine.gold <= 0) depleteGoldMine(mine);
          commandReturnToBase(unit);
        }
      } else if (unit.targetFarm) {
        const farm = unit.targetFarm;
        if (!isFarmAlive(farm)) {
          retargetOrFinish(unit);
          break;
        }

        faceTowards(unit, farm.worldCenter.x, farm.worldCenter.z, 0.3);
        let gatherMult = unit.educationLevel >= 2 ? 1.5 : (unit.educationLevel >= 1 ? 1.25 : 1.0);
        if (hasLivingAgronomist()) {
          gatherMult *= 1.2; // Bônus de presença: +20% de velocidade de colheita em todas as fazendas
        }
        unit.gatherTimer += delta * gatherMult;

        // Animação de agricultor cultivando a fazenda com a enxada
        const hoeSwing = Math.sin(unit.gatherTimer * Math.PI * 3.5);
        unit.cylinderMesh.rotation.x = Math.max(0, hoeSwing) * 0.36;
        unit.cylinderMesh.position.y = 0.4 - Math.max(0, hoeSwing) * 0.06;
        if (hoeSwing > 0.94) {
          soundManager.farmHarvest();
        }

        if (unit.gatherTimer >= currentMatchConfig.woodGatherTime) {
          unit.cylinderMesh.position.y = 0.4;
          unit.cylinderMesh.rotation.x = 0;
          const cap = unit.carryCapacity || GATHER_AMOUNT;
          const isAgronomist = unit.educationLevel >= 2 && unit.eliteSpecialization === 'AGRONOMIST';
          // Agrônomo: Dobra o rendimento de fazendas ao redor (x2 colheita e conserva o solo)
          const hasNearbyAgronomist = isAgronomist || unitsList.some(
            (u) => u.unitType === 'VILLAGER' && u.faction === unit.faction && u.educationLevel >= 2 && u.eliteSpecialization === 'AGRONOMIST' && !u.isDying && u.group.position.distanceTo(farm.worldCenter) <= 8.5
          );

          const baseTake = Math.min(cap, farm.farmFood ?? 0);
          const isDoubled = hasNearbyAgronomist;
          const farmDeduct = isDoubled ? Math.ceil(baseTake * 0.5) : baseTake;
          farm.farmFood = Math.max(0, (farm.farmFood ?? 0) - farmDeduct);
          unit.carrying = isDoubled ? Math.min(cap * 2, baseTake * 2) : baseTake;
          updateFarmVisuals(farm);

          if (isDoubled) {
            spawnFloatingText(unit.group.position.clone().setY(2.0), isAgronomist ? '🌾 Safra Dobrada (2x)! 🌾' : '🌾 Rendimento Dobrado (Agrônomo 2x)!', '#4ade80');
          }

          unit.carryMesh.visible = true;
          unit.woodCarryMesh.visible = false;
          unit.berryCarryMesh.visible = true;
          unit.stoneCarryMesh.visible = false;
          unit.goldCarryMesh.visible = false;

          if ((farm.farmFood ?? 0) <= 0) {
            depleteFarm(farm);
          }
          commandReturnToBase(unit);
        }
      } else if (unit.carriedResourceType === 'FOOD') {
        const bush = unit.targetBerryBush;
        if (!isBerryBushAlive(bush)) {
          retargetOrFinish(unit);
          break;
        }

        faceTowards(unit, bush.gridX + 0.5, bush.gridZ + 0.5, 0.3);
        const gatherMult = unit.educationLevel >= 2 ? 1.5 : (unit.educationLevel >= 1 ? 1.25 : 1.0);
        const aiRate = unit.faction === 'ENEMY' ? (currentAIDifficulty === 'EASY' ? 0.55 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0)) : 1.0;
        unit.gatherTimer += delta * gatherMult * aiRate;

        // Animação sutil de colheita/agachar (movimento vertical + inclinação leve)
        const forageBob = Math.sin(unit.gatherTimer * Math.PI * 4);
        unit.cylinderMesh.rotation.x = Math.max(0, forageBob) * 0.22;
        unit.cylinderMesh.position.y = 0.4 - Math.max(0, forageBob) * 0.08;
        if (forageBob > 0.9) {
          bush.forageUntil = now + 120;
          soundManager.forageFood();
        }

        if (unit.gatherTimer >= currentMatchConfig.woodGatherTime) {
          unit.cylinderMesh.position.y = 0.4;
          const cap = unit.carryCapacity || GATHER_AMOUNT;
          const amount = Math.min(cap, bush.food);
          bush.food -= amount;
          unit.carrying = amount;
          updateBerryBushVisuals(bush);

          unit.carryMesh.visible = true;
          unit.woodCarryMesh.visible = false;
          unit.berryCarryMesh.visible = true;
          unit.stoneCarryMesh.visible = false;
          unit.goldCarryMesh.visible = false;

          if (bush.food <= 0) depleteBerryBush(bush);
          commandReturnToBase(unit);
        }
      } else if (unit.carriedResourceType === 'STONE') {
        const mine = unit.targetStoneMine;
        if (!isStoneMineAlive(mine)) {
          retargetOrFinish(unit);
          break;
        }

        faceTowards(unit, mine.gridX + 0.5, mine.gridZ + 0.5, 0.3);
        const aiRate = unit.faction === 'ENEMY' ? (currentAIDifficulty === 'EASY' ? 0.55 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0)) : 1.0;
        unit.gatherTimer += delta * (unit.educationLevel >= 1 ? 1.25 : 1.0) * aiRate;

        // Animação de picaretada vigorosa (balanço rápido de cima para baixo)
        const pickSwing = Math.sin(unit.gatherTimer * Math.PI * 3.5);
        unit.cylinderMesh.rotation.x = Math.max(0, pickSwing) * 0.44;

        if (pickSwing > 0.94) {
          mine.mineUntil = now + 140;
          soundManager.mineStone();
          // Faíscas sutis no ponto de impacto da picareta
          if (Math.random() < 0.28) {
            const sparkPos = new THREE.Vector3(
              (unit.group.position.x + mine.gridX + 0.5) * 0.5,
              0.25,
              (unit.group.position.z + mine.gridZ + 0.5) * 0.5
            );
            spawnParticles(sparkPos, 3, 0xfde047);
          }
        }

        if (unit.gatherTimer >= currentMatchConfig.stoneMiningTime) {
          unit.cylinderMesh.rotation.x = 0;
          const cap = unit.carryCapacity || GATHER_AMOUNT;
          const amount = Math.min(cap, mine.stone);
          mine.stone -= amount;
          unit.carrying = amount;
          updateStoneMineVisuals(mine);

          unit.carryMesh.visible = true;
          unit.woodCarryMesh.visible = false;
          unit.berryCarryMesh.visible = false;
          unit.stoneCarryMesh.visible = true;
          unit.goldCarryMesh.visible = false;

          if (mine.stone <= 0) depleteStoneMine(mine);
          commandReturnToBase(unit);
        }
      } else {
        const tree = unit.targetTree;
        if (!isTreeAlive(tree)) {
          retargetOrFinish(unit);
          break;
        }

        faceTowards(unit, tree.gridX + 0.5, tree.gridZ + 0.5, 0.3);
        const aiRate = unit.faction === 'ENEMY' ? (currentAIDifficulty === 'EASY' ? 0.55 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0)) : 1.0;
        unit.gatherTimer += delta * (unit.educationLevel >= 1 ? 1.25 : 1.0) * aiRate;

        const swing = Math.sin(unit.gatherTimer * Math.PI * 3);
        unit.cylinderMesh.rotation.x = Math.max(0, swing) * 0.38;
        if (swing > 0.95) {
          tree.chopUntil = now + 140;
          soundManager.chopWood();
        }

        if (unit.gatherTimer >= currentMatchConfig.woodGatherTime) {
          const cap = unit.carryCapacity || GATHER_AMOUNT;
          const amount = Math.min(cap, tree.wood);
          tree.wood -= amount;
          unit.carrying = amount;
          unit.carryMesh.visible = true;
          unit.woodCarryMesh.visible = true;
          unit.berryCarryMesh.visible = false;
          unit.stoneCarryMesh.visible = false;
          unit.goldCarryMesh.visible = false;
          if (tree.wood <= 0) depleteTree(tree);
          commandReturnToBase(unit);
        }
      }
      break;
    }

    case 'RETURNING_TO_BASE': {
      // Validação do dropoff durante o trajeto
      let isDropoffValid = true;
      if (unit.dropoffBuilding) {
        if (!unit.dropoffBuilding.isCompleted || unit.dropoffBuilding.faction !== unit.faction) {
          isDropoffValid = false;
        }
      } else {
        if (unit.faction === 'PLAYER') {
          if (townCenterState.isDestroyed) isDropoffValid = false;
        } else {
          if (!enemyCampState || enemyCampState.isTentDestroyed) isDropoffValid = false;
        }
      }

      if (!isDropoffValid) {
        const fallback = findNearestDropoffPoint(unit, unit.carriedResourceType, unit.faction);
        if (fallback) {
          unit.dropoffTarget = fallback.buildingCenter;
          unit.dropoffBuilding = fallback.building;
          setUnitPath(unit, fallback.cell);
        } else {
          // Sem dropoff válido da sua facção: transiciona para IDLE retendo a carga
          unit.state = 'IDLE';
          unit.dropoffTarget = null;
          unit.dropoffBuilding = null;
          unit.waypoints = [];
          break;
        }
      }

      if (moveAlongPath(unit, delta)) {
        unit.state = 'DEPOSITING';
        unit.depositTimer = 0;
      }
      break;
    }

    case 'DEPOSITING': {
      // Validação estrita do ponto de entrega da mesma facção antes de descarregar
      let isDropoffValid = true;
      if (unit.dropoffBuilding) {
        if (!unit.dropoffBuilding.isCompleted || unit.dropoffBuilding.faction !== unit.faction) {
          isDropoffValid = false;
        }
      } else {
        if (unit.faction === 'PLAYER') {
          if (townCenterState.isDestroyed) isDropoffValid = false;
        } else {
          if (!enemyCampState || enemyCampState.isTentDestroyed) isDropoffValid = false;
        }
      }

      if (!isDropoffValid) {
        unit.state = 'IDLE';
        unit.dropoffTarget = null;
        unit.dropoffBuilding = null;
        unit.waypoints = [];
        break;
      }

      const dropoffPos = unit.dropoffTarget ?? (unit.faction === 'ENEMY' ? new THREE.Vector3(enemyCampCoord.x + 1, 0, enemyCampCoord.z + 1) : TC_WORLD_CENTER);
      faceTowards(unit, dropoffPos.x, dropoffPos.z, 0.3);
      unit.depositTimer += delta;
      if (unit.depositTimer >= DEPOSIT_TIME) {
        if (unit.carrying > 0) {
          if (unit.faction === 'PLAYER') {
            if (unit.carriedResourceType === 'FOOD') {
              resources.food += unit.carrying;
              gameStats.foodCollectedTotal += unit.carrying;
              updateResourceHUD(true);
              spawnFloatingText(
                unit.group.position.clone().setY(1.4),
                `+${unit.carrying} 🍖`,
                '#f87171'
              );
            } else if (unit.carriedResourceType === 'STONE') {
              resources.stone += unit.carrying;
              gameStats.stoneCollectedTotal += unit.carrying;
              updateResourceHUD(true);
              spawnFloatingText(
                unit.group.position.clone().setY(1.4),
                `+${unit.carrying} 🪨`,
                '#94a3b8'
              );
            } else if (unit.carriedResourceType === 'GOLD') {
              resources.gold += unit.carrying;
              gameStats.goldCollectedTotal += unit.carrying;
              updateResourceHUD(true);
              spawnFloatingText(
                unit.group.position.clone().setY(1.4),
                `+${unit.carrying} 🪙`,
                '#facc15'
              );
            } else {
              resources.wood += unit.carrying;
              gameStats.woodCollectedTotal += unit.carrying;
              updateResourceHUD(true);
              spawnFloatingText(
                unit.group.position.clone().setY(1.4),
                `+${unit.carrying} 🪵`,
                '#fbbf24'
              );
            }
          } else {
            // Unidade inimiga: credita EXCLUSIVAMENTE nos recursos da IA inimiga
            if (unit.carriedResourceType === 'FOOD') {
              enemyResources.food += unit.carrying;
            } else if (unit.carriedResourceType === 'STONE') {
              enemyResources.stone += unit.carrying;
            } else if (unit.carriedResourceType === 'GOLD') {
              enemyResources.gold += unit.carrying;
            } else {
              enemyResources.wood += unit.carrying;
            }

            // NUNCA incrementa recursos do jogador nem altera seu HUD
            const isVisible = isCellInside(Math.floor(unit.group.position.x), Math.floor(unit.group.position.z)) &&
              fogGrid[(Math.floor(unit.group.position.z) + HALF_GRID) * GRID_SIZE + (Math.floor(unit.group.position.x) + HALF_GRID)] === FogState.VISIBLE;
            if (isVisible) {
              const icon = unit.carriedResourceType === 'FOOD' ? '🍖' : unit.carriedResourceType === 'STONE' ? '🪨' : unit.carriedResourceType === 'GOLD' ? '🪙' : '🪵';
              spawnFloatingText(unit.group.position.clone().setY(1.4), `+${unit.carrying} ${icon} (Inimigo)`, '#ef4444');
            }
          }
          unit.carrying = 0;
          unit.carryMesh.visible = false;
          unit.woodCarryMesh.visible = false;
          unit.berryCarryMesh.visible = false;
          unit.stoneCarryMesh.visible = false;
          unit.goldCarryMesh.visible = false;
        }

        unit.dropoffTarget = null;
        unit.dropoffBuilding = null;

        if (unit.carriedResourceType === 'FOOD') {
          if (unit.targetFarm && isFarmAlive(unit.targetFarm) && unit.targetFarm.faction === unit.faction) {
            commandFarm(unit, unit.targetFarm);
          } else if (isBerryBushAlive(unit.targetBerryBush)) {
            commandForage(unit, unit.targetBerryBush);
          } else if (unit.lastBerryCell) {
            retargetOrFinish(unit);
          } else {
            goIdle(unit);
          }
        } else if (unit.carriedResourceType === 'STONE') {
          if (isStoneMineAlive(unit.targetStoneMine)) {
            commandMine(unit, unit.targetStoneMine);
          } else if (unit.lastStoneCell) {
            retargetOrFinish(unit);
          } else {
            goIdle(unit);
          }
        } else if (unit.carriedResourceType === 'GOLD') {
          if (isGoldMineAlive(unit.targetGoldMine)) {
            commandMineGold(unit, unit.targetGoldMine);
          } else if (unit.lastGoldCell) {
            retargetOrFinish(unit);
          } else {
            goIdle(unit);
          }
        } else {
          if (isTreeAlive(unit.targetTree)) {
            commandGather(unit, unit.targetTree);
          } else if (unit.lastTreeCell) {
            retargetOrFinish(unit);
          } else {
            goIdle(unit);
          }
        }
      }
      break;
    }

    case 'MOVING_TO_BUILD': {
      const b = unit.targetBuilding;
      if (!b || b.isCompleted) {
        const next = findNearbyUnfinishedConstructionSite(unit.group.position, unit.faction, 4.5);
        if (next) {
          commandBuild(unit, next);
        } else {
          goIdle(unit);
        }
        break;
      }
      if (moveAlongPath(unit, delta)) {
        unit.state = 'BUILDING';
      }
      break;
    }

    case 'BUILDING': {
      const building = unit.targetBuilding;
      if (!building || building.isCompleted) {
        const next = findNearbyUnfinishedConstructionSite(unit.group.position, unit.faction, 4.5);
        if (next) {
          commandBuild(unit, next);
        } else {
          goIdle(unit);
        }
        break;
      }

      // Alquimista trabalhando em obras também gera ouro passivo
      tickAlchemistPassiveGold(unit, delta);

      faceTowards(unit, building.worldCenter.x, building.worldCenter.z, 0.3);

      // Animação de martelar/bater (balanço rítmico do corpo)
      const hammerSwing = Math.sin(now * 0.012);
      unit.cylinderMesh.rotation.x = Math.max(0, hammerSwing) * 0.42;

      // Adiciona progresso: 10% por segundo por aldeão (1 aldeão = 10s, 2 = 5s)
      // Mestre Construtor (Nível 1): +40% (14.0) | Arquiteto de Elite (Nível 2): +60% (16.0)
      const isArchitect = unit.educationLevel >= 2 && unit.eliteSpecialization === 'ARCHITECT';
      const buildRate = isArchitect ? 16.0 : ((unit.educationLevel && unit.educationLevel >= 1) ? 14.0 : 10.0);
      building.progress = Math.min(100, building.progress + buildRate * delta);

      // Atualiza barra de progresso 3D
      const p = building.progress / 100;
      building.progressBarMesh.scale.x = Math.max(0.01, p);
      const halfW = building.size === 1 ? 0.43 : (building.size === 3 ? 0.78 : 0.63);
      building.progressBarMesh.position.x = -halfW * (1 - p);

      if (building.progress >= 100) {
        building.isCompleted = true;
        const isAllied = building.faction === 'PLAYER' || (building.faction as string) === 'ALLIED' || !building.isEnemy;
        if (isAllied) {
          soundManager.buildingComplete();
        }
        building.siteGroup.visible = false;
        building.progressGroup.visible = false;
        const isDiscovered = isAllied || isBuildingDiscovered(building);
        building.finishedGroup.visible = isDiscovered;
        building.group.visible = isDiscovered;

        if (building.type === 'WALL') {
          setWallCellOccupancy(building.gridX, building.gridZ, true);
          try {
            updateWallConnections(building);
          } catch (e) {
            console.error('[Wall] Falha na finalização da Muralha:', e);
          }
          building.finishedGroup.visible = true;
          building.group.visible = true;
          building.finishedGroup.scale.set(1, 1, 1);
        } else if (building.type === 'GATE') {
          if (!building.gateOpenProgress || building.gateOpenProgress < 0.5) {
            setCellWalkable(building.gridX, building.gridZ, false);
            setCellWalkable(building.gridX + 1, building.gridZ, false);
            setWallCellOccupancy(building.gridX, building.gridZ, true);
            setWallCellOccupancy(building.gridX + 1, building.gridZ, true);
          }
          try {
            rebuildWallNeighbors(building.gridX - 1, building.gridZ);
            rebuildWallNeighbors(building.gridX + 2, building.gridZ);
          } catch (e) {
            console.error('[Gate] Falha na finalização do Portão:', e);
          }
          building.finishedGroup.visible = true;
          building.group.visible = true;
          building.finishedGroup.scale.set(1, 1, 1);
        }

        // Arquiteto de Elite: Confere +30% de HP às obras concluídas
        if (isArchitect) {
          const baseHp = building.maxHp || (building.size === 3 ? 400 : 200);
          building.maxHp = Math.round(baseHp * 1.3);
          building.hp = building.maxHp;
          spawnFloatingText(building.worldCenter.clone().setY(3.0), '🛡️ Obra Reforçada (+30% HP)!', '#38bdf8');
        }

        // Efeito elástico ao concluir
        building.finishedGroup.scale.set(1.15, 1.15, 1.15);
        setTimeout(() => {
          building.finishedGroup.scale.set(1, 1, 1);
          if (building.type === 'WALL') {
            building.finishedGroup.visible = true;
            building.group.visible = true;
          }
        }, 220);

        const label =
          building.type === 'TOWER' ? 'Torre de Vigia Concluída! 🏹' :
          building.type === 'WALL' ? 'Muralha de Pedra Concluída! 🧱' :
          building.type === 'GATE' ? 'Portão Fortificado Concluído! 🚪' :
          building.type === 'LUMBER_CAMP' ? 'Madeireira Concluída! 🪵' :
          building.type === 'MINING_CAMP' ? 'Campo de Mineração Concluído! 🪨' :
          building.type === 'HOUSE' ? 'Casa Concluída! 🏠 (+5 Pop)' :
          building.type === 'MILL' ? 'Moinho Concluído! 🌾 (Depósito de Alimento)' :
          building.type === 'FARM' ? 'Fazenda Concluída! 🌾 (175 Alimento)' :
          building.type === 'SCHOOL' ? 'Escola da Vila Concluída! 🏫' :
          building.type === 'COLLEGE' ? 'Real Faculdade Concluída! 🏛️' :
          'Quartel Concluído! ⚔️';
        const typeName =
          building.type === 'TOWER' ? 'Torre de Vigia' :
          building.type === 'WALL' ? 'Muralha de Pedra' :
          building.type === 'GATE' ? 'Portão Fortificado' :
          building.type === 'LUMBER_CAMP' ? 'Madeireira' :
          building.type === 'MINING_CAMP' ? 'Campo de Mineração' :
          building.type === 'HOUSE' ? 'Casa' :
          building.type === 'MILL' ? 'Moinho' :
          building.type === 'FARM' ? 'Fazenda' :
          building.type === 'SCHOOL' ? 'Escola da Vila' :
          building.type === 'COLLEGE' ? 'Real Faculdade' :
          'Quartel';
        if (isAllied || isBuildingDirectlyVisible(building)) {
          spawnFloatingText(building.worldCenter.clone().setY(2.2), label);
        }
        console.log(`[RTS Construção] ${typeName} em (${building.gridX}, ${building.gridZ}) concluído com sucesso!`);
        gameStats.buildingsConstructedTotal++;

        if (building.type === 'HOUSE') {
          if (building.faction === 'PLAYER' || (building.faction as string) === 'ALLIED' || !building.isEnemy) {
            bumpElement(resPopEl);
            spawnFloatingText(building.worldCenter.clone().setY(2.6), '+5 População 👥', '#38bdf8');
            updateTelemetryUnitsCount();
          } else if (building.faction === 'ENEMY' || building.isEnemy) {
            enemyPopCap = Math.min(MAX_GLOBAL_POPULATION, enemyPopCap + 5);
            if (currentMatchConfig.revealWholeMap || isBuildingDirectlyVisible(building)) {
              spawnFloatingText(building.worldCenter.clone().setY(2.6), '+5 Pop Inimiga 👥', '#ef4444');
            }
            console.log(`[RTS IA] Casa Inimiga concluída (+5 Pop Inimiga). Limite agora: ${enemyPopCap}`);
            // Não toca no playerPopCap nem no HUD do jogador!
          }
        }
        if (building.type === 'SCHOOL' && selectedBuilding === building) {
          updateSchoolHUD();
        }
        if (building.type === 'COLLEGE' && selectedBuilding === building) {
          updateCollegeHUD();
        }
        if (building.faction === 'PLAYER' || (building.faction as string) === 'ALLIED' || !building.isEnemy) {
          updateTelemetryUnitsCount();
          updateResourceHUD();
        }

        if (building.type === 'TOWER') {
          updateFogOfWar(true);
        }

        // Migração Inteligente de Depósito:
        // Se uma Madeireira, Campo de Mineração ou Moinho foi concluído, aldeões DA MESMA FACÇÃO que estejam RETURNING_TO_BASE
        // com o recurso correspondente recalculam dinamicamente para usar a nova estrutura se for mais próxima
        if (building.type === 'LUMBER_CAMP' || building.type === 'MINING_CAMP' || building.type === 'MILL') {
          unitsList.forEach((u) => {
            if (u.unitType === 'VILLAGER' && u.state === 'RETURNING_TO_BASE' && u.faction === building.faction) {
              if (
                (building.type === 'LUMBER_CAMP' && u.carriedResourceType === 'WOOD') ||
                (building.type === 'MINING_CAMP' && (u.carriedResourceType === 'STONE' || u.carriedResourceType === 'GOLD')) ||
                (building.type === 'MILL' && u.carriedResourceType === 'FOOD')
              ) {
                const dropoff = findNearestDropoffPoint(u, u.carriedResourceType, u.faction);
                if (dropoff) {
                  u.dropoffTarget = dropoff.buildingCenter;
                  u.dropoffBuilding = dropoff.building;
                  setUnitPath(u, dropoff.cell);
                }
              }
            }
          });
        }

        if (building.type === 'FARM') {
          // O primeiro aldeão que estava construindo passa automaticamente a cultivar como agricultor
          let assigned = false;
          unitsList.forEach((u) => {
            if (u.targetBuilding === building) {
              if (!assigned) {
                commandFarm(u, building);
                assigned = true;
              } else {
                goIdle(u);
              }
            }
          });
        } else {
          // Encadeamento Automático de Obras (Auto-Chain Construction):
          // Direciona os operários automaticamente para outro canteiro incompleto próximo via A*
          unitsList.forEach((u) => {
            if (u.targetBuilding === building) {
              const next = findNearbyUnfinishedConstructionSite(building.worldCenter, u.faction, 4.5);
              if (next) {
                console.log(`[RTS Encadeamento] Aldeão encadeando obra para canteiro em (${next.gridX}, ${next.gridZ}) [${next.type}]`);
                commandBuild(u, next);
              } else {
                goIdle(u);
              }
            }
          });
        }
      }
      break;
    }

    case 'MOVING_TO_REPAIR': {
      if (unit.targetStructure === 'TOWN_CENTER') {
        if (townCenterState.isDestroyed || townCenterState.hp >= townCenterState.maxHp) {
          goIdle(unit);
          break;
        }
        const dist = Math.hypot(unit.group.position.x - TC_WORLD_CENTER.x, unit.group.position.z - TC_WORLD_CENTER.z);
        if (dist <= 2.6 || moveAlongPath(unit, delta)) {
          unit.state = 'REPAIRING';
          unit.waypoints = [];
        }
      } else {
        const b = unit.targetBuilding;
        if (!b || b.isDepleted || !b.isCompleted || (b.hp ?? 0) >= (b.maxHp ?? 1)) {
          const next = findNearbyDamagedBuilding(unit.group.position, unit.faction, 5.0);
          if (next) {
            commandRepairBuilding(unit, next);
          } else {
            goIdle(unit);
          }
          break;
        }
        const dist = Math.hypot(unit.group.position.x - b.worldCenter.x, unit.group.position.z - b.worldCenter.z);
        const reach = (b.size === 1 ? 1.6 : (b.size === 3 ? 2.5 : 2.0));
        if (dist <= reach || moveAlongPath(unit, delta)) {
          unit.state = 'REPAIRING';
          unit.waypoints = [];
        }
      }
      break;
    }

    case 'REPAIRING': {
      if (unit.targetStructure === 'TOWN_CENTER') {
        if (townCenterState.isDestroyed || townCenterState.hp >= townCenterState.maxHp) {
          spawnFloatingText(TC_WORLD_CENTER.clone().setY(3.2), '✨ Estrutura Totalmente Reparada!', '#22c55e');
          soundManager.buildingComplete();
          const next = findNearbyDamagedBuilding(unit.group.position, unit.faction, 5.0);
          if (next) {
            commandRepairBuilding(unit, next);
          } else {
            goIdle(unit);
          }
          break;
        }

        faceTowards(unit, TC_WORLD_CENTER.x, TC_WORLD_CENTER.z, 0.3);

        // Animação de martelar (balanço rítmico do corpo)
        const hammerSwing = Math.sin(now * 0.012);
        unit.cylinderMesh.rotation.x = Math.max(0, hammerSwing) * 0.42;

        // Som de martelo e faíscas periódicas
        unit.repairSoundTimer = (unit.repairSoundTimer ?? 0) + delta;
        if (unit.repairSoundTimer >= 0.45) {
          unit.repairSoundTimer = 0;
          soundManager.hammer();
          spawnParticles(unit.group.position.clone().add(new THREE.Vector3(0, 0.4, 0)), 3, 0xf59e0b);
        }

        // Custo proporcional
        const rates = getRepairCostRates('TOWN_CENTER', townCenterState.maxHp);
        const hpRate = 25.0; // 25 HP por segundo
        const hpRestored = Math.min(hpRate * delta, townCenterState.maxHp - townCenterState.hp);
        const woodCost = hpRestored * rates.woodPerHp;

        if (woodCost > 0 && resources.wood <= 0) {
          spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem recursos para reparar!', '#f87171');
          goIdle(unit);
          break;
        }

        unit.repairWoodSpent = (unit.repairWoodSpent ?? 0) + woodCost;
        if (unit.repairWoodSpent >= 1) {
          const toDeduct = Math.floor(unit.repairWoodSpent);
          if (resources.wood < toDeduct) {
            spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem recursos para reparar!', '#f87171');
            goIdle(unit);
            break;
          }
          resources.wood -= toDeduct;
          unit.repairWoodSpent -= toDeduct;
        }

        townCenterState.hp = Math.min(townCenterState.maxHp, townCenterState.hp + hpRestored);
        updateTownCenterHpBar();
        updateTownCenterSelectedHUD();

        if (townCenterState.hp >= townCenterState.maxHp) {
          townCenterState.hp = townCenterState.maxHp;
          updateTownCenterHpBar();
          updateTownCenterSelectedHUD();
          spawnFloatingText(TC_WORLD_CENTER.clone().setY(3.2), '✨ Estrutura Totalmente Reparada!', '#22c55e');
          soundManager.buildingComplete();

          const next = findNearbyDamagedBuilding(unit.group.position, unit.faction, 5.0);
          if (next) {
            commandRepairBuilding(unit, next);
          } else {
            goIdle(unit);
          }
        }
      } else {
        const b = unit.targetBuilding;
        if (!b || b.isDepleted || !b.isCompleted || (b.hp ?? 0) >= (b.maxHp ?? 1)) {
          if (b && b.isCompleted && (b.hp ?? 0) >= (b.maxHp ?? 1)) {
            spawnFloatingText(b.worldCenter.clone().setY(2.6), '✨ Estrutura Totalmente Reparada!', '#22c55e');
            soundManager.buildingComplete();
          }
          const next = findNearbyDamagedBuilding(unit.group.position, unit.faction, 5.0);
          if (next) {
            commandRepairBuilding(unit, next);
          } else if (isTownCenterDamaged() && unit.group.position.distanceTo(TC_WORLD_CENTER) <= 7.0) {
            commandRepairTownCenter(unit);
          } else {
            goIdle(unit);
          }
          break;
        }

        faceTowards(unit, b.worldCenter.x, b.worldCenter.z, 0.3);

        // Animação de martelar
        const hammerSwing = Math.sin(now * 0.012);
        unit.cylinderMesh.rotation.x = Math.max(0, hammerSwing) * 0.42;

        // Som de martelo e faíscas periódicas
        unit.repairSoundTimer = (unit.repairSoundTimer ?? 0) + delta;
        if (unit.repairSoundTimer >= 0.45) {
          unit.repairSoundTimer = 0;
          soundManager.hammer();
          spawnParticles(unit.group.position.clone().add(new THREE.Vector3(0, 0.4, 0)), 3, 0xf59e0b);
        }

        ensureBuildingHp(b);
        const rates = getRepairCostRates(b.type, b.maxHp!);
        const hpRate = 25.0; // 25 HP por segundo
        const hpRestored = Math.min(hpRate * delta, b.maxHp! - b.hp!);
        const woodCost = hpRestored * rates.woodPerHp;
        const stoneCost = hpRestored * rates.stonePerHp;

        if ((woodCost > 0 && resources.wood <= 0) || (stoneCost > 0 && resources.stone <= 0)) {
          spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem recursos para reparar!', '#f87171');
          goIdle(unit);
          break;
        }

        unit.repairWoodSpent = (unit.repairWoodSpent ?? 0) + woodCost;
        if (unit.repairWoodSpent >= 1) {
          const toDeduct = Math.floor(unit.repairWoodSpent);
          if (resources.wood < toDeduct) {
            spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem recursos para reparar!', '#f87171');
            goIdle(unit);
            break;
          }
          resources.wood -= toDeduct;
          unit.repairWoodSpent -= toDeduct;
        }

        unit.repairStoneSpent = (unit.repairStoneSpent ?? 0) + stoneCost;
        if (unit.repairStoneSpent >= 1) {
          const toDeduct = Math.floor(unit.repairStoneSpent);
          if (resources.stone < toDeduct) {
            spawnFloatingText(unit.group.position.clone().setY(1.4), '⚠️ Sem recursos para reparar!', '#f87171');
            goIdle(unit);
            break;
          }
          resources.stone -= toDeduct;
          unit.repairStoneSpent -= toDeduct;
        }

        b.hp = Math.min(b.maxHp!, b.hp! + hpRestored);
        updateBuildingHpBar(b, now);
        if (selectedBuilding === b) {
          updateBuildingSelectedHUD(b);
        }

        if (b.hp >= b.maxHp!) {
          b.hp = b.maxHp!;
          updateBuildingHpBar(b, now);
          spawnFloatingText(b.worldCenter.clone().setY(2.6), '✨ Estrutura Totalmente Reparada!', '#22c55e');
          soundManager.buildingComplete();

          const next = findNearbyDamagedBuilding(unit.group.position, unit.faction, 5.0);
          if (next) {
            commandRepairBuilding(unit, next);
          } else if (isTownCenterDamaged() && unit.group.position.distanceTo(TC_WORLD_CENTER) <= 7.0) {
            commandRepairTownCenter(unit);
          } else {
            goIdle(unit);
          }
        }
      }
      break;
    }

    case 'MOVING_TO_SCHOOL': {
      const school = unit.targetSchool;
      if (!school || !school.isCompleted || (school.hp !== undefined && school.hp <= 0)) {
        unit.targetSchool = null;
        goIdle(unit);
        break;
      }

      const arrived = moveAlongPath(unit, delta);
      const schoolCenter = school.worldCenter;
      const myPos = unit.group.position;
      const distToSchool = Math.hypot(myPos.x - schoolCenter.x, myPos.z - schoolCenter.z);

      if (arrived || distToSchool < 1.5) {
        if (!school.enrolledStudents) {
          school.enrolledStudents = [];
        }
        if (school.enrolledStudents.length >= (school.maxStudents || SCHOOL_MAX_STUDENTS)) {
          spawnFloatingText(unit.group.position.clone().setY(2.0), 'Escola Lotada! 🏫', '#f59e0b');
          unit.targetSchool = null;
          goIdle(unit);
          break;
        }

        // Aldeão entra na Escola: fica oculto/garrisoned na cena 3D enquanto estuda
        unit.isGarrisoned = true;
        unit.group.visible = false;
        unit.state = 'STUDYING';
        unit.waypoints = [];
        if (unit.isSelected) {
          unit.isSelected = false;
          unit.selectionRing.visible = false;
          updateTelemetrySelectionCount();
          updateUnitHUD();
        }

        school.enrolledStudents.push({
          unitId: unit.id,
          progressSec: 0,
        });

        spawnFloatingText(school.worldCenter.clone().setY(2.5), '📖 Matriculado na Escola!', '#38bdf8');
        updateSchoolHUD();
      }
      break;
    }

    case 'MOVING_TO_COLLEGE': {
      const college = unit.targetCollege;
      if (!college || !college.isCompleted || (college.hp !== undefined && college.hp <= 0)) {
        unit.targetCollege = null;
        goIdle(unit);
        break;
      }

      const arrived = moveAlongPath(unit, delta);
      const collegeCenter = college.worldCenter;
      const myPos = unit.group.position;
      const distToCollege = Math.hypot(myPos.x - collegeCenter.x, myPos.z - collegeCenter.z);

      if (arrived || distToCollege < 2.0) {
        if (!college.enrolledStudents) {
          college.enrolledStudents = [];
        }
        if (college.enrolledStudents.length >= (college.maxStudents || COLLEGE_MAX_STUDENTS)) {
          spawnFloatingText(unit.group.position.clone().setY(2.0), 'Faculdade Lotada! 🏛️', '#f59e0b');
          unit.targetCollege = null;
          goIdle(unit);
          break;
        }

        // Aldeão pós-graduando entra na Faculdade: fica oculto/garrisoned na cena 3D enquanto estuda
        unit.isGarrisoned = true;
        unit.group.visible = false;
        unit.state = 'STUDYING';
        unit.waypoints = [];
        if (unit.isSelected) {
          unit.isSelected = false;
          unit.selectionRing.visible = false;
          if (unit.auraRingMesh) unit.auraRingMesh.visible = false;
          updateTelemetrySelectionCount();
          updateUnitHUD();
        }

        const chosenCourse = college.selectedCollegeCourse || 'ARCHITECT';
        college.enrolledStudents.push({
          unitId: unit.id,
          progressSec: 0,
          chosenCourse
        });

        const courseName =
          chosenCourse === 'ARCHITECT' ? '📐 Arquiteto' :
          chosenCourse === 'AGRONOMIST' ? '🌾 Agrônomo' :
          chosenCourse === 'ARMORER' ? '🛡️ Armeiro' : '⚗️ Alquimista';
        spawnFloatingText(college.worldCenter.clone().setY(3.0), `📜 Matriculado em ${courseName}!`, '#facc15');
        updateCollegeHUD();
      }
      break;
    }

    case 'STUDYING': {
      // Aldeão estudando dentro da escola ou faculdade: fica oculto e aguarda formatura ou ejeção via updateSchools/updateColleges
      break;
    }

    case 'ATTACKING': {
      const target = unit.targetEnemy;
      if (!target || target.hp <= 0 || target.isDying) {
        unit.targetEnemy = null;
        if (unit.faction === 'PLAYER' && (unit.unitType === 'SWORDSMAN' || unit.unitType === 'ARCHER') && !unit.isDying && unit.hp > 0) {
          const nextTarget = findBestEnemyTarget(unit, 7.0);
          if (nextTarget) {
            commandAttack(unit, nextTarget);
            spawnFloatingText(
              unit.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
              unit.unitType === 'ARCHER' ? '🏹 Próximo Alvo!' : '⚔️ Próximo Alvo!',
              '#38bdf8'
            );
            break;
          }
        }
        goIdle(unit);
        break;
      }

      const myPos = unit.group.position;
      const targetPos = target.group.position;
      const dist = Math.hypot(myPos.x - targetPos.x, myPos.z - targetPos.z);

      // Alcance de ataque (1.2 para corpo a corpo, 6.0 para Arqueiro)
      if (dist <= unit.attackRange) {
        unit.waypoints = [];
        unit.currentWaypointIndex = 0;
        faceTowards(unit, targetPos.x, targetPos.z, 0.4);

        if (now - unit.lastAttackTime >= unit.attackCooldown * 1000) {
          unit.lastAttackTime = now;
          if (unit.unitType === 'ARCHER') {
            executeRangedAttack(unit, target, now);
          } else {
            executeAttack(unit, target, now);
          }
        }
      } else {
        // Fora do alcance: perseguir o alvo
        const currentTargetCell = unitCell(target);
        if (
          unit.waypoints.length === 0 ||
          !unit.lastPursuitTargetCell ||
          !unit.lastPursuitTargetCell.equals(currentTargetCell)
        ) {
          unit.lastPursuitTargetCell = currentTargetCell.clone();
          const nextCell = findClosestWalkableCell(currentTargetCell, unitCell(unit));
          setUnitPath(unit, nextCell);
        }
        moveAlongPath(unit, delta);
      }
      break;
    }

    case 'ATTACKING_STRUCTURE': {
      if (unit.targetStructure === 'TENT') {
        if (!enemyCampState || enemyCampState.isTentDestroyed) {
          unit.targetStructure = null;
          goIdle(unit);
          break;
        }

        const tcCenter = new THREE.Vector3(enemyCampCoord.x + 1.5, 0, enemyCampCoord.z + 1.5);
        const myPos = unit.group.position;
        const dist = Math.hypot(myPos.x - tcCenter.x, myPos.z - tcCenter.z);
        const reach = unit.unitType === 'ARCHER' ? unit.attackRange : 2.6;

        if (dist <= reach) {
          unit.waypoints = [];
          unit.currentWaypointIndex = 0;
          faceTowards(unit, tcCenter.x, tcCenter.z, 0.4);

          if (now - unit.lastAttackTime >= unit.attackCooldown * 1000) {
            unit.lastAttackTime = now;
            if (unit.unitType === 'ARCHER') {
              executeRangedAttack(unit, 'TENT', now);
            } else {
              executeAttackTent(unit, now);
            }
          }
        } else {
          if (unit.waypoints.length === 0) {
            const dest = findClosestWalkableCell(
              new THREE.Vector2(enemyCampCoord.x + 1, enemyCampCoord.z + 1),
              unitCell(unit)
            );
            setUnitPath(unit, dest);
          }
          moveAlongPath(unit, delta);
        }
      } else if (unit.targetStructure === 'TOWN_CENTER') {
        if (townCenterState.isDestroyed || townCenterState.hp <= 0) {
          unit.targetStructure = null;
          goIdle(unit);
          break;
        }

        const tcCenter = TC_WORLD_CENTER;
        const myPos = unit.group.position;
        const dist = Math.hypot(myPos.x - tcCenter.x, myPos.z - tcCenter.z);
        const reach = unit.unitType === 'ARCHER' ? unit.attackRange : 2.6;

        if (dist <= reach) {
          unit.waypoints = [];
          unit.currentWaypointIndex = 0;
          faceTowards(unit, tcCenter.x, tcCenter.z, 0.4);

          if (now - unit.lastAttackTime >= unit.attackCooldown * 1000) {
            unit.lastAttackTime = now;
            if (unit.unitType === 'ARCHER') {
              executeRangedAttack(unit, 'TOWN_CENTER', now);
            } else {
              executeAttackTownCenter(unit, now);
            }
          }
        } else {
          if (unit.waypoints.length === 0) {
            const dest = findClosestWalkableCell(new THREE.Vector2(tcCoord.minX + 1, tcCoord.minZ + 1), unitCell(unit));
            setUnitPath(unit, dest);
            if (unit.waypoints.length === 0) {
              goIdle(unit);
              break;
            }
          }
          if (moveAlongPath(unit, delta)) {
            // Chegou ao fim do caminho acessível pelo A*: se ainda estiver fora de alcance (ex: muralha impedindo avanço), fica em guarda (IDLE)
            goIdle(unit);
          }
        }
      } else if (unit.targetStructure === 'BUILDING') {
        const building = unit.targetBuilding;
        if (!building || building.isDepleted || (building.hp !== undefined && building.hp <= 0)) {
          unit.targetStructure = null;
          unit.targetBuilding = null;
          goIdle(unit);
          break;
        }

        const bCenter = building.worldCenter;
        const myPos = unit.group.position;
        const dist = Math.hypot(myPos.x - bCenter.x, myPos.z - bCenter.z);
        const reach = unit.unitType === 'ARCHER' ? unit.attackRange : (building.size === 1 ? 1.6 : (building.size === 2 ? 2.2 : 2.8));

        if (dist <= reach) {
          unit.waypoints = [];
          unit.currentWaypointIndex = 0;
          faceTowards(unit, bCenter.x, bCenter.z, 0.4);

          if (now - unit.lastAttackTime >= unit.attackCooldown * 1000) {
            unit.lastAttackTime = now;
            if (unit.unitType === 'ARCHER') {
              executeRangedAttack(unit, building, now);
            } else {
              executeAttackBuilding(unit, building, now);
            }
          }
        } else {
          if (unit.waypoints.length === 0) {
            const dest = findClosestWalkableCell(new THREE.Vector2(building.gridX, building.gridZ), unitCell(unit));
            setUnitPath(unit, dest);
          }
          moveAlongPath(unit, delta);
        }
      } else {
        goIdle(unit);
      }
      break;
    }
  }
}

// --- SISTEMA DE COMBATE & HP ---
function updateUnitHpBar(unit: RTSUnit, now: number) {
  const pct = THREE.MathUtils.clamp(unit.hp / unit.maxHp, 0, 1);
  unit.hpBarFillMesh.scale.x = Math.max(0.001, pct);
  unit.hpBarFillMesh.position.x = -0.3 * (1 - pct);

  const mat = unit.hpBarFillMesh.material as THREE.MeshBasicMaterial;
  if (unit.faction === 'ENEMY') {
    mat.color.setHex(0xef4444);
  } else {
    if (pct > 0.5) mat.color.setHex(0x22c55e);
    else if (pct > 0.25) mat.color.setHex(0xeab308);
    else mat.color.setHex(0xef4444);
  }

  if (unit.isDying) {
    unit.hpBarGroup.visible = false;
  } else if (unit.faction === 'ENEMY') {
    const gx = Math.round(unit.gridX ?? unit.group.position.x);
    const gz = Math.round(unit.gridZ ?? unit.group.position.z);
    const inDirectVision = currentMatchConfig.revealWholeMap || (isCellInside(gx, gz) && getFogStateAt(gx, gz) === FogState.VISIBLE);
    unit.hpBarGroup.visible = inDirectVision;
  } else {
    unit.hpBarGroup.visible =
      unit.hp < unit.maxHp ||
      unit.state === 'ATTACKING' ||
      now < unit.hpBarShowUntil ||
      unit.isSelected;
  }
}

interface DeathAnimation {
  unit: RTSUnit;
  startTime: number;
  duration: number;
}
const activeDeathAnimations: DeathAnimation[] = [];

function killUnit(unit: RTSUnit, now: number) {
  unit.isDying = true;
  unit.state = 'IDLE';
  unit.waypoints = [];
  unit.hp = 0;
  if (unit.isSelected) deselectUnit(unit);
  unit.selectionRing.visible = false;
  unit.hpBarGroup.visible = false;

  spawnFloatingText(unit.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)), '💀 Abatido', '#94a3b8');

  activeDeathAnimations.push({
    unit,
    startTime: now,
    duration: 800
  });

  if (unit.faction === 'ENEMY') {
    gameStats.enemiesKilledTotal++;
  }

  // Limpa alvos de quem atacava esta unidade
  for (const u of unitsList) {
    if (u.targetEnemy === unit) {
      u.targetEnemy = null;
      if (u.state === 'ATTACKING') {
        if (u.faction === 'PLAYER' && u.unitType === 'SWORDSMAN' && !u.isDying && u.hp > 0) {
          const nextTarget = findBestEnemyTarget(u, 7.0);
          if (nextTarget) {
            commandAttack(u, nextTarget);
            spawnFloatingText(
              u.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
              '⚔️ Próximo Alvo!',
              '#38bdf8'
            );
            continue;
          }
        }
        goIdle(u);
      }
    }
  }

  updateSwordsmenArmorerBuff();
  updateResourceHUD();
  checkGameOverConditions();
}

function executeAttack(attacker: RTSUnit, target: RTSUnit, now: number) {
  // 1. Efeitos sonoros de golpe e alerta de tropas atacadas
  soundManager.swordClash();
  if (target.faction === 'PLAYER') {
    soundManager.alertAttack();
  }

  // 1.1. Animação de ataque (lunge/golpe rápido)
  const origZ = attacker.cylinderMesh.position.z;
  attacker.cylinderMesh.position.z = -0.16;
  attacker.cylinderMesh.rotation.x = 0.35;
  setTimeout(() => {
    if (attacker && attacker.cylinderMesh) {
      attacker.cylinderMesh.position.z = origZ;
      attacker.cylinderMesh.rotation.x = 0;
    }
  }, 160);

  // 2. Aplicação de dano (Alquimista: Dano ígneo incendiário aumentado; Tropas aliadas ganham armas incendiárias com Alquimista)
  const isAlchemist = attacker.educationLevel >= 2 && attacker.eliteSpecialization === 'ALCHEMIST';
  const hasIncendiaryTech = attacker.faction === 'PLAYER' && hasPlayerAlchemist();
  const rawDamage = isAlchemist ? attacker.damage + 4 : (hasIncendiaryTech && attacker.unitType === 'SWORDSMAN' ? attacker.damage + 2 : attacker.damage);
  let effectiveDamage = rawDamage;
  if (((target.faction as string) === 'ALLIED' || !target.isEnemy) && (target.unitType === 'SWORDSMAN' || (target as any).type === 'SWORDSMAN') && hasLivingArmorer()) {
    effectiveDamage = Math.max(1, Math.round(rawDamage * 0.75)); // Absorve 25% do impacto
  }
  const dmg = effectiveDamage;
  target.hp = Math.max(0, target.hp - dmg);
  target.hpBarShowUntil = now + 4000;
  updateUnitHpBar(target, now);

  // Efeito de Chamas Incendiárias Alquímicas
  if (isAlchemist || (hasIncendiaryTech && attacker.unitType === 'SWORDSMAN')) {
    spawnParticles(target.group.position.clone().setY(0.7), 16, 0xf97316);
    spawnFloatingText(target.group.position.clone().add(new THREE.Vector3(0, 1.8, 0)), isAlchemist ? '🔥 Fogo Alquímico!' : '🔥 Lâmina Incendiária!', '#f97316');
  }

  // 3. Efeito flash visual no alvo
  const targetMat = target.cylinderMesh.material as THREE.MeshStandardMaterial;
  const originalColor = targetMat.color.getHex();
  targetMat.color.setHex(isAlchemist ? 0xf97316 : 0xffffff);
  setTimeout(() => {
    if (target && target.cylinderMesh) {
      targetMat.color.setHex(originalColor);
    }
  }, 90);

  // 4. Texto flutuante de dano
  spawnFloatingText(
    target.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
    `-${dmg}`,
    attacker.faction === 'PLAYER' ? '#ef4444' : '#f87171'
  );

  // 5. Retaliação Imediata & Alerta de Socorro da Base (Self-Defense & Town Watch)
  onUnitDamagedByEnemy(target, attacker);

  // 6. Morte ao zerar HP
  if (target.hp <= 0 && !target.isDying) {
    killUnit(target, now);
  }
}

function executeAttackTent(attacker: RTSUnit, now: number) {
  if (!enemyCampState || enemyCampState.isTentDestroyed) {
    goIdle(attacker);
    return;
  }
  soundManager.swordClash();
  const origZ = attacker.cylinderMesh.position.z;
  attacker.cylinderMesh.position.z = -0.16;
  attacker.cylinderMesh.rotation.x = 0.35;
  setTimeout(() => {
    if (attacker && attacker.cylinderMesh) {
      attacker.cylinderMesh.position.z = origZ;
      attacker.cylinderMesh.rotation.x = 0;
    }
  }, 160);

  const dmg = attacker.damage;
  damageEnemyTent(dmg, now);
  spawnFloatingText(
    new THREE.Vector3(enemyCampCoord.x + 1.5, 2.0, enemyCampCoord.z + 1.5),
    `-${dmg}`,
    attacker.faction === 'PLAYER' ? '#ef4444' : '#f87171'
  );
}

export function executeAttackBuilding(attacker: RTSUnit, building: ConstructionBuilding, now: number) {
  if (building.isDepleted || (building.hp !== undefined && building.hp <= 0)) {
    goIdle(attacker);
    return;
  }
  soundManager.swordClash();
  const origZ = attacker.cylinderMesh.position.z;
  attacker.cylinderMesh.position.z = -0.16;
  attacker.cylinderMesh.rotation.x = 0.35;
  setTimeout(() => {
    if (attacker && attacker.cylinderMesh) {
      attacker.cylinderMesh.position.z = origZ;
      attacker.cylinderMesh.rotation.x = 0;
    }
  }, 160);

  const dmg = attacker.damage;
  damageBuilding(building, dmg, now);
  spawnFloatingText(
    building.worldCenter.clone().add(new THREE.Vector3(0, 1.8, 0)),
    `-${dmg}`,
    attacker.faction === 'PLAYER' ? '#ef4444' : '#f87171'
  );

  // Alerta de socorro da base se a construção atacada for aliada
  if (building.faction === 'PLAYER') {
    callAlliedSoldiersForHelp(building.worldCenter, attacker, 10.0);
  }
}

function executeAttackTownCenter(attacker: RTSUnit, now: number) {
  if (townCenterState.isDestroyed) {
    goIdle(attacker);
    return;
  }
  soundManager.swordClash();
  soundManager.alertAttack();
  const origZ = attacker.cylinderMesh.position.z;
  attacker.cylinderMesh.position.z = -0.16;
  attacker.cylinderMesh.rotation.x = 0.35;
  setTimeout(() => {
    if (attacker && attacker.cylinderMesh) {
      attacker.cylinderMesh.position.z = origZ;
      attacker.cylinderMesh.rotation.x = 0;
    }
  }, 160);

  const dmg = attacker.damage;
  damageTownCenter(dmg, now);
  spawnFloatingText(
    TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 2.0, 0)),
    `-${dmg}`,
    '#ef4444'
  );

  // Alerta de socorro da base: chama soldados aliados ociosos num raio de 10.0 células para defender o Town Center
  callAlliedSoldiersForHelp(TC_WORLD_CENTER, attacker, 10.0);
}

// --- SISTEMA BALÍSTICO DE DISPARO DE FLECHAS DOS ARQUEIROS ---
export interface ArcherProjectile {
  mesh: THREE.Group;
  startPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  targetUnit: RTSUnit | null;
  targetBuilding: ConstructionBuilding | null;
  targetType: 'UNIT' | 'BUILDING' | 'TENT' | 'TOWN_CENTER';
  progress: number;
  duration: number;
  arcHeight: number;
  damage: number;
  attackerFaction: UnitFaction;
  attacker: RTSUnit;
}

export const archerProjectiles: ArcherProjectile[] = [];

export function createArrowMesh(): THREE.Group {
  const group = new THREE.Group();

  // Haste de madeira
  const shaftGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.44, 6);
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.8 });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  group.add(shaft);

  // Ponta cônica de metal
  const tipGeo = new THREE.ConeGeometry(0.038, 0.09, 6);
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.3 });
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.position.y = 0.23;
  group.add(tip);

  // Fletching / penas na cauda
  const featherGeo = new THREE.BoxGeometry(0.01, 0.08, 0.06);
  const featherMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.6 });
  const f1 = new THREE.Mesh(featherGeo, featherMat);
  f1.position.y = -0.17;
  group.add(f1);

  const f2 = new THREE.Mesh(featherGeo, featherMat);
  f2.position.y = -0.17;
  f2.rotation.y = Math.PI / 2;
  group.add(f2);

  return group;
}

export function executeRangedAttack(
  attacker: RTSUnit,
  target: RTSUnit | ConstructionBuilding | 'TENT' | 'TOWN_CENTER',
  _now: number
) {
  if (attacker.isDying || attacker.hp <= 0) return;

  // Animação de disparo do arqueiro (recuo do tronco ao soltar a corda)
  if (attacker.cylinderMesh) {
    attacker.cylinderMesh.rotation.x = -0.22;
    setTimeout(() => {
      if (attacker && attacker.cylinderMesh) {
        attacker.cylinderMesh.rotation.x = 0;
      }
    }, 180);
  }

  // Efeito sonoro autêntico da corda de arco
  soundManager.bowShoot();

  let targetWorldPos: THREE.Vector3;
  let targetType: 'UNIT' | 'BUILDING' | 'TENT' | 'TOWN_CENTER';
  let targetUnit: RTSUnit | null = null;
  let targetBuilding: ConstructionBuilding | null = null;

  if (target === 'TENT') {
    targetType = 'TENT';
    targetWorldPos = new THREE.Vector3(enemyCampCoord.x + 1.5, 0.6, enemyCampCoord.z + 1.5);
  } else if (target === 'TOWN_CENTER') {
    targetType = 'TOWN_CENTER';
    targetWorldPos = TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 1.0, 0));
  } else if ('size' in target) {
    targetType = 'BUILDING';
    targetBuilding = target;
    targetWorldPos = target.worldCenter.clone().add(new THREE.Vector3(0, 0.8, 0));
  } else {
    targetType = 'UNIT';
    targetUnit = target;
    targetWorldPos = target.group.position.clone().add(new THREE.Vector3(0, 0.45, 0));
  }

  const startPos = attacker.group.position.clone().add(new THREE.Vector3(0, 0.55, 0));
  const dist = Math.hypot(targetWorldPos.x - startPos.x, targetWorldPos.z - startPos.z);
  const arcHeight = Math.max(0.65, Math.min(2.4, dist * 0.26));
  const duration = Math.max(0.24, Math.min(0.58, dist / 12.5));

  const arrowMesh = createArrowMesh();
  arrowMesh.position.copy(startPos);
  scene.add(arrowMesh);

  archerProjectiles.push({
    mesh: arrowMesh,
    startPos,
    targetPos: targetWorldPos,
    targetUnit,
    targetBuilding,
    targetType,
    progress: 0,
    duration,
    arcHeight,
    damage: attacker.damage,
    attackerFaction: attacker.faction,
    attacker,
  });
}

function commandAttack(unit: RTSUnit, target: RTSUnit) {
  if (unit.isDying || target.isDying) return;
  unit.targetEnemy = target;
  unit.targetStructure = null;
  unit.targetTree = null;
  unit.targetBuilding = null;
  unit.state = 'ATTACKING';
  unit.lastPursuitTargetCell = null;

  const myPos = unit.group.position;
  const targetPos = target.group.position;
  const dist = Math.hypot(myPos.x - targetPos.x, myPos.z - targetPos.z);

  if (dist > unit.attackRange) {
    const targetCell = unitCell(target);
    unit.lastPursuitTargetCell = targetCell.clone();
    const destination = findClosestWalkableCell(targetCell, unitCell(unit));
    setUnitPath(unit, destination);
  } else {
    unit.waypoints = [];
    unit.currentWaypointIndex = 0;
  }
}

export const commandAttackUnit = commandAttack;

/**
 * Encontra o inimigo ideal dentro de um raio de detecção (maxRadius).
 * Prioriza atacantes militares inimigos (SWORDSMAN) antes de aldeões (VILLAGER),
 * e depois o inimigo mais próximo.
 */
export function findBestEnemyTarget(unit: RTSUnit, maxRadius = 6.5): RTSUnit | null {
  if (unit.isDying) return null;
  const myPos = unit.group.position;
  let bestTarget: RTSUnit | null = null;
  let bestScore = Infinity;

  for (const other of unitsList) {
    if (other.isDying || other.hp <= 0 || other.faction !== 'ENEMY') continue;
    const dist = Math.hypot(other.group.position.x - myPos.x, other.group.position.z - myPos.z);
    if (dist <= maxRadius) {
      // Prioridade 1: Tropas militares (SWORDSMAN / ARCHER) têm peso menor (melhor score)
      // Prioridade 2: Menor distância
      const priorityWeight = (other.unitType === 'SWORDSMAN' || other.unitType === 'ARCHER') ? 0 : 1000;
      const score = priorityWeight + dist;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = other;
      }
    }
  }

  return bestTarget;
}

/**
 * Alerta de Socorro para Soldados Aliados Próximos (Call for Help / Town Alarm):
 * Aciona soldados aliados próximos ociosos (SWORDSMAN / ARCHER) para defender o alvo atacado.
 */
export function alertNearbyAlliedSoldiers(gridXOrPos: number | THREE.Vector3, gridZOrAttacker: number | RTSUnit, maybeAttackerOrRadius?: RTSUnit | number, maybeRadius?: number): void {
  let attackPos: THREE.Vector3;
  let attacker: RTSUnit;
  let radius = 10.0;

  if (typeof gridXOrPos === 'number') {
    const gx = gridXOrPos;
    const gz = gridZOrAttacker as number;
    attacker = maybeAttackerOrRadius as RTSUnit;
    if (typeof maybeRadius === 'number') radius = maybeRadius;
    attackPos = new THREE.Vector3(gx + 0.5, 0, gz + 0.5);
  } else {
    attackPos = gridXOrPos;
    attacker = gridZOrAttacker as RTSUnit;
    if (typeof maybeAttackerOrRadius === 'number') radius = maybeAttackerOrRadius;
  }

  callAlliedSoldiersForHelp(attackPos, attacker, radius);
}

/**
 * Reação Imediata ao Sofrer Dano:
 * Aldeões interrompem trabalho civil, revidam contra o agressor e chamam reforços aliados.
 * Soldados e arqueiros se defendem imediatamente e contra-atacam.
 */
export function onUnitDamagedByEnemy(victim: RTSUnit, attacker: RTSUnit): void {
  if (victim.hp <= 0 || victim.isDying || !attacker || attacker.hp <= 0 || attacker.isDying) return;

  const vPos = victim.group ? victim.group.position : new THREE.Vector3((victim.gridX ?? 0) + 0.5, 0, (victim.gridZ ?? 0) + 0.5);

  // 1. SE A VÍTIMA FOR DA FACÇÃO DO JOGADOR (OU ALIADA)
  if (victim.faction === 'PLAYER' || !victim.isEnemy) {
    if (victim.unitType === 'VILLAGER') {
      const isWorkingOrIdle = [
        'GATHERING', 'MOVING_TO_RESOURCE',
        'BUILDING', 'MOVING_TO_BUILD',
        'FARMING', 'RETURNING_TO_BASE',
        'IDLE', 'MINING_GOLD', 'DEPOSITING',
        'MOVING_TO_REPAIR', 'REPAIRING',
        'MOVING_TO_SCHOOL', 'MOVING_TO_COLLEGE', 'MOVING'
      ].includes(victim.state);

      if (isWorkingOrIdle) {
        // Limpa poses de trabalho e ponteiros de trabalho civil
        resetChopPose(victim);
        clearUnitFarmTarget(victim);
        victim.targetTree = null;
        victim.targetBerryBush = null;
        victim.targetStoneMine = null;
        victim.targetGoldMine = null;
        victim.targetBuilding = null;
        (victim as any).targetResource = undefined;
        victim.gatherCell = null;
        victim.buildCell = null;
        victim.dropoffTarget = null;
        victim.dropoffBuilding = null;

        // Entra em combate de auto-defesa contra o agressor
        commandAttack(victim, attacker);

        // Feedback sonoro e visual de alarme
        soundManager.alertAttack?.();
        spawnFloatingText(vPos.clone().add(new THREE.Vector3(0, 1.4, 0)), '⚠️ Sob Ataque!', '#ef4444');
      }
    } else if (victim.unitType === 'SWORDSMAN' || victim.unitType === 'ARCHER') {
      const isAlreadyDuelingMelee =
        victim.state === 'ATTACKING' &&
        victim.targetEnemy &&
        !victim.targetEnemy.isDying &&
        victim.targetEnemy.hp > 0;

      if (!isAlreadyDuelingMelee && (victim.state === 'IDLE' || victim.state === 'MOVING' || victim.state === 'ATTACKING_STRUCTURE')) {
        commandAttack(victim, attacker);
        spawnFloatingText(
          vPos.clone().add(new THREE.Vector3(0, 1.4, 0)),
          victim.unitType === 'ARCHER' ? '🏹 Contra-Atacar!' : '⚔️ Contra-Atacar!',
          '#38bdf8'
        );
      }
    }

    // Alerta de socorro para guerreiros aliados nas proximidades
    alertNearbyAlliedSoldiers(vPos, attacker, 10.0);
  } else if (victim.faction === 'ENEMY') {
    if (victim.state === 'IDLE' && !victim.targetEnemy) {
      commandAttack(victim, attacker);
    }
  }
}

/**
 * Alerta de Socorro da Base (Call for Help / Town Watch):
 * Todos os soldados aliados que estiverem IDLE num raio de radius células recebem ordem para defender contra o invasor.
 */
export function callAlliedSoldiersForHelp(attackPos: THREE.Vector3, attacker: RTSUnit, radius = 10.0): void {
  if (!attacker || attacker.isDying || attacker.hp <= 0) return;
  for (const u of unitsList) {
    if (u.isDying || u.hp <= 0 || u.faction !== 'PLAYER') continue;
    if (u.unitType !== 'SWORDSMAN' && u.unitType !== 'ARCHER') continue;
    if (u.state === 'IDLE') {
      const d = Math.hypot(u.group.position.x - attackPos.x, u.group.position.z - attackPos.z);
      if (d <= radius) {
        commandAttack(u, attacker);
      }
    }
  }
}

let lastAlliedAggroCheck = 0;
/**
 * Auto-Engagement de Soldados Aliados (Aggro por Proximidade / Stance Agressiva):
 * Executado continuamente a cada ~250ms no loop de simulação.
 */
export function updateAlliedCombatAggro(now: number): void {
  if (now - lastAlliedAggroCheck < 250) return;
  lastAlliedAggroCheck = now;

  for (const unit of unitsList) {
    if (unit.isDying || unit.hp <= 0 || unit.faction !== 'PLAYER') continue;
    if (unit.unitType !== 'SWORDSMAN' && unit.unitType !== 'ARCHER') continue;

    // a. Quando engajar automaticamente:
    // - Se estiver IDLE ou ATTACKING_STRUCTURE
    // - Se estiver MOVING, só engaja se estiver bloqueado corpo a corpo por um inimigo a menos de 1.5 células
    let canEngage = false;
    if (unit.state === 'IDLE' || unit.state === 'ATTACKING_STRUCTURE') {
      canEngage = true;
    } else if (unit.state === 'MOVING') {
      const myPos = unit.group.position;
      const isBlockedByEnemy = unitsList.some(
        (e: RTSUnit) => e.faction === 'ENEMY' && !e.isDying && e.hp > 0 &&
        Math.hypot(e.group.position.x - myPos.x, e.group.position.z - myPos.z) <= 1.5
      );
      if (isBlockedByEnemy) {
        canEngage = true;
      }
    }

    if (!canEngage) continue;

    // b. Raio de Detecção de até 7.0 células para Arqueiros (alcance 6.0) e 6.5 para Espadachins
    const aggroRadius = unit.unitType === 'ARCHER' ? 7.0 : 6.5;
    const nearestEnemy = findBestEnemyTarget(unit, aggroRadius);
    if (nearestEnemy) {
      commandAttack(unit, nearestEnemy);
    }
  }
}

(window as any).__RTS_COMBAT__ = {
  createUnit,
  unitsList,
  findBestEnemyTarget,
  commandAttack,
  callAlliedSoldiersForHelp,
  alertNearbyAlliedSoldiers,
  onUnitDamagedByEnemy,
  updateAlliedCombatAggro,
  archerProjectiles,
  trainArcher,
  placeArcheryRange,
  executeRangedAttack,
  buildingsList,
  resources,
};

export function commandAttackBuilding(unit: RTSUnit, building: ConstructionBuilding) {
  if (unit.isDying || building.isDepleted || (building.hp !== undefined && building.hp <= 0)) return;
  unit.state = 'ATTACKING_STRUCTURE';
  unit.targetStructure = 'BUILDING';
  unit.targetBuilding = building;
  unit.targetEnemy = null;
  unit.targetTree = null;
  unit.lastPursuitTargetCell = null;

  const bCenter = building.worldCenter;
  const myPos = unit.group.position;
  const dist = Math.hypot(myPos.x - bCenter.x, myPos.z - bCenter.z);
  const reach = unit.unitType === 'ARCHER' ? unit.attackRange : (building.size === 1 ? 1.6 : (building.size === 2 ? 2.2 : 2.8));

  if (dist > reach) {
    const dest = findClosestWalkableCell(new THREE.Vector2(building.gridX, building.gridZ), unitCell(unit));
    setUnitPath(unit, dest);
  } else {
    unit.waypoints = [];
    unit.currentWaypointIndex = 0;
  }
}

function commandAttackTent(unit: RTSUnit) {
  if (unit.isDying || !enemyCampState || enemyCampState.isTentDestroyed) return;
  unit.state = 'ATTACKING_STRUCTURE';
  unit.targetStructure = 'TENT';
  unit.targetEnemy = null;
  unit.targetTree = null;
  unit.targetBuilding = null;
  unit.lastPursuitTargetCell = null;

  const tcPos = new THREE.Vector3(enemyCampCoord.x + 1.5, 0, enemyCampCoord.z + 1.5);
  const myPos = unit.group.position;
  const dist = Math.hypot(myPos.x - tcPos.x, myPos.z - tcPos.z);
  const reach = unit.unitType === 'ARCHER' ? unit.attackRange : 2.6;

  if (dist > reach) {
    const dest = findClosestWalkableCell(
      new THREE.Vector2(enemyCampCoord.x + 1, enemyCampCoord.z + 1),
      unitCell(unit)
    );
    setUnitPath(unit, dest);
  } else {
    unit.waypoints = [];
    unit.currentWaypointIndex = 0;
  }
}

export function commandAttackTownCenter(unit: RTSUnit) {
  if (unit.isDying || townCenterState.isDestroyed) return;
  unit.state = 'ATTACKING_STRUCTURE';
  unit.targetStructure = 'TOWN_CENTER';
  unit.targetEnemy = null;
  unit.targetTree = null;
  unit.targetBuilding = null;
  unit.lastPursuitTargetCell = null;

  const tcPos = TC_WORLD_CENTER;
  const myPos = unit.group.position;
  const dist = Math.hypot(myPos.x - tcPos.x, myPos.z - tcPos.z);
  const reach = unit.unitType === 'ARCHER' ? unit.attackRange : 2.6;

  if (dist > reach) {
    const dest = findClosestWalkableCell(new THREE.Vector2(tcCoord.minX + 1, tcCoord.minZ + 1), unitCell(unit));
    setUnitPath(unit, dest);

    // Se o A* não gerou rota até o Town Center por haver bloqueio completo de muralhas,
    // a unidade NÃO deve atacar as muralhas. Ela deve permanecer em guarda/patrulha no limite acessível.
    if (unit.waypoints.length === 0) {
      unit.state = 'IDLE';
    }
  } else {
    unit.waypoints = [];
    unit.currentWaypointIndex = 0;
  }
}

function isEnemyTentUnderCursor(clientX: number, clientY: number): boolean {
  if (!enemyCampState || enemyCampState.isTentDestroyed) return false;
  const isCampVisible = currentMatchConfig.revealWholeMap || (
    isCellInside(enemyCampCoord.x + 1, enemyCampCoord.z + 1) &&
    isBuildingDiscovered({ gridX: enemyCampCoord.x, gridZ: enemyCampCoord.z, size: enemyCampCoord.size })
  );
  if (!isCampVisible) return false;

  setPointerNDC(clientX, clientY);
  if (enemyTownCenterState) {
    const intersects = raycaster.intersectObjects(enemyTownCenterState.group.children, true);
    if (intersects.length > 0) return true;
  } else if (enemyCampState.tentMesh) {
    const intersects = raycaster.intersectObject(enemyCampState.tentMesh, false);
    if (intersects.length > 0) return true;
  }

  if (raycaster.ray.intersectPlane(groundPlane, groundIntersect)) {
    const gx = Math.floor(groundIntersect.x);
    const gz = Math.floor(groundIntersect.z);
    return gx >= enemyCampCoord.x && gx < enemyCampCoord.x + enemyCampCoord.size &&
           gz >= enemyCampCoord.z && gz < enemyCampCoord.z + enemyCampCoord.size;
  }
  return false;
}

function getEnemyUnderCursor(clientX: number, clientY: number): RTSUnit | null {
  setPointerNDC(clientX, clientY);
  const enemies = unitsList.filter((u) => u.faction === 'ENEMY' && !u.isDying && u.group.visible);
  const meshes = enemies.map((u) => u.cylinderMesh);
  const intersects = raycaster.intersectObjects(meshes, false);
  if (intersects.length > 0) {
    return enemies.find((u) => u.cylinderMesh === intersects[0].object) ?? null;
  }
  if (raycaster.ray.intersectPlane(groundPlane, groundIntersect)) {
    return enemies.find(
      (u) => Math.hypot(u.group.position.x - groundIntersect.x, u.group.position.z - groundIntersect.z) < 0.75
    ) ?? null;
  }
  return null;
}

// --- 14. MARCADOR VISUAL DE COMANDO ---
interface MoveMarker {
  group: THREE.Group;
  createdAt: number;
  duration: number;
}
const activeMoveMarkers: MoveMarker[] = [];

function spawnMoveMarker(worldX: number, worldZ: number, color = 0x00ff00) {
  const marker = new THREE.Group();
  marker.position.set(worldX, 0.02, worldZ);

  const s = 0.32;
  const crossLine = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-s, 0, 0), new THREE.Vector3(s, 0, 0),
      new THREE.Vector3(0, 0, -s), new THREE.Vector3(0, 0, s)
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1.0 })
  );
  marker.add(crossLine);

  const ringMesh = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 0.32, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  ringMesh.rotation.x = -Math.PI / 2;
  marker.add(ringMesh);

  scene.add(marker);
  activeMoveMarkers.push({ group: marker, createdAt: performance.now(), duration: 450 });
}

// --- 15. UI TELEMETRY ---
const selectionBoxEl = document.getElementById('selection-box')!;
const telemetryPanelEl = document.getElementById('telemetry-panel');
const telemetryHeaderEl = document.getElementById('telemetry-header');
const telemetryToggleIconEl = document.getElementById('telemetry-toggle-icon');
const telemetryTileEl = document.getElementById('telemetry-tile');
const telemetryWalkableEl = document.getElementById('telemetry-walkable');
const btnResetCam = document.getElementById('btn-reset-cam');
const btnClearUnits = document.getElementById('btn-clear-units');
const btnSpawnUnit = document.getElementById('btn-spawn-unit');

// Impede que cliques na telemetria disparem seleções ou ordens no Three.js
telemetryPanelEl?.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});
telemetryPanelEl?.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});
telemetryPanelEl?.addEventListener('click', (e) => {
  e.stopPropagation();
});

telemetryHeaderEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!telemetryPanelEl) return;
  const isNowCollapsed = telemetryPanelEl.classList.toggle('is-collapsed');
  if (telemetryToggleIconEl) {
    telemetryToggleIconEl.textContent = isNowCollapsed ? '▾' : '▴';
  }
});

function updateTelemetryUnitsCount() {
  const currentPop = getCurrentPlayerPopulation();
  const popCap = getPopulationCap();
  if (resPopEl) {
    resPopEl.textContent = `${currentPop} / ${popCap}`;
    if (currentPop >= popCap) {
      resPopEl.classList.add('pop-capped');
    } else {
      resPopEl.classList.remove('pop-capped');
    }
  }
  const resPopItem = document.getElementById('res-pop');
  if (resPopItem) {
    resPopItem.title = `População: ${currentPop} / ${popCap} (Máximo Global: ${MAX_GLOBAL_POPULATION})`;
  }
}

export const updatePopulationHUD = updateTelemetryUnitsCount;

function updateTelemetrySelectionCount(): void {
  // Desativado: telemetria removida da interface
  return;
}

btnClearUnits?.addEventListener('click', (e) => {
  e.stopPropagation();
  clearAllUnits();
});

btnSpawnUnit?.addEventListener('click', (e) => {
  e.stopPropagation();
  spawnUnitAtCursorOrCenter();
});

const btnTestFarmMill = document.getElementById('btn-test-farm-mill');
btnTestFarmMill?.addEventListener('click', (e) => {
  e.stopPropagation();
  fogGrid.fill(FogState.VISIBLE);
  updateFogOfWar(true);
  resources.wood += 300;
  resources.food += 100;
  updateResourceHUD(true);

  const mx = tcCoord.maxX + 2;
  const mz = tcCoord.minZ;
  const fx = tcCoord.maxX + 5;
  const fz = tcCoord.minZ;

  let mill = buildingsList.find((b) => b.type === 'MILL');
  if (!mill) {
    mill = createMillFoundation(mx, mz);
    mill.progress = 100;
    mill.isCompleted = true;
    mill.siteGroup.visible = false;
    mill.progressGroup.visible = false;
    mill.finishedGroup.visible = true;
  }

  let farm = buildingsList.find((b) => b.type === 'FARM');
  if (!farm) {
    farm = createFarmFoundation(fx, fz);
    farm.progress = 100;
    farm.isCompleted = true;
    farm.siteGroup.visible = false;
    farm.progressGroup.visible = false;
    farm.finishedGroup.visible = true;
  }

  const villager = unitsList.find((u) => u.unitType === 'VILLAGER' && u.faction === 'PLAYER');
  if (villager && farm) {
    commandFarm(villager, farm);
  }

  selectBuilding(farm);
  renderMinimap();
  spawnFloatingText(farm.worldCenter.clone().setY(2.2), '🌾 Moinho & Fazenda Criados!', '#22c55e');
});

const btnTestWallsGates = document.getElementById('btn-test-walls-gates');
btnTestWallsGates?.addEventListener('click', (e) => {
  e.stopPropagation();
  fogGrid.fill(FogState.VISIBLE);
  updateFogOfWar(true);
  resources.wood += 500;
  resources.stone += 500;
  resources.gold += 300;

  // 1. Gradua um aldeão a Arquiteto Mestre
  let villager = unitsList.find((u) => u.unitType === 'VILLAGER' && u.faction === 'PLAYER');
  if (!villager) {
    villager = createUnit(tcCoord.maxX + 1, tcCoord.minZ, 'VILLAGER', 'PLAYER');
  }

  villager.educationLevel = 2;
  villager.eliteSpecialization = 'ARCHITECT';
  villager.canEnrollInCollege = false;
  if (!isStoneWallReinforced) reinforceStoneWalls();
  if (villager.academicCapGroup) villager.academicCapGroup.visible = true;
  if (villager.academicGownMesh) villager.academicGownMesh.visible = true;
  if (villager.auraRingMesh) villager.auraRingMesh.visible = true;

  // 2. Constrói um trecho de muralha contínua e um portão funcional alinhado
  const wx = tcCoord.maxX + 4;
  const wzStart = tcCoord.minZ - 1;

  // Cria Wall 1 e Wall 2
  const w1 = createWallFoundation(wx, wzStart);
  w1.progress = 100;
  w1.isCompleted = true;
  w1.siteGroup.visible = false;
  w1.finishedGroup.visible = true;

  const w2 = createWallFoundation(wx, wzStart + 1);
  w2.progress = 100;
  w2.isCompleted = true;
  w2.siteGroup.visible = false;
  w2.finishedGroup.visible = true;

  // Cria Portão (2x1)
  const gate = createGateFoundation(wx, wzStart + 2);
  gate.progress = 100;
  gate.isCompleted = true;
  gate.siteGroup.visible = false;
  gate.finishedGroup.visible = true;

  // Cria Wall 3 e Wall 4
  const w3 = createWallFoundation(wx, wzStart + 3);
  w3.progress = 100;
  w3.isCompleted = true;
  w3.siteGroup.visible = false;
  w3.finishedGroup.visible = true;

  const w4 = createWallFoundation(wx, wzStart + 4);
  w4.progress = 100;
  w4.isCompleted = true;
  w4.siteGroup.visible = false;
  w4.finishedGroup.visible = true;

  // Reconecta nós visuais em 3D
  rebuildWallMesh(w1);
  rebuildWallMesh(w2);
  rebuildWallMesh(w3);
  rebuildWallMesh(w4);

  // 3. Seleciona o Arquiteto para exibir seu card distintivo
  deselectAllUnits();
  selectUnit(villager);

  // 4. Direciona um aldeão a atravessar o portão
  const walker = unitsList.find((u) => u.unitType === 'VILLAGER' && u !== villager && u.faction === 'PLAYER') || createUnit(wx - 2, wzStart + 2, 'VILLAGER', 'PLAYER');
  walker.group.position.set(wx - 2 + 0.5, 0, wzStart + 2 + 0.5);
  setUnitPath(walker, new THREE.Vector2(wx + 3, wzStart + 2));

  updateResourceHUD(true);
  renderMinimap();
  spawnFloatingText(gate.worldCenter.clone().setY(2.2), '🧱 Fortificações & Arquiteto Prontos!', '#38bdf8');
  soundManager.buildingComplete();
});

btnBuildBarracks?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'BARRACKS') {
    exitPlacementMode();
  } else {
    enterPlacementMode('BARRACKS');
  }
});

btnBuildArchery?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'ARCHERY_RANGE') {
    exitPlacementMode();
  } else {
    enterPlacementMode('ARCHERY_RANGE');
  }
});

btnBuildTower?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
      '⚠️ Você precisa de um Arquiteto para projetar Torres de Vigia!',
      '#ef4444'
    );
    return;
  }
  if (isPlacementMode && currentPlacementType === 'TOWER') {
    exitPlacementMode();
  } else {
    enterPlacementMode('TOWER');
  }
});

btnBuildLumber?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'LUMBER_CAMP') {
    exitPlacementMode();
  } else {
    enterPlacementMode('LUMBER_CAMP');
  }
});

btnBuildMining?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'MINING_CAMP') {
    exitPlacementMode();
  } else {
    enterPlacementMode('MINING_CAMP');
  }
});

btnBuildHouse?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'HOUSE') {
    exitPlacementMode();
  } else {
    enterPlacementMode('HOUSE');
  }
});

btnBuildMill?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'MILL') {
    exitPlacementMode();
  } else {
    enterPlacementMode('MILL');
  }
});

btnBuildFarm?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (!hasLivingAgronomist()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
      '⚠️ Você precisa de um Agrônomo para planejar terras cultiváveis!',
      '#ef4444'
    );
    return;
  }
  if (isPlacementMode && currentPlacementType === 'FARM') {
    exitPlacementMode();
  } else {
    enterPlacementMode('FARM');
  }
});

btnReseedFarm?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (selectedBuilding && selectedBuilding.type === 'FARM') {
    reseedFarm(selectedBuilding);
  }
});

btnCloseFarm?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  deselectBuilding();
});

btnCloseMill?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  deselectBuilding();
});

btnBuildSchool?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'SCHOOL') {
    exitPlacementMode();
  } else {
    enterPlacementMode('SCHOOL');
  }
});

btnBuildCollege?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (isPlacementMode && currentPlacementType === 'COLLEGE') {
    exitPlacementMode();
  } else {
    enterPlacementMode('COLLEGE');
  }
});

btnBuildWall?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
      '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
      '#ef4444'
    );
    return;
  }
  if (isPlacementMode && currentPlacementType === 'WALL') {
    exitPlacementMode();
  } else {
    enterPlacementMode('WALL');
  }
});

btnBuildGate?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (!hasLivingArchitect()) {
    soundManager.popCappedAlert();
    spawnFloatingText(
      new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
      '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
      '#ef4444'
    );
    return;
  }
  if (isPlacementMode && currentPlacementType === 'GATE') {
    exitPlacementMode();
  } else {
    enterPlacementMode('GATE');
  }
});

btnCloseSchool?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  deselectBuilding();
});

btnEjectStudents?.addEventListener('click', (e) => {
  e.stopPropagation();
  soundManager.uiClick();
  if (selectedBuilding && selectedBuilding.type === 'SCHOOL') {
    ejectAllStudents(selectedBuilding);
  }
});

function spawnUnitAtCursorOrCenter() {
  const currentPop = getCurrentPlayerPopulation();
  const popCap = getPopulationCap();
  if (currentPop >= popCap) {
    soundManager.popCappedAlert();
    console.log(`[RTS População] Limite populacional atingido (${currentPop}/${popCap})! Construa Casas [H].`);
    spawnFloatingText(TC_WORLD_CENTER.clone().setY(2.8), `⚠️ Limite de População (${currentPop}/${popCap})! Construa Casas [H]`, '#f87171');
    bumpElement(resPopEl);
    return;
  }
  const target = currentCell && currentCell.isInside
    ? new THREE.Vector2(currentCell.gridX, currentCell.gridZ)
    : new THREE.Vector2(tcCoord.maxX + 1, tcCoord.maxZ + 1);
  const free = findClosestWalkableCell(target, new THREE.Vector2(tcCoord.minX + 1, tcCoord.minZ + 1));
  createUnit(free.x, free.y);
  gameStats.unitsTrainedTotal++;
}

function setWalkableLabel(text: string, color: string) {
  if (telemetryWalkableEl) {
    telemetryWalkableEl.textContent = text;
    telemetryWalkableEl.style.color = color;
  }
}

function updateHoverMarker(clientX: number, clientY: number) {
  setPointerNDC(clientX, clientY);

  // Se estiver em modo de posicionamento (Ghost Building)
  if (isPlacementMode) {
    const cell = raycastGridCell(clientX, clientY);
    if (cell && cell.isInside) {
      ghostGridX = cell.gridX;
      ghostGridZ = cell.gridZ;

      const dims = getBuildingDimensions(currentPlacementType);
      const sizeX = dims.width;
      const sizeZ = dims.height;
      const valid = isValidBuildingPlacement(ghostGridX, ghostGridZ, currentPlacementType);
      setGhostValidity(valid);

      // Oculta todos os fantasmas antes de posicionar o correto
      ghostTowerGroup.visible = false;
      ghostGroup.visible = false;
      ghostArcheryGroup.visible = false;
      ghostLumberGroup.visible = false;
      ghostMiningGroup.visible = false;
      ghostHouseGroup.visible = false;
      ghostMillGroup.visible = false;
      ghostFarmGroup.visible = false;
      ghostSchoolGroup.visible = false;
      ghostCollegeGroup.visible = false;
      ghostWallGroup.visible = false;
      ghostGateGroup.visible = false;

      if (currentPlacementType === 'WALL') {
        if (!isDraggingWall) {
          const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 1);
          ghostWallGroup.position.set(ghostGridX + 0.5, gh, ghostGridZ + 0.5);
          ghostWallGroup.visible = true;
        } else {
          ghostWallGroup.visible = false;
        }
      } else if (currentPlacementType === 'GATE') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostGateGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 0.5);
        ghostGateGroup.visible = true;
      } else if (currentPlacementType === 'TOWER') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 1);
        ghostTowerGroup.position.set(ghostGridX + 0.5, gh, ghostGridZ + 0.5);
        ghostTowerGroup.visible = true;
      } else if (currentPlacementType === 'ARCHERY_RANGE') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostArcheryGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostArcheryGroup.visible = true;
      } else if (currentPlacementType === 'LUMBER_CAMP') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostLumberGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostLumberGroup.visible = true;
      } else if (currentPlacementType === 'MINING_CAMP') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostMiningGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostMiningGroup.visible = true;
      } else if (currentPlacementType === 'HOUSE') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 1);
        ghostHouseGroup.position.set(ghostGridX + 0.5, gh, ghostGridZ + 0.5);
        ghostHouseGroup.visible = true;
      } else if (currentPlacementType === 'MILL') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostMillGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostMillGroup.visible = true;
      } else if (currentPlacementType === 'FARM') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostFarmGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostFarmGroup.visible = true;
      } else if (currentPlacementType === 'SCHOOL') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostSchoolGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostSchoolGroup.visible = true;
      } else if (currentPlacementType === 'COLLEGE') {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 3);
        ghostCollegeGroup.position.set(ghostGridX + 1.5, gh, ghostGridZ + 1.5);
        ghostCollegeGroup.visible = true;
      } else {
        const gh = getBuildingPlacementHeight(ghostGridX, ghostGridZ, 2);
        ghostGroup.position.set(ghostGridX + 1.0, gh, ghostGridZ + 1.0);
        ghostGroup.visible = true;
      }

      setWalkableLabel(valid ? `Local Válido [${sizeX}x${sizeZ}]` : 'Local Bloqueado', valid ? '#22c55e' : '#ef4444');
      if (telemetryTileEl) telemetryTileEl.textContent = `[${ghostGridX}, ${ghostGridZ}]`;
      renderer.domElement.style.cursor = valid ? 'pointer' : 'not-allowed';
    }
    return;
  }

  // Verifica se o cursor está sobre o Centro da Cidade
  if (isTownCenterUnderCursor(clientX, clientY)) {
    const selectedVillagers = getSelectedUnits().filter((u) => u.faction === 'PLAYER' && u.unitType === 'VILLAGER');
    if (selectedVillagers.length > 0 && isTownCenterDamaged()) {
      setWalkableLabel(`🔧 Reparar Centro da Cidade (HP: ${Math.floor(townCenterState.hp)} / ${townCenterState.maxHp})`, '#22c55e');
      renderer.domElement.style.cursor = 'pointer';
      return;
    }
  }

  // Modo normal: verifica se há construção sob o cursor
  const building = getBuildingUnderCursor(clientX, clientY);
  if (building) {
    const bh = getTerrainHeight(building.worldCenter.x, building.worldCenter.z);
    markerGroup.position.set(building.worldCenter.x, bh + 0.015, building.worldCenter.z);
    markerGroup.visible = false;
    ensureBuildingHp(building);

    const selectedVillagers = getSelectedUnits().filter((u) => u.faction === 'PLAYER' && u.unitType === 'VILLAGER');
    const isDamaged = building.faction === 'PLAYER' && building.isCompleted && (building.hp ?? 0) < (building.maxHp ?? 1);

    if (selectedVillagers.length > 0 && isDamaged) {
      const displayName = getBuildingDisplayName(building.type);
      setWalkableLabel(`🔧 Reparar ${displayName} (HP: ${Math.floor(building.hp!)} / ${building.maxHp})`, '#22c55e');
      renderer.domElement.style.cursor = 'pointer';
      return;
    }

    if (building.isCompleted) {
      const name =
        building.type === 'WALL' ? 'Muralha de Pedra (Concluída)' :
        building.type === 'GATE' ? 'Portão Fortificado (Concluído)' :
        building.type === 'TOWER' ? 'Torre de Vigia (Concluída)' :
        building.type === 'LUMBER_CAMP' ? 'Madeireira (Concluída)' :
        building.type === 'MINING_CAMP' ? 'Campo de Mineração (Concluído)' :
        building.type === 'HOUSE' ? 'Casa (Concluída • +5 Pop)' :
        building.type === 'MILL' ? 'Moinho (Concluído • Depósito Alimento)' :
        building.type === 'FARM' ? (building.isDepleted ? 'Fazenda (Esgotada • Requer 60 🪵)' : `Fazenda (${Math.ceil(building.farmFood ?? 0)}/175 🍖)`) :
        building.type === 'SCHOOL' ? `Escola da Vila (Concluída • ${building.enrolledStudents?.length || 0}/3 Alunos)` :
        building.type === 'COLLEGE' ? `Real Faculdade (Concluída • ${building.enrolledStudents?.length || 0}/3 Especializandos)` :
        'Quartel (Concluído)';
      setWalkableLabel(name, '#fbbf24');
    } else {
      const name =
        building.type === 'WALL' ? 'Canteiro Muralha' :
        building.type === 'GATE' ? 'Canteiro Portão' :
        building.type === 'TOWER' ? 'Canteiro Torre' :
        building.type === 'LUMBER_CAMP' ? 'Canteiro Madeireira' :
        building.type === 'MINING_CAMP' ? 'Canteiro Mineração' :
        building.type === 'HOUSE' ? 'Canteiro Casa' :
        building.type === 'MILL' ? 'Canteiro Moinho' :
        building.type === 'FARM' ? 'Canteiro Fazenda' :
        building.type === 'SCHOOL' ? 'Canteiro Escola' :
        building.type === 'COLLEGE' ? 'Canteiro Faculdade' :
        'Canteiro Quartel';
      setWalkableLabel(`${name} • ${Math.floor(building.progress)}%`, '#f59e0b');
    }
    renderer.domElement.style.cursor = getSelectedUnits().length > 0 && !building.isCompleted ? 'crosshair' : 'default';
    return;
  }

  const goldMine = getGoldMineUnderCursor(clientX, clientY);
  const stoneMine = getStoneMineUnderCursor(clientX, clientY);
  const bush = getBerryBushUnderCursor(clientX, clientY);
  const tree = getTreeUnderCursor(clientX, clientY);
  currentCell = raycastGridCell(clientX, clientY);

  if (goldMine) {
    const gh = getTerrainHeight(goldMine.gridX + 0.5, goldMine.gridZ + 0.5);
    markerGroup.position.set(goldMine.gridX + 0.5, gh + 0.015, goldMine.gridZ + 0.5);
    markerGroup.visible = true;
    markerPlaneMat.color.setHex(0xeab308);
    markerEdgesMat.color.setHex(0xfacc15);
    setWalkableLabel(`Mina de Ouro • ${goldMine.gold}/${goldMine.maxGold} 🪙`, '#facc15');
    if (telemetryTileEl) telemetryTileEl.textContent = `[${goldMine.gridX}, ${goldMine.gridZ}]`;
    renderer.domElement.style.cursor = getSelectedUnits().length > 0 ? 'crosshair' : 'default';
    return;
  }

  if (stoneMine) {
    const mh = getTerrainHeight(stoneMine.gridX + 0.5, stoneMine.gridZ + 0.5);
    markerGroup.position.set(stoneMine.gridX + 0.5, mh + 0.015, stoneMine.gridZ + 0.5);
    markerGroup.visible = true;
    markerPlaneMat.color.setHex(0x64748b);
    markerEdgesMat.color.setHex(0x94a3b8);
    setWalkableLabel(`Jazida de Pedra • ${stoneMine.stone}/${stoneMine.maxStone} 🪨`, '#94a3b8');
    if (telemetryTileEl) telemetryTileEl.textContent = `[${stoneMine.gridX}, ${stoneMine.gridZ}]`;
    renderer.domElement.style.cursor = getSelectedUnits().length > 0 ? 'crosshair' : 'default';
    return;
  }

  if (bush) {
    const bh = getTerrainHeight(bush.gridX + 0.5, bush.gridZ + 0.5);
    markerGroup.position.set(bush.gridX + 0.5, bh + 0.015, bush.gridZ + 0.5);
    markerGroup.visible = true;
    markerPlaneMat.color.setHex(0xdc2626);
    markerEdgesMat.color.setHex(0xf87171);
    setWalkableLabel(`Arbusto de Frutas • ${bush.food}/${bush.maxFood} 🍓`, '#f87171');
    if (telemetryTileEl) telemetryTileEl.textContent = `[${bush.gridX}, ${bush.gridZ}]`;
    renderer.domElement.style.cursor = getSelectedUnits().length > 0 ? 'crosshair' : 'default';
    return;
  }

  if (tree) {
    const th = getTerrainHeight(tree.gridX + 0.5, tree.gridZ + 0.5);
    markerGroup.position.set(tree.gridX + 0.5, th + 0.015, tree.gridZ + 0.5);
    markerGroup.visible = true;
    markerPlaneMat.color.setHex(0xf59e0b);
    markerEdgesMat.color.setHex(0xfbbf24);
    setWalkableLabel(`Árvore • ${tree.wood}/${TREE_MAX_WOOD}`, '#fbbf24');
    if (telemetryTileEl) telemetryTileEl.textContent = `[${tree.gridX}, ${tree.gridZ}]`;
    renderer.domElement.style.cursor = getSelectedUnits().length > 0 ? 'crosshair' : 'default';
    return;
  }

  renderer.domElement.style.cursor = 'default';

  if (currentCell && currentCell.isInside) {
    const ch = getTerrainHeight(currentCell.gridX + 0.5, currentCell.gridZ + 0.5);
    markerGroup.position.set(currentCell.gridX + 0.5, ch + 0.015, currentCell.gridZ + 0.5);
    markerGroup.visible = true;

    const isTC = currentCell.gridX >= tcCoord.minX && currentCell.gridX <= tcCoord.maxX &&
      currentCell.gridZ >= tcCoord.minZ && currentCell.gridZ <= tcCoord.maxZ;
    const isCliff = cliffCellsSet.has(cellKey(currentCell.gridX, currentCell.gridZ));

    if (isCliff) {
      markerPlaneMat.color.setHex(0xef4444);
      markerEdgesMat.color.setHex(0xf87171);
      setWalkableLabel(`Penhasco Íngreme (Y=${ch.toFixed(1)})`, '#ef4444');
    } else if (currentCell.walkable) {
      markerPlaneMat.color.setHex(0x38bdf8);
      markerEdgesMat.color.setHex(0x7dd3fc);
      setWalkableLabel(ch > 0.4 ? `Colina Suave (Y=${ch.toFixed(1)})` : 'Planície Caminhável', '#38bdf8');
    } else {
      markerPlaneMat.color.setHex(0xef4444);
      markerEdgesMat.color.setHex(0xf87171);
      setWalkableLabel(isTC ? 'Town Center' : 'Obstáculo', '#ef4444');
    }

    if (telemetryTileEl) telemetryTileEl.textContent = `[${currentCell.gridX}, ${currentCell.gridZ}]`;
  } else {
    markerGroup.visible = false;
    if (telemetryTileEl) telemetryTileEl.textContent = 'Fora do Grid';
    setWalkableLabel('-', '#94a3b8');
  }
}

// --- 16. CONTROLES DE MOUSE & TECLADO ---
const RIGHT_GROUND = new THREE.Vector3(1, 0, -1).normalize();
const UP_GROUND = new THREE.Vector3(-1, 0, -1).normalize();

let isMiddleDragging = false;
let lastMousePos = { x: 0, y: 0 };
let currentCell: { gridX: number; gridZ: number; isInside: boolean; walkable: boolean } | null = null;

let isLeftMouseDown = false;
let isLeftDragging = false;
let dragStartX = 0;
let dragStartY = 0;

const EDGE_THRESHOLD = 26;
const mousePos = { x: -1, y: -1 };
let isMouseInsideWindow = false;

const edgeTopEl = document.getElementById('edge-top');
const edgeBottomEl = document.getElementById('edge-bottom');
const edgeLeftEl = document.getElementById('edge-left');
const edgeRightEl = document.getElementById('edge-right');

const keys: Record<string, boolean> = {};
window.addEventListener('keydown', (e) => {
  if (isMatchConfigModalOpen) {
    if (e.key === 'Escape' && hasMatchEverStarted) {
      closeMatchConfigModal();
    }
    return;
  }

  // Atalho [F5]: Quick Save instantâneo
  if (e.key === 'F5') {
    e.preventDefault();
    saveToSlot('rts_quicksave', 'Quick Save');
    return;
  }

  // Atalho [F9]: Quick Load instantâneo do último Quick Save
  if (e.key === 'F9') {
    e.preventDefault();
    loadFromSlot('rts_quicksave');
    return;
  }

  // Atalho [Escape]: Fechar modal de Salvar/Carregar se aberto
  if (e.key === 'Escape' && isSaveLoadModalOpen) {
    e.preventDefault();
    closeSaveLoadModal();
    return;
  }

  // Atalho Espaço: Pausar / Retomar Simulação
  if (e.code === 'Space' || e.key === ' ') {
    // Previne rolagem acidental de página se houver scroll
    e.preventDefault();
    // Ignora caso o usuário esteja digitando em um input de texto/modal aberto
    const activeTag = (document.activeElement?.tagName || '').toLowerCase();
    if (activeTag === 'input' || activeTag === 'textarea') return;

    toggleGamePause();
    return;
  }

  keys[e.key.toLowerCase()] = true;
  if (e.key.toLowerCase() === 'u') spawnUnitAtCursorOrCenter();

  // Atalho [J] Cheat de Recursos (Sandbox / Debug)
  if (e.key.toLowerCase() === 'j') {
    resources.wood += 500;
    resources.gold += 300;
    resources.stone += 300;
    resources.food += 300;
    updateResourceHUD(true);
    spawnFloatingText(new THREE.Vector3(cameraTarget.x, 2.5, cameraTarget.z), '🪙 Recursos Concedidos! (+500M, +300O, +300P)', '#22c55e');
  }

  // Atalho [Y] Concluir Construção Imediatamente
  if (e.key.toLowerCase() === 'y') {
    if (selectedBuilding && !selectedBuilding.isCompleted) {
      selectedBuilding.progress = 100;
      selectedBuilding.isCompleted = true;
      selectedBuilding.siteGroup.visible = false;
      selectedBuilding.progressGroup.visible = false;
      selectedBuilding.finishedGroup.visible = true;
      soundManager.buildingComplete();
      spawnFloatingText(selectedBuilding.worldCenter.clone().setY(2.2), '✨ Construção Concluída!', '#38bdf8');
      updateResourceHUD(true);
      if (selectedBuilding.type === 'ARCHERY_RANGE') updateArcheryHUD();
      if (selectedBuilding.type === 'BARRACKS') updateBarracksHUD();
    }
  }

  // Atalho [X] Concluir Treinamento Imediatamente
  if (e.key.toLowerCase() === 'x') {
    if (selectedBuilding && selectedBuilding.isCompleted && selectedBuilding.trainingQueue.length > 0) {
      selectedBuilding.trainingTimer = 999;
    }
  }

  // Atalho [O] Spawnar Inimigo de Teste
  if (e.key.toLowerCase() === 'o') {
    const enemy = createUnit(tcCoord.minX + 7, tcCoord.minZ + 7, 'SWORDSMAN', 'ENEMY');
    spawnFloatingText(enemy.group.position.clone().setY(2.0), '⚔️ Inimigo de Teste Spawnado!', '#ef4444');
  }

  // Atalho V para treinar Aldeão no Town Center se selecionado
  if (e.key.toLowerCase() === 'v') {
    if (isTownCenterSelected) {
      trainVillagerAtTownCenter();
    }
  }

  // Atalho W para construir Torre de Vigia
  if (e.key.toLowerCase() === 'w') {
    if (!hasLivingArchitect()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Arquiteto para projetar Torres de Vigia!',
        '#ef4444'
      );
      return;
    }
    if (isPlacementMode && currentPlacementType === 'TOWER') {
      exitPlacementMode();
    } else {
      enterPlacementMode('TOWER');
    }
  }

  // Atalho B para construir Quartel
  if (e.key.toLowerCase() === 'b') {
    if (isPlacementMode && currentPlacementType === 'BARRACKS') {
      exitPlacementMode();
    } else {
      enterPlacementMode('BARRACKS');
    }
  }

  // Atalho A para construir Campo de Tiro com Arco (Archery Range)
  if (e.key.toLowerCase() === 'a') {
    if (isPlacementMode && currentPlacementType === 'ARCHERY_RANGE') {
      exitPlacementMode();
    } else {
      enterPlacementMode('ARCHERY_RANGE');
    }
  }

  // Atalho L para construir Madeireira (Lumber Camp)
  if (e.key.toLowerCase() === 'l') {
    if (isPlacementMode && currentPlacementType === 'LUMBER_CAMP') {
      exitPlacementMode();
    } else {
      enterPlacementMode('LUMBER_CAMP');
    }
  }

  // Atalho M para construir Campo de Mineração (Mining Camp)
  if (e.key.toLowerCase() === 'm') {
    if (isPlacementMode && currentPlacementType === 'MINING_CAMP') {
      exitPlacementMode();
    } else {
      enterPlacementMode('MINING_CAMP');
    }
  }

  // Atalho T para treinar Espadachim se o Quartel estiver selecionado
  if (e.key.toLowerCase() === 't') {
    if (selectedBuilding && selectedBuilding.type === 'BARRACKS' && selectedBuilding.isCompleted) {
      trainSwordsman(selectedBuilding);
    }
  }

  // Atalho R para treinar Arqueiro se o Campo de Tiro com Arco estiver selecionado
  if (e.key.toLowerCase() === 'r') {
    if (selectedBuilding && selectedBuilding.type === 'ARCHERY_RANGE' && selectedBuilding.isCompleted) {
      trainArcher(selectedBuilding);
    }
  }

  // Atalho H para construir Casa
  if (e.key.toLowerCase() === 'h') {
    if (isPlacementMode && currentPlacementType === 'HOUSE') {
      exitPlacementMode();
    } else {
      enterPlacementMode('HOUSE');
    }
  }

  // Atalho I para construir Moinho (Mill)
  if (e.key.toLowerCase() === 'i') {
    if (isPlacementMode && currentPlacementType === 'MILL') {
      exitPlacementMode();
    } else {
      enterPlacementMode('MILL');
    }
  }

  // Atalho F para construir Fazenda (Farm)
  if (e.key.toLowerCase() === 'f') {
    if (!hasLivingAgronomist()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Agrônomo para planejar terras cultiváveis!',
        '#ef4444'
      );
      return;
    }
    if (isPlacementMode && currentPlacementType === 'FARM') {
      exitPlacementMode();
    } else {
      enterPlacementMode('FARM');
    }
  }

  // Atalho E para construir Escola (School)
  if (e.key.toLowerCase() === 'e') {
    if (isPlacementMode && currentPlacementType === 'SCHOOL') {
      exitPlacementMode();
    } else {
      enterPlacementMode('SCHOOL');
    }
  }

  // Atalho C para construir Real Faculdade (College)
  if (e.key.toLowerCase() === 'c') {
    if (isPlacementMode && currentPlacementType === 'COLLEGE') {
      exitPlacementMode();
    } else {
      enterPlacementMode('COLLEGE');
    }
  }

  // Atalho P para construir Muralha de Pedra (Stone Wall)
  if (e.key.toLowerCase() === 'p') {
    if (!hasLivingArchitect()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
        '#ef4444'
      );
      return;
    }
    if (isPlacementMode && currentPlacementType === 'WALL') {
      exitPlacementMode();
    } else {
      enterPlacementMode('WALL');
    }
  }

  // Atalho G para construir Portão Fortificado (Gate)
  if (e.key.toLowerCase() === 'g') {
    if (!hasLivingArchitect()) {
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ Você precisa de um Arquiteto vivo formado na Faculdade para erguer fortificações!',
        '#ef4444'
      );
      return;
    }
    if (isPlacementMode && currentPlacementType === 'GATE') {
      exitPlacementMode();
    } else {
      enterPlacementMode('GATE');
    }
  }

  // Atalho K ou F1 para abrir/fechar o Guia de Controles
  if (e.key.toLowerCase() === 'k' || e.key === 'F1') {
    toggleControlsPopover();
  }

  // Tecla Esc: fecha balões popover, cancela modo de posicionamento, fecha painel do quartel, desseleciona unidades ou abre/fecha menu de pausa
  if (e.key === 'Escape') {
    if (isEnginePopoverOpen || isControlsPopoverOpen) {
      closeEnginePopover();
      closeControlsPopover();
    } else if (isPlacementMode) {
      exitPlacementMode();
    } else if (selectedBuilding) {
      deselectBuilding();
    } else if (isTownCenterSelected) {
      deselectTownCenter();
    } else if (unitsList.some((u) => u.isSelected)) {
      deselectAllUnits();
    } else if (currentGameState === 'IN_GAME') {
      toggleGamePause();
    }
  }
});

btnTrainSwordsman?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'BARRACKS' && selectedBuilding.isCompleted) {
    trainSwordsman(selectedBuilding);
  }
});

btnCloseBarracks?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectBuilding();
});

btnTrainArcher?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'ARCHERY_RANGE' && selectedBuilding.isCompleted) {
    trainArcher(selectedBuilding);
  }
});

btnCloseArchery?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectBuilding();
});

btnTrainVillager?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (isTownCenterSelected) {
    trainVillagerAtTownCenter();
  }
});

btnCloseTc?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectTownCenter();
});

btnCloseBuilding?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectBuilding();
});

btnRepairGeneric?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding) {
    dispatchNearbyIdleVillagerToRepair(selectedBuilding);
  }
});

btnRepairTc?.addEventListener('click', (e) => {
  e.stopPropagation();
  dispatchNearbyIdleVillagerToRepair('TOWN_CENTER');
});

document.querySelectorAll('.btn-repair-action').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedBuilding) {
      dispatchNearbyIdleVillagerToRepair(selectedBuilding);
    }
  });
});

// Botões de Limpar Ponto de Encontro (Rally Point)
document.getElementById('btn-clear-tc-rally')?.addEventListener('click', (e) => {
  e.stopPropagation();
  townCenterState.rallyPoint = null;
  soundManager.uiClick();
  updateTownCenterRallyHUD();
  updateRallyPointVisuals();
  spawnFloatingText(TC_WORLD_CENTER.clone().setY(2.2), '🚩 Ponto Restaurado para a Porta', '#94a3b8');
});

document.getElementById('btn-clear-barracks-rally')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'BARRACKS') {
    selectedBuilding.rallyPoint = null;
    soundManager.uiClick();
    updateBuildingRallyHUD(selectedBuilding);
    updateRallyPointVisuals();
    spawnFloatingText(selectedBuilding.worldCenter.clone().setY(2.2), '🚩 Ponto Restaurado para a Porta', '#94a3b8');
  }
});

document.getElementById('btn-clear-archery-rally')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'ARCHERY_RANGE') {
    selectedBuilding.rallyPoint = null;
    soundManager.uiClick();
    updateBuildingRallyHUD(selectedBuilding);
    updateRallyPointVisuals();
    spawnFloatingText(selectedBuilding.worldCenter.clone().setY(2.2), '🚩 Ponto Restaurado para a Porta', '#94a3b8');
  }
});

document.getElementById('btn-clear-school-rally')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'SCHOOL') {
    selectedBuilding.rallyPoint = null;
    soundManager.uiClick();
    updateBuildingRallyHUD(selectedBuilding);
    updateRallyPointVisuals();
    spawnFloatingText(selectedBuilding.worldCenter.clone().setY(2.2), '🚩 Ponto Restaurado para a Porta', '#94a3b8');
  }
});

document.getElementById('btn-clear-college-rally')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (selectedBuilding && selectedBuilding.type === 'COLLEGE') {
    selectedBuilding.rallyPoint = null;
    soundManager.uiClick();
    updateBuildingRallyHUD(selectedBuilding);
    updateRallyPointVisuals();
    spawnFloatingText(selectedBuilding.worldCenter.clone().setY(2.2), '🚩 Ponto Restaurado para a Porta', '#94a3b8');
  }
});

// --- FULLSCREEN NATIVO & MOBILE HUD CONTROLS ---
export function toggleFullscreen(): void {
  try {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch((err) => {
          console.warn('Erro ao solicitar tela cheia:', err);
        });
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch((err) => {
          console.warn('Erro ao sair de tela cheia:', err);
        });
      }
    }
  } catch (err) {
    console.warn('Fullscreen API error:', err);
  }
}

document.querySelectorAll('.btn-toggle-fullscreen').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
    soundManager.uiClick();
  });
});

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  document.querySelectorAll('.btn-toggle-fullscreen').forEach((btn) => {
    const icon = btn.querySelector('.fullscreen-icon, .btn-icon, .btn-menu-icon');
    if (icon) icon.textContent = isFs ? '🗗' : '⛶';
    const label = btn.querySelector('.btn-menu-label');
    if (label) label.textContent = isFs ? 'Sair Tela Cheia' : 'Tela Cheia';
  });
});

// Botão Flutuante de Alternância Tática (Toggle de Modo de Ação: [ 👆 Modo Seleção ] vs [ 🎯 Modo Comando ])
export type MobileActionMode = 'SELECT_MOVE' | 'DIRECT_ORDER';
export let mobileActionMode: MobileActionMode = 'SELECT_MOVE';

const btnMobileActionMode = document.getElementById('btn-mobile-action-mode');
btnMobileActionMode?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (mobileActionMode === 'SELECT_MOVE') {
    mobileActionMode = 'DIRECT_ORDER';
    btnMobileActionMode.classList.add('mode-direct-order');
    btnMobileActionMode.innerHTML = '<span class="mode-icon">🎯</span><span class="mode-text">Comando</span>';
    spawnFloatingText(new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z), '🎯 Modo: Comando (Ordem Direta / Reparar)', '#ef4444');
  } else {
    mobileActionMode = 'SELECT_MOVE';
    btnMobileActionMode.classList.remove('mode-direct-order');
    btnMobileActionMode.innerHTML = '<span class="mode-icon">👆</span><span class="mode-text">Seleção</span>';
    spawnFloatingText(new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z), '👆 Modo: Seleção', '#38bdf8');
  }
  soundManager.uiClick();
  if (navigator.vibrate) {
    try { navigator.vibrate(25); } catch (_) {}
  }
});

// Botão de Desmarcar Seleção Atual no HUD Mobile ([ ✕ Desmarcar ])
const btnDeselectCurrent = document.getElementById('btn-deselect-current');
btnDeselectCurrent?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectAllUnits();
  deselectBuilding();
  deselectTownCenter();
  updateDeselectButtonVisibility();
  soundManager.uiClick();
});

// Botão Fechar no Card de Unidade
const btnCloseUnitCard = document.getElementById('btn-close-unit-card');
btnCloseUnitCard?.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectAllUnits();
  deselectBuilding();
  deselectTownCenter();
  updateDeselectButtonVisibility();
  soundManager.uiClick();
});

// Minimapa Mobile: Recolher em botão flutuante e expandir
const btnCollapseMinimap = document.getElementById('btn-collapse-minimap');
const btnToggleMinimapMobile = document.getElementById('btn-toggle-minimap-mobile');
const minimapContainerEl = document.getElementById('minimap-container');
const mobileTacticalControlsEl = document.getElementById('mobile-tactical-controls');

btnCollapseMinimap?.addEventListener('click', (e) => {
  e.stopPropagation();
  minimapContainerEl?.classList.add('is-collapsed');
  mobileTacticalControlsEl?.classList.add('minimap-collapsed');
  soundManager.uiClick();
});

btnToggleMinimapMobile?.addEventListener('click', (e) => {
  e.stopPropagation();
  const isNowCollapsed = minimapContainerEl?.classList.toggle('is-collapsed');
  mobileTacticalControlsEl?.classList.toggle('minimap-collapsed', !!isNowCollapsed);
  soundManager.uiClick();
});

// Dock de Construções: Abas de Categorias (Civis, Militares, Educação, Todas)
const dockTabButtons = document.querySelectorAll<HTMLButtonElement>('.dock-tab-btn');
const bottomActionDockEl = document.getElementById('bottom-action-dock');
dockTabButtons.forEach((tab) => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    dockTabButtons.forEach((b) => b.classList.remove('active'));
    tab.classList.add('active');
    const cat = tab.getAttribute('data-category') || 'all';
    bottomActionDockEl?.setAttribute('data-category', cat);
    soundManager.uiClick();
  });
});

window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

/**
 * Botão direito:
 * - Se em Placement Mode: Cancela sem gastar recursos
 * - Se clicar em Inimigo: Comanda ataque e perseguição
 * - Se clicar em Obra em andamento: Envia operários para construir
 * - Se clicar em Edifício danificado: Envia aldeões para reparar
 * - Se clicar em Arbusto de Frutas: Forragear alimento
 * - Se clicar em Árvore: Coletar madeira
 * - Se clicar em Chão: Mover via A*
 */
function handleRightClick(clientX: number, clientY: number) {
  if (isGameOver || isMatchConfigModalOpen) return;
  if (isPlacementMode) {
    exitPlacementMode();
    return;
  }

  const selected = getSelectedUnits().filter((u) => u.faction === 'PLAYER');

  // Interceptação de Ponto de Encontro (Rally Point) para edifícios de produção aliados selecionados
  const isAlliedTcSelected = isTownCenterSelected && !townCenterState.isDestroyed;
  const isAlliedProdBuildingSelected = !!(
    selectedBuilding &&
    (selectedBuilding.faction === 'PLAYER' || !selectedBuilding.isEnemy) &&
    ['BARRACKS', 'ARCHERY_RANGE', 'SCHOOL', 'COLLEGE'].includes(selectedBuilding.type)
  );

  if (selected.length === 0 && (isAlliedTcSelected || isAlliedProdBuildingSelected)) {
    let clickedGridX = 0;
    let clickedGridZ = 0;
    let clickedTargetType: 'GROUND' | 'RESOURCE' | 'BUILDING' = 'GROUND';
    let clickedEntityId: number | string | undefined = undefined;
    let resType: 'WOOD' | 'FOOD' | 'STONE' | 'GOLD' | undefined = undefined;

    // 1. Verifica se clicou em uma construção
    const bUnderCursor = getBuildingUnderCursor(clientX, clientY);
    if (bUnderCursor) {
      if (!bUnderCursor.isCompleted) {
        clickedTargetType = 'BUILDING';
        clickedEntityId = bUnderCursor.id;
        clickedGridX = bUnderCursor.gridX;
        clickedGridZ = bUnderCursor.gridZ;
      } else if (bUnderCursor.type === 'FARM') {
        clickedTargetType = 'RESOURCE';
        clickedEntityId = bUnderCursor.id;
        resType = 'FOOD';
        clickedGridX = bUnderCursor.gridX;
        clickedGridZ = bUnderCursor.gridZ;
      } else {
        clickedTargetType = 'GROUND';
        clickedGridX = Math.floor(bUnderCursor.worldCenter.x);
        clickedGridZ = Math.floor(bUnderCursor.worldCenter.z);
      }
    } else {
      // 2. Recursos naturais sob o cursor
      const gold = getGoldMineUnderCursor(clientX, clientY);
      const stone = getStoneMineUnderCursor(clientX, clientY);
      const bush = getBerryBushUnderCursor(clientX, clientY);
      const tree = getTreeUnderCursor(clientX, clientY);

      if (gold) {
        clickedTargetType = 'RESOURCE';
        clickedEntityId = gold.key;
        resType = 'GOLD';
        clickedGridX = gold.gridX;
        clickedGridZ = gold.gridZ;
      } else if (stone) {
        clickedTargetType = 'RESOURCE';
        clickedEntityId = stone.key;
        resType = 'STONE';
        clickedGridX = stone.gridX;
        clickedGridZ = stone.gridZ;
      } else if (bush) {
        clickedTargetType = 'RESOURCE';
        clickedEntityId = bush.key;
        resType = 'FOOD';
        clickedGridX = bush.gridX;
        clickedGridZ = bush.gridZ;
      } else if (tree) {
        clickedTargetType = 'RESOURCE';
        clickedEntityId = tree.key;
        resType = 'WOOD';
        clickedGridX = tree.gridX;
        clickedGridZ = tree.gridZ;
      } else {
        // 3. Chão
        setPointerNDC(clientX, clientY);
        if (!raycaster.ray.intersectPlane(groundPlane, groundIntersect)) return;
        clickedTargetType = 'GROUND';
        clickedGridX = Math.floor(groundIntersect.x);
        clickedGridZ = Math.floor(groundIntersect.z);
      }
    }

    if (!isCellInside(clickedGridX, clickedGridZ)) return;

    const rp: RallyPoint = {
      x: clickedGridX,
      z: clickedGridZ,
      targetType: clickedTargetType,
      targetId: clickedEntityId,
      resourceType: resType
    };

    if (isAlliedTcSelected) {
      townCenterState.rallyPoint = rp;
      updateTownCenterRallyHUD();
    } else if (selectedBuilding) {
      selectedBuilding.rallyPoint = rp;
      updateBuildingRallyHUD(selectedBuilding);
    }

    soundManager.rallyPointSet();
    spawnRallyPointPulse(clickedGridX + 0.5, clickedGridZ + 0.5);

    let desc = `(${clickedGridX}, ${clickedGridZ})`;
    if (clickedTargetType === 'RESOURCE') {
      desc = `Recurso ${resType ? (resType === 'WOOD' ? '🪵' : (resType === 'FOOD' ? '🍖' : (resType === 'GOLD' ? '🪙' : '🪨'))) : ''} (${clickedGridX}, ${clickedGridZ})`;
    } else if (clickedTargetType === 'BUILDING') {
      desc = `Canteiro de Obras 🔨 (${clickedGridX}, ${clickedGridZ})`;
    }
    spawnFloatingText(new THREE.Vector3(clickedGridX + 0.5, 1.4, clickedGridZ + 0.5), `🚩 Ponto de Encontro: ${desc}`, '#38bdf8');
    updateRallyPointVisuals();
    return;
  }

  if (selected.length > 0) {
    soundManager.orderMove();
  }

  // 0. Verifica se clicou em um soldado inimigo
  const enemy = getEnemyUnderCursor(clientX, clientY);
  if (enemy) {
    spawnMoveMarker(enemy.group.position.x, enemy.group.position.z, 0xef4444);
    if (selected.length > 0) {
      console.log(`[RTS Combate] ${selected.length} unidade(s) atacando soldado inimigo!`);
      selected.forEach((u) => commandAttack(u, enemy));
      return;
    }
  }

  // 0.5. Verifica se clicou no Centro da Cidade Inimigo
  if (isEnemyTentUnderCursor(clientX, clientY)) {
    spawnMoveMarker(enemyCampCoord.x + 1.5, enemyCampCoord.z + 1.5, 0xef4444);
    if (selected.length > 0) {
      console.log(`[RTS Combate] ${selected.length} unidade(s) atacando o Centro da Cidade Inimigo!`);
      selected.forEach((u) => commandAttackTent(u));
      return;
    }
  }

  // 0.8. Verifica se clicou no Centro da Cidade Aliado
  if (isTownCenterUnderCursor(clientX, clientY)) {
    const villagers = selected.filter((u) => u.unitType === 'VILLAGER');
    if (isTownCenterDamaged()) {
      if (villagers.length > 0) {
        spawnMoveMarker(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z, 0x22c55e);
        console.log(`[RTS Reparo] ${villagers.length} aldeão(ões) enviados para reparar o Centro da Cidade.`);
        villagers.forEach((v) => commandRepairTownCenter(v));
        return;
      }
    } else {
      const carryingVillagers = villagers.filter((v) => v.carrying > 0);
      if (carryingVillagers.length > 0) {
        carryingVillagers.forEach((v) => commandReturnToBase(v));
        spawnMoveMarker(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z, 0x22c55e);
        return;
      }
    }
  }

  // 1. Verifica se clicou em uma construção
  const building = getBuildingUnderCursor(clientX, clientY);
  if (building) {
    if (building.faction === 'ENEMY') {
      spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0xef4444);
      if (selected.length > 0) {
        console.log(`[RTS Combate] ${selected.length} unidade(s) atacando estrutura inimiga (${building.type})!`);
        selected.forEach((u) => commandAttackBuilding(u, building));
        return;
      }
    } else if (!building.isCompleted) {
      spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0xf59e0b);
      if (selected.length > 0) {
        const villagers = selected.filter((u) => u.unitType === 'VILLAGER');
        const soldiers = selected.filter((u) => u.unitType !== 'VILLAGER');

        if (villagers.length > 0) {
          console.log(`[RTS Construção] ${villagers.length} aldeão(ões) enviados para construir a obra.`);
          villagers.forEach((u) => commandBuild(u, building));
        }

        if (soldiers.length > 0) {
          console.log(`[RTS Escolta] ${soldiers.length} combatente(s) escoltando a construção.`);
          const buildingCell = new THREE.Vector2(building.gridX, building.gridZ);
          soldiers.forEach((u) => {
            const escortCell = findClosestWalkableCell(buildingCell, unitCell(u));
            commandMove(u, escortCell);
          });
        }
        return;
      }
    } else {
      // Edifício aliado concluído e danificado: Aldeões entram no modo de reparo
      ensureBuildingHp(building);
      if (building.faction === 'PLAYER' && (building.hp ?? 0) < (building.maxHp ?? 1)) {
        const villagers = selected.filter((u) => u.unitType === 'VILLAGER');
        if (villagers.length > 0) {
          spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x22c55e);
          console.log(`[RTS Reparo] ${villagers.length} aldeão(ões) enviados para reparar ${building.type}.`);
          villagers.forEach((v) => commandRepairBuilding(v, building));
          return;
        }
      }
      if (building.type === 'FARM') {
        if (building.isDepleted) {
          if (resources.wood >= FARM_COST_WOOD) {
            reseedFarm(building);
            const villager = selected.find((u) => u.unitType === 'VILLAGER');
            if (villager) {
              commandFarm(villager, building);
              spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x22c55e);
            }
          } else {
            spawnFloatingText(building.worldCenter.clone().setY(1.4), `⚠️ Esgotada! Requer ${FARM_COST_WOOD} 🪵 para renovar`, '#f87171');
            spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0xef4444);
          }
          return;
        }

        const villager = selected.find((u) => u.unitType === 'VILLAGER');
        if (villager) {
          spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x22c55e);
          commandFarm(villager, building);
          spawnFloatingText(villager.group.position.clone().setY(1.6), '👨‍🌾 Agricultor Designado', '#4ade80');
          console.log(`[RTS Fazenda] Aldeão designado como agricultor na Fazenda (${building.gridX}, ${building.gridZ}).`);
          return;
        }
      }

      if (building.type === 'SCHOOL') {
        const villagers = selected.filter((u) => u.unitType === 'VILLAGER' && !u.isGarrisoned);
        if (villagers.length > 0) {
          let enrolledCount = 0;
          for (const v of villagers) {
            if (v.educationLevel >= 1) {
              spawnFloatingText(v.group.position.clone().setY(1.8), 'Já é Graduado! 🎓', '#38bdf8');
              continue;
            }
            const currentEnrolled = building.enrolledStudents ? building.enrolledStudents.length : 0;
            const headingCount = unitsList.filter(
              (u) => u.state === 'MOVING_TO_SCHOOL' && u.targetSchool === building
            ).length;
            if (currentEnrolled + headingCount >= (building.maxStudents || SCHOOL_MAX_STUDENTS)) {
              spawnFloatingText(building.worldCenter.clone().setY(2.2), 'Escola Lotada! (3/3) 🏫', '#f59e0b');
              break;
            }
            commandEnrollInSchool(v, building);
            spawnFloatingText(v.group.position.clone().setY(1.8), 'Indo Estudar... 🎒', '#a78bfa');
            enrolledCount++;
          }
          if (enrolledCount > 0) {
            spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x38bdf8);
            return;
          }
        }
      }

      if (building.type === 'COLLEGE') {
        const villagers = selected.filter((u) => u.unitType === 'VILLAGER' && !u.isGarrisoned);
        if (villagers.length > 0) {
          let enrolledCount = 0;
          for (const v of villagers) {
            // Requisito estrito: aceita APENAS aldeões de nível 1 (Cidadão Instruído da Escola)
            if (v.educationLevel === 0) {
              soundManager.popCappedAlert();
              spawnFloatingText(v.group.position.clone().setY(1.8), '⚠️ Requer Ensino Básico (Escola)!', '#ef4444');
              continue;
            }
            if (v.educationLevel >= 2) {
              spawnFloatingText(v.group.position.clone().setY(1.8), '🌟 Já é Especialista de Elite!', '#facc15');
              continue;
            }

            const currentEnrolled = building.enrolledStudents ? building.enrolledStudents.length : 0;
            const headingCount = unitsList.filter(
              (u) => u.state === 'MOVING_TO_COLLEGE' && u.targetCollege === building
            ).length;
            if (currentEnrolled + headingCount >= (building.maxStudents || COLLEGE_MAX_STUDENTS)) {
              spawnFloatingText(building.worldCenter.clone().setY(2.6), 'Faculdade Lotada! (3/3) 🏛️', '#f59e0b');
              break;
            }
            commandEnrollInCollege(v, building);
            spawnFloatingText(v.group.position.clone().setY(1.8), 'Indo para Faculdade... 📜', '#facc15');
            enrolledCount++;
          }
          if (enrolledCount > 0) {
            spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0xfacc15);
            return;
          }
        }
      }

      // Se clicou em Madeireira, Mina ou Moinho com aldeões da mesma facção carregando recursos compatíveis
      let sentToDropoff = false;
      selected.forEach((u) => {
        if (u.unitType === 'VILLAGER' && u.carrying > 0 && u.faction === building.faction) {
          if (
            (building.type === 'LUMBER_CAMP' && u.carriedResourceType === 'WOOD') ||
            (building.type === 'MINING_CAMP' && (u.carriedResourceType === 'STONE' || u.carriedResourceType === 'GOLD')) ||
            (building.type === 'MILL' && u.carriedResourceType === 'FOOD')
          ) {
            commandReturnToBase(u);
            sentToDropoff = true;
          }
        }
      });
      if (sentToDropoff) {
        spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x22c55e);
        return;
      }
      spawnMoveMarker(building.worldCenter.x, building.worldCenter.z, 0x38bdf8);
      return;
    }
  }

  // 1.45. Verifica se clicou em uma mina de ouro
  const goldMine = getGoldMineUnderCursor(clientX, clientY);
  if (goldMine) {
    spawnMoveMarker(goldMine.gridX + 0.5, goldMine.gridZ + 0.5, 0xfacc15);
    if (selected.length === 0) return;
    console.log(`[RTS Garimpo] ${selected.length} aldeão(ões) enviados à mina de ouro (${goldMine.gridX}, ${goldMine.gridZ}).`);
    selected.forEach((u) => commandMineGold(u, goldMine));
    return;
  }

  // 1.5. Verifica se clicou em uma jazida de pedra
  const stoneMine = getStoneMineUnderCursor(clientX, clientY);
  if (stoneMine) {
    spawnMoveMarker(stoneMine.gridX + 0.5, stoneMine.gridZ + 0.5, 0x94a3b8);
    if (selected.length === 0) return;
    console.log(`[RTS Mineração] ${selected.length} aldeão(ões) enviados à jazida de pedra (${stoneMine.gridX}, ${stoneMine.gridZ}).`);
    selected.forEach((u) => commandMine(u, stoneMine));
    return;
  }

  // 1.6. Verifica se clicou em um arbusto de frutas
  const bush = getBerryBushUnderCursor(clientX, clientY);
  if (bush) {
    spawnMoveMarker(bush.gridX + 0.5, bush.gridZ + 0.5, 0xdc2626);
    if (selected.length === 0) return;
    console.log(`[RTS Forrageamento] ${selected.length} aldeão(ões) enviados ao arbusto de frutas (${bush.gridX}, ${bush.gridZ}).`);
    selected.forEach((u) => commandForage(u, bush));
    return;
  }

  // 2. Verifica se clicou em uma árvore
  const tree = getTreeUnderCursor(clientX, clientY);
  if (tree) {
    spawnMoveMarker(tree.gridX + 0.5, tree.gridZ + 0.5, 0xfbbf24);
    if (selected.length === 0) return;
    console.log(`[RTS Coleta] ${selected.length} aldeão(ões) enviados à árvore (${tree.gridX}, ${tree.gridZ}).`);
    selected.forEach((u) => commandGather(u, tree));
    return;
  }

  // 3. Clique em chão: movimentação via A*
  setPointerNDC(clientX, clientY);
  if (!raycaster.ray.intersectPlane(groundPlane, groundIntersect)) return;

  spawnMoveMarker(groundIntersect.x, groundIntersect.z);
  if (selected.length === 0) return;

  const target = new THREE.Vector2(Math.floor(groundIntersect.x), Math.floor(groundIntersect.z));
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

  selected.forEach((unit, index) => {
    let unitTarget = target.clone();
    if (index > 0) {
      const o = offsets[index % offsets.length];
      const candidate = new THREE.Vector2(target.x + o[0], target.y + o[1]);
      if (isCellWalkable(candidate.x, candidate.y)) unitTarget = candidate;
    }
    commandMove(unit, unitTarget);
  });
}

let pointerDownPos = { x: 0, y: 0 };
let pointerDownTime = 0;
let lastTouchTapTime = 0;
const TOUCH_DRAG_THRESHOLD = 14;

window.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
  pointerDownTime = performance.now();

  if (e.pointerType === 'touch') return;
  if ((e.target as HTMLElement).closest('.ui-overlay') || (e.target as HTMLElement).closest('.match-config-modal')) return;
  if ((isGameOver || isMatchConfigModalOpen) && e.button !== 1) return;

  if (e.button === 0) {
    // Clique esquerdo
    if (isPlacementMode) {
      if (currentPlacementType === 'WALL') {
        const cell = raycastGridCell(e.clientX, e.clientY);
        if (cell && cell.isInside) {
          isDraggingWall = true;
          wallDragStart = { x: cell.gridX, z: cell.gridZ };
          ghostWallGroup.visible = false;
          updateWallDrag(cell.gridX, cell.gridZ, e.clientX, e.clientY);
        }
        return;
      }

      // Revalida as coordenadas sob o cursor no momento exato do clique
      const clickCell = raycastGridCell(e.clientX, e.clientY);
      if (clickCell && clickCell.isInside) {
        ghostGridX = clickCell.gridX;
        ghostGridZ = clickCell.gridZ;
      }

      if (!isValidBuildingPlacement(ghostGridX, ghostGridZ, currentPlacementType)) {
        soundManager.popCappedAlert();
        spawnFloatingText(new THREE.Vector3(ghostGridX + 0.5, 2.0, ghostGridZ + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
        return;
      }

      if (currentPlacementType === 'GATE') {
        placeGate(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'TOWER') {
        placeTower(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'LUMBER_CAMP') {
        placeLumberCamp(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'MINING_CAMP') {
        placeMiningCamp(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'HOUSE') {
        placeHouse(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'MILL') {
        placeMill(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'FARM') {
        placeFarm(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'SCHOOL') {
        placeSchool(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'COLLEGE') {
        placeCollege(ghostGridX, ghostGridZ, e.shiftKey);
      } else if (currentPlacementType === 'ARCHERY_RANGE') {
        placeArcheryRange(ghostGridX, ghostGridZ, e.shiftKey);
      } else {
        placeBarracks(ghostGridX, ghostGridZ, e.shiftKey);
      }
      return;
    }

    isLeftMouseDown = true;
    isLeftDragging = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  } else if (e.button === 1) {
    e.preventDefault();
    isMiddleDragging = true;
    lastMousePos = { x: e.clientX, y: e.clientY };
    document.body.style.cursor = 'grabbing';
  } else if (e.button === 2) {
    e.preventDefault();
    handleRightClick(e.clientX, e.clientY);
  }
});

window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;
  isMouseInsideWindow = true;

  if (isMatchConfigModalOpen) return;

  if (isMiddleDragging) {
    const deltaX = e.clientX - lastMousePos.x;
    const deltaY = e.clientY - lastMousePos.y;
    lastMousePos = { x: e.clientX, y: e.clientY };

    const worldUnitsPerPixel = frustumSize / window.innerHeight;
    targetDesired.addScaledVector(RIGHT_GROUND, -deltaX * worldUnitsPerPixel);
    targetDesired.addScaledVector(UP_GROUND, deltaY * worldUnitsPerPixel * 1.225);
    clampCameraTarget(targetDesired);
    return;
  }

  if (isPlacementMode && isDraggingWall && wallDragStart) {
    const cell = raycastGridCell(e.clientX, e.clientY);
    if (cell && cell.isInside) {
      updateWallDrag(cell.gridX, cell.gridZ, e.clientX, e.clientY);
    }
    return;
  }

  if (isLeftMouseDown && !isPlacementMode && Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > 10) {
    isLeftDragging = true;
    const minX = Math.min(dragStartX, e.clientX);
    const minY = Math.min(dragStartY, e.clientY);
    selectionBoxEl.style.left = `${minX}px`;
    selectionBoxEl.style.top = `${minY}px`;
    selectionBoxEl.style.width = `${Math.abs(e.clientX - dragStartX)}px`;
    selectionBoxEl.style.height = `${Math.abs(e.clientY - dragStartY)}px`;
    selectionBoxEl.style.display = 'block';
  }

  if (!isLeftDragging) updateHoverMarker(e.clientX, e.clientY);
});

window.addEventListener('pointerup', (e) => {
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  const distSq = dx * dx + dy * dy;
  const elapsedTime = performance.now() - pointerDownTime;
  const isTap = distSq < (TOUCH_DRAG_THRESHOLD * TOUCH_DRAG_THRESHOLD) && elapsedTime < 350;

  if (e.pointerType === 'touch') {
    // Fallback para navegadores que emitem apenas PointerEvents (sem TouchEvents)
    if (isTap && (performance.now() - lastTouchTapTime > 350)) {
      lastTouchTapTime = performance.now();
      handleQuickTap(e.clientX, e.clientY);
    }
    return;
  }
  if (e.button === 0 && isPlacementMode && isDraggingWall) {
    finishWallDrag(e.shiftKey);
    return;
  }

  if (e.button === 0 && isLeftMouseDown && !isPlacementMode) {
    isLeftMouseDown = false;

    if (isLeftDragging) {
      isLeftDragging = false;
      selectionBoxEl.style.display = 'none';

      const minX = Math.min(dragStartX, e.clientX);
      const maxX = Math.max(dragStartX, e.clientX);
      const minY = Math.min(dragStartY, e.clientY);
      const maxY = Math.max(dragStartY, e.clientY);

      if (!e.shiftKey) {
        deselectAllUnits();
        deselectBuilding();
        deselectTownCenter();
      }

      for (const unit of unitsList) {
        if (unit.faction === 'PLAYER' && !unit.isDying && !unit.isGarrisoned) {
          const proj = unit.group.position.clone().project(camera);
          const sx = ((proj.x + 1) / 2) * window.innerWidth;
          const sy = ((-proj.y + 1) / 2) * window.innerHeight;
          if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
            deselectTownCenter();
            selectUnit(unit);
          }
        }
      }
      updateUnitHUD();
    } else {
      selectionBoxEl.style.display = 'none';
      const clicked = findUnitUnderPointer(e.clientX, e.clientY);

      if (clicked) {
        deselectBuilding();
        deselectTownCenter();
        if (clicked.faction === 'PLAYER') {
          if (e.shiftKey) {
            if (clicked.isSelected) deselectUnit(clicked);
            else selectUnit(clicked);
          } else {
            selectSingleUnit(clicked);
          }
        }
      } else {
        // Permite selecionar edifícios concluídos com o botão esquerdo (Quartel, Fazenda, Moinho, etc.)
        const building = getBuildingUnderCursor(e.clientX, e.clientY);
        if (building && building.isCompleted) {
          deselectTownCenter();
          selectBuilding(building);
        } else if (isTownCenterUnderCursor(e.clientX, e.clientY)) {
          // Permite selecionar o Town Center com o botão esquerdo
          deselectBuilding();
          deselectAllUnits();
          selectTownCenter();
        } else {
          if (!e.shiftKey) {
            deselectAllUnits();
            deselectBuilding();
            deselectTownCenter();
          }
        }
      }
    }
  }

  if (e.button === 1) {
    isMiddleDragging = false;
    document.body.style.cursor = 'default';
  }
});

// ========================================================
// SISTEMA DE ENTRADA TOUCH & GESTOS DE CÂMERA (MOBILE RTS)
// ========================================================
let touchStartTime = 0;
let touchStartX = 0;
let touchStartY = 0;
let touchLastX = 0;
let touchLastY = 0;
let touchMovedDistance = 0;
let isTouchPanning = false;
let isTouchLongPress = false;
let isTouchBoxSelecting = false;
let touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;

let touchInertiaActive = false;
let touchVelocityX = 0;
let touchVelocityY = 0;
let lastTouchMoveTime = 0;

let isPinchZooming = false;
let lastPinchDist = 0;

function getTouchesDistance(t1: Touch, t2: Touch): number {
  const dx = t2.clientX - t1.clientX;
  const dy = t2.clientY - t1.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function handleQuickTap(clientX: number, clientY: number): void {
  if (isGameOver || isMatchConfigModalOpen) return;

  // 1. Placement Mode: tocar para posicionar edifício ou muro
  if (isPlacementMode) {
    if (currentPlacementType === 'WALL') {
      const cell = raycastGridCell(clientX, clientY);
      if (cell && cell.isInside) {
        if (!isDraggingWall) {
          isDraggingWall = true;
          wallDragStart = { x: cell.gridX, z: cell.gridZ };
          ghostWallGroup.visible = false;
          updateWallDrag(cell.gridX, cell.gridZ, clientX, clientY);
        } else {
          finishWallDrag(false);
        }
      }
      return;
    }

    const cell = raycastGridCell(clientX, clientY);
    if (cell && cell.isInside) {
      ghostGridX = cell.gridX;
      ghostGridZ = cell.gridZ;
      updateHoverMarker(clientX, clientY);
      if (!isValidBuildingPlacement(ghostGridX, ghostGridZ, currentPlacementType)) {
        soundManager.popCappedAlert();
        spawnFloatingText(new THREE.Vector3(ghostGridX + 0.5, 2.0, ghostGridZ + 0.5), '⚠️ Terreno ocupado ou obstruído!', '#ef4444');
        return;
      }
      if (currentPlacementType === 'GATE') placeGate(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'TOWER') placeTower(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'LUMBER_CAMP') placeLumberCamp(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'MINING_CAMP') placeMiningCamp(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'HOUSE') placeHouse(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'MILL') placeMill(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'FARM') placeFarm(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'SCHOOL') placeSchool(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'COLLEGE') placeCollege(ghostGridX, ghostGridZ, false);
      else if (currentPlacementType === 'ARCHERY_RANGE') placeArcheryRange(ghostGridX, ghostGridZ, false);
      else placeBarracks(ghostGridX, ghostGridZ, false);
    }
    return;
  }

  // 2. Unidades aliadas selecionadas atualmente
  const selected = getSelectedUnits().filter((u) => u.faction === 'PLAYER');

  // 3. PRIORIDADE 1: Seleção de Unidade (Aldeão ou Soldado) com Proximity Hit-Test de 0.85 células
  const clickedUnit = findUnitUnderPointer(clientX, clientY);
  if (clickedUnit) {
    if (clickedUnit.faction === 'PLAYER') {
      // Aldeão ou soldado aliado: sempre seleciona a unidade tocada imediatamente!
      deselectBuilding();
      deselectTownCenter();
      selectSingleUnit(clickedUnit);
      soundManager.uiClick();
      if (navigator.vibrate) try { navigator.vibrate(25); } catch (_) {}
      updateDeselectButtonVisibility();
      return;
    } else {
      // Unidade inimiga: se houver tropas aliadas selecionadas, emite ordem de ataque (Right-Click)
      if (selected.length > 0) {
        handleRightClick(clientX, clientY);
        return;
      } else {
        // Sem tropas selecionadas: seleciona a unidade inimiga para visualização no card
        deselectBuilding();
        deselectTownCenter();
        selectSingleUnit(clickedUnit);
        soundManager.uiClick();
        if (navigator.vibrate) try { navigator.vibrate(20); } catch (_) {}
        updateDeselectButtonVisibility();
        return;
      }
    }
  }

  // 4. PRIORIDADE 2: Centro da Cidade Aliado sob o toque (quando NÃO há unidade tocada)
  if (isTownCenterUnderCursor(clientX, clientY)) {
    // Exceção (Ação Intencional de Aldeões): se danificado E em DIRECT_ORDER com aldeões selecionados
    if (mobileActionMode === 'DIRECT_ORDER' && selected.length > 0 && isTownCenterDamaged() && selected.some((u) => u.unitType === 'VILLAGER')) {
      handleRightClick(clientX, clientY);
      return;
    }
    // Caso contrário: SEMPRE desmarca unidades anteriores e seleciona o Centro da Cidade
    deselectAllUnits();
    deselectBuilding();
    selectTownCenter();
    soundManager.uiClick();
    updateDeselectButtonVisibility();
    return;
  }

  // 5. PRIORIDADE 3: Edifício Aliado sob o toque (Quartel, Estábulo, Escola, Faculdade, Fazenda, etc.)
  const building = getBuildingUnderCursor(clientX, clientY);
  if (building) {
    const isAllied = building.faction === 'PLAYER' || (building as any).faction === 'ALLIED' || !building.isEnemy;
    const isCompleted = building.isCompleted && (building.progress === undefined || building.progress >= 100);

    if (isAllied && isCompleted) {
      ensureBuildingHp(building);
      const isDamaged = (building.hp ?? 0) < (building.maxHp ?? 1);
      // Exceção (Ação Intencional de Aldeões): apenas se danificado E explicitamente em DIRECT_ORDER com aldeões
      if (mobileActionMode === 'DIRECT_ORDER' && selected.length > 0 && isDamaged && selected.some((u) => u.unitType === 'VILLAGER')) {
        handleRightClick(clientX, clientY);
        return;
      }
      // Prioridade de Seleção: SEMPRE desmarca unidades anteriores e seleciona o edifício imediatamente
      deselectAllUnits();
      deselectTownCenter();
      selectBuilding(building);
      soundManager.uiClick();
      updateDeselectButtonVisibility();
      return;
    } else if (isAllied && !isCompleted) {
      // Canteiro em obras: se houver aldeões selecionados, eles constroem
      if (selected.length > 0 && selected.some((u) => u.unitType === 'VILLAGER')) {
        handleRightClick(clientX, clientY);
        return;
      }
      deselectAllUnits();
      deselectTownCenter();
      selectBuilding(building);
      soundManager.uiClick();
      updateDeselectButtonVisibility();
      return;
    } else if (!isAllied) {
      // Edifício inimigo: ataca se houver tropas
      if (selected.length > 0) {
        handleRightClick(clientX, clientY);
        return;
      }
    }
  }

  // 6. Alvos Táticos sob o cursor (recursos naturais e inimigos)
  const enemy = getEnemyUnderCursor(clientX, clientY);
  const isEnemyTent = isEnemyTentUnderCursor(clientX, clientY);
  const gold = getGoldMineUnderCursor(clientX, clientY);
  const stone = getStoneMineUnderCursor(clientX, clientY);
  const bush = getBerryBushUnderCursor(clientX, clientY);
  const tree = getTreeUnderCursor(clientX, clientY);
  const isResource = !!(gold || stone || bush || tree);
  const isEnemyTarget = !!(enemy || isEnemyTent);

  // Modo Comando / Ordem Direta: com unidades selecionadas, direciona ação ao alvo ou movimento no chão
  if (mobileActionMode === 'DIRECT_ORDER' && selected.length > 0) {
    handleRightClick(clientX, clientY);
    return;
  }

  // Modo Seleção com unidades selecionadas:
  // Se tocou intencionalmente em recurso ou inimigo, executa a ordem correspondente
  if (selected.length > 0 && (isResource || isEnemyTarget)) {
    handleRightClick(clientX, clientY);
    return;
  }

  // 7. Toque no Vazio / Chão do Mapa:
  // Se o ponto tocado não for recurso nem inimigo nem unidade nem edifício:
  // Limpa a seleção de unidades e edifícios, liberando o estado para novas seleções sem travas
  deselectAllUnits();
  deselectBuilding();
  deselectTownCenter();
  updateDeselectButtonVisibility();
}

window.addEventListener('touchstart', (e: TouchEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.ui-overlay, .match-config-modal, .pause-menu-modal, .game-over-modal, .mobile-tactical-controls, .popover-balloon')) {
    return;
  }
  if (isGameOver || isMatchConfigModalOpen) return;

  touchInertiaActive = false;
  touchVelocityX = 0;
  touchVelocityY = 0;

  if (e.touches.length === 1) {
    const t = e.touches[0];
    touchStartTime = performance.now();
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchLastX = t.clientX;
    touchLastY = t.clientY;
    touchMovedDistance = 0;
    isTouchPanning = false;
    isTouchLongPress = false;
    isTouchBoxSelecting = false;
    lastTouchMoveTime = touchStartTime;

    const TOUCH_DRAG_THRESHOLD = 14;

    if (touchLongPressTimer) clearTimeout(touchLongPressTimer);
    touchLongPressTimer = setTimeout(() => {
      if (touchMovedDistance < TOUCH_DRAG_THRESHOLD && !isPlacementMode) {
        isTouchLongPress = true;
        isTouchBoxSelecting = true;
        if (navigator.vibrate) {
          try { navigator.vibrate(35); } catch (_) {}
        }
        selectionBoxEl.style.left = `${touchStartX}px`;
        selectionBoxEl.style.top = `${touchStartY}px`;
        selectionBoxEl.style.width = '0px';
        selectionBoxEl.style.height = '0px';
        selectionBoxEl.style.display = 'block';
        spawnFloatingText(new THREE.Vector3(cameraTarget.x, 2.5, cameraTarget.z), '📦 Modo Seleção em Caixa', '#38bdf8');
      }
    }, 450);

  } else if (e.touches.length === 2) {
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
    isTouchBoxSelecting = false;
    selectionBoxEl.style.display = 'none';
    isPinchZooming = true;
    lastPinchDist = getTouchesDistance(e.touches[0], e.touches[1]);
    e.preventDefault();
  }
}, { passive: false });

window.addEventListener('touchmove', (e: TouchEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.ui-overlay, .match-config-modal, .pause-menu-modal, .mobile-tactical-controls')) {
    return;
  }
  if (isGameOver || isMatchConfigModalOpen) return;

  const TOUCH_DRAG_THRESHOLD = 14;

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - touchLastX;
    const dy = t.clientY - touchLastY;
    const totalDist = Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY);
    touchMovedDistance = Math.max(touchMovedDistance, totalDist);

    if (totalDist >= TOUCH_DRAG_THRESHOLD && !isTouchLongPress && touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }

    if (isTouchBoxSelecting) {
      e.preventDefault();
      const minX = Math.min(touchStartX, t.clientX);
      const minY = Math.min(touchStartY, t.clientY);
      const w = Math.abs(t.clientX - touchStartX);
      const h = Math.abs(t.clientY - touchStartY);
      selectionBoxEl.style.left = `${minX}px`;
      selectionBoxEl.style.top = `${minY}px`;
      selectionBoxEl.style.width = `${w}px`;
      selectionBoxEl.style.height = `${h}px`;
      selectionBoxEl.style.display = 'block';
      return;
    }

    if (!isTouchBoxSelecting) {
      // Só ativa arrasto e pan da câmera se o movimento exceder a tolerância de toque (deadzone de 14px)
      if (totalDist >= TOUCH_DRAG_THRESHOLD) {
        e.preventDefault();
        isTouchPanning = true;
        const worldUnitsPerPixel = frustumSize / window.innerHeight;
        targetDesired.addScaledVector(RIGHT_GROUND, -dx * worldUnitsPerPixel);
        targetDesired.addScaledVector(UP_GROUND, dy * worldUnitsPerPixel * 1.225);
        clampCameraTarget(targetDesired);

        const now = performance.now();
        const dt = Math.max(1, now - lastTouchMoveTime);
        touchVelocityX = (dx / dt) * 16.6;
        touchVelocityY = (dy / dt) * 16.6;
        lastTouchMoveTime = now;
      }

      touchLastX = t.clientX;
      touchLastY = t.clientY;
    }

  } else if (e.touches.length === 2 && isPinchZooming) {
    e.preventDefault();
    const currentDist = getTouchesDistance(e.touches[0], e.touches[1]);
    if (currentDist > 10 && lastPinchDist > 10) {
      const deltaDist = currentDist - lastPinchDist;
      const zoomFactor = 1 - (deltaDist / 280);
      targetFrustumSize = THREE.MathUtils.clamp(targetFrustumSize * zoomFactor, MIN_FRUSTUM, MAX_FRUSTUM);
      lastPinchDist = currentDist;
    }
  }
}, { passive: false });

window.addEventListener('touchend', (e: TouchEvent) => {
  if (touchLongPressTimer) {
    clearTimeout(touchLongPressTimer);
    touchLongPressTimer = null;
  }

  if (isPinchZooming && e.touches.length < 2) {
    isPinchZooming = false;
    return;
  }

  if (isTouchBoxSelecting) {
    isTouchBoxSelecting = false;
    selectionBoxEl.style.display = 'none';

    const minX = Math.min(touchStartX, touchLastX);
    const maxX = Math.max(touchStartX, touchLastX);
    const minY = Math.min(touchStartY, touchLastY);
    const maxY = Math.max(touchStartY, touchLastY);

    if (Math.abs(maxX - minX) > 10 || Math.abs(maxY - minY) > 10) {
      deselectAllUnits();
      deselectBuilding();
      deselectTownCenter();

      let selectedCount = 0;
      for (const unit of unitsList) {
        if (unit.faction === 'PLAYER' && !unit.isDying && !unit.isGarrisoned) {
          const proj = unit.group.position.clone().project(camera);
          const sx = ((proj.x + 1) / 2) * window.innerWidth;
          const sy = ((-proj.y + 1) / 2) * window.innerHeight;
          if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
            deselectTownCenter();
            selectUnit(unit);
            selectedCount++;
          }
        }
      }
      if (selectedCount > 0) {
        soundManager.uiClick();
        if (navigator.vibrate) try { navigator.vibrate(20); } catch (_) {}
      }
      updateUnitHUD();
    }
    return;
  }

  const duration = performance.now() - touchStartTime;
  const dx = touchLastX - touchStartX;
  const dy = touchLastY - touchStartY;
  const distSq = dx * dx + dy * dy;
  const TOUCH_DRAG_THRESHOLD = 14;

  // Se moveu menos que TOUCH_DRAG_THRESHOLD (14px) e demorou menos de 350ms, É UM TOQUE INTENCIONAL (TAP/CLIQUE)
  const isTap = touchMovedDistance < TOUCH_DRAG_THRESHOLD && distSq < (TOUCH_DRAG_THRESHOLD * TOUCH_DRAG_THRESHOLD) && duration < 350;

  if (isTap) {
    isTouchPanning = false;
    touchInertiaActive = false;
    touchVelocityX = 0;
    touchVelocityY = 0;
    lastTouchTapTime = performance.now();
    handleQuickTap(touchStartX, touchStartY);
    return;
  }

  if (isTouchPanning && touchMovedDistance >= TOUCH_DRAG_THRESHOLD) {
    isTouchPanning = false;
    if (Math.hypot(touchVelocityX, touchVelocityY) > 0.5) {
      touchInertiaActive = true;
    }
    return;
  }
});

window.addEventListener('touchcancel', () => {
  if (touchLongPressTimer) {
    clearTimeout(touchLongPressTimer);
    touchLongPressTimer = null;
  }
  isTouchPanning = false;
  isTouchBoxSelecting = false;
  isPinchZooming = false;
  selectionBoxEl.style.display = 'none';
});

window.addEventListener('mouseleave', () => {
  isMouseInsideWindow = false;
  isMiddleDragging = false;
  isLeftMouseDown = false;
  isLeftDragging = false;
  cancelWallDrag();
  selectionBoxEl.style.display = 'none';
  markerGroup.visible = false;
  if (isPlacementMode) ghostGroup.visible = false;
  document.body.style.cursor = 'default';
  clearEdgeIndicators();
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  targetFrustumSize = THREE.MathUtils.clamp(targetFrustumSize * (1 + e.deltaY * 0.0015), MIN_FRUSTUM, MAX_FRUSTUM);
}, { passive: false });

btnResetCam?.addEventListener('click', (e) => {
  e.stopPropagation();
  targetDesired.set(TC_WORLD_CENTER.x, 0, TC_WORLD_CENTER.z);
  targetFrustumSize = 28;
});

function clearEdgeIndicators() {
  edgeTopEl?.classList.remove('active');
  edgeBottomEl?.classList.remove('active');
  edgeLeftEl?.classList.remove('active');
  edgeRightEl?.classList.remove('active');
}

/** Limita o pan da câmera aos limites do tabuleiro atual (a visão não se perde fora do mapa). */
function clampCameraTarget(vec: THREE.Vector3) {
  vec.x = THREE.MathUtils.clamp(vec.x, MAP_MIN, MAP_MAX + 1);
  vec.z = THREE.MathUtils.clamp(vec.z, MAP_MIN, MAP_MAX + 1);
}

// --- 16. ACAMPAMENTO INIMIGO (NORDESTE) COM 200 HP ---
export interface EnemyCampState {
  group: THREE.Group;
  faction: UnitFaction;
  isEnemy: boolean;
  tentMesh: THREE.Mesh;
  flagMesh: THREE.Mesh;
  poleMesh: THREE.Mesh;
  fireGroup: THREE.Group;
  tentHp: number;
  tentMaxHp: number;
  isTentDestroyed: boolean;
  hpBarGroup: THREE.Group;
  hpBarFillMesh: THREE.Mesh;
  ruinsGroup: THREE.Group | null;
}

let enemyCampGroup: THREE.Group | null = null;
export let enemyTownCenterState: TownCenterState | null = null;

/** Encontra um local válido e desobstruído para uma nova obra ao redor do Town Center Inimigo */
function findFreeEnemyBuildingSite(
  tcX: number,
  tcZ: number,
  size: number,
  minRadius: number,
  maxRadius: number
): { x: number; z: number } | null {
  const attempts: { x: number; z: number; dist: number }[] = [];

  for (let r = minRadius; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const d = Math.hypot(dx, dz);
        if (d >= minRadius && d <= maxRadius) {
          const gx = tcX + dx;
          const gz = tcZ + dz;
          if (canPlaceEnemyBuildingAt(gx, gz, size)) {
            attempts.push({ x: gx, z: gz, dist: d });
          }
        }
      }
    }
  }

  if (attempts.length === 0) return null;
  attempts.sort((a, b) => a.dist - b.dist);
  const pick = attempts[Math.floor(Math.random() * Math.min(5, attempts.length))];
  return { x: pick.x, z: pick.z };
}

function canPlaceEnemyBuildingAt(gridX: number, gridZ: number, size: number): boolean {
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const cx = gridX + dx;
      const cz = gridZ + dz;
      if (!isCellInside(cx, cz)) return false;
      if (!isCellWalkable(cx, cz)) return false;
      if (treesMap.has(cellKey(cx, cz))) return false;
      if (stoneMinesMap.has(cellKey(cx, cz))) return false;
      if (goldMinesMap.has(cellKey(cx, cz))) return false;
      if (berryBushesMap.has(cellKey(cx, cz))) return false;
      if (buildingsGridMap.has(cellKey(cx, cz))) return false;
    }
  }
  return true;
}

/** Posições iniciais dos 4 aldeões inimigos alinhados na frente do Town Center inimigo */
function getInitialEnemyVillagerSpawns(): [number, number][] {
  const ecX = enemyCampCoord.x;
  const ecZ = enemyCampCoord.z;
  const candidateList: [number, number][] = [
    [ecX + 0, ecZ + 3],
    [ecX + 1, ecZ + 3],
    [ecX + 2, ecZ + 3],
    [ecX + 1, ecZ + 4],
    [ecX - 1, ecZ + 1],
    [ecX + 3, ecZ + 1],
    [ecX + 1, ecZ - 1]
  ];
  const result: [number, number][] = [];
  for (const [x, z] of candidateList) {
    if (isCellInside(x, z) && isCellWalkable(x, z)) {
      result.push([x, z]);
      if (result.length === 4) break;
    }
  }
  while (result.length < 4) {
    const sc = findFreeEnemySpawnCell(ecX, ecZ);
    result.push([sc.x, sc.z]);
  }
  return result;
}

/** 1. SPAWN INICIAL SIMÉTRICO: Instancia o Town Center Inimigo (3x3), estoque real e 4 aldeões */
export function createEnemyTownCenter(baseX: number, baseZ: number): TownCenterState {
  if (enemyCampGroup) {
    scene.remove(enemyCampGroup);
  }

  const elevation = getBuildingPlacementHeight(baseX, baseZ, 3);
  const tcGroup = createTownCenterMeshGroup('ENEMY');
  tcGroup.position.set(baseX + 1.5, elevation, baseZ + 1.5);

  const hpBar = createTownCenterHpBar('ENEMY');
  tcGroup.add(hpBar.group);

  scene.add(tcGroup);
  enemyCampGroup = tcGroup;
  enemyCampGroup.visible = currentMatchConfig.revealWholeMap;
  if (!currentMatchConfig.revealWholeMap) {
    enemyCampGroup.traverse((c: any) => { if (c.isMesh) c.castShadow = false; });
    hpBar.group.visible = false;
  }

  // Bloqueia as 9 células no grid (3x3, walkable = false)
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      setCellWalkable(baseX + dx, baseZ + dz, false);
    }
  }

  const maxHp = currentMatchConfig.townCenterHp;
  enemyTownCenterState = {
    group: tcGroup,
    faction: 'ENEMY',
    isEnemy: true,
    hp: maxHp,
    maxHp: maxHp,
    isDestroyed: false,
    hpBarGroup: hpBar.group,
    hpBarFillMesh: hpBar.fillMesh,
    ruinsGroup: null,
    currentOpacity: 1.0
  };

  const roofMesh = (tcGroup.children.find((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.ConeGeometry) || tcGroup) as THREE.Mesh;
  const flagMesh = (tcGroup.getObjectByName('tc-flag') || tcGroup) as THREE.Mesh;

  enemyCampState = {
    group: tcGroup,
    faction: 'ENEMY',
    isEnemy: true,
    tentMesh: roofMesh,
    flagMesh: flagMesh,
    poleMesh: flagMesh,
    fireGroup: new THREE.Group(),
    get tentHp() { return enemyTownCenterState ? enemyTownCenterState.hp : 0; },
    set tentHp(v: number) { if (enemyTownCenterState) enemyTownCenterState.hp = v; },
    tentMaxHp: maxHp,
    get isTentDestroyed() { return enemyTownCenterState ? enemyTownCenterState.isDestroyed : true; },
    set isTentDestroyed(v: boolean) { if (enemyTownCenterState) enemyTownCenterState.isDestroyed = v; },
    hpBarGroup: hpBar.group,
    hpBarFillMesh: hpBar.fillMesh,
    ruinsGroup: null
  };

  // Estoque e população exclusivo da IA inimiga
  enemyResources.wood = (currentMatchConfig as any).startingWood ?? currentMatchConfig.initialWood ?? 150;
  enemyResources.food = (currentMatchConfig as any).startingFood ?? 0;
  enemyResources.gold = (currentMatchConfig as any).startingGold ?? 0;
  enemyResources.stone = (currentMatchConfig as any).startingStone ?? 0;
  enemyPopCap = 5;
  enemyTcIsTraining = false;
  enemyTcTrainTimer = 0;

  // Spawna exatamente 4 Aldeões Inimigos alinhados na frente do TC inimigo (SEM soldados pré-spawnados)
  const spawns = getInitialEnemyVillagerSpawns();
  for (const [vx, vz] of spawns) {
    createUnit(vx, vz, 'VILLAGER', 'ENEMY');
  }

  console.log(`[RTS IA] Town Center Inimigo (3x3) instanciado em (${baseX}, ${baseZ}) com 4 Aldeões e ${enemyResources.wood} Madeira.`);
  return enemyTownCenterState;
}

export const createEnemyCamp = createEnemyTownCenter;

/** Encontra uma célula livre e caminhável ao redor do Town Center inimigo para spawn seguro de soldados/aldeões */
export function findFreeEnemySpawnCell(campX: number, campZ: number): { x: number; z: number } {
  const candidateOffsets = [
    [-1, -1], [0, -1], [1, -1], [2, -1], [3, -1],
    [3, 0], [3, 1], [3, 2], [3, 3],
    [2, 3], [1, 3], [0, 3], [-1, 3],
    [-1, 2], [-1, 1], [-1, 0],
    [-2, 0], [-2, 1], [-2, 2], [4, 0], [4, 1], [4, 2], [1, 4], [2, 4]
  ];
  for (const [ox, oz] of candidateOffsets) {
    const cx = campX + ox;
    const cz = campZ + oz;
    if (isCellInside(cx, cz) && isCellWalkable(cx, cz)) {
      const isOccupied = unitsList.some(
        (u) => !u.isDying && Math.round(u.group.position.x) === cx && Math.round(u.group.position.z) === cz
      );
      if (!isOccupied) return { x: cx, z: cz };
    }
  }
  return { x: campX - 1, z: campZ + 1 };
}

/** Inicia rotina de trabalho dos 4 aldeões inimigos (priorizando 2 em Alimento e 2 em Madeira) */
export function initEnemyWorkerRoutines(): void {
  const tcCenter = new THREE.Vector3(enemyCampCoord.x + 1.5, 0, enemyCampCoord.z + 1.5);
  const enemyWorkers = unitsList.filter(
    (u) => u.faction === 'ENEMY' && !u.isDying && u.unitType === 'VILLAGER'
  );

  let closestBush: BerryBushResource | null = null;
  let closestBushDist = Infinity;
  berryBushesMap.forEach((bush) => {
    if (bush.food > 0) {
      const d = Math.hypot(bush.gridX + 0.5 - tcCenter.x, bush.gridZ + 0.5 - tcCenter.z);
      if (d < closestBushDist) {
        closestBushDist = d;
        closestBush = bush;
      }
    }
  });

  let closestTree: TreeResource | null = null;
  let closestTreeDist = Infinity;
  treesMap.forEach((tree) => {
    if (tree.wood > 0) {
      const d = Math.hypot(tree.gridX + 0.5 - tcCenter.x, tree.gridZ + 0.5 - tcCenter.z);
      if (d < closestTreeDist) {
        closestTreeDist = d;
        closestTree = tree;
      }
    }
  });

  enemyWorkers.forEach((w, idx) => {
    if (idx < 2 && closestBush) {
      commandForage(w, closestBush);
    } else if (closestTree) {
      commandGather(w, closestTree);
    }
  });
}

export function updateEnemyTownCenterHpBar() {
  if (!enemyTownCenterState) return;
  const pct = THREE.MathUtils.clamp(enemyTownCenterState.hp / enemyTownCenterState.maxHp, 0, 1);
  enemyTownCenterState.hpBarFillMesh.scale.x = Math.max(0.001, pct);
  enemyTownCenterState.hpBarFillMesh.position.x = -1.16 * (1 - pct);

  const isVisibleInFog = currentMatchConfig.revealWholeMap || (
    isCellInside(enemyCampCoord.x + 1, enemyCampCoord.z + 1) &&
    fogGrid[(enemyCampCoord.z + 1 + HALF_GRID) * GRID_SIZE + (enemyCampCoord.x + 1 + HALF_GRID)] === FogState.VISIBLE
  );

  enemyTownCenterState.hpBarGroup.visible = isVisibleInFog && !enemyTownCenterState.isDestroyed;
}

export const updateEnemyCampHpBar = updateEnemyTownCenterHpBar;

export function damageEnemyTownCenter(dmg: number, _now: number) {
  if (!enemyTownCenterState || enemyTownCenterState.isDestroyed) return;
  enemyTownCenterState.hp = Math.max(0, enemyTownCenterState.hp - dmg);
  updateEnemyTownCenterHpBar();

  // Flash visual no TC
  enemyTownCenterState.group.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material && 'color' in c.material) {
      const mat = c.material as THREE.MeshStandardMaterial;
      const orig = mat.color.getHex();
      mat.color.setHex(0xffffff);
      setTimeout(() => {
        if (enemyTownCenterState && mat) mat.color.setHex(orig);
      }, 80);
    }
  });

  // Faíscas
  spawnParticles(new THREE.Vector3(enemyCampCoord.x + 1.5, 1.2, enemyCampCoord.z + 1.5), 5, 0xef4444);

  if (enemyTownCenterState.hp <= 0) {
    destroyEnemyTownCenter();
  }
}

export const damageEnemyTent = damageEnemyTownCenter;

export function destroyEnemyTownCenter() {
  if (!enemyTownCenterState || enemyTownCenterState.isDestroyed) return;
  enemyTownCenterState.isDestroyed = true;
  enemyTownCenterState.hpBarGroup.visible = false;

  // Oculta componentes normais do TC inimigo
  enemyTownCenterState.group.traverse((c) => {
    if (c instanceof THREE.Mesh && c.name !== 'tc-ruin') {
      c.visible = false;
    }
  });

  // Libera as 9 células do grid para caminhada
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      setCellWalkable(enemyCampCoord.x + dx, enemyCampCoord.z + dz, true);
    }
  }

  // Cria escombros e ruínas
  if (!enemyTownCenterState.ruinsGroup) {
    const ruins = new THREE.Group();
    ruins.name = 'tc-ruins-group';
    for (let i = 0; i < 14; i++) {
      const debris = new THREE.Mesh(
        new THREE.BoxGeometry(0.4 + Math.random() * 0.45, 0.2 + Math.random() * 0.35, 0.4 + Math.random() * 0.45),
        new THREE.MeshStandardMaterial({ color: 0x292524, roughness: 0.95 })
      );
      debris.name = 'tc-ruin';
      debris.position.set((Math.random() - 0.5) * 2.5, 0.15, (Math.random() - 0.5) * 2.5);
      debris.rotation.set(Math.random() * 0.4, Math.random() * Math.PI, Math.random() * 0.4);
      ruins.add(debris);
    }
    enemyTownCenterState.group.add(ruins);
    enemyTownCenterState.ruinsGroup = ruins;
  } else {
    enemyTownCenterState.ruinsGroup.visible = true;
  }

  // Efeitos dramáticos de explosão e fumaça
  spawnParticles(new THREE.Vector3(enemyCampCoord.x + 1.5, 1.5, enemyCampCoord.z + 1.5), 50, 0xef4444);
  spawnParticles(new THREE.Vector3(enemyCampCoord.x + 1.5, 2.5, enemyCampCoord.z + 1.5), 40, 0x1e293b);
  triggerCameraShake(0.8);

  spawnFloatingText(
    new THREE.Vector3(enemyCampCoord.x + 1.5, 3.2, enemyCampCoord.z + 1.5),
    '💥 Centro da Cidade Inimigo Destruído!',
    '#f59e0b'
  );

  // Alerta todas as unidades inimigas para contra-ataque caso estejam IDLE
  for (const u of unitsList) {
    if (u.faction === 'ENEMY' && u.state === 'IDLE' && !u.isDying) {
      const alivePlayer = unitsList.find((p) => p.faction === 'PLAYER' && !p.isDying);
      if (alivePlayer) commandAttack(u, alivePlayer);
    }
  }

  // Unidades aliadas voltam a IDLE
  for (const u of unitsList) {
    if (u.state === 'ATTACKING_STRUCTURE' && u.targetStructure === 'TENT') {
      goIdle(u);
    }
  }

  checkGameOverConditions();
}

export const destroyEnemyTent = destroyEnemyTownCenter;

export function damageBuilding(building: ConstructionBuilding, dmg: number, _now: number) {
  if (building.isDepleted) return;
  ensureBuildingHp(building);
  building.hp = Math.max(0, (building.hp ?? building.maxHp ?? 1) - dmg);
  building.hpBarShowUntil = _now + 6000;
  updateBuildingHpBar(building, _now);
  if (selectedBuilding === building) {
    updateBuildingSelectedHUD(building);
  }
  spawnParticles(building.worldCenter.clone().add(new THREE.Vector3(0, 1.0, 0)), 4, 0xef4444);

  if (building.hp <= 0) {
    destroyBuilding(building);
  }
}

export function destroyBuilding(building: ConstructionBuilding) {
  building.isDepleted = true;
  building.hp = 0;

  // Libera as células do grid
  for (let dx = 0; dx < building.size; dx++) {
    for (let dz = 0; dz < building.size; dz++) {
      const gx = building.gridX + dx;
      const gz = building.gridZ + dz;
      setCellWalkable(gx, gz, true);
      if (building.type === 'WALL' || building.type === 'GATE') {
        setWallCellOccupancy(gx, gz, false);
      }
      buildingsGridMap.delete(cellKey(gx, gz));
    }
  }

  building.group.visible = false;
  scene.remove(building.group);

  const idx = buildingsList.indexOf(building);
  if (idx !== -1) buildingsList.splice(idx, 1);

  if (building.type === 'HOUSE') {
    if (building.faction === 'ENEMY' || building.isEnemy) {
      enemyPopCap = Math.max(5, enemyPopCap - 5);
      // Não toca no playerPopCap nem no HUD do jogador!
    } else {
      // Ao abater uma Casa aliada, desconta do limite populacional do jogador e atualiza o HUD
      updateTelemetryUnitsCount();
    }
  }

  const isDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered(building);
  if (isDiscovered) {
    spawnParticles(building.worldCenter.clone().add(new THREE.Vector3(0, 1.0, 0)), 30, 0xef4444);
    triggerCameraShake(0.4);
    spawnFloatingText(
      building.worldCenter.clone().add(new THREE.Vector3(0, 2.0, 0)),
      `💥 ${building.type === 'BARRACKS' ? 'Quartel Inimigo' : 'Casa Inimiga'} Destruído!`,
      '#f59e0b'
    );
  }

  for (const u of unitsList) {
    if (u.state === 'ATTACKING_STRUCTURE' && u.targetBuilding === building) {
      goIdle(u);
    }
  }

  checkGameOverConditions();
}

export function damageTownCenter(dmg: number, _now: number) {
  if (townCenterState.isDestroyed) return;
  townCenterState.hp = Math.max(0, townCenterState.hp - dmg);
  updateTownCenterHpBar();
  if (isTownCenterSelected) {
    updateTownCenterSelectedHUD();
  }

  spawnParticles(TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 1.2, 0)), 4, 0xf59e0b);

  if (townCenterState.hp <= 0) {
    destroyTownCenter();
  }
}

export function destroyTownCenter() {
  if (townCenterState.isDestroyed) return;
  townCenterState.isDestroyed = true;
  townCenterState.hpBarGroup.visible = false;

  // Oculta componentes normais do TC
  townCenterState.group.traverse((c) => {
    if (c instanceof THREE.Mesh && c.name !== 'tc-ruin') {
      c.visible = false;
    }
  });

  // Cria escombros e ruínas do TC
  if (!townCenterState.ruinsGroup) {
    const ruins = new THREE.Group();
    ruins.name = 'tc-ruins-group';
    for (let i = 0; i < 14; i++) {
      const rock = new THREE.Mesh(
        new THREE.BoxGeometry(0.4 + Math.random() * 0.45, 0.2 + Math.random() * 0.35, 0.4 + Math.random() * 0.45),
        new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.95 })
      );
      rock.name = 'tc-ruin';
      rock.position.set((Math.random() - 0.5) * 2.5, 0.15, (Math.random() - 0.5) * 2.5);
      rock.rotation.set(Math.random() * 0.4, Math.random() * Math.PI, Math.random() * 0.4);
      ruins.add(rock);
    }
    townCenterState.group.add(ruins);
    townCenterState.ruinsGroup = ruins;
  } else {
    townCenterState.ruinsGroup.visible = true;
  }

  spawnParticles(TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 1.5, 0)), 50, 0xef4444);
  spawnParticles(TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 2.5, 0)), 40, 0x1e293b);
  triggerCameraShake(0.8);

  spawnFloatingText(
    TC_WORLD_CENTER.clone().add(new THREE.Vector3(0, 3.2, 0)),
    '💀 Town Center Destruído!',
    '#ef4444'
  );

  updateTelemetryUnitsCount();
  checkGameOverConditions();
}

function restoreTownCenter() {
  townCenterState.maxHp = currentMatchConfig.townCenterHp;
  townCenterState.hp = currentMatchConfig.townCenterHp;
  townCenterState.isDestroyed = false;
  townCenterState.currentOpacity = 1.0;
  TC_WORLD_CENTER.set(
    tcCoord.minX + 1.5,
    getBuildingPlacementHeight(tcCoord.minX, tcCoord.minZ, 3),
    tcCoord.minZ + 1.5
  );
  townCenter.position.copy(TC_WORLD_CENTER);
  updateTownCenterOutline();
  applyBuildingOpacity(townCenterState.group, 1.0);
  townCenterState.group.traverse((c) => {
    if (c instanceof THREE.Mesh && c.name !== 'tc-ruin') {
      c.visible = true;
    }
  });
  if (townCenterState.ruinsGroup) {
    townCenterState.ruinsGroup.visible = false;
  }
  updateTownCenterHpBar();

  blockTownCenterCells();
  recomputeTownCenterDropoffCells();
  updateTelemetryUnitsCount();
}



// --- 16.5 IA OFENSIVA DO INIMIGO, PATRULHAS & ONDAS DE INVASÃO ---
let lastEnemyAiCheck = 0;
const ENEMY_AI_INTERVAL = 300; // ms

export let lastInvasionWaveTime = 0;
export let invasionWaveCount = 0;
export let invasionAlertEndTime = 0;
let invasionBannerTimeout: number | null = null;
let minimapAlertTimeout: number | null = null;

export function updateEnemyAI(now: number, delta: number = 0.016) {
  if (isGameOver || currentMatchConfig.peacefulMode || !hasEnemyFaction) return;
  if (!enemyTownCenterState || enemyTownCenterState.isDestroyed) return;

  // Processa Treinamento de Aldeões no Town Center Inimigo
  if (enemyTcIsTraining) {
    const trainRate = currentAIDifficulty === 'EASY' ? 0.6 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0);
    enemyTcTrainTimer += delta * trainRate;
    if (enemyTcTrainTimer >= VILLAGER_TRAIN_TIME) {
      enemyTcIsTraining = false;
      enemyTcTrainTimer = 0;
      const spawnCell = findFreeEnemySpawnCell(enemyCampCoord.x, enemyCampCoord.z);
      createUnit(spawnCell.x, spawnCell.z, 'VILLAGER', 'ENEMY');
      spawnFloatingText(
        new THREE.Vector3(spawnCell.x + 0.5, 1.8, spawnCell.z + 0.5),
        '+1 Aldeão Inimigo 👨‍🌾',
        '#ef4444'
      );
      console.log(`[RTS IA] Aldeão Inimigo concluído e spawnado em (${spawnCell.x}, ${spawnCell.z})!`);
    }
  }

  if (now - lastEnemyAiCheck < ENEMY_AI_INTERVAL) return;
  lastEnemyAiCheck = now;

  const enemyUnits = unitsList.filter((u) => u.faction === 'ENEMY' && !u.isDying);
  const playerUnits = unitsList.filter((u) => u.faction === 'PLAYER' && !u.isDying);
  const tcCenter = new THREE.Vector3(enemyCampCoord.x + 1.5, 0, enemyCampCoord.z + 1.5);

  // 1. Economia Real da IA (coleta e treinamento de aldeões até 6)
  updateEnemyEconomy(now, tcCenter, enemyUnits);

  // 2. Árvore de Construção Autônoma da IA (Casas e Quartel)
  updateEnemyAutonomousConstruction(now, enemyUnits);

  // 3. Produção Militar Condicionada ao Quartel Inimigo Concluído
  updateEnemyMilitaryProduction(now);

  // 4. Comportamento de Patrulha / Guarda da Base Vermelha
  updateEnemyPatrolsAndGuards(now, tcCenter, playerUnits, enemyUnits);

  // 5. Marcha Militar Contínua dos Soldados Invasores via A* rumo ao Town Center
  updateEnemyInvaders(now, playerUnits, enemyUnits);

  // 6. Ondas Periódicas de Invasão Automáticas (com tropas reais do Quartel)
  if (lastInvasionWaveTime === 0) {
    lastInvasionWaveTime = gameStats.startTime;
  }
  // Calibração de Dificuldade da IA:
  // - EASY: Primeiro ataque demora bastante (6 a 7 min) e intervalo entre ondas subsequentes é de 3.5 a 4.5 minutos.
  // - MEDIUM: Primeiro ataque (~4min), intervalo padrão (~3min).
  // - HARD: Primeiro ataque precoce (~2.5min - 3min), ataques mais frequentes (-25% de intervalo).
  let baseIntervalMin = currentMatchConfig.invasionIntervalMinutes || 3.0;
  if (!hasInvasionTriggered) {
    baseIntervalMin = currentAIDifficulty === 'EASY' ? 6.5 : (currentAIDifficulty === 'HARD' ? 2.75 : 4.0);
  } else {
    if (currentAIDifficulty === 'EASY') baseIntervalMin = Math.max(3.5, baseIntervalMin * 1.5);
    else if (currentAIDifficulty === 'HARD') baseIntervalMin *= 0.75;
  }
  const waveIntervalMs = Math.max(1.0, baseIntervalMin) * 60 * 1000;
  const timeSinceLastWave = now - lastInvasionWaveTime;

  // Dispara a cada X minutos OU após espadachins treinados pelo jogador na primeira onda
  const minSwordsmenTrigger = currentAIDifficulty === 'EASY' ? 8 : (currentAIDifficulty === 'HARD' ? 2 : 3);
  if (timeSinceLastWave >= waveIntervalMs || (!hasInvasionTriggered && playerSwordsmenTrainedCount >= minSwordsmenTrigger)) {
    triggerInvasionWave(now);
  }
}

/** 1. IA Econômica Básica: os aldeões inimigos mantêm coleta ativa e balanceada de madeira e alimento */
function updateEnemyEconomy(_now: number, tcCenter: THREE.Vector3, enemyUnits: RTSUnit[]): void {
  const enemyWorkers = enemyUnits.filter((u) => u.unitType === 'VILLAGER');
  if (enemyWorkers.length === 0) return;

  // Treinamento de Novos Aldeões no Town Center Inimigo até 6 trabalhadores
  if (
    enemyResources.food >= 50 &&
    enemyWorkers.length < 6 &&
    enemyUnits.length < enemyPopCap &&
    !enemyTcIsTraining &&
    enemyTownCenterState &&
    !enemyTownCenterState.isDestroyed
  ) {
    enemyResources.food -= 50;
    enemyTcIsTraining = true;
    enemyTcTrainTimer = 0;
    spawnFloatingText(
      new THREE.Vector3(enemyCampCoord.x + 1.5, 2.8, enemyCampCoord.z + 1.5),
      'Treinando Aldeão Inimigo 👨‍🌾 (-50 🍖)',
      '#ef4444'
    );
    console.log(`[RTS IA] Treinamento de Aldeão Inimigo iniciado no TC. Trabalhadores: ${enemyWorkers.length}/6`);
  }

  // Verifica se o Quartel inimigo já está erguido e de pé
  const hasCompletedBarracks = buildingsList.some(
    (b) => b.faction === 'ENEMY' && b.type === 'BARRACKS' && b.isCompleted && (!b.hp || b.hp > 0)
  );

  let foodGatherers = 0;
  let woodGatherers = 0;
  let goldGatherers = 0;

  for (const w of enemyWorkers) {
    if (w.state === 'BUILDING' || w.state === 'MOVING_TO_BUILD') continue;

    if (w.carriedResourceType === 'FOOD' || w.targetBerryBush) {
      foodGatherers++;
    } else if (w.carriedResourceType === 'WOOD' || w.targetTree) {
      woodGatherers++;
    } else if (w.carriedResourceType === 'GOLD' || w.targetGoldMine) {
      goldGatherers++;
    }
  }

  for (const w of enemyWorkers) {
    if (w.state === 'BUILDING' || w.state === 'MOVING_TO_BUILD') continue;

    if (w.state === 'IDLE') {
      if (w.carrying > 0) {
        commandReturnToBase(w);
        continue;
      }

      // Quando o Quartel estiver construído, aloca pelo menos 1 aldeão para ouro
      if (hasCompletedBarracks && goldGatherers < 1) {
        const closestGold = findNearestGoldMine(tcCenter.x, tcCenter.z, 35);
        if (closestGold) {
          commandMineGold(w, closestGold);
          goldGatherers++;
          continue;
        }
      }

      const closestBush = findNearestBerryBush(tcCenter.x, tcCenter.z, 35);
      const closestTree = findNearestTree(tcCenter.x, tcCenter.z, 35);

      // Distribuição equilibrada: prioriza 2 em Madeira e 2 em Alimento
      if (foodGatherers <= woodGatherers && closestBush) {
        commandForage(w, closestBush);
        foodGatherers++;
      } else if (closestTree) {
        commandGather(w, closestTree);
        woodGatherers++;
      } else if (closestBush) {
        commandForage(w, closestBush);
        foodGatherers++;
      }
    }
  }
}

/** 2. Árvore de Construção Autônoma da IA: Casas (HOUSE) e Quartel (BARRACKS) */
function updateEnemyAutonomousConstruction(_now: number, enemyUnits: RTSUnit[]): void {
  const enemyWorkers = enemyUnits.filter((u) => u.unitType === 'VILLAGER');
  if (enemyWorkers.length === 0) return;

  const tcX = enemyCampCoord.x;
  const tcZ = enemyCampCoord.z;

  // Envia operários para obras inimigas inacabadas
  const unfinishedBuildings = buildingsList.filter(
    (b) => b.faction === 'ENEMY' && !b.isCompleted && (!b.hp || b.hp > 0)
  );

  for (const b of unfinishedBuildings) {
    const buildersCount = enemyWorkers.filter(
      (u) => (u.state === 'BUILDING' || u.state === 'MOVING_TO_BUILD') && u.targetBuilding === b
    ).length;
    const maxBuilders = b.type === 'BARRACKS' ? 2 : 1;
    if (buildersCount < maxBuilders) {
      const freeWorker = enemyWorkers.find(
        (u) => (u.state === 'IDLE' || u.state === 'GATHERING' || u.state === 'MINING_GOLD' || u.state === 'MOVING_TO_RESOURCE') &&
               u.targetBuilding !== b
      );
      if (freeWorker) {
        commandBuild(freeWorker, b);
      }
    }
  }

  // A. Construção de Casa: se pop perto do limite (enemyUnits >= popCap - 1), wood >= 30, e sem casa em obra
  const hasHouseInConstruction = buildingsList.some(
    (b) => b.faction === 'ENEMY' && b.type === 'HOUSE' && !b.isCompleted
  );

  if (!hasHouseInConstruction && enemyUnits.length >= enemyPopCap - 1 && enemyResources.wood >= 30) {
    const site = findFreeEnemyBuildingSite(tcX, tcZ, 1, 4, 7);
    if (site) {
      enemyResources.wood -= 30;
      const house = createHouseFoundation(site.x, site.z, 'ENEMY');
      spawnFloatingText(house.worldCenter.clone().setY(2.0), 'Canteiro Casa Inimiga 🏠 (-30 🪵)', '#ef4444');
      console.log(`[RTS IA] Canteiro de Casa Inimiga iniciado em (${site.x}, ${site.z}).`);

      const builder = enemyWorkers.find((u) => u.state !== 'BUILDING' && u.state !== 'MOVING_TO_BUILD') || enemyWorkers[0];
      if (builder) {
        commandBuild(builder, house);
      }
      return;
    }
  }

  // B. Construção do Quartel Inimigo: começa SEM quartel. Assim que wood >= 100 (ou BARRACKS_COST_WOOD) e sem quartel
  const hasBarracksOrUnderway = buildingsList.some(
    (b) => b.faction === 'ENEMY' && b.type === 'BARRACKS' && (!b.hp || b.hp > 0)
  );

  const barracksCost = Math.min(100, BARRACKS_COST_WOOD || 50);
  if (!hasBarracksOrUnderway && enemyResources.wood >= barracksCost) {
    const site = findFreeEnemyBuildingSite(tcX, tcZ, 2, 5, 8);
    if (site) {
      enemyResources.wood -= barracksCost;
      const barracks = createBarracksFoundation(site.x, site.z, 'ENEMY');
      spawnFloatingText(barracks.worldCenter.clone().setY(2.2), `Canteiro Quartel Inimigo ⚔️ (-${barracksCost} 🪵)`, '#ef4444');
      console.log(`[RTS IA] Canteiro de Quartel Inimigo iniciado em (${site.x}, ${site.z}).`);

      let assigned = 0;
      for (const w of enemyWorkers) {
        if (assigned >= 2) break;
        if (w.state !== 'BUILDING' && w.state !== 'MOVING_TO_BUILD') {
          commandBuild(w, barracks);
          assigned++;
        }
      }
    }
  }
}

/** 3. Produção Militar Condicionada ao Quartel: Treina Espadachins apenas com Quartel Concluído e recursos */
function updateEnemyMilitaryProduction(_now: number): void {
  // Regra Estrita: O inimigo SÓ PODE treinar soldados se possuir pelo menos 1 Quartel Concluído e de pé
  const enemyBarracks = buildingsList.filter(
    (b) => b.faction === 'ENEMY' && b.type === 'BARRACKS' && b.isCompleted && (!b.hp || b.hp > 0)
  );
  if (enemyBarracks.length === 0) return;

  const currentEnemyPop = unitsList.filter((u) => u.faction === 'ENEMY' && !u.isDying).length;
  const queuedInBarracks = enemyBarracks.reduce((sum, b) => sum + b.trainingQueue.length, 0);

  if (currentEnemyPop + queuedInBarracks >= enemyPopCap) {
    return; // Limite populacional atingido
  }

  // Custo: 25 madeira (ou 40 comida) e 10 ouro
  const canAffordWood = enemyResources.wood >= SWORDSMAN_COST_WOOD && enemyResources.gold >= SWORDSMAN_COST_GOLD;
  const canAffordFood = enemyResources.food >= 40 && enemyResources.gold >= SWORDSMAN_COST_GOLD;

  if (!canAffordWood && !canAffordFood) return;

  const availableBarracks = enemyBarracks.find((b) => b.trainingQueue.length < 5);
  if (!availableBarracks) return;

  if (canAffordWood) {
    enemyResources.wood -= SWORDSMAN_COST_WOOD;
    enemyResources.gold -= SWORDSMAN_COST_GOLD;
  } else {
    enemyResources.food -= 40;
    enemyResources.gold -= SWORDSMAN_COST_GOLD;
  }

  availableBarracks.trainingQueue.push({
    id: `enemy_sw_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    unitType: 'SWORDSMAN',
    totalDuration: getSwordsmanTrainTime()
  });

  spawnFloatingText(
    availableBarracks.worldCenter.clone().add(new THREE.Vector3(0, 2.2, 0)),
    'Treinando Espadachim ⚔️',
    '#ef4444'
  );
  console.log(`[RTS IA] Treinamento de Espadachim Inimigo iniciado no Quartel (${availableBarracks.gridX}, ${availableBarracks.gridZ}).`);
}

/** 4. Comportamento de Patrulha / Guarda: protege o Town Center e o Quartel inimigo */
function updateEnemyPatrolsAndGuards(
  now: number,
  tcCenter: THREE.Vector3,
  playerUnits: RTSUnit[],
  enemyUnits: RTSUnit[]
): void {
  const guards = enemyUnits.filter((u) => u.unitType === 'SWORDSMAN' && u.isEnemyPatrol && !u.isEnemyInvader);
  const GUARD_VISION_PERIMETER = 7.5;
  const MAX_PURSUIT_DIST_FROM_TC = 13.0;

  for (const guard of guards) {
    const intruder = playerUnits.find((p) => {
      const d = Math.hypot(p.group.position.x - guard.group.position.x, p.group.position.z - guard.group.position.z);
      return d <= GUARD_VISION_PERIMETER;
    });

    if (intruder) {
      if (guard.targetEnemy !== intruder) {
        commandAttack(guard, intruder);
        spawnFloatingText(
          guard.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
          '⚔️ Patrulha Alerta!',
          '#ef4444'
        );
        try {
          soundManager.swordClash();
        } catch {}
      }
      continue;
    }

    if (guard.state === 'ATTACKING') {
      const target = guard.targetEnemy;
      const distFromTC = target
        ? Math.hypot(target.group.position.x - tcCenter.x, target.group.position.z - tcCenter.z)
        : Infinity;
      if (!target || target.hp <= 0 || target.isDying || distFromTC > MAX_PURSUIT_DIST_FROM_TC) {
        goIdle(guard);
      }
      continue;
    }

    // Patrulha ativa ao redor do Town Center (raio de 3.5 a 6.2 células)
    if (guard.state === 'IDLE') {
      if (guard.patrolWaitUntil && now < guard.patrolWaitUntil) {
        continue;
      }

      const angle = Math.random() * Math.PI * 2;
      const radius = 3.5 + Math.random() * 2.7;
      const targetX = Math.round(tcCenter.x + Math.cos(angle) * radius);
      const targetZ = Math.round(tcCenter.z + Math.sin(angle) * radius);

      const patrolCell = findClosestWalkableCell(new THREE.Vector2(targetX, targetZ), unitCell(guard));
      setUnitPath(guard, patrolCell);
      guard.patrolWaitUntil = now + 2800 + Math.random() * 3200;
    }
  }
}

/** 5. Marcha Militar Contínua dos Invasores via A* rumo ao Town Center do jogador */
function updateEnemyInvaders(
  _now: number,
  playerUnits: RTSUnit[],
  enemyUnits: RTSUnit[]
): void {
  const invaders = enemyUnits.filter((u) => u.isEnemyInvader);

  for (const invader of invaders) {
    if (invader.state === 'IDLE') {
      // Verifica se há defensores aliados ao alcance de visão/guarda
      const nearbyDefender = playerUnits.find((p) => {
        const d = Math.hypot(p.group.position.x - invader.group.position.x, p.group.position.z - invader.group.position.z);
        return d <= 5.5;
      });
      if (nearbyDefender) {
        commandAttack(invader, nearbyDefender);
      } else if (!townCenterState.isDestroyed) {
        // Tenta marchar rumo ao TC; se o caminho estiver bloqueado por muralhas, o comando colocará a unidade em guarda no limite acessível
        const tcPos = TC_WORLD_CENTER;
        const myPos = invader.group.position;
        const distToTc = Math.hypot(myPos.x - tcPos.x, myPos.z - tcPos.z);
        if (distToTc > 3.0) {
          commandAttackTownCenter(invader);
        }
      }
    } else if (invader.state === 'ATTACKING_STRUCTURE' && invader.targetStructure === 'TOWN_CENTER') {
      const nearbyDefender = playerUnits.find((p) => {
        const d = Math.hypot(p.group.position.x - invader.group.position.x, p.group.position.z - invader.group.position.z);
        return d <= 3.5;
      });
      if (nearbyDefender) {
        commandAttack(invader, nearbyDefender);
      }
    }
  }
}

/** 5. Dispara Onda Periódica de Invasão reunindo soldados REALMENTE TREINADOS no Quartel */
export function triggerInvasionWave(now: number = performance.now()): void {
  if (isGameOver || currentMatchConfig.peacefulMode || !hasEnemyFaction) return;
  if (!enemyTownCenterState || enemyTownCenterState.isDestroyed) return;

  // Reúne tropas inimigas legítimas prontas que foram treinadas no Quartel
  let readySoldiers = unitsList.filter(
    (u) => u.faction === 'ENEMY' && u.unitType === 'SWORDSMAN' && !u.isDying && !u.isEnemyInvader && !u.isEnemyPatrol
  );

  // Se não houver tropas de reserva mas houver mais de 2 guardas de patrulha, convoca os excedentes
  if (readySoldiers.length === 0) {
    const guards = unitsList.filter(
      (u) => u.faction === 'ENEMY' && u.unitType === 'SWORDSMAN' && !u.isDying && u.isEnemyPatrol
    );
    if (guards.length > 2) {
      readySoldiers = guards.slice(2);
    }
  }

  // Não "brota soldados do nada": só marcha se houver tropas de fato prontas na base
  if (readySoldiers.length === 0) {
    return;
  }

  // Calibração de Tropas por Onda:
  // - EASY: Reduz o número de atacantes para 2 a 3 unidades no início, escalando suavemente com o tempo
  if (currentAIDifficulty === 'EASY') {
    const maxEasySoldiers = Math.min(2 + Math.floor(invasionWaveCount * 0.5), 4);
    if (readySoldiers.length > maxEasySoldiers) {
      readySoldiers = readySoldiers.slice(0, maxEasySoldiers);
    }
  }

  hasInvasionTriggered = true;
  lastInvasionWaveTime = now;
  invasionWaveCount++;

  // A. HUD exibe aviso '⚔️ O inimigo está marchando contra sua base!'
  const banner = document.getElementById('invasion-banner');
  const bannerText = document.getElementById('invasion-banner-text');
  if (banner) {
    if (bannerText) {
      bannerText.innerHTML = `<strong>⚔️ O inimigo está marchando contra sua base!</strong> <span style="font-size: 11px; opacity: 0.85; margin-left: 6px;">(Onda #${invasionWaveCount} • ${readySoldiers.length} tropas)</span>`;
    }
    banner.style.display = 'flex';
    if (invasionBannerTimeout) clearTimeout(invasionBannerTimeout);
    invasionBannerTimeout = window.setTimeout(() => {
      if (banner) banner.style.display = 'none';
    }, 7500);
  }

  // B. Pulso de alerta visual no minimapa
  invasionAlertEndTime = now + 7500;
  const minimapContainer = document.getElementById('minimap-container');
  if (minimapContainer) {
    minimapContainer.classList.add('minimap-invasion-alert');
    if (minimapAlertTimeout) clearTimeout(minimapAlertTimeout);
    minimapAlertTimeout = window.setTimeout(() => {
      minimapContainer?.classList.remove('minimap-invasion-alert');
    }, 7500);
  }

  // C. Toque de trombeta no SoundManager
  try {
    soundManager.warTrumpetAlert();
  } catch (err) {
    console.warn('[RTS Audio] Erro ao tocar trombeta de invasão:', err);
  }

  // D. Tremor dinâmico de câmera
  triggerCameraShake(0.35);

  // E. Ordena marcha militar contínua via A* rumo ao Town Center
  for (const soldier of readySoldiers) {
    soldier.isEnemyInvader = true;
    soldier.isEnemyPatrol = false;

    spawnParticles(soldier.group.position.clone().add(new THREE.Vector3(0, 0.4, 0)), 8, 0xef4444);
    spawnFloatingText(
      soldier.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
      '⚔️ Marchar!',
      '#ef4444'
    );

    commandAttackTownCenter(soldier);
  }

  console.log(
    `[RTS IA] Onda de Invasão #${invasionWaveCount} iniciada com ${readySoldiers.length} tropas reais treinadas marchando via A*!`
  );
}

export function triggerInvasion(): void {
  triggerInvasionWave(performance.now());
}

// --- 16.6 CONDIÇÕES DE VITÓRIA, DERROTA & MODAL DE FIM DE JOGO ---
export function checkGameOverConditions() {
  if (isGameOver) return;

  // 1. Condição de Derrota
  // A: Town Center destruído
  if (townCenterState.isDestroyed || townCenterState.hp <= 0) {
    triggerGameOver('DEFEAT', 'O seu Town Center principal foi destruído pelas forças inimigas!');
    return;
  }

  // B: Perder todas as unidades e ficar sem recursos para treinar novas (< 30 madeira)
  const alivePlayerUnits = unitsList.filter((u) => u.faction === 'PLAYER' && !u.isDying);
  if (alivePlayerUnits.length === 0 && resources.wood < 30) {
    triggerGameOver(
      'DEFEAT',
      'Todas as suas unidades foram aniquiladas e seu povo ficou sem recursos para treinar novos reforços!'
    );
    return;
  }

  // 2. Condição de Vitória: Destruir o Town Center Inimigo (Vitória Imediata)
  if (!currentMatchConfig.peacefulMode && hasEnemyFaction) {
    const isEnemyTcDead = !enemyTownCenterState || enemyTownCenterState.isDestroyed || enemyTownCenterState.hp <= 0;
    if (isEnemyTcDead) {
      triggerGameOver(
        'VICTORY',
        'O Centro da Cidade Inimigo foi reduzido a cinzas! A vitória é do seu império!'
      );
      return;
    }
  }
}

export function triggerGameOver(outcome: 'VICTORY' | 'DEFEAT', subtitle: string) {
  if (isGameOver) return;
  isGameOver = true;

  const modal = document.getElementById('game-over-modal');
  const card = document.getElementById('game-over-card');
  const icon = document.getElementById('game-over-icon');
  const title = document.getElementById('game-over-title');
  const subtitleEl = document.getElementById('game-over-subtitle');

  if (modal && card && icon && title && subtitleEl) {
    if (outcome === 'VICTORY') {
      card.className = 'game-over-card victory';
      icon.textContent = '👑';
      title.textContent = 'VITÓRIA CONQUISTADA';
    } else {
      card.className = 'game-over-card defeat';
      icon.textContent = '💀';
      title.textContent = 'DERROTA ESMAGADORA';
    }
    subtitleEl.textContent = subtitle;

    const elapsedSecs = Math.max(0, Math.floor((performance.now() - gameStats.startTime) / 1000));
    const mins = Math.floor(elapsedSecs / 60);
    const secs = elapsedSecs % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const statTimeEl = document.getElementById('stat-time');
    const statWoodEl = document.getElementById('stat-wood');
    const statFoodEl = document.getElementById('stat-food');
    const statStoneEl = document.getElementById('stat-stone');
    const statUnitsEl = document.getElementById('stat-units');
    const statKillsEl = document.getElementById('stat-kills');
    const statBuildingsEl = document.getElementById('stat-buildings');

    if (statTimeEl) statTimeEl.textContent = timeStr;
    if (statWoodEl) statWoodEl.textContent = `${gameStats.woodCollectedTotal}`;
    if (statFoodEl) statFoodEl.textContent = `${gameStats.foodCollectedTotal}`;
    if (statStoneEl) statStoneEl.textContent = `${gameStats.stoneCollectedTotal}`;
    if (statUnitsEl) statUnitsEl.textContent = `${gameStats.unitsTrainedTotal}`;
    if (statKillsEl) statKillsEl.textContent = `${gameStats.enemiesKilledTotal}`;
    if (statBuildingsEl) statBuildingsEl.textContent = `${gameStats.buildingsConstructedTotal}`;

    modal.style.display = 'flex';
  }
}

/** Remove o acampamento inimigo atual da cena (para recriá-lo em outra posição/tamanho de mapa). */
function disposeEnemyCamp(): void {
  if (!enemyCampGroup) return;
  scene.remove(enemyCampGroup);
  enemyCampGroup.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => m.dispose());
    }
  });
  enemyCampGroup = null;
  enemyCampState = null;
  enemyTownCenterState = null;
}

/**
 * Reinicia a partida. Se `newMapSize` for informado (30, 50 ou 80), o tabuleiro inteiro
 * é reconstruído: grid de ocupação, névoa, chão, minimapa, limites de câmera e entidades.
 */
export function restartGame(newMapSize: number = pendingMapSize, newSeed?: number) {
  const targetSize = isValidMapSize(newMapSize) ? newMapSize : mapSize;
  if (typeof newSeed === 'number') {
    currentMapSeed = newSeed;
  }
  isGameOver = false;
  isGamePaused = false;
  pauseStartTime = 0;
  (window as any).isGamePaused = false;

  const modal = document.getElementById('game-over-modal');
  if (modal) modal.style.display = 'none';
  const banner = document.getElementById('invasion-banner');
  if (banner) banner.style.display = 'none';
  const pauseBanner = document.getElementById('pause-indicator');
  if (pauseBanner) {
    pauseBanner.style.display = 'none';
    pauseBanner.classList.add('hidden');
  }
  if (isPlacementMode) exitPlacementMode();
  closeEnginePopover();
  closeControlsPopover();

  // 1. Reseta Estatísticas & Recursos
  gameStats.startTime = performance.now();
  gameStats.woodCollectedTotal = 0;
  gameStats.foodCollectedTotal = 0;
  gameStats.stoneCollectedTotal = 0;
  gameStats.goldCollectedTotal = 0;
  gameStats.unitsTrainedTotal = 4;
  gameStats.enemiesKilledTotal = 0;
  gameStats.buildingsConstructedTotal = 0;
  playerSwordsmenTrainedCount = 0;
  hasInvasionTriggered = false;
  lastInvasionWaveTime = performance.now();
  invasionWaveCount = 0;
  invasionAlertEndTime = 0;

  tcTrainingQueue.length = 0;
  tcTrainingTimer = 0;
  deselectTownCenter();

  resources.wood = currentMatchConfig.initialWood;
  resources.food = 0;
  resources.gold = 0;
  resources.stone = 0;
  enemyResources.wood = 0;
  enemyResources.food = 0;
  enemyResources.gold = 0;
  enemyResources.stone = 0;
  updateResourceHUD();

  // 2. Remove todas as unidades atuais
  for (const u of unitsList) {
    if (u.group.parent) scene.remove(u.group);
  }
  unitsList.length = 0;
  activeDeathAnimations.length = 0;
  activeSpawnAnimations.length = 0;

  for (const p of activeParticles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  activeParticles.length = 0;

  for (const p of towerProjectiles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  towerProjectiles.length = 0;

  for (const p of archerProjectiles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  archerProjectiles.length = 0;

  // 3. Remove todos os edifícios construídos
  for (const b of buildingsList) {
    if (b.group.parent) scene.remove(b.group);
  }
  buildingsList.length = 0;
  buildingsGridMap.clear();
  deselectBuilding();

  // 4. Remove obstáculos e acampamento antigos, e reconstrói o tabuleiro com relevo procedural
  clearMapObstacles();
  disposeEnemyCamp();
  applyMapSize(targetSize, currentMapSeed);
  pendingMapSize = targetSize;

  // 5. Ordem estrita de restauração:
  // a & b. Restaura Town Center e registra células no grid
  restoreTownCenter();

  hasEnemyFaction = !currentMatchConfig.peacefulMode;

  // c. Spawna IMEDIATAMENTE os 4 aldeões aliados no quadrante frontal visível (Sul/Sudoeste, em leque aberto)
  for (const [vx, vz] of getInitialVillagerSpawns()) {
    createUnit(vx, vz, 'VILLAGER', 'PLAYER');
  }

  // Cria acampamento inimigo (e os 4 trabalhadores inimigos) se não for modo pacífico
  if (!currentMatchConfig.peacefulMode) {
    createEnemyCamp(enemyCampCoord.x, enemyCampCoord.z);
    spawnGuaranteedEnemyResources();
    initEnemyWorkerRoutines();
  }

  // d. Gera recursos ao redor
  spawnGuaranteedAlliedResources();
  spawnStoneWall();
  spawnOrganicForests(currentMapSeed);
  spawnWildMineralAndFruitClusters(currentMapSeed);

  // e. Reposiciona alvos de câmera focados no Town Center aliado
  setupGameCamera(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z);

  // f. Atualiza Névoa de Guerra
  if (currentMatchConfig.revealWholeMap) {
    fogGrid.fill(FogState.VISIBLE);
  } else {
    fogGrid.fill(FogState.UNEXPLORED);
  }
  updateFogOfWar(true);
  renderMinimap();

  updateTelemetryUnitsCount();
  updateTelemetrySelectionCount();
  updateObjectiveHUD();
  resetPeacefulQuests();
  syncMapSizeUI();

  console.log(`[RTS] Partida reiniciada com sucesso! Mapa ${mapSize}x${mapSize} • Seed: #${currentMapSeed} • Modo Pacífico: ${currentMatchConfig.peacefulMode} • Mapa Todo Visível: ${currentMatchConfig.revealWholeMap} • ${treesMap.size} árvores.`);
}

const btnGameOverRestart = document.getElementById('btn-gameover-restart') || document.getElementById('btn-restart-game');
btnGameOverRestart?.addEventListener('click', (e) => {
  e.stopPropagation();
  const gameOverModal = document.getElementById('game-over-modal');
  if (gameOverModal) {
    gameOverModal.style.display = 'none';
    gameOverModal.classList.add('hidden');
  }
  restartGame();
});

document.getElementById('btn-game-over-menu')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const modal = document.getElementById('game-over-modal');
  if (modal) modal.style.display = 'none';
  returnToMainMenu();
});

// Modal de confirmação segura para reiniciar a partida
const btnSettingsRestart = document.getElementById('btn-settings-restart-match');
const btnPauseRestart = document.getElementById('btn-pause-restart');
const confirmRestartDialog = document.getElementById('confirm-restart-dialog');
const btnConfirmRestartYes = document.getElementById('btn-confirm-restart-yes');
const btnConfirmRestartNo = document.getElementById('btn-confirm-restart-no');

const openConfirmRestartDialog = (e?: Event) => {
  e?.stopPropagation();
  confirmRestartDialog?.classList.remove('hidden');
};

const closeConfirmRestartDialog = (e?: Event) => {
  e?.stopPropagation();
  confirmRestartDialog?.classList.add('hidden');
};

btnSettingsRestart?.addEventListener('click', openConfirmRestartDialog);
btnPauseRestart?.addEventListener('click', openConfirmRestartDialog);
btnConfirmRestartNo?.addEventListener('click', closeConfirmRestartDialog);

btnConfirmRestartYes?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeConfirmRestartDialog();

  // Fecha modais abertos
  const matchConfig = document.getElementById('match-config-modal');
  if (matchConfig) {
    matchConfig.style.display = 'none';
    matchConfig.classList.add('hidden');
  }
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal) {
    settingsModal.style.display = 'none';
    settingsModal.classList.add('hidden');
  }
  const pauseModal = document.getElementById('pause-menu-modal');
  if (pauseModal) {
    pauseModal.style.display = 'none';
    pauseModal.classList.add('hidden');
  }
  isMatchConfigModalOpen = false;
  isGamePaused = false;

  restartGame();
});

// Botões adicionais do rodapé de configurações (Retomar e Menu Principal)
document.getElementById('btn-settings-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeMatchConfigModal();
});

document.getElementById('btn-settings-main-menu')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeMatchConfigModal();
  returnToMainMenu();
});

const btnRandomSeed = document.getElementById('btn-random-seed');
btnRandomSeed?.addEventListener('click', (e) => {
  e.stopPropagation();
  const nextSeed = Math.floor(Math.random() * 900000) + 100000;
  restartGame(pendingMapSize, nextSeed);
});

// --- 16.7 SELETOR DE TAMANHO DE MAPA (HUD) ---
let pendingMapSize = mapSize;
const mapSizeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.map-size-option'));
const btnRestartMapSize = document.getElementById('btn-restart-map-size') as HTMLButtonElement | null;
const mapSizeCurrentEl = document.getElementById('map-size-current');
const minimapSizeEl = document.getElementById('minimap-size');

function syncMapSizeUI(): void {
  for (const btn of mapSizeButtons) {
    const size = Number(btn.dataset.size);
    btn.classList.toggle('selected', size === pendingMapSize);
    btn.classList.toggle('current', size === mapSize);
    btn.setAttribute('aria-checked', String(size === pendingMapSize));
  }
  const changed = pendingMapSize !== mapSize;
  if (btnRestartMapSize) {
    btnRestartMapSize.classList.toggle('pending', changed);
    btnRestartMapSize.title = changed
      ? `Reiniciar a partida em um mapa ${pendingMapSize}×${pendingMapSize}`
      : `Reiniciar a partida no mapa atual (${mapSize}×${mapSize})`;
  }
  if (mapSizeCurrentEl) mapSizeCurrentEl.textContent = `${mapSize}×${mapSize}`;
  if (triggerMapSizeBadgeEl) triggerMapSizeBadgeEl.textContent = `${mapSize}×${mapSize}`;
  if (minimapSizeEl) minimapSizeEl.textContent = `${mapSize}×${mapSize}`;
}

for (const btn of mapSizeButtons) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const size = Number(btn.dataset.size);
    if (isValidMapSize(size)) {
      pendingMapSize = size;
      syncMapSizeUI();
    }
  });
}

btnRestartMapSize?.addEventListener('click', (e) => {
  e.stopPropagation();
  restartGame(pendingMapSize);
});
syncMapSizeUI();

// --- 16.8 MODAL DE CONFIGURAÇÃO PRÉ-JOGO (PARTIDA CUSTOMIZADA / SANDBOX) ---
const matchConfigModalEl = document.getElementById('match-config-modal');
const btnCloseMatchConfig = document.getElementById('btn-close-match-config') as HTMLButtonElement | null;
const btnStartMatch = document.getElementById('btn-start-match') as HTMLButtonElement | null;
const btnStartMatchLabel = document.getElementById('btn-start-match-label');
const btnResetMatchConfig = document.getElementById('btn-reset-match-config') as HTMLButtonElement | null;
const btnOpenMatchConfig = document.getElementById('btn-open-match-config') as HTMLButtonElement | null;

// Abas
const configTabBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.config-tab-btn'));
const configTabPanes = Array.from(document.querySelectorAll<HTMLElement>('.config-tab-pane'));

// Sliders e Badges
const inputTcHp = document.getElementById('cfg-tc-hp') as HTMLInputElement | null;
const badgeTcHp = document.getElementById('val-tc-hp');

const inputEnemyHp = document.getElementById('cfg-enemy-hp') as HTMLInputElement | null;
const badgeEnemyHp = document.getElementById('val-enemy-hp');

const inputWoodTime = document.getElementById('cfg-wood-time') as HTMLInputElement | null;
const badgeWoodTime = document.getElementById('val-wood-time');

const inputStoneTime = document.getElementById('cfg-stone-time') as HTMLInputElement | null;
const badgeStoneTime = document.getElementById('val-stone-time');

const inputGoldTime = document.getElementById('cfg-gold-time') as HTMLInputElement | null;
const badgeGoldTime = document.getElementById('val-gold-time');

const inputTreeCap = document.getElementById('cfg-tree-cap') as HTMLInputElement | null;
const badgeTreeCap = document.getElementById('val-tree-cap');

const inputStoneCap = document.getElementById('cfg-stone-cap') as HTMLInputElement | null;
const badgeStoneCap = document.getElementById('val-stone-cap');

const inputGoldCap = document.getElementById('cfg-gold-cap') as HTMLInputElement | null;
const badgeGoldCap = document.getElementById('val-gold-cap');

const inputSwordHp = document.getElementById('cfg-sword-hp') as HTMLInputElement | null;
const badgeSwordHp = document.getElementById('val-sword-hp');

const inputSwordDmg = document.getElementById('cfg-sword-dmg') as HTMLInputElement | null;
const badgeSwordDmg = document.getElementById('val-sword-dmg');

const inputTrainTime = document.getElementById('cfg-train-time') as HTMLInputElement | null;
const badgeTrainTime = document.getElementById('val-train-time');

const inputInitWood = document.getElementById('cfg-init-wood') as HTMLInputElement | null;
const badgeInitWood = document.getElementById('val-init-wood');

const inputCollegeTime = document.getElementById('cfg-college-time') as HTMLInputElement | null;
const badgeCollegeTime = document.getElementById('val-college-time');

const inputInvasionInterval = document.getElementById('cfg-invasion-interval') as HTMLInputElement | null;
const badgeInvasionInterval = document.getElementById('val-invasion-interval');

// =====================================================================
// SISTEMA DE MISSÕES EM CAPÍTULOS (MODO CONSTRUTOR PACÍFICO)
// =====================================================================
export interface QuestObjective {
  id: string;
  description: string;
  targetCount: number;
  currentCount: number;
  isCompleted: boolean;
  // 'BUILDING_COUNT' | 'UNIT_COUNT' | 'EDUCATION_COUNT' | 'SPECIALIZATION_COUNT' | 'RESOURCE_ACCUMULATED'
  checkType: string;
  targetType?: string;
}

export interface ColonyChapter {
  chapterIndex: number;
  title: string;
  subtitle: string;
  objectives: QuestObjective[];
  reward: { wood?: number; food?: number; gold?: number; stone?: number; text: string };
}

function createPeacefulChapters(): ColonyChapter[] {
  const o = (id: string, description: string, checkType: string, targetType: string, targetCount: number): QuestObjective =>
    ({ id, description, checkType, targetType, targetCount, currentCount: 0, isCompleted: false });
  return [
    {
      chapterIndex: 0, title: 'O Assentamento Rural',
      subtitle: 'Construa a infraestrutura básica para abrigar seus aldeões.',
      objectives: [
        o('c1_houses', 'Construir 3 Casas', 'BUILDING_COUNT', 'HOUSE', 3),
        o('c1_lumber', 'Construir 1 Madeireira', 'BUILDING_COUNT', 'LUMBER_CAMP', 1),
        o('c1_mine', 'Construir 1 Mina', 'BUILDING_COUNT', 'MINING_CAMP', 1)
      ],
      reward: { wood: 100, gold: 50, text: '+100 Madeira, +50 Ouro' }
    },
    {
      chapterIndex: 1, title: 'Sustento & Expansão Agrícola',
      subtitle: 'Garanta alimento e educação para sua população crescente.',
      objectives: [
        o('c2_mill', 'Construir 1 Moinho', 'BUILDING_COUNT', 'MILL', 1),
        o('c2_school', 'Construir a Escola', 'BUILDING_COUNT', 'SCHOOL', 1),
        o('c2_villagers', 'Atingir 10 Aldeões', 'UNIT_COUNT', 'VILLAGER', 10)
      ],
      reward: { food: 150, wood: 80, text: '+150 Alimento, +80 Madeira' }
    },
    {
      chapterIndex: 2, title: 'Educação e Ciência Imperial',
      subtitle: 'Forme cidadãos instruídos e especialistas de elite.',
      objectives: [
        o('c3_edu', 'Formar 2 Aldeões com Ensino Básico', 'EDUCATION_COUNT', 'VILLAGER', 2),
        o('c3_college', 'Construir a Faculdade', 'BUILDING_COUNT', 'COLLEGE', 1),
        o('c3_agro', 'Formar 1 Agrônomo', 'SPECIALIZATION_COUNT', 'AGRONOMIST', 1),
        o('c3_farm', 'Construir 1 Fazenda', 'BUILDING_COUNT', 'FARM', 1)
      ],
      reward: { gold: 120, stone: 100, text: '+120 Ouro, +100 Pedra' }
    },
    {
      chapterIndex: 3, title: 'Soberania e Urbanismo Monumental',
      subtitle: 'Erga defesas imponentes e encha o tesouro da colônia.',
      objectives: [
        o('c4_arch', 'Formar 1 Arquiteto', 'SPECIALIZATION_COUNT', 'ARCHITECT', 1),
        o('c4_walls', 'Erguer 10 Muralhas de Pedra', 'BUILDING_COUNT', 'WALL', 10),
        o('c4_tower', 'Construir 1 Torre de Vigia', 'BUILDING_COUNT', 'TOWER', 1),
        o('c4_gold', 'Acumular 400 de Ouro', 'RESOURCE_ACCUMULATED', 'GOLD', 400)
      ],
      reward: { wood: 200, stone: 150, text: '+200 Madeira, +150 Pedra' }
    },
    {
      chapterIndex: 4, title: 'O Polo Industrial & Extração de Minério',
      subtitle: 'A expansão da cidade exige reservas massivas de ouro e pedra para as grandes obras.',
      objectives: [
        o('c5_mines', 'Construir 2 Minas', 'BUILDING_COUNT', 'MINING_CAMP', 2),
        o('c5_stone', 'Acumular 300 de Pedra', 'RESOURCE_ACCUMULATED', 'STONE', 300),
        o('c5_farms', 'Construir 4 Fazendas', 'BUILDING_COUNT', 'FARM', 4),
        o('c5_villagers', 'Atingir 20 Aldeões', 'UNIT_COUNT', 'VILLAGER', 20)
      ],
      reward: { gold: 200, stone: 150, text: '+200 Ouro, +150 Pedra' }
    },
    {
      chapterIndex: 5, title: 'O Bastião de Ferro & Mestre Armeiro',
      subtitle: 'Proteja suas rotas comerciais contra os perigos da selva com armamentos avançados.',
      objectives: [
        o('c6_armorer', 'Formar 1 Armeiro na Faculdade', 'SPECIALIZATION_COUNT', 'ARMORER', 1),
        o('c6_archery', 'Construir o Campo de Tiro com Arco', 'BUILDING_COUNT', 'ARCHERY_RANGE', 1),
        o('c6_archers', 'Treinar 5 Arqueiros de guarda', 'UNIT_COUNT', 'ARCHER', 5),
        o('c6_towers', 'Erguer 2 Torres de Vigia fortificadas', 'BUILDING_COUNT', 'TOWER', 2)
      ],
      reward: { food: 200, gold: 100, text: '+200 Alimento, +100 Ouro' }
    },
    {
      chapterIndex: 6, title: 'A Rede de Abastecimento & Moinhos Regionais',
      subtitle: 'Uma metrópole não pode depender de um único celeiro. Decentralize a agricultura.',
      objectives: [
        o('c7_mills', 'Construir 3 Moinhos espalhados', 'BUILDING_COUNT', 'MILL', 3),
        o('c7_farms', 'Construir 8 Fazendas produtivas', 'BUILDING_COUNT', 'FARM', 8),
        o('c7_food', 'Acumular 1.000 de Alimento no tesouro', 'RESOURCE_ACCUMULATED', 'FOOD', 1000)
      ],
      reward: { wood: 300, gold: 200, text: '+300 Madeira, +200 Ouro' }
    },
    {
      chapterIndex: 7, title: 'A Capital da Sabedoria e Soberania Global',
      subtitle: 'Coroe os séculos de trabalho duro transformando sua colônia no farol da civilização.',
      objectives: [
        o('c8_alchemist', 'Formar 1 Alquimista na Faculdade', 'SPECIALIZATION_COUNT', 'ALCHEMIST', 1),
        o('c8_walls', 'Erguer 30 Muralhas e Portões de Pedra', 'BUILDING_WALLS_GATES', 'WALL_OR_GATE', 30),
        o('c8_pop', 'Atingir população de 40 habitantes', 'POPULATION_TOTAL', 'TOTAL', 40),
        o('c8_gold', 'Acumular 1.000 de Ouro no tesouro', 'RESOURCE_ACCUMULATED', 'GOLD', 1000)
      ],
      reward: { text: '🏆 Vitória Épica de Supremacia Pacífica!' }
    }
  ];
}

let peacefulChapters: ColonyChapter[] = createPeacefulChapters();
let currentChapterIndex = 0;
let lastQuestCheckTime = 0;
const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

function playQuestTone(notes: number[], step: number, dur: number, vol: number): void {
  const ctx = soundManager.ensureAudioContext();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const st = t0 + i * step;
    gain.gain.setValueAtTime(0.0001, st);
    gain.gain.exponentialRampToValueAtTime(vol, st + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(st);
    osc.stop(st + dur + 0.05);
  });
}
const playQuestItemComplete = () => playQuestTone([659.25, 987.77], 0.09, 0.35, 0.12);
const playQuestChapterFanfare = () => playQuestTone([523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5], 0.13, 0.6, 0.14);

function questFloat(text: string, color: string): void {
  spawnFloatingText(new THREE.Vector3(TC_WORLD_CENTER.x, 3.2, TC_WORLD_CENTER.z), text, color);
}

function renderQuestTrackerUI(): void {
  const tracker = document.getElementById('peaceful-quest-tracker');
  if (!tracker) return;
  const chapter = peacefulChapters[currentChapterIndex];
  if (!currentMatchConfig.peacefulMode || !chapter || currentGameState === 'MENU') {
    tracker.classList.add('hidden');
    return;
  }
  tracker.classList.remove('hidden');
  const badge = document.getElementById('quest-chapter-badge');
  const title = document.getElementById('quest-chapter-title');
  const desc = document.getElementById('quest-chapter-desc');
  const reward = document.getElementById('quest-reward-text');
  const list = document.getElementById('quest-objectives-list');
  if (badge) badge.textContent = `Capítulo ${ROMAN_NUMERALS[chapter.chapterIndex]}`;
  if (title) title.textContent = chapter.title;
  if (desc) desc.textContent = chapter.subtitle;
  if (reward) reward.textContent = chapter.reward.text;
  if (list) {
    const html = chapter.objectives.map(obj => `
      <li class="quest-item${obj.isCompleted ? ' completed' : ''}" data-quest-id="${obj.id}">
        <span class="quest-item-desc"><span class="quest-check-icon">${obj.isCompleted ? '✔' : '◻'}</span> ${obj.description}</span>
        <span class="quest-item-count">${obj.checkType === 'RESOURCE_ACCUMULATED' ? `${obj.currentCount}/${obj.targetCount}` : `${obj.currentCount}/${obj.targetCount}`}</span>
      </li>`).join('');
    if (list.innerHTML !== html) list.innerHTML = html;
  }
}

function completeChapter(chapter: ColonyChapter): void {
  playQuestChapterFanfare();
  const r = chapter.reward;
  if (r.wood) resources.wood += r.wood;
  if (r.food) resources.food += r.food;
  if (r.gold) resources.gold += r.gold;
  if (r.stone) resources.stone += r.stone;
  if (r.wood || r.food || r.gold || r.stone) questFloat(`🎁 ${r.text}`, '#4ade80');

  if (chapter.chapterIndex >= peacefulChapters.length - 1) {
    triggerGameOver('VICTORY', 'Sua colônia se tornou a mais próspera e admirada de todo o reino!');
    const titleEl = document.getElementById('game-over-title');
    if (titleEl) titleEl.textContent = '🏆 IMPERADOR DA PAZ E DA PROSPERIDADE!';
    return;
  }
  const tracker = document.getElementById('peaceful-quest-tracker');
  tracker?.classList.add('quest-chapter-transition');
  currentChapterIndex++;
  setTimeout(() => {
    renderQuestTrackerUI();
    tracker?.classList.remove('quest-chapter-transition');
  }, 450);
}

export function updatePeacefulQuests(): void {
  if (!currentMatchConfig.peacefulMode || isGameOver) { renderQuestTrackerUI(); return; }
  const chapter = peacefulChapters[currentChapterIndex];
  if (!chapter) return;
  let allCompleted = true;
  const myUnits = unitsList.filter(u => u.faction === 'PLAYER' && !u.isDying && u.hp > 0);

  chapter.objectives.forEach(obj => {
    if (obj.isCompleted) return;
    let count = 0;
    switch (obj.checkType) {
      case 'BUILDING_COUNT':
        count = buildingsList.filter(b => b.type === obj.targetType && b.faction === 'PLAYER' && b.isCompleted && (b.hp === undefined || b.hp > 0)).length;
        break;
      case 'BUILDING_WALLS_GATES':
        count = buildingsList.filter(b => (b.type === 'WALL' || b.type === 'GATE') && b.faction === 'PLAYER' && b.isCompleted && (b.hp === undefined || b.hp > 0)).length;
        break;
      case 'UNIT_COUNT':
        count = myUnits.filter(u => u.unitType === obj.targetType).length;
        break;
      case 'POPULATION_TOTAL':
        count = myUnits.length;
        break;
      case 'EDUCATION_COUNT':
        count = myUnits.filter(u => u.educationLevel >= 1).length;
        break;
      case 'SPECIALIZATION_COUNT':
        count = myUnits.filter(u => u.eliteSpecialization === obj.targetType || u.specialization === obj.targetType).length;
        break;
      case 'RESOURCE_ACCUMULATED':
        if (obj.targetType === 'GOLD') count = Math.floor(resources.gold);
        else if (obj.targetType === 'STONE') count = Math.floor(resources.stone);
        else if (obj.targetType === 'FOOD') count = Math.floor(resources.food);
        else if (obj.targetType === 'WOOD') count = Math.floor(resources.wood);
        break;
    }
    obj.currentCount = Math.min(obj.targetCount, count);
    if (obj.currentCount >= obj.targetCount) {
      obj.isCompleted = true;
      playQuestItemComplete();
      questFloat('✨ Objetivo Concluído!', '#4ade80');
    }
    if (!obj.isCompleted) allCompleted = false;
  });

  renderQuestTrackerUI();
  if (allCompleted) completeChapter(chapter);
}

export function resetPeacefulQuests(data?: { currentChapterIndex: number; completedObjectiveIds: string[] }): void {
  peacefulChapters = createPeacefulChapters();
  currentChapterIndex = Math.max(0, Math.min(data?.currentChapterIndex ?? 0, peacefulChapters.length - 1));
  const done = new Set(data?.completedObjectiveIds ?? []);
  peacefulChapters.forEach((ch, i) => ch.objectives.forEach(obj => {
    if (i < currentChapterIndex || done.has(obj.id)) { obj.isCompleted = true; obj.currentCount = obj.targetCount; }
  }));
  renderQuestTrackerUI();
}

document.getElementById('btn-toggle-quest-body')?.addEventListener('click', () => {
  const tracker = document.getElementById('peaceful-quest-tracker');
  if (!tracker) return;
  const collapsed = tracker.classList.toggle('collapsed');
  const arrow = document.getElementById('quest-toggle-arrow');
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
});

export function updateObjectiveHUD(): void {
  const objEl = document.getElementById('telemetry-objective');
  if (objEl) {
    if (currentMatchConfig.peacefulMode) {
      objEl.textContent = '🕊️ Modo Construtor Pacífico';
      objEl.style.color = '#38bdf8';
    } else {
      objEl.textContent = '⚔️ Destruir Centro da Cidade Inimigo';
      objEl.style.color = '#f59e0b';
    }
  }
}

const btnMapSizeSegments = Array.from(document.querySelectorAll<HTMLButtonElement>('#cfg-map-size-control .btn-segmented'));
const badgeMapSize = document.getElementById('val-map-size');

const inputRevealMap = document.getElementById('cfg-reveal-map') as HTMLInputElement | null;
const badgeRevealMap = document.getElementById('val-reveal-map');
const lblRevealMap = document.getElementById('lbl-reveal-map');

const btnGameModeSegments = Array.from(document.querySelectorAll<HTMLButtonElement>('#cfg-game-mode-control .btn-segmented'));
const badgeGameMode = document.getElementById('val-game-mode');

const popoverChkRevealMap = document.getElementById('popover-chk-reveal-map') as HTMLInputElement | null;
const popoverChkPeaceful = document.getElementById('popover-chk-peaceful') as HTMLInputElement | null;

let selectedModalMapSize = currentMatchConfig.mapSize;
let selectedModalPeacefulMode = currentMatchConfig.peacefulMode;

export function syncMatchConfigInputs(cfg: MatchConfig = currentMatchConfig): void {
  if (inputTcHp) inputTcHp.value = String(cfg.townCenterHp);
  if (badgeTcHp) badgeTcHp.textContent = `${cfg.townCenterHp} HP`;

  if (inputEnemyHp) inputEnemyHp.value = String(cfg.enemyCampHp);
  if (badgeEnemyHp) badgeEnemyHp.textContent = `${cfg.enemyCampHp} HP`;

  if (inputWoodTime) inputWoodTime.value = String(cfg.woodGatherTime);
  if (badgeWoodTime) badgeWoodTime.textContent = `${cfg.woodGatherTime.toFixed(1)}s`;

  if (inputStoneTime) inputStoneTime.value = String(cfg.stoneMiningTime);
  if (badgeStoneTime) badgeStoneTime.textContent = `${cfg.stoneMiningTime.toFixed(1)}s`;

  if (inputGoldTime) inputGoldTime.value = String(cfg.goldMiningTime);
  if (badgeGoldTime) badgeGoldTime.textContent = `${cfg.goldMiningTime.toFixed(1)}s`;

  if (inputTreeCap) inputTreeCap.value = String(cfg.treeCapacity);
  if (badgeTreeCap) badgeTreeCap.textContent = `${cfg.treeCapacity} 🪵`;

  if (inputStoneCap) inputStoneCap.value = String(cfg.stoneCapacity);
  if (badgeStoneCap) badgeStoneCap.textContent = `${cfg.stoneCapacity} 🪨`;

  if (inputGoldCap) inputGoldCap.value = String(cfg.goldCapacity);
  if (badgeGoldCap) badgeGoldCap.textContent = `${cfg.goldCapacity} 🪙`;

  if (inputSwordHp) inputSwordHp.value = String(cfg.swordsmanHp);
  if (badgeSwordHp) badgeSwordHp.textContent = `${cfg.swordsmanHp} HP`;

  if (inputSwordDmg) inputSwordDmg.value = String(cfg.swordsmanDamage);
  if (badgeSwordDmg) badgeSwordDmg.textContent = `${cfg.swordsmanDamage} Dano`;

  if (inputTrainTime) inputTrainTime.value = String(cfg.trainingTime);
  if (badgeTrainTime) badgeTrainTime.textContent = `${cfg.trainingTime.toFixed(1)}s`;

  if (inputInitWood) inputInitWood.value = String(cfg.initialWood);
  if (badgeInitWood) badgeInitWood.textContent = `${cfg.initialWood} 🪵`;

  if (inputCollegeTime) inputCollegeTime.value = String(cfg.collegeStudyDurationSec || 240);
  if (badgeCollegeTime) badgeCollegeTime.textContent = `${cfg.collegeStudyDurationSec || 240}s`;

  if (inputInvasionInterval) inputInvasionInterval.value = String(cfg.invasionIntervalMinutes || 3.0);
  if (badgeInvasionInterval) badgeInvasionInterval.textContent = `${(cfg.invasionIntervalMinutes || 3.0).toFixed(1)} min`;

  selectedModalMapSize = cfg.mapSize;
  if (badgeMapSize) badgeMapSize.textContent = `${cfg.mapSize}×${cfg.mapSize}`;
  for (const btn of btnMapSizeSegments) {
    const s = Number(btn.dataset.size);
    btn.classList.toggle('active', s === cfg.mapSize);
  }

  if (inputRevealMap) inputRevealMap.checked = cfg.revealWholeMap;
  if (badgeRevealMap) badgeRevealMap.textContent = cfg.revealWholeMap ? 'Todo Visível (Sem Névoa)' : 'Névoa Ativa';
  if (lblRevealMap) lblRevealMap.textContent = cfg.revealWholeMap ? 'Mapa Todo Visível (Sem Névoa de Guerra)' : 'Revelar Mapa Completo (Desativar Névoa de Guerra)';

  selectedModalPeacefulMode = cfg.peacefulMode;
  if (badgeGameMode) badgeGameMode.textContent = cfg.peacefulMode ? '🕊️ Construtor Pacífico' : '⚔️ Padrão';
  for (const btn of btnGameModeSegments) {
    const isPeaceful = btn.dataset.peaceful === 'true';
    btn.classList.toggle('active', isPeaceful === cfg.peacefulMode);
  }

  if (popoverChkRevealMap) popoverChkRevealMap.checked = cfg.revealWholeMap;
  if (popoverChkPeaceful) popoverChkPeaceful.checked = cfg.peacefulMode;
}

export function updateSettingsModalInteractability(isPlaying: boolean): void {
  const modal = document.getElementById('match-config-modal');
  if (!modal) return;

  // Seleciona todos os inputs, selects e botões de configuração que NÃO pertençam ao áudio ou ao rodapé de ações
  const structuralInputs = modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    'input:not(#settings-volume-slider):not([id*="sound"]):not([id*="audio"]), ' +
    'select:not([id*="sound"]):not([id*="audio"]), ' +
    '#tab-structures input, #tab-economy input, #tab-army input, #tab-world input, ' +
    '.btn-map-size-option, .config-switch input, ' +
    '#btn-reset-match-config'
  );

  structuralInputs.forEach((elem) => {
    elem.disabled = isPlaying;
    if (isPlaying) {
      elem.classList.add('input-locked-in-game');
    } else {
      elem.classList.remove('input-locked-in-game');
    }
  });

  // Abas estruturais (Estruturas, Economia, Exército, Terreno)
  const structuralTabs = modal.querySelectorAll<HTMLButtonElement>(
    '.config-tab-btn[data-tab="tab-structures"], ' +
    '.config-tab-btn[data-tab="tab-economy"], ' +
    '.config-tab-btn[data-tab="tab-army"], ' +
    '.config-tab-btn[data-tab="tab-world"]'
  );
  structuralTabs.forEach((tab) => {
    if (isPlaying) {
      tab.classList.add('input-locked-in-game');
    } else {
      tab.classList.remove('input-locked-in-game');
    }
  });

  // Alerta visual avisando que a partida está em andamento
  let inGameLockNotice = document.getElementById('settings-in-game-lock-notice');
  if (isPlaying) {
    if (!inGameLockNotice) {
      inGameLockNotice = document.createElement('div');
      inGameLockNotice.id = 'settings-in-game-lock-notice';
      inGameLockNotice.className = 'settings-lock-banner';
      inGameLockNotice.innerHTML = '🔒 <em>Configurações do mapa e regras estão travadas durante a partida. Apenas o áudio pode ser ajustado.</em>';
      const card = document.getElementById('match-config-card') || modal;
      const tabsNav = card.querySelector('.config-tabs-nav');
      if (tabsNav) {
        card.insertBefore(inGameLockNotice, tabsNav);
      } else {
        card.prepend(inGameLockNotice);
      }
    }
    inGameLockNotice.style.display = 'block';

    // Garante que a aba de Áudio esteja ativa por padrão durante o jogo
    const audioTabBtn = modal.querySelector<HTMLButtonElement>('.config-tab-btn[data-tab="tab-audio"]');
    const audioTabPane = document.getElementById('tab-audio');
    if (audioTabBtn && audioTabPane) {
      modal.querySelectorAll('.config-tab-btn').forEach((b) => b.classList.remove('active'));
      modal.querySelectorAll('.config-tab-pane').forEach((p) => p.classList.remove('active'));
      audioTabBtn.classList.add('active');
      audioTabPane.classList.add('active');
    }
  } else if (inGameLockNotice) {
    inGameLockNotice.style.display = 'none';
  }
}

export function openMatchConfigModal(isPlayingOverride?: boolean): void {
  isMatchConfigModalOpen = true;
  if (matchConfigModalEl) matchConfigModalEl.style.display = 'flex';

  const isPlaying = isPlayingOverride !== undefined ? isPlayingOverride : (hasMatchEverStarted && currentGameState === 'IN_GAME');
  updateSettingsModalInteractability(isPlaying);

  const settingsModalActions = document.getElementById('settings-modal-actions');
  if (isPlaying) {
    if (btnCloseMatchConfig) btnCloseMatchConfig.style.display = 'inline-flex';
    if (btnStartMatchLabel) btnStartMatchLabel.textContent = 'Salvar & Retomar';
    if (settingsModalActions) settingsModalActions.style.display = 'flex';
  } else {
    if (btnCloseMatchConfig) btnCloseMatchConfig.style.display = 'none';
    if (btnStartMatchLabel) btnStartMatchLabel.textContent = 'Iniciar Partida';
    if (settingsModalActions) settingsModalActions.style.display = 'none';
  }

  syncMatchConfigInputs(currentMatchConfig);
  updateAudioSettingsUI();
  closeEnginePopover();
}

export function closeMatchConfigModal(): void {
  isMatchConfigModalOpen = false;
  if (matchConfigModalEl) matchConfigModalEl.style.display = 'none';
}

export function applyAndStartMatchConfig(): void {
  const prevPeaceful = currentMatchConfig.peacefulMode;
  const prevReveal = currentMatchConfig.revealWholeMap;
  const newReveal = inputRevealMap ? inputRevealMap.checked : DEFAULT_MATCH_CONFIG.revealWholeMap;
  const newPeaceful = selectedModalPeacefulMode;

  currentMatchConfig.townCenterHp = Math.max(100, Math.min(2000, Number(inputTcHp?.value) || DEFAULT_MATCH_CONFIG.townCenterHp));
  currentMatchConfig.enemyCampHp = Math.max(50, Math.min(1000, Number(inputEnemyHp?.value) || DEFAULT_MATCH_CONFIG.enemyCampHp));
  currentMatchConfig.woodGatherTime = Math.max(0.5, Math.min(10.0, Number(inputWoodTime?.value) || DEFAULT_MATCH_CONFIG.woodGatherTime));
  currentMatchConfig.stoneMiningTime = Math.max(0.5, Math.min(10.0, Number(inputStoneTime?.value) || DEFAULT_MATCH_CONFIG.stoneMiningTime));
  currentMatchConfig.goldMiningTime = Math.max(0.5, Math.min(10.0, Number(inputGoldTime?.value) || DEFAULT_MATCH_CONFIG.goldMiningTime));
  currentMatchConfig.treeCapacity = Math.max(20, Math.min(500, Number(inputTreeCap?.value) || DEFAULT_MATCH_CONFIG.treeCapacity));
  currentMatchConfig.stoneCapacity = Math.max(50, Math.min(1000, Number(inputStoneCap?.value) || DEFAULT_MATCH_CONFIG.stoneCapacity));
  currentMatchConfig.goldCapacity = Math.max(50, Math.min(1000, Number(inputGoldCap?.value) || DEFAULT_MATCH_CONFIG.goldCapacity));
  currentMatchConfig.swordsmanHp = Math.max(20, Math.min(200, Number(inputSwordHp?.value) || DEFAULT_MATCH_CONFIG.swordsmanHp));
  currentMatchConfig.swordsmanDamage = Math.max(2, Math.min(40, Number(inputSwordDmg?.value) || DEFAULT_MATCH_CONFIG.swordsmanDamage));
  currentMatchConfig.trainingTime = Math.max(1.0, Math.min(15.0, Number(inputTrainTime?.value) || DEFAULT_MATCH_CONFIG.trainingTime));
  currentMatchConfig.initialWood = Math.max(0, Math.min(500, Number(inputInitWood?.value) || DEFAULT_MATCH_CONFIG.initialWood));
  currentMatchConfig.collegeStudyDurationSec = Math.max(10, Math.min(300, Number(inputCollegeTime?.value) || (DEFAULT_MATCH_CONFIG.collegeStudyDurationSec || 240)));
  currentMatchConfig.invasionIntervalMinutes = Math.max(1.0, Math.min(10.0, Number(inputInvasionInterval?.value) || DEFAULT_MATCH_CONFIG.invasionIntervalMinutes));
  currentMatchConfig.mapSize = selectedModalMapSize;
  currentMatchConfig.revealWholeMap = newReveal;
  currentMatchConfig.peacefulMode = newPeaceful;
  hasEnemyFaction = !newPeaceful;

  if (!hasMatchEverStarted) {
    hasMatchEverStarted = true;
    resources.wood = currentMatchConfig.initialWood;
    updateResourceHUD();

    townCenterState.maxHp = currentMatchConfig.townCenterHp;
    townCenterState.hp = currentMatchConfig.townCenterHp;
    updateTownCenterHpBar();

    if (currentMatchConfig.peacefulMode || currentMatchConfig.revealWholeMap || currentMatchConfig.mapSize !== mapSize) {
      restartGame(currentMatchConfig.mapSize);
    } else {
      if (enemyCampState) {
        enemyCampState.tentMaxHp = currentMatchConfig.enemyCampHp;
        enemyCampState.tentHp = currentMatchConfig.enemyCampHp;
        updateEnemyCampHpBar();
      }

      for (const tree of treesMap.values()) {
        tree.wood = currentMatchConfig.treeCapacity;
      }
      for (const mine of stoneMinesMap.values()) {
        mine.stone = currentMatchConfig.stoneCapacity;
        mine.maxStone = currentMatchConfig.stoneCapacity;
      }
      for (const mine of goldMinesMap.values()) {
        mine.gold = currentMatchConfig.goldCapacity;
        mine.maxGold = currentMatchConfig.goldCapacity;
      }

      setupGameCamera(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z);
      fogGrid.fill(FogState.UNEXPLORED);
      updateFogOfWar(true);
      updateEntitiesVisibility();
      renderMinimap();
    }
  } else {
    if (currentMatchConfig.mapSize !== mapSize || currentMatchConfig.peacefulMode !== prevPeaceful) {
      restartGame(currentMatchConfig.mapSize);
    } else {
      townCenterState.maxHp = currentMatchConfig.townCenterHp;
      townCenterState.hp = Math.min(townCenterState.hp, townCenterState.maxHp);
      updateTownCenterHpBar();

      if (enemyCampState) {
        enemyCampState.tentMaxHp = currentMatchConfig.enemyCampHp;
        enemyCampState.tentHp = Math.min(enemyCampState.tentHp, enemyCampState.tentMaxHp);
        updateEnemyCampHpBar();
      }

      for (const tree of treesMap.values()) {
        tree.wood = currentMatchConfig.treeCapacity;
      }
      for (const mine of stoneMinesMap.values()) {
        mine.stone = currentMatchConfig.stoneCapacity;
        mine.maxStone = currentMatchConfig.stoneCapacity;
      }
      for (const mine of goldMinesMap.values()) {
        mine.gold = currentMatchConfig.goldCapacity;
        mine.maxGold = currentMatchConfig.goldCapacity;
      }

      if (currentMatchConfig.revealWholeMap !== prevReveal) {
        if (currentMatchConfig.revealWholeMap) {
          fogGrid.fill(FogState.VISIBLE);
        } else {
          fogGrid.fill(FogState.UNEXPLORED);
        }
        updateFogOfWar(true);
        renderMinimap();
      }
    }
  }

  updateObjectiveHUD();
  closeMatchConfigModal();
  if (currentGameState === 'MENU') {
    currentGameState = 'IN_GAME';
    isGamePaused = false;
    hasMatchEverStarted = true;
    setUIMenuMode(false);
    if (menuDuelGroup) menuDuelGroup.visible = false;
  }
  if (!currentMatchConfig.revealWholeMap) {
    setupGameCamera(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z);
    updateFogOfWar(true);
    updateEntitiesVisibility();
    renderMinimap();
  }
  console.log('[MatchConfig] Configurações aplicadas:', currentMatchConfig);
}

function initMatchConfigModal(): void {
  inputTcHp?.addEventListener('input', () => {
    if (badgeTcHp && inputTcHp) badgeTcHp.textContent = `${inputTcHp.value} HP`;
  });
  inputEnemyHp?.addEventListener('input', () => {
    if (badgeEnemyHp && inputEnemyHp) badgeEnemyHp.textContent = `${inputEnemyHp.value} HP`;
  });
  inputWoodTime?.addEventListener('input', () => {
    if (badgeWoodTime && inputWoodTime) badgeWoodTime.textContent = `${Number(inputWoodTime.value).toFixed(1)}s`;
  });
  inputStoneTime?.addEventListener('input', () => {
    if (badgeStoneTime && inputStoneTime) badgeStoneTime.textContent = `${Number(inputStoneTime.value).toFixed(1)}s`;
  });
  inputGoldTime?.addEventListener('input', () => {
    if (badgeGoldTime && inputGoldTime) badgeGoldTime.textContent = `${Number(inputGoldTime.value).toFixed(1)}s`;
  });
  inputTreeCap?.addEventListener('input', () => {
    if (badgeTreeCap && inputTreeCap) badgeTreeCap.textContent = `${inputTreeCap.value} 🪵`;
  });
  inputStoneCap?.addEventListener('input', () => {
    if (badgeStoneCap && inputStoneCap) badgeStoneCap.textContent = `${inputStoneCap.value} 🪨`;
  });
  inputGoldCap?.addEventListener('input', () => {
    if (badgeGoldCap && inputGoldCap) badgeGoldCap.textContent = `${inputGoldCap.value} 🪙`;
  });
  inputSwordHp?.addEventListener('input', () => {
    if (badgeSwordHp && inputSwordHp) badgeSwordHp.textContent = `${inputSwordHp.value} HP`;
  });
  inputSwordDmg?.addEventListener('input', () => {
    if (badgeSwordDmg && inputSwordDmg) badgeSwordDmg.textContent = `${inputSwordDmg.value} Dano`;
  });
  inputTrainTime?.addEventListener('input', () => {
    if (badgeTrainTime && inputTrainTime) badgeTrainTime.textContent = `${Number(inputTrainTime.value).toFixed(1)}s`;
  });
  inputInitWood?.addEventListener('input', () => {
    if (badgeInitWood && inputInitWood) badgeInitWood.textContent = `${inputInitWood.value} 🪵`;
  });
  inputCollegeTime?.addEventListener('input', () => {
    if (badgeCollegeTime && inputCollegeTime) badgeCollegeTime.textContent = `${inputCollegeTime.value}s`;
  });
  inputInvasionInterval?.addEventListener('input', () => {
    if (badgeInvasionInterval && inputInvasionInterval) badgeInvasionInterval.textContent = `${Number(inputInvasionInterval.value).toFixed(1)} min`;
  });

  inputRevealMap?.addEventListener('change', () => {
    const checked = Boolean(inputRevealMap.checked);
    if (badgeRevealMap) badgeRevealMap.textContent = checked ? 'Todo Visível (Sem Névoa)' : 'Névoa Ativa';
    if (lblRevealMap) lblRevealMap.textContent = checked ? 'Mapa Todo Visível (Sem Névoa de Guerra)' : 'Revelar Mapa Completo (Desativar Névoa de Guerra)';
    if (popoverChkRevealMap) popoverChkRevealMap.checked = checked;
  });

  for (const segBtn of btnGameModeSegments) {
    segBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isPeaceful = segBtn.dataset.peaceful === 'true';
      selectedModalPeacefulMode = isPeaceful;
      for (const b of btnGameModeSegments) b.classList.toggle('active', b === segBtn);
      if (badgeGameMode) badgeGameMode.textContent = isPeaceful ? '🕊️ Construtor Pacífico' : '⚔️ Padrão';
      if (popoverChkPeaceful) popoverChkPeaceful.checked = isPeaceful;
    });
  }

  popoverChkRevealMap?.addEventListener('change', (e) => {
    e.stopPropagation();
    currentMatchConfig.revealWholeMap = Boolean(popoverChkRevealMap.checked);
    if (inputRevealMap) inputRevealMap.checked = currentMatchConfig.revealWholeMap;
    if (badgeRevealMap) badgeRevealMap.textContent = currentMatchConfig.revealWholeMap ? 'Todo Visível (Sem Névoa)' : 'Névoa Ativa';
    if (lblRevealMap) lblRevealMap.textContent = currentMatchConfig.revealWholeMap ? 'Mapa Todo Visível (Sem Névoa de Guerra)' : 'Revelar Mapa Completo (Desativar Névoa de Guerra)';
    if (currentMatchConfig.revealWholeMap) {
      fogGrid.fill(FogState.VISIBLE);
    } else {
      fogGrid.fill(FogState.UNEXPLORED);
    }
    updateFogOfWar(true);
    renderMinimap();
  });

  popoverChkPeaceful?.addEventListener('change', (e) => {
    e.stopPropagation();
    selectedModalPeacefulMode = Boolean(popoverChkPeaceful.checked);
    currentMatchConfig.peacefulMode = selectedModalPeacefulMode;
    hasEnemyFaction = !selectedModalPeacefulMode;
    if (badgeGameMode) badgeGameMode.textContent = selectedModalPeacefulMode ? '🕊️ Construtor Pacífico' : '⚔️ Padrão';
    for (const b of btnGameModeSegments) {
      b.classList.toggle('active', (b.dataset.peaceful === 'true') === selectedModalPeacefulMode);
    }
    updateObjectiveHUD();
  });

  for (const tabBtn of configTabBtns) {
    tabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = tabBtn.dataset.tab;
      for (const b of configTabBtns) b.classList.toggle('active', b === tabBtn);
      for (const p of configTabPanes) p.classList.toggle('active', p.id === targetId);
    });
  }

  for (const segBtn of btnMapSizeSegments) {
    segBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = Number(segBtn.dataset.size);
      if (isValidMapSize(s)) {
        selectedModalMapSize = s;
        for (const b of btnMapSizeSegments) b.classList.toggle('active', b === segBtn);
        if (badgeMapSize) badgeMapSize.textContent = `${s}×${s}`;
      }
    });
  }

  btnResetMatchConfig?.addEventListener('click', (e) => {
    e.stopPropagation();
    syncMatchConfigInputs(DEFAULT_MATCH_CONFIG);
  });

  btnStartMatch?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyAndStartMatchConfig();
  });

  btnCloseMatchConfig?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hasMatchEverStarted) {
      closeMatchConfigModal();
    }
  });

  btnOpenMatchConfig?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMatchConfigModal();
  });

  syncMatchConfigInputs(DEFAULT_MATCH_CONFIG);
  updateObjectiveHUD();
}

initMatchConfigModal();

// --- 18. SISTEMA DE VISÃO & FOG OF WAR (FoW) ---
/**
 * Revela células do grid dentro de um raio euclidiano a partir de um centro.
 */
function revealVisionCircle(centerX: number, centerZ: number, radius: number): void {
  const r2 = radius * radius;
  const minX = Math.max(-HALF_GRID, Math.floor(centerX - radius));
  const maxX = Math.min(HALF_GRID - 1, Math.floor(centerX + radius));
  const minZ = Math.max(-HALF_GRID, Math.floor(centerZ - radius));
  const maxZ = Math.min(HALF_GRID - 1, Math.floor(centerZ + radius));

  for (let gz = minZ; gz <= maxZ; gz++) {
    const dz = gz + 0.5 - centerZ;
    const dz2 = dz * dz;
    const rowOffset = (gz + HALF_GRID) * GRID_SIZE;
    for (let gx = minX; gx <= maxX; gx++) {
      const dx = gx + 0.5 - centerX;
      if (dx * dx + dz2 <= r2) {
        fogGrid[rowOffset + (gx + HALF_GRID)] = FogState.VISIBLE;
      }
    }
  }
}

let lastFogUpdate = 0;
const FOG_UPDATE_INTERVAL = 120; // ms (~8 Hz para excelente fluidez)

export function updateFogOfWar(force: boolean = false): void {
  const now = performance.now();
  if (!force && now - lastFogUpdate < FOG_UPDATE_INTERVAL) {
    return;
  }
  lastFogUpdate = now;

  if (currentMatchConfig.revealWholeMap) {
    fogGrid.fill(FogState.VISIBLE);
    const data = fogImageData.data;
    const len = GRID_SIZE * GRID_SIZE;
    for (let i = 0; i < len; i++) {
      const pIdx = i * 4;
      data[pIdx + 0] = 0;
      data[pIdx + 1] = 0;
      data[pIdx + 2] = 0;
      data[pIdx + 3] = 0;
    }
    fogCtx.putImageData(fogImageData, 0, 0);
    fogTexture.needsUpdate = true;

    for (const u of unitsList) {
      if (u.faction === 'ENEMY') {
        u.group.visible = !u.isDying;
        u.hpBarGroup.visible = !u.isDying;
      }
    }
    if (enemyCampGroup && enemyCampState) {
      enemyCampGroup.visible = !enemyCampState.isTentDestroyed;
      updateEnemyCampHpBar();
    }
    updateTownCenterHpBar();

    treesMap.forEach((tree) => { tree.group.visible = true; });
    berryBushesMap.forEach((bush) => { bush.group.visible = true; });
    stoneMinesMap.forEach((mine) => { mine.group.visible = true; });
    goldMinesMap.forEach((mine) => { mine.group.visible = true; });
    return;
  }

  // 1. Redefine todas as células VISIBLE para EXPLORED
  for (let i = 0; i < fogGrid.length; i++) {
    if (fogGrid[i] === FogState.VISIBLE) {
      fogGrid[i] = FogState.EXPLORED;
    }
  }

  // 2. Revela a visão a partir de todas as unidades e prédios aliados vivos
  // Town Center aliado (Raio 8)
  revealVisionCircle(TC_WORLD_CENTER.x, TC_WORLD_CENTER.z, 8);

  // Quartéis, Torres e demais prédios exclusivamente ALIADOS
  for (const b of buildingsList) {
    if ((b.faction === 'PLAYER' || (b.faction as string) === 'ALLIED' || !b.isEnemy) && !b.isDepleted) {
      const radius = b.type === 'TOWER' && b.isCompleted ? TOWER_VISION_RADIUS : 8;
      revealVisionCircle(b.gridX + b.size / 2, b.gridZ + b.size / 2, radius);
    }
  }

  // Unidades aliadas: Aldeão = 5 células, Soldados/Arqueiros = 6 células
  for (const u of unitsList) {
    if ((u.faction === 'PLAYER' || (u.faction as string) === 'ALLIED' || !u.isEnemy) && !u.isDying) {
      const radius = u.unitType === 'SWORDSMAN' || u.unitType === 'ARCHER' ? 6 : 5;
      revealVisionCircle(u.group.position.x, u.group.position.z, radius);
    }
  }

  // 3. Fallback de Segurança da Visão:
  // Se por qualquer motivo a lista de unidades estiver vazia durante o primeiro tick (ou unidades aliadas = 0),
  // garanta que uma área mínima de 8 células ao redor da coordenada inicial da base aliada seja revelada (fogState = VISIBLE),
  // impedindo que o canvas fique completamente encoberto de preto.
  let playerLivingUnits = 0;
  for (const u of unitsList) {
    if ((u.faction === 'PLAYER' || (u.faction as string) === 'ALLIED' || !u.isEnemy) && !u.isDying) {
      playerLivingUnits++;
    }
  }
  if (playerLivingUnits === 0 || force) {
    revealVisionCircle(tcCoord.minX + 1.5, tcCoord.minZ + 1.5, 8);
  }

  // 4. Atualiza a textura dinâmica da névoa no terreno (50x50)
  const data = fogImageData.data;
  for (let iz = 0; iz < GRID_SIZE; iz++) {
    for (let ix = 0; ix < GRID_SIZE; ix++) {
      const state = fogGrid[iz * GRID_SIZE + ix];
      const pIdx = (iz * GRID_SIZE + ix) * 4;
      if (state === FogState.UNEXPLORED) {
        // Totalmente preto / escuro
        data[pIdx + 0] = 6;
        data[pIdx + 1] = 8;
        data[pIdx + 2] = 12;
        data[pIdx + 3] = 255;
      } else if (state === FogState.EXPLORED) {
        // Névoa cinza translúcida (shroud descoberto anteriormente)
        data[pIdx + 0] = 14;
        data[pIdx + 1] = 18;
        data[pIdx + 2] = 26;
        data[pIdx + 3] = 175;
      } else {
        // VISIBLE: transparente (terreno totalmente visível)
        data[pIdx + 0] = 0;
        data[pIdx + 1] = 0;
        data[pIdx + 2] = 0;
        data[pIdx + 3] = 0;
      }
    }
  }
  fogCtx.putImageData(fogImageData, 0, 0);
  fogTexture.needsUpdate = true;

  // 5. Atualiza a visibilidade 3D e sombras de entidades e cenário
  updateEntitiesVisibility();
}

/**
 * Atualiza rigorosamente a visibilidade 3D e projeção de sombras de todas as entidades:
 * - Edifícios inimigos: visíveis apenas se a célula já foi explorada (EXPLORED ou VISIBLE).
 * - Unidades inimigas: visíveis apenas sob visão direta (VISIBLE).
 * - Objetos invisíveis têm castShadow desligado para evitar sombras fantasmas no chão.
 */
export function updateEntitiesVisibility(): void {
  // Se o mapa estiver no modo "Revelar Mapa Completo", tudo fica visível
  if (currentMatchConfig.revealWholeMap) {
    for (const b of buildingsList) {
      const bMesh = b.mesh ?? b.group;
      if (bMesh) {
        bMesh.visible = !b.isDepleted;
        bMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = !b.isDepleted;
        });
      }
      if (b.group && b.group !== bMesh) {
        b.group.visible = !b.isDepleted;
        b.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = !b.isDepleted;
        });
      }
      if (b.hpBarGroup) {
        b.hpBarGroup.visible = (b.hp ?? 0) < (b.maxHp ?? 1) && !b.isDepleted;
      }
    }
    for (const u of unitsList) {
      const uMesh = u.mesh ?? u.group;
      if (uMesh) {
        uMesh.visible = !u.isDying;
        uMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = !u.isDying;
        });
      }
      if (u.group && u.group !== uMesh) {
        u.group.visible = !u.isDying;
        u.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = !u.isDying;
        });
      }
      if (u.hpBarMesh) u.hpBarMesh.visible = !u.isDying && u.hp < u.maxHp;
      if (u.hpBarGroup && u.hpBarGroup !== u.hpBarMesh) u.hpBarGroup.visible = !u.isDying && u.hp < u.maxHp;
    }
    if (enemyCampGroup && enemyCampState) {
      enemyCampGroup.visible = !enemyCampState.isTentDestroyed || !!enemyTownCenterState?.ruinsGroup;
      enemyCampGroup.traverse((child: any) => {
        if (child.isMesh) child.castShadow = !enemyCampState.isTentDestroyed || !!enemyTownCenterState?.ruinsGroup;
      });
      if (enemyTownCenterState?.hpBarGroup) {
        enemyTownCenterState.hpBarGroup.visible = !enemyCampState.isTentDestroyed;
      }
      updateEnemyCampHpBar();
    }
    updateTownCenterHpBar();
    treesMap.forEach((tree) => { tree.group.visible = true; });
    berryBushesMap.forEach((bush) => { bush.group.visible = true; });
    stoneMinesMap.forEach((mine) => { mine.group.visible = true; });
    goldMinesMap.forEach((mine) => { mine.group.visible = true; });
    wallsList.forEach((wall) => { wall.group.visible = true; });
    return;
  }

  // 1. Edifícios Inimigos:
  // Só ficam visíveis se a célula já tiver sido pelo menos EXPLORADA (EXPLORED ou VISIBLE)
  for (const b of buildingsList) {
    const bMesh = b.mesh ?? b.group;
    if (b.faction === 'ENEMY' || b.isEnemy) {
      const fogState = getFogStateAt(b.gridX, b.gridZ);
      const isDiscovered = fogState === FogState.EXPLORED || fogState === FogState.VISIBLE || isBuildingDiscovered(b);
      const inDirectVision = fogState === FogState.VISIBLE || isBuildingDirectlyVisible(b);
      const isVisible = isDiscovered && !b.isDepleted;

      if (bMesh) {
        bMesh.visible = isVisible;
        // Evita que projete sombras enquanto invisível:
        bMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }
      if (b.group && b.group !== bMesh) {
        b.group.visible = isVisible;
        b.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }

      if (b.progressGroup) {
        b.progressGroup.visible = isVisible && !b.isCompleted;
      }
      if (b.hpBarGroup) {
        b.hpBarGroup.visible = inDirectVision && (b.hp ?? 0) < (b.maxHp ?? 1) && !b.isDepleted;
      }
    } else {
      // Edifícios aliados são sempre visíveis para o jogador
      const isVisible = !b.isDepleted;
      if (bMesh) {
        bMesh.visible = isVisible;
        bMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }
      if (b.group && b.group !== bMesh) {
        b.group.visible = isVisible;
        b.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }
      if (b.hpBarGroup) {
        b.hpBarGroup.visible = (b.hp ?? 0) < (b.maxHp ?? 1) && !b.isDepleted;
      }
    }
  }

  // 2. Town Center Inimigo (3x3):
  if (enemyCampGroup && enemyCampState) {
    const tcObj = { gridX: enemyCampCoord.x, gridZ: enemyCampCoord.z, size: enemyCampCoord.size };
    const fogState = getFogStateAt(enemyCampCoord.x + 1, enemyCampCoord.z + 1);
    const isDiscovered = fogState === FogState.EXPLORED || fogState === FogState.VISIBLE || isBuildingDiscovered(tcObj);
    const inDirectVision = fogState === FogState.VISIBLE || isBuildingDirectlyVisible(tcObj);
    const isVisible = isDiscovered && (!enemyCampState.isTentDestroyed || !!enemyTownCenterState?.ruinsGroup);

    enemyCampGroup.visible = isVisible;
    enemyCampGroup.traverse((child: any) => {
      if (child.isMesh) child.castShadow = isVisible;
    });

    if (enemyTownCenterState?.hpBarGroup) {
      enemyTownCenterState.hpBarGroup.visible = inDirectVision && !enemyCampState.isTentDestroyed;
    }
    updateEnemyCampHpBar();
  }
  updateTownCenterHpBar();

  // 3. Unidades Inimigas (Aldeões e Soldados):
  // Regra RTS clássica: Unidades móveis inimigas SÓ ficam visíveis se estiverem em linha de visão DIRETA (FogState.VISIBLE)!
  // Se estiverem sob a névoa cinza (EXPLORED) ou no escuro (UNEXPLORED), ficam 100% INVISÍVEIS.
  for (const u of unitsList) {
    const uMesh = u.mesh ?? u.group;
    if (u.faction === 'ENEMY' || u.isEnemy) {
      const gx = Math.round(u.gridX ?? u.group.position.x);
      const gz = Math.round(u.gridZ ?? u.group.position.z);
      const fogState = getFogStateAt(gx, gz);
      const inDirectVision = !u.isDying && fogState === FogState.VISIBLE;

      if (uMesh) {
        uMesh.visible = inDirectVision;
        uMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = inDirectVision;
        });
      }
      if (u.group && u.group !== uMesh) {
        u.group.visible = inDirectVision;
        u.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = inDirectVision;
        });
      }

      // Oculta também barra de vida flutuante se houver
      if (u.hpBarMesh) u.hpBarMesh.visible = inDirectVision;
      if (u.hpBarGroup && u.hpBarGroup !== u.hpBarMesh) u.hpBarGroup.visible = inDirectVision;
    } else {
      // Unidades aliadas são sempre visíveis
      const isVisible = !u.isDying;
      if (uMesh) {
        uMesh.visible = isVisible;
        uMesh.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }
      if (u.group && u.group !== uMesh) {
        u.group.visible = isVisible;
        u.group.traverse((child: any) => {
          if (child.isMesh) child.castShadow = isVisible;
        });
      }
    }
  }

  // 4. Recursos e Cenário
  treesMap.forEach((tree) => {
    tree.group.visible = getFogStateAt(tree.gridX, tree.gridZ) !== FogState.UNEXPLORED;
  });
  berryBushesMap.forEach((bush) => {
    bush.group.visible = getFogStateAt(bush.gridX, bush.gridZ) !== FogState.UNEXPLORED;
  });
  stoneMinesMap.forEach((mine) => {
    mine.group.visible = getFogStateAt(mine.gridX, mine.gridZ) !== FogState.UNEXPLORED;
  });
  goldMinesMap.forEach((mine) => {
    mine.group.visible = getFogStateAt(mine.gridX, mine.gridZ) !== FogState.UNEXPLORED;
  });
  wallsList.forEach((wall) => {
    wall.group.visible = getFogStateAt(wall.gridX, wall.gridZ) !== FogState.UNEXPLORED;
  });
}

// --- 19. MINIMAPA INTERATIVO EM CANVAS 2D (160x160) ---
const minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
const minimapCoordsEl = document.getElementById('minimap-coords');

const frustumV1 = new THREE.Vector3();
const frustumV2 = new THREE.Vector3();
const frustumV3 = new THREE.Vector3();
const frustumV4 = new THREE.Vector3();
const frustumDir = new THREE.Vector3();

/**
 * Projeta um ponto NDC (-1 a 1) no plano do chão (y = 0) na perspectiva ortográfica da câmera.
 */
function getFrustumCornerOnGround(ndcX: number, ndcY: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(ndcX, ndcY, 0).unproject(camera);
  camera.getWorldDirection(frustumDir);
  if (Math.abs(frustumDir.y) > 0.0001) {
    const t = -out.y / frustumDir.y;
    out.addScaledVector(frustumDir, t);
  }
  return out;
}

function drawCameraFrustumOnMinimap(ctx: CanvasRenderingContext2D, tilePx: number): void {
  getFrustumCornerOnGround(-1, 1, frustumV1);  // Canto Superior Esquerdo
  getFrustumCornerOnGround(1, 1, frustumV2);   // Canto Superior Direito
  getFrustumCornerOnGround(1, -1, frustumV3);  // Canto Inferior Direito
  getFrustumCornerOnGround(-1, -1, frustumV4); // Canto Inferior Esquerdo

  const p1x = (frustumV1.x + HALF_GRID) * tilePx;
  const p1y = (frustumV1.z + HALF_GRID) * tilePx;
  const p2x = (frustumV2.x + HALF_GRID) * tilePx;
  const p2y = (frustumV2.z + HALF_GRID) * tilePx;
  const p3x = (frustumV3.x + HALF_GRID) * tilePx;
  const p3y = (frustumV3.z + HALF_GRID) * tilePx;
  const p4x = (frustumV4.x + HALF_GRID) * tilePx;
  const p4y = (frustumV4.z + HALF_GRID) * tilePx;

  ctx.beginPath();
  ctx.moveTo(p1x, p1y);
  ctx.lineTo(p2x, p2y);
  ctx.lineTo(p3x, p3y);
  ctx.lineTo(p4x, p4y);
  ctx.closePath();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

export function renderMinimap(): void {
  if (!minimapCanvas || !minimapCtx) return;

  const w = minimapCanvas.width;  // 160
  const h = minimapCanvas.height; // 160
  const tilePx = w / GRID_SIZE;   // 3.2 px por ladrilho

  minimapCtx.save();
  minimapCtx.clearRect(0, 0, w, h);

  // 1. Grade e Névoa (Células inexploradas ficam pretas)
  minimapCtx.fillStyle = '#06080c';
  minimapCtx.fillRect(0, 0, w, h);

  const dotSize = Math.max(2, Math.round(tilePx));

  for (let iz = 0; iz < GRID_SIZE; iz++) {
    for (let ix = 0; ix < GRID_SIZE; ix++) {
      const state = fogGrid[iz * GRID_SIZE + ix];
      if (state === FogState.UNEXPLORED) continue;

      const x0 = Math.floor(ix * tilePx);
      const y0 = Math.floor(iz * tilePx);
      const x1 = Math.ceil((ix + 1) * tilePx);
      const y1 = Math.ceil((iz + 1) * tilePx);
      const gx = ix - HALF_GRID;
      const gz = iz - HALF_GRID;
      const isCliff = cliffCellsSet.has(cellKey(gx, gz));
      const cellH = getCellHeight(gx, gz);

      if (isCliff) {
        minimapCtx.fillStyle = state === FogState.EXPLORED ? '#334155' : '#64748b';
      } else if (cellH > 1.0) {
        minimapCtx.fillStyle = state === FogState.EXPLORED ? '#1e293b' : '#334155';
      } else if (cellH > 0.3) {
        minimapCtx.fillStyle = state === FogState.EXPLORED ? '#162332' : '#253549';
      } else {
        minimapCtx.fillStyle = state === FogState.EXPLORED ? '#111721' : '#1e293b';
      }
      minimapCtx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
  }

  // 2. Pontos verdes: Árvores (apenas se reveladas)
  treesMap.forEach((tree) => {
    const ix = tree.gridX + HALF_GRID;
    const iz = tree.gridZ + HALF_GRID;
    const state = fogGrid[iz * GRID_SIZE + ix];
    if (state === FogState.UNEXPLORED) return;

    minimapCtx.fillStyle = state === FogState.EXPLORED ? '#15803d' : '#22c55e';
    minimapCtx.fillRect(Math.floor(ix * tilePx), Math.floor(iz * tilePx), dotSize, dotSize);
  });

  // 2.5. Pontos vermelhos/framboesa: Arbustos de Frutas (apenas se revelados)
  berryBushesMap.forEach((bush) => {
    const ix = bush.gridX + HALF_GRID;
    const iz = bush.gridZ + HALF_GRID;
    const state = fogGrid[iz * GRID_SIZE + ix];
    if (state === FogState.UNEXPLORED) return;

    minimapCtx.fillStyle = state === FogState.EXPLORED ? '#b91c1c' : '#ef4444';
    minimapCtx.fillRect(Math.floor(ix * tilePx), Math.floor(iz * tilePx), dotSize, dotSize);
  });

  // 2.7. Pontos cinza-ardósia: Jazidas de Pedra (apenas se reveladas)
  stoneMinesMap.forEach((mine) => {
    const ix = mine.gridX + HALF_GRID;
    const iz = mine.gridZ + HALF_GRID;
    const state = fogGrid[iz * GRID_SIZE + ix];
    if (state === FogState.UNEXPLORED) return;

    minimapCtx.fillStyle = state === FogState.EXPLORED ? '#475569' : '#94a3b8';
    minimapCtx.fillRect(Math.floor(ix * tilePx), Math.floor(iz * tilePx), dotSize, dotSize);
  });

  // 2.8. Pontos dourados: Minas de Ouro (apenas se reveladas)
  goldMinesMap.forEach((mine) => {
    const ix = mine.gridX + HALF_GRID;
    const iz = mine.gridZ + HALF_GRID;
    const state = fogGrid[iz * GRID_SIZE + ix];
    if (state === FogState.UNEXPLORED) return;

    minimapCtx.fillStyle = state === FogState.EXPLORED ? '#ca8a04' : '#facc15';
    minimapCtx.fillRect(Math.floor(ix * tilePx), Math.floor(iz * tilePx), dotSize, dotSize);
  });

  // 3. Pontos cinzas: Paredes (apenas se reveladas)
  for (const wall of wallsList) {
    const ix = wall.gridX + HALF_GRID;
    const iz = wall.gridZ + HALF_GRID;
    const state = fogGrid[iz * GRID_SIZE + ix];
    if (state === FogState.UNEXPLORED) continue;

    minimapCtx.fillStyle = state === FogState.EXPLORED ? '#64748b' : '#94a3b8';
    minimapCtx.fillRect(Math.floor(ix * tilePx), Math.floor(iz * tilePx), dotSize, dotSize);
  }

  // 4. Edifícios do Jogador (Azuis/Âmbar): Town Center (3x3), Quartéis (2x2) e Torres de Vigia (1x1)
  // Town Center (se não destruído)
  if (!townCenterState.isDestroyed) {
    const tcPx = Math.floor((tcCoord.minX + HALF_GRID) * tilePx);
    const tcPz = Math.floor((tcCoord.minZ + HALF_GRID) * tilePx);
    const tcW = Math.max(4, Math.ceil(3 * tilePx));
    minimapCtx.fillStyle = '#2563eb';
    minimapCtx.fillRect(tcPx, tcPz, tcW, tcW);
    minimapCtx.strokeStyle = '#60a5fa';
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(tcPx, tcPz, tcW, tcW);
  }

  // 4. Edifícios
  for (const b of buildingsList) {
    if (b.isDepleted) continue;

    const bPx = Math.floor((b.gridX + HALF_GRID) * tilePx);
    const bPz = Math.floor((b.gridZ + HALF_GRID) * tilePx);
    const bW = Math.max(2, Math.ceil(b.size * tilePx));

    // EDIFÍCIOS INIMIGOS: só aparecem no minimapa se já explorados (EXPLORED ou VISIBLE)
    if (b.faction === 'ENEMY' || b.isEnemy) {
      const fog = getFogStateAt(b.gridX, b.gridZ);
      const isDiscovered = currentMatchConfig.revealWholeMap || fog === FogState.EXPLORED || fog === FogState.VISIBLE || isBuildingDiscovered(b);
      if (isDiscovered) {
        minimapCtx.fillStyle = '#dc2626';
        minimapCtx.fillRect(bPx, bPz, bW, bW);
        minimapCtx.strokeStyle = '#f87171';
        minimapCtx.lineWidth = 1;
        minimapCtx.strokeRect(bPx, bPz, bW, bW);
      }
      continue;
    }

    // EDIFÍCIOS ALIADOS:
    if (b.type === 'TOWER') {
      minimapCtx.fillStyle = '#f59e0b';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#fbbf24';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'LUMBER_CAMP') {
      minimapCtx.fillStyle = '#b45309';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#f59e0b';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'MINING_CAMP') {
      minimapCtx.fillStyle = '#64748b';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#cbd5e1';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'HOUSE') {
      minimapCtx.fillStyle = '#d97706';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#fde68a';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'MILL') {
      minimapCtx.fillStyle = '#d97706';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#fef08a';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'FARM') {
      minimapCtx.fillStyle = b.isDepleted ? '#78350f' : '#eab308';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = b.isDepleted ? '#92400e' : '#fef08a';
    } else if (b.type === 'WALL') {
      minimapCtx.fillStyle = '#64748b';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#94a3b8';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'GATE') {
      const gw = Math.max(3, Math.ceil((b.sizeX || 2) * tilePx));
      const gh = Math.max(2, Math.ceil((b.sizeZ || 1) * tilePx));
      minimapCtx.fillStyle = '#78350f';
      minimapCtx.fillRect(bPx, bPz, gw, gh);
      minimapCtx.strokeStyle = '#f59e0b';
      minimapCtx.strokeRect(bPx, bPz, gw, gh);
    } else if (b.type === 'SCHOOL') {
      minimapCtx.fillStyle = '#8b5cf6';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#a78bfa';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else if (b.type === 'COLLEGE') {
      minimapCtx.fillStyle = '#6366f1';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#818cf8';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    } else {
      minimapCtx.fillStyle = '#3b82f6';
      minimapCtx.fillRect(bPx, bPz, bW, bW);
      minimapCtx.strokeStyle = '#93c5fd';
      minimapCtx.strokeRect(bPx, bPz, bW, bW);
    }
  }

  // 5. Town Center Inimigo (Vermelho): só aparece no minimapa se a área foi explorada (EXPLORED ou VISIBLE)
  if (enemyCampState && !enemyCampState.isTentDestroyed && isCellInside(enemyCampCoord.x, enemyCampCoord.z)) {
    const fog = getFogStateAt(enemyCampCoord.x + 1, enemyCampCoord.z + 1);
    const isCampDiscovered = currentMatchConfig.revealWholeMap || fog === FogState.EXPLORED || fog === FogState.VISIBLE || isBuildingDiscovered({ gridX: enemyCampCoord.x, gridZ: enemyCampCoord.z, size: enemyCampCoord.size });
    if (isCampDiscovered) {
      const cPx = Math.floor((enemyCampCoord.x + HALF_GRID) * tilePx);
      const cPz = Math.floor((enemyCampCoord.z + HALF_GRID) * tilePx);
      const cW = Math.max(3, Math.ceil(enemyCampCoord.size * tilePx));
      minimapCtx.fillStyle = '#dc2626';
      minimapCtx.fillRect(cPx, cPz, cW, cW);
      minimapCtx.strokeStyle = '#f87171';
      minimapCtx.lineWidth = 1;
      minimapCtx.strokeRect(cPx, cPz, cW, cW);
    }
  }

  // 6. Pontos de Unidades
  // Unidades do jogador (azuis)
  for (const u of unitsList) {
    if ((u.faction === 'PLAYER' || (u.faction as string) === 'ALLIED' || !u.isEnemy) && !u.isDying) {
      const ux = (u.group.position.x + HALF_GRID) * tilePx;
      const uz = (u.group.position.z + HALF_GRID) * tilePx;
      minimapCtx.beginPath();
      minimapCtx.arc(ux, uz, u.unitType === 'SWORDSMAN' ? 2.8 : 2.2, 0, Math.PI * 2);
      minimapCtx.fillStyle = u.unitType === 'SWORDSMAN' ? '#38bdf8' : '#60a5fa';
      minimapCtx.fill();
      minimapCtx.strokeStyle = '#ffffff';
      minimapCtx.lineWidth = 0.8;
      minimapCtx.stroke();
    }
  }

  // Unidades inimigas (pontos vermelhos - apenas se estiverem em visão DIRETA / VISIBLE)
  for (const u of unitsList) {
    if ((u.faction === 'ENEMY' || u.isEnemy) && !u.isDying) {
      const gx = Math.round(u.gridX ?? u.group.position.x);
      const gz = Math.round(u.gridZ ?? u.group.position.z);
      const fog = getFogStateAt(gx, gz);
      if (currentMatchConfig.revealWholeMap || fog === FogState.VISIBLE) {
        const ux = (u.group.position.x + HALF_GRID) * tilePx;
        const uz = (u.group.position.z + HALF_GRID) * tilePx;
        minimapCtx.beginPath();
        minimapCtx.arc(ux, uz, 2.8, 0, Math.PI * 2);
        minimapCtx.fillStyle = '#ef4444';
        minimapCtx.fill();
        minimapCtx.strokeStyle = '#fecaca';
        minimapCtx.lineWidth = 0.8;
        minimapCtx.stroke();
      }
    }
  }

  // 6.5 Efeito de Pulso de Alerta de Invasão no Minimapa
  const alertRemaining = invasionAlertEndTime - performance.now();
  if (alertRemaining > 0) {
    const isCampDiscovered = currentMatchConfig.revealWholeMap || isBuildingDiscovered({ gridX: enemyCampCoord.x, gridZ: enemyCampCoord.z, size: enemyCampCoord.size });
    const elapsed = 7500 - alertRemaining;

    // Só exibe radar do acampamento se já descoberto
    if (isCampDiscovered) {
      const campPx = (enemyCampCoord.x + 1 + HALF_GRID) * tilePx;
      const campPz = (enemyCampCoord.z + 1 + HALF_GRID) * tilePx;

      for (let i = 0; i < 3; i++) {
        const wavePhase = (elapsed * 0.035 + i * 12) % 36;
        const waveAlpha = Math.max(0, 0.9 - wavePhase / 36);
        minimapCtx.beginPath();
        minimapCtx.arc(campPx, campPz, wavePhase, 0, Math.PI * 2);
        minimapCtx.strokeStyle = `rgba(239, 68, 68, ${waveAlpha.toFixed(2)})`;
        minimapCtx.lineWidth = 1.8;
        minimapCtx.stroke();
      }
    }

    // Marcadores pulsantes sobre soldados invasores em marcha (apenas se em visão direta)
    for (const u of unitsList) {
      if ((u.faction === 'ENEMY' || u.isEnemy) && u.isEnemyInvader && !u.isDying) {
        const gx = Math.round(u.group.position.x);
        const gz = Math.round(u.group.position.z);
        if (currentMatchConfig.revealWholeMap || getFogStateAt(gx, gz) === FogState.VISIBLE) {
          const ux = (u.group.position.x + HALF_GRID) * tilePx;
          const uz = (u.group.position.z + HALF_GRID) * tilePx;
          const pSize = 4.0 + Math.sin(elapsed * 0.016) * 2.2;
          minimapCtx.beginPath();
          minimapCtx.arc(ux, uz, pSize, 0, Math.PI * 2);
          minimapCtx.strokeStyle = 'rgba(239, 68, 68, 0.95)';
          minimapCtx.lineWidth = 1.6;
          minimapCtx.stroke();
        }
      }
    }
  }

  // 7. Retângulo de Frustum da Câmera
  drawCameraFrustumOnMinimap(minimapCtx, tilePx);

  minimapCtx.restore();
}

/**
 * Navegação por Clique/Arrasto no Minimapa:
 * Reposiciona a câmera instantaneamente no ponto correspondente do mapa.
 */
function navigateFromMinimap(e: PointerEvent | MouseEvent): void {
  if (!minimapCanvas) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const rawX = e.clientX - rect.left;
  const rawY = e.clientY - rect.top;
  const clampedX = THREE.MathUtils.clamp(rawX, 0, rect.width);
  const clampedY = THREE.MathUtils.clamp(rawY, 0, rect.height);

  const worldX = (clampedX / rect.width) * GRID_SIZE - HALF_GRID;
  const worldZ = (clampedY / rect.height) * GRID_SIZE - HALF_GRID;

  targetDesired.set(worldX, 0, worldZ);
  clampCameraTarget(targetDesired);
  cameraTarget.copy(targetDesired);
  updateCameraTransform();

  if (minimapCoordsEl) {
    minimapCoordsEl.textContent = `[${Math.floor(targetDesired.x)}, ${Math.floor(targetDesired.z)}]`;
  }
}

let isMinimapInteracting = false;

if (minimapCanvas) {
  minimapCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button === 0) {
      isMinimapInteracting = true;
      try {
        minimapCanvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      navigateFromMinimap(e);
      e.stopPropagation();
      e.preventDefault();
    }
  });

  minimapCanvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (isMinimapInteracting) {
      navigateFromMinimap(e);
      e.stopPropagation();
      e.preventDefault();
    } else {
      const rect = minimapCanvas.getBoundingClientRect();
      const rawX = THREE.MathUtils.clamp(e.clientX - rect.left, 0, rect.width);
      const rawY = THREE.MathUtils.clamp(e.clientY - rect.top, 0, rect.height);
      const wx = Math.floor((rawX / rect.width) * GRID_SIZE - HALF_GRID);
      const wz = Math.floor((rawY / rect.height) * GRID_SIZE - HALF_GRID);
      if (minimapCoordsEl) {
        minimapCoordsEl.textContent = `[${wx}, ${wz}]`;
      }
    }
  });

  const stopMinimapInteraction = (e: PointerEvent) => {
    if (isMinimapInteracting) {
      isMinimapInteracting = false;
      try {
        minimapCanvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      e.stopPropagation();
      e.preventDefault();
    }
  };

  minimapCanvas.addEventListener('pointerup', stopMinimapInteraction);
  minimapCanvas.addEventListener('pointercancel', stopMinimapInteraction);
  minimapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  minimapCanvas.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length === 1) {
      navigateFromMinimap(e.touches[0] as any);
      e.stopPropagation();
      e.preventDefault();
    }
  }, { passive: false });

  minimapCanvas.addEventListener('touchmove', (e: TouchEvent) => {
    if (e.touches.length === 1) {
      navigateFromMinimap(e.touches[0] as any);
      e.stopPropagation();
      e.preventDefault();
    }
  }, { passive: false });
}

// Expor helpers de depuração no window
(window as any).rts = {
  resources,
  addWood: (n: number) => {
    resources.wood += n;
    updateResourceHUD(true);
    return resources.wood;
  },
  unitsList,
  buildingsList,
  wallsList,
  fogGrid,
  FogState,
  gameStats,
  townCenterState,
  get enemyCampState() { return enemyCampState; },
  enemyResources,
  findNearestDropoffPoint,
  damageEnemyTent,
  destroyEnemyTent,
  damageTownCenter,
  destroyTownCenter,
  triggerInvasion,
  restartGame,
  togglePause: toggleGamePause,
  get isPaused() { return isGamePaused; },
  triggerGameOver,
  checkGameOverConditions,
  revealAll: () => {
    fogGrid.fill(FogState.VISIBLE);
    updateFogOfWar(true);
    renderMinimap();
  },
  resetFog: () => {
    fogGrid.fill(FogState.UNEXPLORED);
    updateFogOfWar(true);
    renderMinimap();
  },
  addStone: (n: number) => {
    resources.stone += n;
    updateResourceHUD(true);
    return resources.stone;
  },
  enterPlacementMode,
  exitPlacementMode,
  placeBarracks,
  placeTower,
  placeMill,
  placeFarm,
  placeSchool,
  placeCollege,
  placeWall,
  placeGate,
  hasLivingArchitect,
  getLivingArchitectsCount,
  hasLivingAgronomist,
  hasLivingArmorer,
  updateSwordsmenArmorerBuff,
  commandEnrollInSchool,
  commandEnrollInCollege,
  graduateStudent,
  graduateCollegeStudent,
  ejectStudent,
  ejectCollegeStudent,
  ejectAllStudents,
  ejectAllCollegeStudents,
  destroySchool,
  destroyCollege,
  destroyWall,
  destroyGate,
  commandFarm,
  reseedFarm,
  depleteFarm,
  addFood: (n: number) => {
    resources.food += n;
    updateResourceHUD(true);
    return resources.food;
  },
  selectBuilding,
  deselectBuilding,
  trainSwordsman,
  completeBuilding: (building: ConstructionBuilding) => {
    building.progress = 100;
    building.isCompleted = true;
    soundManager.buildingComplete();
    building.siteGroup.visible = false;
    building.progressGroup.visible = false;
    building.finishedGroup.visible = true;
    building.finishedGroup.scale.set(1, 1, 1);
    building.group.visible = true;
    if (building.type === 'WALL') {
      updateWallConnections(building);
      building.finishedGroup.visible = true;
      building.group.visible = true;
    } else if (building.type === 'GATE') {
      rebuildWallNeighbors(building.gridX - 1, building.gridZ);
      rebuildWallNeighbors(building.gridX + 2, building.gridZ);
      building.finishedGroup.visible = true;
      building.group.visible = true;
    }
    updateResourceHUD();
  },
  soundManager
};

(window as any).soundManager = soundManager;

// --- 17.5. PROJÉTEIS DA TORRE DE VIGIA (DEFESA AUTOMATIZADA) ---
interface TowerProjectile {
  mesh: THREE.Mesh;
  startPos: THREE.Vector3;
  targetUnit: RTSUnit;
  progress: number;
  duration: number;
  startTime: number;
}
const towerProjectiles: TowerProjectile[] = [];

function fireTowerArrow(tower: ConstructionBuilding, target: RTSUnit, now: number) {
  const arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.45, 6);
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
  const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);

  const startPos = tower.worldCenter.clone().setY(2.1);
  arrowMesh.position.copy(startPos);
  const targetPos = target.group.position.clone().add(new THREE.Vector3(0, 0.45, 0));
  arrowMesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    targetPos.clone().sub(startPos).normalize()
  );
  scene.add(arrowMesh);

  towerProjectiles.push({
    mesh: arrowMesh,
    startPos,
    targetUnit: target,
    progress: 0,
    duration: 0.26,
    startTime: now
  });
}

// --- SISTEMA DE OCLUSÃO & TRANSPARÊNCIA DINÂMICA DE EDIFÍCIOS (EFEITO X-RAY) ---
const FADE_MIN_OPACITY = 0.35;
const FADE_SPEED = 7.5; // velocidade de transição suave (~0.18s)

/**
 * Determina se uma posição no plano de chão (ou unidade/cursor)
 * está situada no cone de oclusão imediatamente atrás de uma estrutura
 * em relação à câmera isométrica ortográfica (vetor de visada em direção a -X, -Y, -Z).
 */
function isPositionBehindStructure(
  px: number,
  pz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  height: number,
  margin = 0.45
): boolean {
  // A estrutura só pode estar entre o ponto e a câmera (+X, +Z)
  // se o ponto estiver antes das coordenadas máximas frontais
  if (px >= maxX + margin || pz >= maxZ + margin) return false;

  // Raio do chão em direção à câmera (+1, +1, +1)
  const tMin = Math.max(minX - margin - px, minZ - margin - pz, 0);
  const tMax = Math.min(maxX + margin - px, maxZ + margin - pz, height);

  // O raio deve interceptar o volume da estrutura e o ponto deve estar na face posterior/lateral
  return tMin <= tMax && (px < minX + margin || pz < minZ + margin);
}

/**
 * Verifica se o cursor do mouse está sobre o telhado/parte alta de uma estrutura.
 */
function isCursorOverRoof(group: THREE.Object3D, minHeight = 1.0): boolean {
  if (!isMouseInsideWindow || mousePos.x < 0 || mousePos.y < 0) return false;
  setPointerNDC(mousePos.x, mousePos.y);
  const hits = raycaster.intersectObject(group, true);
  if (hits.length > 0) {
    return hits[0].point.y >= minHeight;
  }
  return false;
}

/**
 * Aplica a opacidade aos materiais de um edifício,
 * preservando barras de HP, barras de progresso e anéis de seleção.
 */
function applyBuildingOpacity(group: THREE.Object3D, opacity: number) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      if (child.name === 'tc-ruin' || child.name === 'selection-mesh') return;
      if (
        child.parent &&
        (child.parent.name === 'hp-bar' ||
          child.parent.name === 'progress-bar' ||
          child.parent.name === 'training-bar')
      ) {
        return;
      }

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat || !('opacity' in mat)) continue;

        if (mat.userData.origOpacity === undefined) {
          mat.userData.origOpacity = mat.opacity !== undefined ? mat.opacity : 1.0;
          mat.userData.origTransparent = !!mat.transparent;
        }

        const baseOp = mat.userData.origOpacity;
        mat.opacity = baseOp * opacity;

        if (opacity < 0.99) {
          mat.transparent = true;
          mat.depthWrite = false;
        } else {
          mat.transparent = mat.userData.origTransparent;
          mat.depthWrite = true;
        }
      }
    }
  });
}

/**
 * Atualiza suavemente a transparência de todos os edifícios (TC e construções concluídas)
 * baseado na presença de unidades amigas ou do cursor na área traseira/telhado.
 */
function updateBuildingOcclusionTransparency(delta: number) {
  const friendlyUnits = unitsList.filter((u) => u.faction === 'PLAYER' && !u.isDying);

  // 1. Town Center
  if (!townCenterState.isDestroyed) {
    const tcMinX = tcCoord.minX;
    const tcMaxX = tcCoord.maxX + 1;
    const tcMinZ = tcCoord.minZ;
    const tcMaxZ = tcCoord.maxZ + 1;
    const tcHeight = 3.8;

    let tcShouldFade = false;

    // A. Unidades amigas atrás do Town Center
    for (const unit of friendlyUnits) {
      const up = unit.group.position;
      if (isPositionBehindStructure(up.x, up.z, tcMinX, tcMaxX, tcMinZ, tcMaxZ, tcHeight)) {
        tcShouldFade = true;
        break;
      }
    }

    // B. Cursor do mouse na área traseira ou no telhado
    if (!tcShouldFade && isMouseInsideWindow && mousePos.x >= 0) {
      if (
        currentCell &&
        isPositionBehindStructure(
          currentCell.gridX + 0.5,
          currentCell.gridZ + 0.5,
          tcMinX,
          tcMaxX,
          tcMinZ,
          tcMaxZ,
          tcHeight
        )
      ) {
        tcShouldFade = true;
      } else if (isCursorOverRoof(townCenter, 1.2)) {
        tcShouldFade = true;
      }
    }

    const tcTarget = tcShouldFade ? FADE_MIN_OPACITY : 1.0;
    townCenterState.currentOpacity = THREE.MathUtils.lerp(
      townCenterState.currentOpacity ?? 1.0,
      tcTarget,
      Math.min(1, delta * FADE_SPEED)
    );
    if (Math.abs((townCenterState.currentOpacity ?? 1.0) - tcTarget) < 0.005) {
      townCenterState.currentOpacity = tcTarget;
    }
    applyBuildingOpacity(townCenterState.group, townCenterState.currentOpacity);
  }

  // 2. Edifícios Concluídos (Quarteis, Torres, Madeireiras, Campos de Mineração, Casas)
  for (const b of buildingsList) {
    if (!b.isCompleted) continue;
    if (b.type === 'FARM' || b.type === 'WALL') continue; // Fazenda e Muralha não bloqueiam visão nem sofrem oclusão

    const bMinX = b.gridX;
    const bMaxX = b.gridX + b.size;
    const bMinZ = b.gridZ;
    const bMaxZ = b.gridZ + b.size;
    const bHeight =
      b.type === 'TOWER'
        ? 4.2
        : b.type === 'MILL'
        ? 3.0
        : b.type === 'BARRACKS'
        ? 2.8
        : b.type === 'HOUSE'
        ? 2.3
        : 2.4;
    const minRoofHeight =
      b.type === 'TOWER'
        ? 1.5
        : b.type === 'MILL'
        ? 1.2
        : b.type === 'BARRACKS'
        ? 1.1
        : b.type === 'HOUSE'
        ? 0.9
        : 1.0;

    let bShouldFade = false;

    for (const unit of friendlyUnits) {
      const up = unit.group.position;
      if (isPositionBehindStructure(up.x, up.z, bMinX, bMaxX, bMinZ, bMaxZ, bHeight)) {
        bShouldFade = true;
        break;
      }
    }

    if (!bShouldFade && isMouseInsideWindow && mousePos.x >= 0) {
      if (
        currentCell &&
        isPositionBehindStructure(
          currentCell.gridX + 0.5,
          currentCell.gridZ + 0.5,
          bMinX,
          bMaxX,
          bMinZ,
          bMaxZ,
          bHeight
        )
      ) {
        bShouldFade = true;
      } else if (isCursorOverRoof(b.finishedGroup, minRoofHeight)) {
        bShouldFade = true;
      }
    }

    const bTarget = bShouldFade ? FADE_MIN_OPACITY : 1.0;
    b.currentOpacity = THREE.MathUtils.lerp(
      b.currentOpacity ?? 1.0,
      bTarget,
      Math.min(1, delta * FADE_SPEED)
    );
    if (Math.abs((b.currentOpacity ?? 1.0) - bTarget) < 0.005) {
      b.currentOpacity = bTarget;
    }
    applyBuildingOpacity(b.finishedGroup, b.currentOpacity);
  }
}

// --- 18. ANIMATION & RENDER LOOP ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  // Se estiver na Tela Inicial / Menu Principal, pausa o loop do Three.js (0% CPU/GPU)
  if (currentGameState === 'MENU') {
    return;
  }

  const delta = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  if (currentMatchConfig.peacefulMode && !isGamePaused && now - lastQuestCheckTime > 400) {
    lastQuestCheckTime = now;
    updatePeacefulQuests();
  }

  if (!isGamePaused) {
    if (cameraShakeRemaining > 0) {
      cameraShakeRemaining = Math.max(0, cameraShakeRemaining - delta);
    }
    updateParticles(delta);
  }

  // 1. Edge Panning
  const edgePanSpeed = 16 * (frustumSize / 28) * delta;
  let edgeX = 0;
  let edgeY = 0;

  if (isMouseInsideWindow && !isMiddleDragging && !isLeftDragging && !isMatchConfigModalOpen) {
    const left = mousePos.x >= 0 && mousePos.x < EDGE_THRESHOLD;
    const right = mousePos.x > window.innerWidth - EDGE_THRESHOLD && mousePos.x <= window.innerWidth;
    const top = mousePos.y >= 0 && mousePos.y < EDGE_THRESHOLD;
    const bottom = mousePos.y > window.innerHeight - EDGE_THRESHOLD && mousePos.y <= window.innerHeight;

    if (left) edgeX -= 1;
    if (right) edgeX += 1;
    if (top) edgeY += 1;
    if (bottom) edgeY -= 1;

    edgeLeftEl?.classList.toggle('active', left);
    edgeRightEl?.classList.toggle('active', right);
    edgeTopEl?.classList.toggle('active', top);
    edgeBottomEl?.classList.toggle('active', bottom);
  } else {
    clearEdgeIndicators();
  }

  if (!isMatchConfigModalOpen) {
    const keySpeed = 18 * (frustumSize / 28) * delta;
    if (keys['w'] || keys['arrowup']) targetDesired.addScaledVector(UP_GROUND, keySpeed);
    if (keys['s'] || keys['arrowdown']) targetDesired.addScaledVector(UP_GROUND, -keySpeed);
    if (keys['d'] || keys['arrowright']) targetDesired.addScaledVector(RIGHT_GROUND, keySpeed);
    if (keys['a'] || keys['arrowleft']) targetDesired.addScaledVector(RIGHT_GROUND, -keySpeed);

    if (edgeX !== 0) targetDesired.addScaledVector(RIGHT_GROUND, edgeX * edgePanSpeed);
    if (edgeY !== 0) targetDesired.addScaledVector(UP_GROUND, edgeY * edgePanSpeed);
  }

  // Amortecimento sutil de inércia para navegação panorâmica touch fluida
  if (touchInertiaActive) {
    const worldUnitsPerPixel = frustumSize / window.innerHeight;
    targetDesired.addScaledVector(RIGHT_GROUND, -touchVelocityX * worldUnitsPerPixel);
    targetDesired.addScaledVector(UP_GROUND, touchVelocityY * worldUnitsPerPixel * 1.225);
    clampCameraTarget(targetDesired);
    touchVelocityX *= 0.91;
    touchVelocityY *= 0.91;
    if (Math.hypot(touchVelocityX, touchVelocityY) < 0.1) {
      touchInertiaActive = false;
      touchVelocityX = 0;
      touchVelocityY = 0;
    }
  }

  clampCameraTarget(targetDesired);
  cameraTarget.lerp(targetDesired, 0.15);

  if (Math.abs(frustumSize - targetFrustumSize) > 0.01) {
    frustumSize = THREE.MathUtils.lerp(frustumSize, targetFrustumSize, 0.14);
    updateCameraFrustum();
  }
  updateCameraTransform();

  // Se o jogo encerrou ou modal de configuração pré-jogo está aberto, congela a simulação (unidades, treinos, IA), mantendo renderização contínua
  if (isGameOver || isMatchConfigModalOpen) {
    updateBuildingOcclusionTransparency(delta);
    updateFogOfWar();
    updateEntitiesVisibility();
    renderMinimap();
    renderer.render(scene, camera);
    return;
  }

  // =========================================================================
  // SIMULAÇÃO LÓGICA DO RTS (CONGELADA QUANDO isGamePaused === true)
  // =========================================================================
  if (!isGamePaused) {
    // Atualiza IA Inimiga e Auto-Aggro de Combate Aliado
    updateEnemyAI(now, delta);
    updateAlliedCombatAggro(now);
    checkGameOverConditions();

    // Bandeira do Town Center
    tcFlag.rotation.y = Math.sin(now * 0.004) * 0.35;

    // Atualiza Fila de Produção e Animações dos Edifícios
    for (const b of buildingsList) {
      if (b.type === 'WALL' && b.hp !== undefined && b.hp <= 0) {
        destroyWall(b);
        continue;
      }
      if (b.type === 'GATE' && b.hp !== undefined && b.hp <= 0) {
        destroyGate(b);
        continue;
      }

      // Rotação contínua e suave das pás do Moinho de Vento
      if (b.type === 'MILL' && b.isCompleted && b.windmillBlades) {
        b.windmillBlades.rotation.z += delta * 1.5;
      }

      if (b.type === 'BARRACKS') {
        if (b.isCompleted && b.trainingQueue.length > 0) {
          const trainRate = b.faction === 'ENEMY' ? (currentAIDifficulty === 'EASY' ? 0.6 : (currentAIDifficulty === 'HARD' ? 1.2 : 1.0)) : 1.0;
          b.trainingTimer += delta * trainRate;

          // Barra 3D sobre o Quartel
          if (b.trainingProgressGroup && b.trainingProgressBarMesh) {
            b.trainingProgressGroup.visible = true;
            b.trainingProgressGroup.quaternion.copy(camera.quaternion);
            const trainDuration = getSwordsmanTrainTime();
            const ratio = Math.min(1, b.trainingTimer / trainDuration);
            b.trainingProgressBarMesh.scale.x = Math.max(0.01, ratio);
            b.trainingProgressBarMesh.position.x = -0.63 * (1 - ratio);
          }

          if (b.trainingTimer >= getSwordsmanTrainTime()) {
            b.trainingTimer = 0;
            b.trainingQueue.shift();

            // Encontra célula livre adjacente
            const perim = getBuildingPerimeterCells(b);
            const freeCell = perim.find(
              (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
            ) ?? findClosestWalkableCell(new THREE.Vector2(b.gridX + 1, b.gridZ + 1), new THREE.Vector2(b.gridX + 1, b.gridZ + 1));

            const soldierFaction = b.faction;
            const soldier = createUnit(freeCell.x, freeCell.y, 'SWORDSMAN', soldierFaction);
            if (soldierFaction === 'PLAYER') {
              gameStats.unitsTrainedTotal++;
              playerSwordsmenTrainedCount++;
              const triggerThreshold = currentAIDifficulty === 'EASY' ? 8 : (currentAIDifficulty === 'HARD' ? 2 : 3);
              if (!hasInvasionTriggered && playerSwordsmenTrainedCount >= triggerThreshold) {
                triggerInvasion();
              }
              spawnFloatingText(new THREE.Vector3(freeCell.x + 0.5, 1.6, freeCell.y + 0.5), '+1 Espadachim ⚔️', '#60a5fa');
              console.log(`[RTS Quartel] Espadachim concluído e spawnado em (${freeCell.x}, ${freeCell.y})!`);
              applyRallyPointOrder(soldier, b.rallyPoint);
            } else {
              const existingGuards = unitsList.filter(
                (u) => u.faction === 'ENEMY' && u.unitType === 'SWORDSMAN' && u.isEnemyPatrol && !u.isDying
              );
              if (existingGuards.length < 2) {
                soldier.isEnemyPatrol = true;
                soldier.isEnemyInvader = false;
              } else {
                soldier.isEnemyPatrol = false;
                soldier.isEnemyInvader = false;
              }
              spawnFloatingText(new THREE.Vector3(freeCell.x + 0.5, 1.6, freeCell.y + 0.5), '+1 Espadachim Inimigo ⚔️', '#ef4444');
              console.log(`[RTS Quartel Inimigo] Espadachim inimigo concluído e spawnado em (${freeCell.x}, ${freeCell.y})!`);
            }
          }

          if (selectedBuilding === b) updateBarracksHUD();
        } else if (b.trainingProgressGroup) {
          b.trainingProgressGroup.visible = false;
        }
      } else if (b.type === 'ARCHERY_RANGE') {
        if (b.isCompleted && b.trainingQueue.length > 0) {
          b.trainingTimer += delta;

          // Barra 3D sobre o Campo de Tiro com Arco
          if (b.trainingProgressGroup && b.trainingProgressBarMesh) {
            b.trainingProgressGroup.visible = true;
            b.trainingProgressGroup.quaternion.copy(camera.quaternion);
            const trainDuration = ARCHER_TRAIN_TIME_SEC;
            const ratio = Math.min(1, b.trainingTimer / trainDuration);
            b.trainingProgressBarMesh.scale.x = Math.max(0.01, ratio);
            b.trainingProgressBarMesh.position.x = -0.63 * (1 - ratio);
          }

          if (b.trainingTimer >= ARCHER_TRAIN_TIME_SEC) {
            b.trainingTimer = 0;
            b.trainingQueue.shift();

            // Encontra célula livre adjacente
            const perim = getBuildingPerimeterCells(b);
            const freeCell = perim.find(
              (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
            ) ?? findClosestWalkableCell(new THREE.Vector2(b.gridX + 1, b.gridZ + 1), new THREE.Vector2(b.gridX + 1, b.gridZ + 1));

            const archerFaction = b.faction;
            const archer = createUnit(freeCell.x, freeCell.y, 'ARCHER', archerFaction);
            if (archerFaction === 'PLAYER') {
              gameStats.unitsTrainedTotal++;
              spawnFloatingText(new THREE.Vector3(freeCell.x + 0.5, 1.6, freeCell.y + 0.5), '+1 Arqueiro 🏹', '#34d399');
              console.log(`[RTS Campo de Tiro] Arqueiro concluído e spawnado em (${freeCell.x}, ${freeCell.y})!`);
              applyRallyPointOrder(archer, b.rallyPoint);
            } else {
              spawnFloatingText(new THREE.Vector3(freeCell.x + 0.5, 1.6, freeCell.y + 0.5), '+1 Arqueiro Inimigo 🏹', '#ef4444');
            }
          }

          if (selectedBuilding === b) updateArcheryHUD();
        } else if (b.trainingProgressGroup) {
          b.trainingProgressGroup.visible = false;
        }
      } else if (b.trainingProgressGroup) {
        b.trainingProgressGroup.visible = false;
      }
    }

    // Atualiza Sistema de Estudo das Escolas e Faculdades
    updateSchools(delta);
    updateColleges(delta);
    updateGates(delta);

    // Cancelamento imediato de fortificações e torres caso o último arquiteto tenha morrido
    if (isPlacementMode && (currentPlacementType === 'WALL' || currentPlacementType === 'GATE' || currentPlacementType === 'TOWER') && !hasLivingArchitect()) {
      exitPlacementMode();
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ O Arquiteto foi abatido! Fortificações e torres bloqueadas.',
        '#ef4444'
      );
    }

    // Cancelamento imediato de fazendas caso o último agrônomo tenha morrido
    if (isPlacementMode && currentPlacementType === 'FARM' && !hasLivingAgronomist()) {
      exitPlacementMode();
      soundManager.popCappedAlert();
      spawnFloatingText(
        new THREE.Vector3(cameraTarget.x, 2.2, cameraTarget.z),
        '⚠️ O Agrônomo foi abatido! Planejamento de terras cultiváveis bloqueado.',
        '#ef4444'
      );
    }

    // Atualiza Fila de Produção do Town Center (Aldeões)
    if (tcTrainingQueue.length > 0) {
      tcTrainingTimer += delta;

      if (tcTrainingTimer >= VILLAGER_TRAIN_TIME) {
        tcTrainingTimer = 0;
        tcTrainingQueue.shift();

        // Encontra célula livre adjacente ao Town Center
        const perimCells: THREE.Vector2[] = [];
        for (let x = tcCoord.minX - 1; x <= tcCoord.maxX + 1; x++) {
          for (let z = tcCoord.minZ - 1; z <= tcCoord.maxZ + 1; z++) {
            if (x < tcCoord.minX || x > tcCoord.maxX || z < tcCoord.minZ || z > tcCoord.maxZ) {
              perimCells.push(new THREE.Vector2(x, z));
            }
          }
        }
        const freeCell = perimCells.find(
          (c) => isCellInside(c.x, c.y) && isCellWalkable(c.x, c.y) && !isCellOccupiedByUnit(c.x, c.y)
        ) ?? findClosestWalkableCell(new THREE.Vector2(tcCoord.minX + 1, tcCoord.minZ + 1), new THREE.Vector2(tcCoord.minX + 1, tcCoord.minZ + 1));

        const villager = createUnit(freeCell.x, freeCell.y, 'VILLAGER', 'PLAYER');
        gameStats.unitsTrainedTotal++;
        spawnFloatingText(new THREE.Vector3(freeCell.x + 0.5, 1.8, freeCell.y + 0.5), '+1 Aldeão 👨‍🌾', '#4ade80');
        console.log(`[RTS Town Center] Aldeão treinado e spawnado em (${freeCell.x}, ${freeCell.y})!`);
        applyRallyPointOrder(villager, townCenterState.rallyPoint);
      }

      if (isTownCenterSelected) updateTownCenterHUD();
    }

    // Animações de morte (tombamento e desaparecimento)
    for (let i = activeDeathAnimations.length - 1; i >= 0; i--) {
      const anim = activeDeathAnimations[i];
      const elapsed = now - anim.startTime;
      const progress = Math.min(1, elapsed / anim.duration);

      anim.unit.cylinderMesh.rotation.x = -Math.PI / 2 * progress;
      anim.unit.group.position.y = -0.25 * progress;
      anim.unit.group.scale.setScalar(Math.max(0.01, 1 - progress * 0.4));

      anim.unit.group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => { m.transparent = true; m.opacity = 1 - progress; });
          } else if (mesh.material) {
            mesh.material.transparent = true;
            mesh.material.opacity = 1 - progress;
          }
        }
      });

      if (progress >= 1) {
        scene.remove(anim.unit.group);
        const idx = unitsList.indexOf(anim.unit);
        if (idx !== -1) unitsList.splice(idx, 1);
        activeDeathAnimations.splice(i, 1);
        updateTelemetryUnitsCount();
        updateResourceHUD();
      }
    }

    // 2. Spawn pop-in das unidades
    for (let i = activeSpawnAnimations.length - 1; i >= 0; i--) {
      const anim = activeSpawnAnimations[i];
      anim.progress += delta * 4.5;
      if (anim.progress >= 1) {
        anim.group.scale.setScalar(1);
        activeSpawnAnimations.splice(i, 1);
      } else {
        anim.group.scale.setScalar(Math.sin(anim.progress * Math.PI * 0.5) * 1.08);
      }
    }

    // 3. Máquina de estados dos aldeões e combatentes
    for (const unit of unitsList) {
      updateUnitState(unit, delta, now);
      resolveWallCollision(unit);
      if (unit.carryMesh.visible) {
        unit.carryMesh.position.y = 0.95 + Math.abs(Math.sin(now * 0.012)) * 0.04;
      }
      // Rotação sutil e pulsação da aura dourada nos especialistas de elite selecionados
      if (unit.auraRingMesh && unit.auraRingMesh.visible) {
        unit.auraRingMesh.rotation.z += delta * 1.5;
        const mat = unit.auraRingMesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.6 + Math.sin(now * 0.006) * 0.3;
      }
    }

    // 4. Árvores: tremor ao ser cortada e encolhimento ao zerar
    treesMap.forEach((tree, key) => {
      if (tree.depleting) {
        tree.depleteProgress += delta / 0.8;
        const p = Math.min(tree.depleteProgress, 1);
        tree.group.scale.setScalar(tree.baseScale * (1 - p * p));
        tree.group.rotation.y += delta * 5;
        if (p >= 1) {
          scene.remove(tree.group);
          setCellWalkable(tree.gridX, tree.gridZ, true);
          treesMap.delete(key);
        }
        return;
      }
      tree.group.rotation.z = now < tree.chopUntil ? Math.sin(now * 0.08) * 0.05 : 0;
    });

    // 4.5. Arbustos de Frutas: encolhimento e desaparecimento ao zerar o alimento
    berryBushesMap.forEach((bush, key) => {
      if (bush.depleting) {
        bush.depleteProgress += delta / 0.8;
        const p = Math.min(bush.depleteProgress, 1);
        bush.group.scale.setScalar(bush.baseScale * (1 - p));
        if (p >= 1) {
          scene.remove(bush.group);
          setCellWalkable(bush.gridX, bush.gridZ, true);
          berryBushesMap.delete(key);
        }
        return;
      }
    });

    // 4.6. Jazidas de Pedra: tremor ao ser minerada e encolhimento/desaparecimento ao zerar a pedra
    stoneMinesMap.forEach((mine, key) => {
      if (mine.depleting) {
        mine.depleteProgress += delta / 0.8;
        const p = Math.min(mine.depleteProgress, 1);
        mine.group.scale.set(mine.baseScale * (1 - p * 0.3), mine.baseScale * (1 - p), mine.baseScale * (1 - p * 0.3));
        mine.group.position.y = -p * 0.2;
        if (p >= 1) {
          spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.25, mine.gridZ + 0.5), 14, 0x64748b);
          scene.remove(mine.group);
          setCellWalkable(mine.gridX, mine.gridZ, true);
          stoneMinesMap.delete(key);
        }
        return;
      }
      mine.group.rotation.y = now < mine.mineUntil ? Math.sin(now * 0.12) * 0.04 : 0;
    });

    // 4.65. Minas de Ouro: tremor ao ser minerada e encolhimento/desaparecimento ao zerar o ouro
    goldMinesMap.forEach((mine, key) => {
      if (mine.depleting) {
        mine.depleteProgress += delta / 0.8;
        const p = Math.min(mine.depleteProgress, 1);
        mine.group.scale.set(mine.baseScale * (1 - p * 0.3), mine.baseScale * (1 - p), mine.baseScale * (1 - p * 0.3));
        mine.group.position.y = -p * 0.2;
        if (p >= 1) {
          spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.25, mine.gridZ + 0.5), 18, 0xfacc15);
          spawnParticles(new THREE.Vector3(mine.gridX + 0.5, 0.25, mine.gridZ + 0.5), 8, 0x1e293b);
          scene.remove(mine.group);
          setCellWalkable(mine.gridX, mine.gridZ, true);
          goldMinesMap.delete(key);
        }
        return;
      }
      mine.group.rotation.y = now < mine.mineUntil ? Math.sin(now * 0.12) * 0.04 : 0;
    });

    // 4.7. Torres de Vigia: Ataque automático a inimigos que se aproximam da base (raio 7.5)
    for (const b of buildingsList) {
      if (b.type !== 'TOWER' || !b.isCompleted) continue;
      if (now - (b.lastAttackTime ?? 0) < TOWER_ATTACK_COOLDOWN * 1000) continue;

      let nearestEnemy: RTSUnit | null = null;
      let nearestDist = TOWER_ATTACK_RANGE;

      for (const u of unitsList) {
        if (u.faction === 'ENEMY' && u.hp > 0 && !u.isDying) {
          const d = Math.hypot(u.group.position.x - b.worldCenter.x, u.group.position.z - b.worldCenter.z);
          if (d <= nearestDist) {
            nearestDist = d;
            nearestEnemy = u;
          }
        }
      }

      if (nearestEnemy) {
        b.lastAttackTime = now;
        fireTowerArrow(b, nearestEnemy, now);
      }
    }

    // 4.8. Atualização de projéteis disparados pelas torres
    for (let i = towerProjectiles.length - 1; i >= 0; i--) {
      const proj = towerProjectiles[i];
      const targetPos = proj.targetUnit.group.position.clone().add(new THREE.Vector3(0, 0.45, 0));
      proj.progress += delta / proj.duration;

      if (proj.progress >= 1) {
        scene.remove(proj.mesh);
        proj.mesh.geometry.dispose();
        towerProjectiles.splice(i, 1);

        if (proj.targetUnit.hp > 0 && !proj.targetUnit.isDying) {
          proj.targetUnit.hp = Math.max(0, proj.targetUnit.hp - TOWER_DAMAGE);
          proj.targetUnit.hpBarShowUntil = now + 4000;
          updateUnitHpBar(proj.targetUnit, now);

          const targetMat = proj.targetUnit.cylinderMesh.material as THREE.MeshStandardMaterial;
          const originalColor = targetMat.color.getHex();
          targetMat.color.setHex(0xffffff);
          setTimeout(() => {
            if (proj.targetUnit && proj.targetUnit.cylinderMesh) {
              targetMat.color.setHex(originalColor);
            }
          }, 90);

          spawnFloatingText(targetPos.clone().setY(1.3), `-${TOWER_DAMAGE}`, '#ef4444');
          spawnParticles(targetPos, 4, 0xf59e0b);

          if (proj.targetUnit.hp <= 0 && !proj.targetUnit.isDying) {
            gameStats.enemiesKilledTotal++;
            killUnit(proj.targetUnit, now);
          }
        }
      } else {
        proj.mesh.position.lerpVectors(proj.startPos, targetPos, proj.progress);
        proj.mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          targetPos.clone().sub(proj.mesh.position).normalize()
        );
      }
    }

    // 4.9. Atualização de projéteis balísticos disparados pelos arqueiros
    for (let i = archerProjectiles.length - 1; i >= 0; i--) {
      const proj = archerProjectiles[i];
      proj.progress += delta / proj.duration;

      let currentTargetPos = proj.targetPos;
      if (proj.targetType === 'UNIT' && proj.targetUnit && !proj.targetUnit.isDying) {
        currentTargetPos = proj.targetUnit.group.position.clone().add(new THREE.Vector3(0, 0.45, 0));
      }

      if (proj.progress >= 1) {
        scene.remove(proj.mesh);
        proj.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        });
        archerProjectiles.splice(i, 1);

        soundManager.arrowHit();
        spawnParticles(currentTargetPos, 5, 0xf59e0b);

        if (proj.targetType === 'UNIT') {
          const u = proj.targetUnit;
          if (u && u.hp > 0 && !u.isDying) {
            const rawDamage = proj.damage;
            let effectiveDamage = rawDamage;
            if (((u.faction as string) === 'ALLIED' || !u.isEnemy) && (u.unitType === 'SWORDSMAN' || (u as any).type === 'SWORDSMAN') && hasLivingArmorer()) {
              effectiveDamage = Math.max(1, Math.round(rawDamage * 0.75)); // Absorve 25% do impacto
            }
            const dmg = effectiveDamage;
            u.hp = Math.max(0, u.hp - dmg);
            u.hpBarShowUntil = now + 4000;
            updateUnitHpBar(u, now);

            const targetMat = u.cylinderMesh.material as THREE.MeshStandardMaterial;
            const originalColor = targetMat.color.getHex();
            targetMat.color.setHex(0xffffff);
            setTimeout(() => {
              if (u && u.cylinderMesh) {
                targetMat.color.setHex(originalColor);
              }
            }, 90);

            spawnFloatingText(currentTargetPos.clone().setY(1.3), `-${dmg}`, '#ef4444');

            if (proj.attacker) {
              onUnitDamagedByEnemy(u, proj.attacker);
            }

            if (u.hp <= 0 && !u.isDying) {
              if (u.faction === 'ENEMY') {
                gameStats.enemiesKilledTotal++;
              }
              killUnit(u, now);
            }
          }
        } else if (proj.targetType === 'BUILDING') {
          const b = proj.targetBuilding;
          if (b && !b.isDepleted && (b.hp === undefined || b.hp > 0)) {
            damageBuilding(b, proj.damage, now);
            spawnFloatingText(b.worldCenter.clone().setY(1.5), `-${proj.damage}`, '#ef4444');
          }
        } else if (proj.targetType === 'TENT') {
          damageEnemyTent(proj.damage, now);
        } else if (proj.targetType === 'TOWN_CENTER') {
          damageTownCenter(proj.damage, now);
        }
      } else {
        const p = proj.progress;
        const currentPos = new THREE.Vector3().lerpVectors(proj.startPos, currentTargetPos, p);
        const parabolaY = 4 * proj.arcHeight * p * (1 - p);
        currentPos.y += parabolaY;
        proj.mesh.position.copy(currentPos);

        const nextP = Math.min(1, p + 0.02);
        const nextPos = new THREE.Vector3().lerpVectors(proj.startPos, currentTargetPos, nextP);
        nextPos.y += 4 * proj.arcHeight * nextP * (1 - nextP);
        const flightDir = nextPos.sub(currentPos).normalize();
        if (flightDir.lengthSq() > 0.0001) {
          proj.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), flightDir);
        }
      }
    }

    // 5. Steering Separation
    const MIN_SEPARATION = 0.75;
    const SEPARATION_FORCE = 3.2;
    for (let i = 0; i < unitsList.length; i++) {
      const u1 = unitsList[i];
      let rx = 0;
      let rz = 0;
      for (let j = 0; j < unitsList.length; j++) {
        if (i === j) continue;
        const u2 = unitsList[j];
        const dx = u1.group.position.x - u2.group.position.x;
        const dz = u1.group.position.z - u2.group.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < MIN_SEPARATION && dist > 0.0001) {
          const strength = (MIN_SEPARATION - dist) / MIN_SEPARATION;
          rx += (dx / dist) * strength;
          rz += (dz / dist) * strength;
        }
      }
      if (rx !== 0 || rz !== 0) {
        const testX = u1.group.position.x + rx * delta * SEPARATION_FORCE;
        const testZ = u1.group.position.z + rz * delta * SEPARATION_FORCE;
        if (isCellWalkable(Math.floor(testX), Math.floor(testZ))) {
          u1.group.position.x = testX;
          u1.group.position.z = testZ;
        }
      }
    }

    // 6. Marcadores visuais de comando
    for (let i = activeMoveMarkers.length - 1; i >= 0; i--) {
      const m = activeMoveMarkers[i];
      const progress = (now - m.createdAt) / m.duration;
      if (progress >= 1) {
        scene.remove(m.group);
        activeMoveMarkers.splice(i, 1);
      } else {
        m.group.scale.setScalar(1.0 + Math.sin(progress * Math.PI) * 0.35);
        m.group.traverse((child) => {
          const mat = (child as THREE.Mesh).material as THREE.Material | undefined;
          if (mat) mat.opacity = 1 - progress;
        });
      }
    }

    // 6.5. Animação de pulsos do Ponto de Encontro (Rally Point) no solo
    for (let i = activeRallyPulses.length - 1; i >= 0; i--) {
      const p = activeRallyPulses[i];
      const progress = (now - p.createdAt) / p.duration;
      if (progress >= 1) {
        scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        activeRallyPulses.splice(i, 1);
      } else {
        const scale = 1.0 + progress * 3.5;
        p.mesh.scale.set(scale, scale, 1);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - progress);
      }
    }
  } // Fim do bloco if (!isGamePaused)

  // =========================================================================
  // SISTEMAS DE RENDERIZAÇÃO, CÂMERA E HUD (SEMPRE ATIVOS MESMO PAUSADO)
  // =========================================================================

  // Animação sutil de ondulação da flâmula do Rally Point
  if (rallyPointVisualGroup && rallyPointVisualGroup.visible && rallyFlagMesh) {
    rallyFlagMesh.rotation.y = Math.sin(now * 0.003) * 0.15;
  }

  // Atualiza orientação das barras de HP das estruturas em relação à câmera
  townCenterState.hpBarGroup.quaternion.copy(camera.quaternion);
  if (enemyCampState?.hpBarGroup) {
    enemyCampState.hpBarGroup.quaternion.copy(camera.quaternion);
  }
  for (const b of buildingsList) {
    if (b.hpBarGroup?.visible) {
      b.hpBarGroup.quaternion.copy(camera.quaternion);
    }
  }

  // Atualiza orientações e barras de HP das unidades
  for (const u of unitsList) {
    if (!u.isDying) {
      u.hpBarGroup.quaternion.copy(camera.quaternion);
      if (!isGamePaused) {
        updateUnitHpBar(u, now);
      }
    }
  }

  if ((unitCardPanelEl && unitCardPanelEl.style.display !== 'none') || (multiSelectionPanelEl && !multiSelectionPanelEl.classList.contains('hidden'))) {
    updateUnitHUD();
  }

  // Mantém cursor encaixado
  if (isMouseInsideWindow && !isMiddleDragging && !isLeftDragging && mousePos.x >= 0 && !isPlacementMode) {
    const cell = raycastGridCell(mousePos.x, mousePos.y);
    if (cell && cell.isInside && !treesMap.has(cellKey(cell.gridX, cell.gridZ)) && !buildingsGridMap.has(cellKey(cell.gridX, cell.gridZ))) {
      markerGroup.position.set(cell.gridX + 0.5, getTerrainHeight(cell.gridX + 0.5, cell.gridZ + 0.5) + 0.015, cell.gridZ + 0.5);
    }
  }

  // Telemetria RTS desativada para economizar CPU e despoluir o HUD

  // 7. Névoa de Guerra (FoW), Visibilidade de Entidades & Minimapa
  updateBuildingOcclusionTransparency(delta);
  updateFogOfWar();
  updateEntitiesVisibility();
  renderMinimap();

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  updateCameraFrustum();
  updateCameraTransform();
});

// =============================================================================
// CONTROLE DE CÂMERA E INICIALIZAÇÃO DA PARTIDA
// =============================================================================
export function setupGameCamera(targetX = TC_WORLD_CENTER.x, targetZ = TC_WORLD_CENTER.z): void {
  cameraTarget.set(targetX, 0, targetZ);
  targetDesired.set(targetX, 0, targetZ);
  frustumSize = 28;
  targetFrustumSize = 28;
  updateCameraFrustum();
  updateCameraTransform();
}

export function setupInitialMatch(seed: number = currentMapSeed): void {
  try {
    // a. Sorteie as coordenadas da base aliada (alliedBaseX, alliedBaseZ) e da base inimiga (enemyBaseX, enemyBaseZ).
    randomizeBasePositions(seed);
    const alliedBaseX = tcCoord.minX + 1.5;
    const alliedBaseZ = tcCoord.minZ + 1.5;
    const enemyBaseX = enemyCampCoord.x + 1.5;
    const enemyBaseZ = enemyCampCoord.z + 1.5;

    // Garante relevo e penhascos alinhados com as posições sorteadas
    generateTerrainHeights(GRID_SIZE, seed);
    evaluateCliffsAndPlateaus();

    // b. Crie a estrutura física do Town Center aliado nessa posição e registre suas células no grid.
    restoreTownCenter();

    hasEnemyFaction = !currentMatchConfig.peacefulMode;

    // c. Spawne IMEDIATAMENTE os 4 aldeões aliados na frente do TC (Z positivo relativo).
    for (const [vx, vz] of getInitialVillagerSpawns()) {
      createUnit(vx, vz, 'VILLAGER', 'PLAYER');
    }

    // Cria o acampamento inimigo se não estiver em modo pacífico
    if (!currentMatchConfig.peacefulMode) {
      createEnemyCamp(enemyCampCoord.x, enemyCampCoord.z);
      spawnGuaranteedEnemyResources();
      initEnemyWorkerRoutines();
    }

    // d. Gere os recursos ao redor (árvores, frutas, ouro e pedra).
    spawnGuaranteedAlliedResources();
    spawnStoneWall();
    spawnOrganicForests(seed);
    spawnWildMineralAndFruitClusters(seed);

    // e. Reposicione os alvos de câmera estritamente focados no Town Center aliado
    setupGameCamera(alliedBaseX, alliedBaseZ);

    // f. Atualize a Névoa de Guerra (updateFogOfWar):
    if (currentMatchConfig.revealWholeMap) {
      fogGrid.fill(FogState.VISIBLE);
    } else {
      fogGrid.fill(FogState.UNEXPLORED);
    }
    updateFogOfWar(true);

    // Atualiza HUD, telemetria e minimapa
    updateResourceHUD();
    updateTelemetryUnitsCount();
    updateTelemetrySelectionCount();
    updateObjectiveHUD();
    renderMinimap();

    console.log(`[RTS Init] Partida inicializada com sucesso! Base Aliada em (${alliedBaseX.toFixed(1)}, ${alliedBaseZ.toFixed(1)}) • Base Inimiga em (${enemyBaseX.toFixed(1)}, ${enemyBaseZ.toFixed(1)}) • ${treesMap.size} árvores.`);
  } catch (err) {
    console.error('[RTS Init Error] Erro capturado na rotina de inicialização:', err);
    try {
      const fallbackX = tcCoord.minX + 1.5;
      const fallbackZ = tcCoord.minZ + 1.5;
      cameraTarget.set(fallbackX, 0, fallbackZ);
      targetDesired.set(fallbackX, 0, fallbackZ);
      updateCameraFrustum();
      updateCameraTransform();
      revealVisionCircle(fallbackX, fallbackZ, 8);
      updateFogOfWar(true);
      renderMinimap();
    } catch (fallbackErr) {
      console.error('[RTS Init Fallback] Falha no fallback de segurança da visão:', fallbackErr);
    }
  }
}

// --- 18. INTEGRAÇÃO ELECTRON DESKTOP & AUTO-UPDATE VIA GITHUB ---
interface UpdateProgressPayload {
  percent?: number;
  transferred?: string | number;
  total?: string | number;
  speed?: string | number;
  bytesPerSecond?: number;
}

interface ElectronUpdaterAPI {
  getAppVersion: () => Promise<string>;
  startDownload: () => Promise<{ success: boolean; error?: string } | void>;
  quitAndInstall: () => Promise<void>;
  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void;
  onUpdateProgress: (callback: (data: UpdateProgressPayload | number) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  onUpdateError: (callback: (errMsg: string) => void) => () => void;
}

declare global {
  interface Window {
    electronUpdater?: ElectronUpdaterAPI;
    rts?: Record<string, any>;
  }
}

function setupElectronAutoUpdate(): void {
  const appVersionBadgeEl = document.getElementById('app-version-badge');
  const electronUpdateBannerEl = document.getElementById('electron-update-banner');
  const updateBannerTitleEl = document.getElementById('update-banner-title');
  const updateBannerVersionTagEl = document.getElementById('update-banner-version-tag');
  const updateBannerDescEl = document.getElementById('update-banner-desc');
  const updateProgressBarEl = document.getElementById('update-progress-bar');
  const updateProgressFillEl = document.getElementById('update-progress-fill');
  const updateProgressTextEl = document.getElementById('update-progress-text');
  const btnUpdateDownload = document.getElementById('btn-update-download');
  const btnUpdateInstall = document.getElementById('btn-update-install');
  const btnUpdateDismiss = document.getElementById('btn-update-dismiss');

  btnUpdateDismiss?.addEventListener('click', () => {
    soundManager.uiClick();
    if (electronUpdateBannerEl) {
      electronUpdateBannerEl.style.display = 'none';
    }
  });

  const updater = window.electronUpdater;
  if (updater) {
    // 1. Atualiza badge com a versão do app no Electron
    updater.getAppVersion().then((ver) => {
      if (appVersionBadgeEl && ver) {
        appVersionBadgeEl.textContent = `v${ver}`;
        appVersionBadgeEl.title = `Domain of Tiles Desktop (v${ver})`;
      }
      if (ver) {
        document.querySelectorAll('.game-version-tag').forEach((el) => {
          el.textContent = `Domain of Tiles • v${ver}`;
        });
      }
    }).catch(() => {});

    // 2. Quando houver nova versão disponível
    updater.onUpdateAvailable((info) => {
      console.log('[AutoUpdate] Nova versão disponível:', info);
      if (electronUpdateBannerEl) {
        electronUpdateBannerEl.style.display = 'flex';
      }
      if (updateBannerVersionTagEl && info.version) {
        updateBannerVersionTagEl.textContent = `v${info.version}`;
      }
      if (updateBannerTitleEl) {
        updateBannerTitleEl.textContent = 'Nova Atualização Disponível!';
      }
      if (updateBannerDescEl) {
        updateBannerDescEl.textContent = `Uma nova versão do Domain of Tiles (v${info.version || 'mais recente'}) está pronta para ser baixada.`;
      }
      if (updateProgressBarEl) updateProgressBarEl.style.display = 'none';
      if (btnUpdateDownload) {
        btnUpdateDownload.style.display = 'inline-flex';
        btnUpdateDownload.removeAttribute('disabled');
      }
      if (btnUpdateInstall) btnUpdateInstall.style.display = 'none';

      soundManager.updateNotification();
    });

    // 3. Progresso do download
    updater.onUpdateProgress((data) => {
      if (updateProgressBarEl) updateProgressBarEl.style.display = 'flex';
      if (btnUpdateDownload) btnUpdateDownload.style.display = 'none';
      // Suporta objeto { percent, transferred, total, speed } ou número direto
      const rawPct = typeof data === 'number' ? data : Number(data?.percent);
      const pct = Math.min(100, Math.max(0, Number.isFinite(rawPct) ? Math.round(rawPct) : 0));
      if (updateProgressFillEl) {
        updateProgressFillEl.style.width = `${pct}%`;
      }
      if (updateProgressBarEl && 'value' in updateProgressBarEl) {
        (updateProgressBarEl as HTMLProgressElement).value = pct;
      }
      if (updateProgressTextEl) {
        if (typeof data === 'object' && data && Number(data.total) > 0) {
          updateProgressTextEl.textContent = `Baixando: ${pct}% (${data.transferred}MB / ${data.total}MB - ${data.speed ?? 0} KB/s)`;
        } else {
          updateProgressTextEl.textContent = `Baixando: ${pct}%`;
        }
      }
      if (updateBannerDescEl) {
        updateBannerDescEl.textContent = `Baixando atualização do repositório (${pct}%)...`;
      }
    });

    // 4. Download concluído
    updater.onUpdateDownloaded((info) => {
      console.log('[AutoUpdate] Download finalizado:', info);
      if (updateProgressFillEl) updateProgressFillEl.style.width = '100%';
      if (updateProgressTextEl) updateProgressTextEl.textContent = '100% Concluído';
      if (updateBannerDescEl) {
        updateBannerDescEl.textContent = `Download concluído! Reinicie para instalar a nova versão v${info.version || ''}.`;
      }
      if (btnUpdateDownload) btnUpdateDownload.style.display = 'none';
      if (btnUpdateInstall) btnUpdateInstall.style.display = 'inline-flex';

      soundManager.buildingComplete();
    });

    // 5. Erro no updater
    updater.onUpdateError((errMsg) => {
      console.warn('[AutoUpdate] Erro recebido:', errMsg);
      if (updateBannerDescEl && electronUpdateBannerEl && electronUpdateBannerEl.style.display !== 'none') {
        updateBannerDescEl.textContent = `Erro no download: ${errMsg}`;
        updateBannerDescEl.style.color = '#ef4444';
      }
      const statusEl = document.getElementById('update-status-message');
      if (statusEl) {
        statusEl.textContent = `Erro no download: ${errMsg}`;
        statusEl.style.color = '#ef4444';
      }
      // Restaura o botão de baixar para permitir nova tentativa
      if (updateProgressBarEl) updateProgressBarEl.style.display = 'none';
      if (btnUpdateDownload) {
        btnUpdateDownload.style.display = 'inline-flex';
        btnUpdateDownload.removeAttribute('disabled');
        btnUpdateDownload.innerHTML = '<span class="btn-icon">🔁</span> Tentar Novamente';
      }
    });

    // Ações dos botões
    btnUpdateDownload?.addEventListener('click', () => {
      soundManager.uiClick();
      if (updateBannerDescEl) updateBannerDescEl.style.color = '';
      if (btnUpdateDownload) {
        btnUpdateDownload.setAttribute('disabled', 'true');
        btnUpdateDownload.textContent = 'Iniciando download...';
      }
      if (updateProgressBarEl) updateProgressBarEl.style.display = 'flex';
      if (updateProgressFillEl) updateProgressFillEl.style.width = '0%';
      if (updateProgressTextEl) updateProgressTextEl.textContent = 'Conectando ao GitHub Releases...';
      updater.startDownload().then((res) => {
        if (res && res.success === false) console.error('[AutoUpdate] Download falhou:', res.error);
      }).catch((err) => {
        console.error('[AutoUpdate] Falha no download:', err);
        if (updateBannerDescEl) updateBannerDescEl.textContent = 'Erro ao iniciar o download.';
        if (btnUpdateDownload) btnUpdateDownload.removeAttribute('disabled');
      });
    });

    btnUpdateInstall?.addEventListener('click', () => {
      soundManager.uiClick();
      updater.quitAndInstall().catch((err) => {
        console.error('[AutoUpdate] Falha ao instalar:', err);
      });
    });
  }

  // Função utilitária no console para simular visualmente o fluxo de atualização (web ou desktop)
  window.rts = window.rts || {};
  window.rts.testUpdateBanner = (targetVersion = '1.1.0') => {
    console.log(`[RTS Test] Simulando banner de atualização para v${targetVersion}...`);
    if (electronUpdateBannerEl) electronUpdateBannerEl.style.display = 'flex';
    if (updateBannerVersionTagEl) updateBannerVersionTagEl.textContent = `v${targetVersion}`;
    if (updateBannerTitleEl) updateBannerTitleEl.textContent = 'Nova Atualização Disponível!';
    if (updateBannerDescEl) updateBannerDescEl.textContent = `Uma nova versão do Domain of Tiles (v${targetVersion}) está pronta para ser baixada.`;
    if (updateProgressBarEl) updateProgressBarEl.style.display = 'none';
    if (btnUpdateDownload) {
      btnUpdateDownload.style.display = 'inline-flex';
      btnUpdateDownload.removeAttribute('disabled');
      btnUpdateDownload.innerHTML = '<span class="btn-icon">⬇️</span> Baixar Agora';
    }
    if (btnUpdateInstall) btnUpdateInstall.style.display = 'none';

    soundManager.updateNotification();

    // Simula clique no download
    const startSimulatedDownload = () => {
      if (btnUpdateDownload) btnUpdateDownload.style.display = 'none';
      if (updateProgressBarEl) updateProgressBarEl.style.display = 'flex';

      let currentPct = 0;
      const interval = setInterval(() => {
        currentPct += 10;
        if (updateProgressFillEl) updateProgressFillEl.style.width = `${currentPct}%`;
        if (updateProgressTextEl) updateProgressTextEl.textContent = `${currentPct}% • 4.2 MB/s`;
        if (updateBannerDescEl) updateBannerDescEl.textContent = `Baixando atualização (${currentPct}%)...`;

        if (currentPct >= 100) {
          clearInterval(interval);
          if (updateBannerDescEl) updateBannerDescEl.textContent = `Download concluído! Reinicie o jogo para aplicar a v${targetVersion}.`;
          if (btnUpdateInstall) {
            btnUpdateInstall.style.display = 'inline-flex';
            btnUpdateInstall.onclick = () => {
              soundManager.uiClick();
              alert(`[Simulação] Atualização v${targetVersion} aplicada com sucesso! O aplicativo reiniciaria.`);
              if (electronUpdateBannerEl) electronUpdateBannerEl.style.display = 'none';
            };
          }
          soundManager.buildingComplete();
          console.log('[RTS Test] Simulação de download finalizada com sucesso!');
        }
      }, 250);
    };

    if (btnUpdateDownload) {
      btnUpdateDownload.onclick = () => {
        soundManager.uiClick();
        startSimulatedDownload();
      };
    }
  };
}

// =============================================================================
// SISTEMA DE SALVAMENTO E CARREGAMENTO DE PARTIDA (SAVE & LOAD GAME)
// =============================================================================

export type BuildingType =
  | 'BARRACKS'
  | 'TOWER'
  | 'LUMBER_CAMP'
  | 'MINING_CAMP'
  | 'HOUSE'
  | 'MILL'
  | 'FARM'
  | 'SCHOOL'
  | 'COLLEGE'
  | 'WALL'
  | 'GATE'
  | 'ARCHERY_RANGE';

export interface SaveGameMetadata {
  version: string;
  saveName: string;
  timestamp: number;
  formattedDate: string;
  mapSize: number;
  gameMode: string;
}

export interface UnitSaveData {
  id: number;
  faction: 'ALLIED' | 'ENEMY';
  type: UnitType;
  gridX: number;
  gridZ: number;
  hp: number;
  maxHp: number;
  educationLevel: number;
  specialization?: string;
  carriedAmount: number;
  carriedType?: string;

  // NOVOS CAMPOS PARA RESTAURAÇÃO DE AÇÃO:
  state: string; // 'IDLE', 'GATHERING', 'MOVING_TO_RESOURCE', 'BUILDING', 'MOVING_TO_BUILD', 'FARMING', 'RETURNING_TO_BASE', 'CHASING', 'ATTACKING', 'MOVING'
  targetResourceId?: number;      // ID do nó de recurso (árvore, mina, arbusto)
  targetResourceCoords?: { x: number; z: number }; // Coordenadas de backup do recurso
  targetBuildingId?: number;      // ID do canteiro de obras ou edifício alvo
  targetBuildingCoords?: { x: number; z: number }; // Coordenadas de backup da obra
  targetUnitId?: number;          // ID da unidade inimiga em combate
  currentPath?: { x: number; z: number }[]; // Rota A* restante se estava se movendo
}

export interface BuildingSaveData {
  id: number;
  type: BuildingType;
  faction: 'ALLIED' | 'ENEMY';
  gridX: number;
  gridZ: number;
  hp: number;
  maxHp: number;
  progress: number;
  isCompleted: boolean;
  enrolledStudentIds?: number[];
  trainingQueue?: { unitType: UnitType; progressSec: number }[];
  farmFood?: number;
  rallyPoint?: { x: number; z: number; targetType: string; targetId?: number | string };
}

export interface ResourceNodeSaveData {
  id: number;
  type: 'TREE' | 'BERRY_BUSH' | 'GOLD_MINE' | 'STONE_MINE';
  gridX: number;
  gridZ: number;
  remainingAmount: number;
}

export interface FullSaveState {
  metadata: SaveGameMetadata;
  matchConfig: any;
  camera: { targetX: number; targetZ: number; frustumSize: number };
  playerResources: { wood: number; food: number; gold: number; stone: number };
  enemyResources: { wood: number; food: number; gold: number; stone: number };
  popCap: { player: number; enemy: number };
  fogGrid: number[];
  units: UnitSaveData[];
  buildings: BuildingSaveData[];
  resources: ResourceNodeSaveData[];
  townCenterRallyPoint?: { x: number; z: number; targetType: string; targetId?: number | string };
  peacefulQuestsData?: { currentChapterIndex: number; completedObjectiveIds: string[] };
}

const QUICK_SAVE_KEY = 'rts_quicksave';

let saveToastTimeout: any = null;
export function showSaveToast(message: string, isError: boolean = false): void {
  const toastEl = document.getElementById('save-toast');
  const iconEl = document.getElementById('save-toast-icon');
  const msgEl = document.getElementById('save-toast-msg');
  if (!toastEl || !msgEl) return;

  if (iconEl) {
    iconEl.textContent = isError ? '⚠️' : (message.includes('📂') ? '📂' : (message.includes('⬇️') ? '⬇️' : '💾'));
  }
  msgEl.textContent = message;

  toastEl.classList.remove('toast-error', 'toast-success');
  toastEl.classList.add(isError ? 'toast-error' : 'toast-success', 'visible');

  if (saveToastTimeout) clearTimeout(saveToastTimeout);
  saveToastTimeout = setTimeout(() => {
    toastEl.classList.remove('visible');
  }, 3500);
}

export function serializeGameState(saveName: string = 'Partida Salva'): FullSaveState {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const formattedDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // 1. Mapeia nós de recursos ainda disponíveis no mapa (com IDs numéricos e registro em Map)
  const resourcesData: ResourceNodeSaveData[] = [];
  const resourceIdMap = new Map<any, number>();
  let resId = 1;
  treesMap.forEach((tree) => {
    if (tree.wood > 0) {
      const id = resId++;
      resourceIdMap.set(tree, id);
      resourcesData.push({
        id,
        type: 'TREE',
        gridX: tree.gridX,
        gridZ: tree.gridZ,
        remainingAmount: Math.round(tree.wood)
      });
    }
  });
  berryBushesMap.forEach((bush) => {
    if (bush.food > 0) {
      const id = resId++;
      resourceIdMap.set(bush, id);
      resourcesData.push({
        id,
        type: 'BERRY_BUSH',
        gridX: bush.gridX,
        gridZ: bush.gridZ,
        remainingAmount: Math.round(bush.food)
      });
    }
  });
  stoneMinesMap.forEach((mine) => {
    if (mine.stone > 0) {
      const id = resId++;
      resourceIdMap.set(mine, id);
      resourcesData.push({
        id,
        type: 'STONE_MINE',
        gridX: mine.gridX,
        gridZ: mine.gridZ,
        remainingAmount: Math.round(mine.stone)
      });
    }
  });
  goldMinesMap.forEach((mine) => {
    if (mine.gold > 0) {
      const id = resId++;
      resourceIdMap.set(mine, id);
      resourcesData.push({
        id,
        type: 'GOLD_MINE',
        gridX: mine.gridX,
        gridZ: mine.gridZ,
        remainingAmount: Math.round(mine.gold)
      });
    }
  });

  // 2. Mapeia IDs numéricos para unidades ativas
  const unitIdMap = new Map<string, number>();
  unitsList
    .filter((u) => !u.isDying)
    .forEach((u, idx) => {
      unitIdMap.set(u.id, idx + 1);
    });

  // 3. Mapeia edifícios ativos (com IDs numéricos e registro em Map)
  const buildingIdMap = new Map<ConstructionBuilding, number>();
  const buildingsData: BuildingSaveData[] = buildingsList.map((b, idx) => {
    const bId = idx + 1;
    buildingIdMap.set(b, bId);

    const enrolledStudentIds = b.enrolledStudents
      ? b.enrolledStudents
          .map((s) => unitIdMap.get(s.unitId))
          .filter((id): id is number => typeof id === 'number')
      : undefined;

    const trainingQueue = b.trainingQueue && b.trainingQueue.length > 0
      ? b.trainingQueue.map((item) => ({
          unitType: item.unitType as UnitType,
          progressSec: b.trainingTimer || 0
        }))
      : undefined;

    return {
      id: bId,
      type: b.type as BuildingType,
      faction: (b.faction === 'ENEMY' ? 'ENEMY' : 'ALLIED') as 'ALLIED' | 'ENEMY',
      gridX: b.gridX,
      gridZ: b.gridZ,
      hp: Math.round(b.hp ?? 100),
      maxHp: Math.round(b.maxHp ?? 100),
      progress: Math.round(b.progress),
      isCompleted: b.isCompleted,
      enrolledStudentIds: enrolledStudentIds && enrolledStudentIds.length > 0 ? enrolledStudentIds : undefined,
      trainingQueue,
      farmFood: b.type === 'FARM' && b.farmFood !== undefined ? Math.round(b.farmFood) : undefined,
      rallyPoint: b.rallyPoint ? {
        x: b.rallyPoint.x,
        z: b.rallyPoint.z,
        targetType: b.rallyPoint.targetType,
        targetId: b.rallyPoint.targetId
      } : undefined
    };
  });

  // 4. Mapeia unidades ativas capturando estado lógico, alvos relacionais e rotas A* restantes
  const unitsData: UnitSaveData[] = unitsList
    .filter((u) => !u.isDying)
    .map((u) => {
      const numId = unitIdMap.get(u.id) || 1;

      let stateStr: string = u.state;
      let targetResId: number | undefined;
      let targetResCoords: { x: number; z: number } | undefined;
      let targetBldId: number | undefined;
      let targetBldCoords: { x: number; z: number } | undefined;
      let targetUId: number | undefined;
      let currentPathCoords: { x: number; z: number }[] | undefined;

      // Fazenda
      if (u.targetFarm) {
        targetBldId = buildingIdMap.get(u.targetFarm);
        targetBldCoords = { x: u.targetFarm.gridX, z: u.targetFarm.gridZ };
        if (u.state === 'GATHERING' || u.state === 'MOVING_TO_RESOURCE') {
          stateStr = 'FARMING';
        }
      }

      // Recursos (árvore, mina, arbusto)
      if (u.targetTree) {
        targetResId = resourceIdMap.get(u.targetTree);
        targetResCoords = { x: u.targetTree.gridX, z: u.targetTree.gridZ };
      } else if (u.targetBerryBush) {
        targetResId = resourceIdMap.get(u.targetBerryBush);
        targetResCoords = { x: u.targetBerryBush.gridX, z: u.targetBerryBush.gridZ };
      } else if (u.targetStoneMine) {
        targetResId = resourceIdMap.get(u.targetStoneMine);
        targetResCoords = { x: u.targetStoneMine.gridX, z: u.targetStoneMine.gridZ };
      } else if (u.targetGoldMine) {
        targetResId = resourceIdMap.get(u.targetGoldMine);
        targetResCoords = { x: u.targetGoldMine.gridX, z: u.targetGoldMine.gridZ };
      }

      // Edifícios (canteiros de obras, reparo ou instituições educacionais)
      if (u.targetBuilding) {
        targetBldId = buildingIdMap.get(u.targetBuilding);
        targetBldCoords = { x: u.targetBuilding.gridX, z: u.targetBuilding.gridZ };
      } else if (u.targetStructure === 'TOWN_CENTER') {
        targetBldCoords = { x: tcCoord.minX, z: tcCoord.minZ };
      } else if (u.targetSchool) {
        targetBldId = buildingIdMap.get(u.targetSchool);
        targetBldCoords = { x: u.targetSchool.gridX, z: u.targetSchool.gridZ };
      } else if (u.targetCollege) {
        targetBldId = buildingIdMap.get(u.targetCollege);
        targetBldCoords = { x: u.targetCollege.gridX, z: u.targetCollege.gridZ };
      }

      // Combate contra unidade inimiga
      if (u.targetEnemy) {
        targetUId = unitIdMap.get(u.targetEnemy.id);
      }

      // Rota de movimento restante se estava se movendo
      if (u.waypoints && u.waypoints.length > 0) {
        const remaining = u.waypoints.slice(u.currentWaypointIndex || 0);
        if (remaining.length > 0) {
          currentPathCoords = remaining.map((wp) => ({
            x: Math.round(wp.x * 100) / 100,
            z: Math.round(wp.z * 100) / 100
          }));
        }
      }

      return {
        id: numId,
        faction: (u.faction === 'ENEMY' ? 'ENEMY' : 'ALLIED') as 'ALLIED' | 'ENEMY',
        type: u.unitType,
        gridX: Math.round(u.group.position.x - 0.5),
        gridZ: Math.round(u.group.position.z - 0.5),
        hp: Math.round(u.hp),
        maxHp: Math.round(u.maxHp),
        educationLevel: u.educationLevel || 0,
        specialization: u.eliteSpecialization || undefined,
        carriedAmount: u.carrying || 0,
        carriedType: u.carriedResourceType || undefined,
        state: stateStr,
        targetResourceId: targetResId,
        targetResourceCoords: targetResCoords,
        targetBuildingId: targetBldId,
        targetBuildingCoords: targetBldCoords,
        targetUnitId: targetUId,
        currentPath: currentPathCoords
      };
    });

  const metadata: SaveGameMetadata = {
    version: '1.0.0',
    saveName,
    timestamp: Date.now(),
    formattedDate,
    mapSize: mapSize,
    gameMode: currentMatchConfig.peacefulMode ? 'Pacífico' : 'Padrão (Invasão)'
  };

  return {
    metadata,
    matchConfig: { ...currentMatchConfig, mapSeed: currentMapSeed },
    camera: {
      targetX: cameraTarget.x,
      targetZ: cameraTarget.z,
      frustumSize: frustumSize
    },
    playerResources: { ...resources },
    enemyResources: { ...enemyResources },
    popCap: {
      player: getPopulationCap(),
      enemy: enemyPopCap
    },
    fogGrid: Array.from(fogGrid),
    units: unitsData,
    buildings: buildingsData,
    resources: resourcesData,
    townCenterRallyPoint: townCenterState.rallyPoint ? {
      x: townCenterState.rallyPoint.x,
      z: townCenterState.rallyPoint.z,
      targetType: townCenterState.rallyPoint.targetType,
      targetId: townCenterState.rallyPoint.targetId
    } : undefined,
    peacefulQuestsData: currentMatchConfig.peacefulMode ? {
      currentChapterIndex,
      completedObjectiveIds: (peacefulChapters[currentChapterIndex]?.objectives ?? []).filter(o => o.isCompleted).map(o => o.id)
    } : undefined
  };
}

function createBuildingFromData(bData: BuildingSaveData): ConstructionBuilding | null {
  const faction: UnitFaction = bData.faction === 'ENEMY' ? 'ENEMY' : 'PLAYER';
  let b: ConstructionBuilding;

  switch (bData.type) {
    case 'BARRACKS':
      b = createBarracksFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'ARCHERY_RANGE':
      b = createArcheryRangeFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'TOWER':
      b = createTowerFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'LUMBER_CAMP':
      b = createLumberCampFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'MINING_CAMP':
      b = createMiningCampFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'HOUSE':
      b = createHouseFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'MILL':
      b = createMillFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'FARM':
      b = createFarmFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'SCHOOL':
      b = createSchoolFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'COLLEGE':
      b = createCollegeFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'WALL':
      b = createWallFoundation(bData.gridX, bData.gridZ, faction);
      break;
    case 'GATE':
      b = createGateFoundation(bData.gridX, bData.gridZ, faction);
      break;
    default:
      console.warn(`[SaveLoad] Tipo de estrutura desconhecido: ${bData.type}`);
      return null;
  }

  b.progress = bData.progress;
  if (bData.hp !== undefined) b.hp = bData.hp;
  if (bData.maxHp !== undefined) b.maxHp = bData.maxHp;

  if (bData.isCompleted) {
    b.isCompleted = true;
    b.siteGroup.visible = false;
    b.progressGroup.visible = false;
    b.finishedGroup.visible = true;
    b.group.visible = true;
    b.finishedGroup.scale.set(1, 1, 1);
    if (b.type === 'WALL') {
      try { updateWallConnections(b); } catch (_) {}
    } else if (b.type === 'GATE') {
      try {
        rebuildWallNeighbors(b.gridX - 1, b.gridZ);
        rebuildWallNeighbors(b.gridX + 2, b.gridZ);
      } catch (_) {}
    }
  } else {
    b.isCompleted = false;
    b.siteGroup.visible = true;
    b.progressGroup.visible = true;
    b.finishedGroup.visible = false;
    b.progressBarMesh.scale.x = Math.max(0.01, b.progress / 100);
  }

  if (b.type === 'FARM' && b.isCompleted) {
    b.farmFood = bData.farmFood !== undefined ? bData.farmFood : 300;
    b.maxFarmFood = 300;
  }

  if (bData.trainingQueue && bData.trainingQueue.length > 0) {
    b.trainingQueue = bData.trainingQueue.map((item, idx) => ({
      id: `queue_${Date.now()}_${idx}`,
      unitType: item.unitType as 'SWORDSMAN' | 'ARCHER',
      totalDuration: item.unitType === 'SWORDSMAN' ? currentMatchConfig.trainingTime : ARCHER_TRAIN_TIME_SEC
    }));
    b.trainingTimer = bData.trainingQueue[0]?.progressSec || 0;
  }

  if (bData.rallyPoint) {
    b.rallyPoint = {
      x: bData.rallyPoint.x,
      z: bData.rallyPoint.z,
      targetType: bData.rallyPoint.targetType as any,
      targetId: bData.rallyPoint.targetId
    };
  } else {
    b.rallyPoint = null;
  }

  return b;
}

export function deserializeAndLoadGame(save: FullSaveState): void {
  if (!save || !save.metadata || !Array.isArray(save.units) || !Array.isArray(save.buildings)) {
    throw new Error('Arquivo de save inválido ou dados corrompidos.');
  }

  // 1. Limpa seleção, modos de colocação, modais e banners de jogo
  deselectAllUnits();
  deselectBuilding();
  deselectTownCenter();
  if (isPlacementMode) exitPlacementMode();
  isGameOver = false;
  isGamePaused = false;
  (window as any).isGamePaused = false;
  const gameOverModal = document.getElementById('game-over-modal');
  if (gameOverModal) gameOverModal.style.display = 'none';
  const pauseBanner = document.getElementById('pause-indicator');
  if (pauseBanner) {
    pauseBanner.style.display = 'none';
    pauseBanner.classList.add('hidden');
  }

  // 2. Remove e descarta (dispose) todas as unidades 3D existentes
  for (const u of unitsList) {
    if (u.group.parent) scene.remove(u.group);
    u.group.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry?.dispose();
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m?.dispose?.());
      }
    });
  }
  unitsList.length = 0;
  activeDeathAnimations.length = 0;
  activeSpawnAnimations.length = 0;

  for (const p of activeParticles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  activeParticles.length = 0;

  for (const p of towerProjectiles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  towerProjectiles.length = 0;

  for (const p of archerProjectiles) {
    if (p.mesh.parent) scene.remove(p.mesh);
  }
  archerProjectiles.length = 0;

  // 3. Remove e descarta (dispose) todos os edifícios 3D existentes
  for (const b of buildingsList) {
    if (b.group.parent) scene.remove(b.group);
    b.group.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry?.dispose();
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m?.dispose?.());
      }
    });
  }
  buildingsList.length = 0;
  buildingsGridMap.clear();

  // 4. Remove obstáculos (árvores, minas, arbustos, muralhas) e acampamento inimigo
  clearMapObstacles();
  disposeEnemyCamp();

  // 5. Restaura tamanho do mapa e relevo caso sejam diferentes
  const targetMapSize = save.metadata.mapSize || mapSize;
  const targetSeed = save.matchConfig?.mapSeed ?? currentMapSeed;
  if (targetMapSize !== mapSize || targetSeed !== currentMapSeed) {
    currentMapSeed = targetSeed;
    applyMapSize(targetMapSize, currentMapSeed);
    pendingMapSize = targetMapSize;
  } else {
    gridOccupancy = createOccupancyGrid(GRID_SIZE);
    evaluateCliffsAndPlateaus();
  }

  if (save.matchConfig) {
    Object.assign(currentMatchConfig, save.matchConfig);
  }
  hasEnemyFaction = !currentMatchConfig.peacefulMode;

  // 6. Restaura Town Center e Acampamento Inimigo
  restoreTownCenter();
  if (hasEnemyFaction) {
    createEnemyCamp(enemyCampCoord.x, enemyCampCoord.z);
  }

  // 7. Recria fisicamente os nós de recursos vivos e os indexa por ID e coordenadas
  const resourceMapById = new Map<number, any>();
  const resourceMapByKey = new Map<number, any>();

  if (Array.isArray(save.resources)) {
    for (const res of save.resources) {
      let createdRes: any = null;
      if (res.type === 'TREE') {
        const tree = createTree(res.gridX, res.gridZ);
        tree.wood = res.remainingAmount;
        createdRes = tree;
      } else if (res.type === 'BERRY_BUSH') {
        const bush = createBerryBush(res.gridX, res.gridZ);
        bush.food = res.remainingAmount;
        createdRes = bush;
      } else if (res.type === 'STONE_MINE') {
        const mine = createStoneMine(res.gridX, res.gridZ);
        mine.stone = res.remainingAmount;
        createdRes = mine;
      } else if (res.type === 'GOLD_MINE') {
        const mine = createGoldMine(res.gridX, res.gridZ);
        mine.gold = res.remainingAmount;
        createdRes = mine;
      }
      if (createdRes) {
        resourceMapById.set(res.id, createdRes);
        resourceMapByKey.set(cellKey(res.gridX, res.gridZ), createdRes);
      }
    }
  }

  function findResourceByIdOrCoords(id?: number, coords?: { x: number; z: number }): any {
    if (id !== undefined && resourceMapById.has(id)) {
      return resourceMapById.get(id);
    }
    if (coords) {
      const k = cellKey(coords.x, coords.z);
      if (resourceMapByKey.has(k)) {
        return resourceMapByKey.get(k);
      }
      return treesMap.get(k) || berryBushesMap.get(k) || stoneMinesMap.get(k) || goldMinesMap.get(k) || null;
    }
    return null;
  }

  // 8. Recria fisicamente as estruturas e as indexa por ID e coordenadas
  const restoredBuildings: ConstructionBuilding[] = [];
  const buildingMapById = new Map<number, ConstructionBuilding>();
  const buildingMapByKey = new Map<number, ConstructionBuilding>();

  if (Array.isArray(save.buildings)) {
    for (const bData of save.buildings) {
      const b = createBuildingFromData(bData);
      if (b) {
        restoredBuildings.push(b);
        buildingMapById.set(bData.id, b);
        buildingMapByKey.set(cellKey(bData.gridX, bData.gridZ), b);
      }
    }
  }

  function findBuildingByIdOrCoords(id?: number, coords?: { x: number; z: number }): ConstructionBuilding | null {
    if (id !== undefined && buildingMapById.has(id)) {
      return buildingMapById.get(id)!;
    }
    if (coords) {
      const k = cellKey(coords.x, coords.z);
      if (buildingMapByKey.has(k)) {
        return buildingMapByKey.get(k)!;
      }
      const found = buildingsList.find((item) => item.gridX === coords.x && item.gridZ === coords.z);
      if (found) return found;
    }
    return null;
  }

  // Atualiza conexões visuais de muros restaurados
  for (const b of restoredBuildings) {
    if (b.type === 'WALL') {
      try { updateWallConnections(b); } catch (_) {}
    }
  }

  // 9. Recria fisicamente as unidades (Passo 1: Instanciação, HP, Educação e Itens)
  const restoredUnitsMap = new Map<number, RTSUnit>();
  if (Array.isArray(save.units)) {
    for (const uData of save.units) {
      const faction: UnitFaction = uData.faction === 'ENEMY' ? 'ENEMY' : 'PLAYER';
      const unit = createUnit(uData.gridX, uData.gridZ, uData.type, faction);
      unit.hp = uData.hp;
      unit.maxHp = uData.maxHp;
      unit.group.scale.setScalar(1);

      // Restaura educação e itens visuais 3D
      if (uData.educationLevel >= 1) {
        unit.educationLevel = 1;
        unit.carryCapacity = 20;
        unit.canEnrollInCollege = true;
        if (unit.backpackMesh) unit.backpackMesh.visible = true;
      }
      if (uData.educationLevel >= 2) {
        unit.educationLevel = 2;
        unit.eliteSpecialization = (uData.specialization as EliteCourse) || 'ARCHITECT';
        unit.canEnrollInCollege = false;
        if (unit.academicCapGroup) unit.academicCapGroup.visible = true;
        if (unit.academicGownMesh) unit.academicGownMesh.visible = true;
      }

      // Restaura recursos carregados
      if (uData.carriedType) {
        unit.carriedResourceType = uData.carriedType as any;
      }
      if (uData.carriedAmount > 0 && uData.carriedType) {
        unit.carrying = uData.carriedAmount;
        unit.carryMesh.visible = true;
        if (unit.woodCarryMesh) unit.woodCarryMesh.visible = (uData.carriedType === 'WOOD');
        if (unit.berryCarryMesh) unit.berryCarryMesh.visible = (uData.carriedType === 'FOOD');
        if (unit.stoneCarryMesh) unit.stoneCarryMesh.visible = (uData.carriedType === 'STONE');
        if (unit.goldCarryMesh) unit.goldCarryMesh.visible = (uData.carriedType === 'GOLD');
      }

      restoredUnitsMap.set(uData.id, unit);
    }
  }

  // Remove animações de spawn para as unidades carregadas ficarem instantaneamente visíveis
  activeSpawnAnimations.length = 0;

  // Restaura vínculos de estudantes matriculados
  if (Array.isArray(save.buildings)) {
    for (let i = 0; i < save.buildings.length; i++) {
      const bData = save.buildings[i];
      const b = restoredBuildings[i];
      if (b && bData.enrolledStudentIds && bData.enrolledStudentIds.length > 0) {
        b.enrolledStudents = [];
        for (const studentId of bData.enrolledStudentIds) {
          const studentUnit = restoredUnitsMap.get(studentId);
          if (studentUnit) {
            studentUnit.isGarrisoned = true;
            studentUnit.group.visible = false;
            studentUnit.state = 'STUDYING';
            studentUnit.waypoints = [];
            b.enrolledStudents.push({
              unitId: studentUnit.id,
              progressSec: 0,
              chosenCourse: b.selectedCollegeCourse || 'ARCHITECT'
            });
          }
        }
      }
    }
  }

  // 9.5 Restaura estado comportamental e ações ativas das unidades (Passo 2)
  if (Array.isArray(save.units)) {
    for (const uData of save.units) {
      const unit = restoredUnitsMap.get(uData.id);
      if (!unit || unit.isGarrisoned) continue;

      const myPos = unit.group.position;

      switch (uData.state) {
        case 'GATHERING':
        case 'MINING_GOLD':
        case 'MOVING_TO_RESOURCE': {
          const res = findResourceByIdOrCoords(uData.targetResourceId, uData.targetResourceCoords);
          if (res) {
            const resX = res.gridX + 0.5;
            const resZ = res.gridZ + 0.5;
            const dist = Math.hypot(myPos.x - resX, myPos.z - resZ);

            if (res.wood !== undefined && res.wood > 0) {
              if (uData.state === 'GATHERING' && dist <= 1.8) {
                unit.targetTree = res;
                unit.carriedResourceType = 'WOOD';
                unit.state = 'GATHERING';
                unit.waypoints = [];
                unit.gatherTimer = 0;
                faceTowards(unit, res.gridX + 0.5, res.gridZ + 0.5, 1.0);
              } else {
                commandGather(unit, res);
              }
            } else if (res.food !== undefined && res.food > 0) {
              if (uData.state === 'GATHERING' && dist <= 1.8) {
                unit.targetBerryBush = res;
                unit.carriedResourceType = 'FOOD';
                unit.state = 'GATHERING';
                unit.waypoints = [];
                unit.gatherTimer = 0;
                faceTowards(unit, res.gridX + 0.5, res.gridZ + 0.5, 1.0);
              } else {
                commandForage(unit, res);
              }
            } else if (res.stone !== undefined && res.stone > 0) {
              if (uData.state === 'GATHERING' && dist <= 1.8) {
                unit.targetStoneMine = res;
                unit.carriedResourceType = 'STONE';
                unit.state = 'GATHERING';
                unit.waypoints = [];
                unit.gatherTimer = 0;
                faceTowards(unit, res.gridX + 0.5, res.gridZ + 0.5, 1.0);
              } else {
                commandMine(unit, res);
              }
            } else if (res.gold !== undefined && res.gold > 0) {
              if ((uData.state === 'MINING_GOLD' || uData.state === 'GATHERING') && dist <= 1.8) {
                unit.targetGoldMine = res;
                unit.carriedResourceType = 'GOLD';
                unit.state = 'MINING_GOLD';
                unit.waypoints = [];
                unit.gatherTimer = 0;
                faceTowards(unit, res.gridX + 0.5, res.gridZ + 0.5, 1.0);
              } else {
                commandMineGold(unit, res);
              }
            } else {
              goIdle(unit);
            }
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'FARMING': {
          const farm = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
          if (farm && farm.type === 'FARM' && !farm.isDepleted) {
            const dist = farm.worldCenter ? Math.hypot(myPos.x - farm.worldCenter.x, myPos.z - farm.worldCenter.z) : 999;
            if (dist <= 3.2 && farm.isCompleted) {
              farm.assignedFarmerId = unit.id;
              unit.targetFarm = farm;
              unit.carriedResourceType = 'FOOD';
              unit.state = 'GATHERING';
              unit.waypoints = [];
              unit.gatherTimer = 0;
              faceTowards(unit, farm.worldCenter.x, farm.worldCenter.z, 1.0);
            } else {
              commandFarm(unit, farm);
            }
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'BUILDING':
        case 'MOVING_TO_BUILD': {
          const b = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
          if (b && !b.isCompleted && b.progress < 100) {
            const bCenter = b.worldCenter;
            const dist = bCenter ? Math.hypot(myPos.x - bCenter.x, myPos.z - bCenter.z) : 999;
            const reach = (b.size === 1 ? 1.6 : (b.size === 3 ? 2.5 : 2.0));
            if (uData.state === 'BUILDING' && dist <= reach) {
              unit.targetBuilding = b;
              unit.state = 'BUILDING';
              unit.waypoints = [];
              faceTowards(unit, bCenter.x, bCenter.z, 1.0);
            } else {
              commandBuild(unit, b);
            }
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'REPAIRING':
        case 'MOVING_TO_REPAIR': {
          if (unit.unitType !== 'VILLAGER') {
            goIdle(unit);
            break;
          }
          const isTcTarget = (uData.targetBuildingCoords &&
            uData.targetBuildingCoords.x >= tcCoord.minX && uData.targetBuildingCoords.x <= tcCoord.maxX &&
            uData.targetBuildingCoords.z >= tcCoord.minZ && uData.targetBuildingCoords.z <= tcCoord.maxZ) ||
            (!uData.targetBuildingId && isTownCenterDamaged());

          if (isTcTarget && isTownCenterDamaged()) {
            const dist = Math.hypot(myPos.x - TC_WORLD_CENTER.x, myPos.z - TC_WORLD_CENTER.z);
            if (uData.state === 'REPAIRING' && dist <= 2.6) {
              unit.targetStructure = 'TOWN_CENTER';
              unit.targetBuilding = null;
              unit.state = 'REPAIRING';
              unit.waypoints = [];
              faceTowards(unit, TC_WORLD_CENTER.x, TC_WORLD_CENTER.z, 1.0);
            } else {
              commandRepairTownCenter(unit);
            }
          } else {
            const b = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
            if (b && b.isCompleted && (b.hp ?? 0) < (b.maxHp ?? 1)) {
              const bCenter = b.worldCenter;
              const dist = bCenter ? Math.hypot(myPos.x - bCenter.x, myPos.z - bCenter.z) : 999;
              const reach = (b.size === 1 ? 1.6 : (b.size === 3 ? 2.5 : 2.0));
              if (uData.state === 'REPAIRING' && dist <= reach) {
                unit.targetBuilding = b;
                unit.targetStructure = 'BUILDING';
                unit.state = 'REPAIRING';
                unit.waypoints = [];
                faceTowards(unit, bCenter.x, bCenter.z, 1.0);
              } else {
                commandRepairBuilding(unit, b);
              }
            } else {
              goIdle(unit);
            }
          }
          break;
        }

        case 'RETURNING_TO_BASE':
        case 'DEPOSITING': {
          if (unit.carrying > 0 && unit.carriedResourceType) {
            commandReturnToBase(unit);
            // Salva o alvo de recurso de retorno para que volte ao trabalho após descarregar
            const res = findResourceByIdOrCoords(uData.targetResourceId, uData.targetResourceCoords);
            if (res) {
              if (res.wood !== undefined) {
                unit.targetTree = res;
                unit.lastTreeCell = new THREE.Vector2(res.gridX, res.gridZ);
              } else if (res.food !== undefined) {
                unit.targetBerryBush = res;
                unit.lastBerryCell = new THREE.Vector2(res.gridX, res.gridZ);
              } else if (res.stone !== undefined) {
                unit.targetStoneMine = res;
                unit.lastStoneCell = new THREE.Vector2(res.gridX, res.gridZ);
              } else if (res.gold !== undefined) {
                unit.targetGoldMine = res;
                unit.lastGoldCell = new THREE.Vector2(res.gridX, res.gridZ);
              }
            } else if (uData.targetBuildingId) {
              const farm = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
              if (farm && farm.type === 'FARM') {
                unit.targetFarm = farm;
              }
            }
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'CHASING':
        case 'ATTACKING': {
          const targetEnemy = uData.targetUnitId ? restoredUnitsMap.get(uData.targetUnitId) : null;
          if (targetEnemy && !targetEnemy.isDying && targetEnemy.hp > 0) {
            commandAttack(unit, targetEnemy);
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'ATTACKING_STRUCTURE': {
          const targetB = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
          if (targetB && !targetB.isDepleted && (targetB.hp === undefined || targetB.hp > 0)) {
            commandAttackBuilding(unit, targetB);
          } else if (uData.targetBuildingCoords && uData.targetBuildingCoords.x === enemyCampCoord.x && uData.targetBuildingCoords.z === enemyCampCoord.z) {
            commandAttackTent(unit);
          } else if (hasEnemyFaction) {
            commandAttackTownCenter(unit);
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'MOVING_TO_SCHOOL': {
          const school = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
          if (school && school.type === 'SCHOOL' && school.isCompleted) {
            commandEnrollInSchool(unit, school);
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'MOVING_TO_COLLEGE': {
          const college = findBuildingByIdOrCoords(uData.targetBuildingId, uData.targetBuildingCoords);
          if (college && college.type === 'COLLEGE' && college.isCompleted) {
            commandEnrollInCollege(unit, college);
          } else {
            goIdle(unit);
          }
          break;
        }

        case 'MOVING': {
          if (uData.currentPath && uData.currentPath.length > 0) {
            unit.waypoints = uData.currentPath.map((p) => new THREE.Vector3(p.x, getTerrainHeight(p.x, p.z), p.z));
            unit.currentWaypointIndex = 0;
            unit.state = 'MOVING';
          } else {
            goIdle(unit);
          }
          break;
        }

        default:
          goIdle(unit);
          break;
      }
    }
  }

  // 10. Restaura estoques de recursos no HUD e nos objetos globais
  if (save.playerResources) {
    resources.wood = save.playerResources.wood ?? resources.wood;
    resources.food = save.playerResources.food ?? resources.food;
    resources.gold = save.playerResources.gold ?? resources.gold;
    resources.stone = save.playerResources.stone ?? resources.stone;
  }
  if (save.enemyResources) {
    enemyResources.wood = save.enemyResources.wood ?? enemyResources.wood;
    enemyResources.food = save.enemyResources.food ?? enemyResources.food;
    enemyResources.gold = save.enemyResources.gold ?? enemyResources.gold;
    enemyResources.stone = save.enemyResources.stone ?? enemyResources.stone;
  }
  if (save.popCap && typeof save.popCap.enemy === 'number') {
    enemyPopCap = save.popCap.enemy;
  }
  updateResourceHUD(true);

  // 11. Restaura névoa de guerra e minimapa
  if (Array.isArray(save.fogGrid) && save.fogGrid.length > 0) {
    for (let i = 0; i < save.fogGrid.length && i < fogGrid.length; i++) {
      fogGrid[i] = save.fogGrid[i];
    }
    updateFogOfWar(true);
  }
  renderMinimap();
  updateTelemetryUnitsCount();
  updateTelemetrySelectionCount();
  updateObjectiveHUD();

  // 12. Reposiciona câmera
  if (save.camera) {
    cameraTarget.set(save.camera.targetX, 0, save.camera.targetZ);
    targetDesired.set(save.camera.targetX, 0, save.camera.targetZ);
    frustumSize = save.camera.frustumSize || 28;
    targetFrustumSize = save.camera.frustumSize || 28;
    updateCameraFrustum();
    updateCameraTransform();
  }

  // 13. Restaura Ponto de Encontro do Town Center
  if (save.townCenterRallyPoint) {
    townCenterState.rallyPoint = {
      x: save.townCenterRallyPoint.x,
      z: save.townCenterRallyPoint.z,
      targetType: save.townCenterRallyPoint.targetType as any,
      targetId: save.townCenterRallyPoint.targetId
    };
  } else {
    townCenterState.rallyPoint = null;
  }
  updateRallyPointVisuals();

  // 14. Restaura progresso das missões do modo pacífico
  resetPeacefulQuests(save.peacefulQuestsData);

  closeSaveLoadModal();
  if (currentGameState === 'MENU') {
    currentGameState = 'IN_GAME';
    isGamePaused = false;
    hasMatchEverStarted = true;
    setUIMenuMode(false);
    if (menuDuelGroup) menuDuelGroup.visible = false;
  }
}

export function saveToSlot(slotKey: string, customName?: string): boolean {
  try {
    const slotLabel = slotKey === QUICK_SAVE_KEY
      ? 'Quick Save'
      : `Slot ${slotKey.slice(-1)}`;
    const fullState = serializeGameState(customName || slotLabel);
    const json = JSON.stringify(fullState);
    localStorage.setItem(slotKey, json);

    soundManager.buildingComplete();
    showSaveToast(slotKey === QUICK_SAVE_KEY ? '⚡ Quick Save realizado [F5]!' : `💾 Partida salva com sucesso no ${slotLabel}!`);
    refreshSaveLoadUI();
    return true;
  } catch (err) {
    console.error('[SaveLoad] Erro ao salvar partida:', err);
    showSaveToast('⚠️ Falha ao salvar a partida!', true);
    return false;
  }
}

export function loadFromSlot(slotKey: string): boolean {
  try {
    const json = localStorage.getItem(slotKey);
    if (!json) {
      showSaveToast('⚠️ Nenhum save encontrado neste slot!', true);
      return false;
    }
    const state: FullSaveState = JSON.parse(json);
    deserializeAndLoadGame(state);
    soundManager.uiClick();
    const slotLabel = slotKey === QUICK_SAVE_KEY ? 'Quick Save [F9]' : `Slot ${slotKey.slice(-1)}`;
    showSaveToast(`📂 Partida carregada com sucesso do ${slotLabel}!`);
    return true;
  } catch (err) {
    console.error('[SaveLoad] Erro ao carregar partida:', err);
    showSaveToast('⚠️ Falha ao carregar a partida salva!', true);
    return false;
  }
}

export function deleteSlot(slotKey: string): void {
  try {
    localStorage.removeItem(slotKey);
    soundManager.uiClick();
    const slotLabel = slotKey === QUICK_SAVE_KEY ? 'Quick Save' : `Slot ${slotKey.slice(-1)}`;
    showSaveToast(`🗑️ ${slotLabel} apagado.`);
    refreshSaveLoadUI();
  } catch (err) {
    console.error('[SaveLoad] Erro ao deletar slot:', err);
  }
}

export function exportSaveFile(slotKey?: string): void {
  try {
    let fullState: FullSaveState;
    if (slotKey) {
      const json = localStorage.getItem(slotKey);
      if (json) {
        fullState = JSON.parse(json);
      } else {
        fullState = serializeGameState('Export');
      }
    } else {
      fullState = serializeGameState('Export');
    }

    const jsonString = JSON.stringify(fullState, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'domain_of_tiles_save.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    soundManager.uiClick();
    showSaveToast('⬇️ Arquivo domain_of_tiles_save.json exportado com sucesso!');
  } catch (err) {
    console.error('[SaveLoad] Erro ao exportar save:', err);
    showSaveToast('⚠️ Falha ao exportar arquivo de save!', true);
  }
}

export async function importSaveFile(file: File): Promise<boolean> {
  try {
    const text = await file.text();
    const state: FullSaveState = JSON.parse(text);
    deserializeAndLoadGame(state);
    soundManager.buildingComplete();
    showSaveToast('📂 Partida importada e carregada com sucesso!');
    return true;
  } catch (err) {
    console.error('[SaveLoad] Erro ao importar arquivo de save:', err);
    showSaveToast('⚠️ Arquivo de save inválido ou incompatível!', true);
    return false;
  }
}

export function refreshSaveLoadUI(): void {
  // Quick Save
  const qsJson = localStorage.getItem(QUICK_SAVE_KEY);
  const qsDateEl = document.getElementById('quicksave-date');
  const qsSummaryEl = document.getElementById('quicksave-summary');
  const qsLoadBtn = document.getElementById('btn-quicksave-load') as HTMLButtonElement | null;
  const qsCard = document.getElementById('save-quick-card');

  if (qsJson) {
    try {
      const qsState: FullSaveState = JSON.parse(qsJson);
      if (qsDateEl) qsDateEl.textContent = qsState.metadata?.formattedDate || 'Salvo';
      if (qsSummaryEl) {
        const alliedUnits = (qsState.units || []).filter(u => u.faction === 'ALLIED');
        const popMax = qsState.popCap?.player || 20;
        qsSummaryEl.textContent = `Mapa ${qsState.metadata?.mapSize || 50}x${qsState.metadata?.mapSize || 50} • Pop: ${alliedUnits.length}/${popMax} • ${qsState.units?.length || 0} Unidades • ${qsState.buildings?.length || 0} Estruturas`;
      }
      if (qsLoadBtn) qsLoadBtn.disabled = false;
      if (qsCard) qsCard.classList.add('has-save');
    } catch (_) {
      if (qsLoadBtn) qsLoadBtn.disabled = true;
    }
  } else {
    if (qsDateEl) qsDateEl.textContent = 'Nenhum Quick Save registrado';
    if (qsSummaryEl) qsSummaryEl.textContent = 'Pressione [F5] durante o jogo para salvar instantaneamente e [F9] para carregar.';
    if (qsLoadBtn) qsLoadBtn.disabled = true;
    if (qsCard) qsCard.classList.remove('has-save');
  }

  // Slots 1, 2, 3
  const slotKeys = ['rts_save_slot_1', 'rts_save_slot_2', 'rts_save_slot_3'];
  slotKeys.forEach((key, idx) => {
    const slotNum = idx + 1;
    const card = document.getElementById(`slot-card-${slotNum}`);
    const statusEl = document.getElementById(`slot-${slotNum}-status`);
    const dateEl = document.getElementById(`slot-${slotNum}-date`);
    const summaryEl = document.getElementById(`slot-${slotNum}-summary`);
    const loadBtn = card?.querySelector('.btn-slot-load') as HTMLButtonElement | null;
    const deleteBtn = card?.querySelector('.btn-slot-delete') as HTMLButtonElement | null;

    const raw = localStorage.getItem(key);
    if (raw) {
      try {
        const s: FullSaveState = JSON.parse(raw);
        if (card) card.classList.add('has-save');
        if (statusEl) {
          statusEl.textContent = 'Salvo';
          statusEl.classList.add('active-save');
        }
        if (dateEl) dateEl.textContent = s.metadata?.formattedDate || '—';
        if (summaryEl) {
          const allied = (s.units || []).filter(u => u.faction === 'ALLIED');
          const villagers = allied.filter(u => u.type === 'VILLAGER').length;
          const military = allied.filter(u => u.type !== 'VILLAGER').length;
          const popMax = s.popCap?.player || 20;
          summaryEl.textContent = `Mapa ${s.metadata?.mapSize || 50}x${s.metadata?.mapSize || 50} | Pop: ${allied.length}/${popMax} | ${villagers} Aldeões, ${military} Guerreiros | ${s.buildings?.length || 0} Edifícios`;
        }
        if (loadBtn) loadBtn.disabled = false;
        if (deleteBtn) deleteBtn.disabled = false;
      } catch (_) {
        if (card) card.classList.remove('has-save');
        if (statusEl) {
          statusEl.textContent = 'Corrompido';
          statusEl.classList.remove('active-save');
        }
        if (summaryEl) summaryEl.textContent = 'Arquivo corrompido ou incompatível.';
        if (loadBtn) loadBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = false;
      }
    } else {
      if (card) card.classList.remove('has-save');
      if (statusEl) {
        statusEl.textContent = 'Vazio';
        statusEl.classList.remove('active-save');
      }
      if (dateEl) dateEl.textContent = '—';
      if (summaryEl) summaryEl.textContent = 'Espaço livre para salvar uma nova partida.';
      if (loadBtn) loadBtn.disabled = true;
      if (deleteBtn) deleteBtn.disabled = true;
    }
  });
}

export function openSaveLoadModal(): void {
  const modal = document.getElementById('save-load-modal');
  if (!modal) return;
  refreshSaveLoadUI();
  modal.style.display = 'flex';
  isSaveLoadModalOpen = true;
  soundManager.uiClick();
}

export function closeSaveLoadModal(): void {
  const modal = document.getElementById('save-load-modal');
  if (!modal) return;
  modal.style.display = 'none';
  isSaveLoadModalOpen = false;
}

export function setupSaveLoadSystem(): void {
  const btnToggle = document.getElementById('btn-toggle-save-load');
  if (btnToggle) {
    btnToggle.onclick = () => {
      if (isSaveLoadModalOpen) closeSaveLoadModal();
      else openSaveLoadModal();
    };
  }

  const btnClose = document.getElementById('btn-close-save-load');
  if (btnClose) {
    btnClose.onclick = () => closeSaveLoadModal();
  }

  const backdrop = document.getElementById('save-load-backdrop');
  if (backdrop) {
    backdrop.onclick = () => closeSaveLoadModal();
  }

  const btnQsSave = document.getElementById('btn-quicksave-save');
  if (btnQsSave) {
    btnQsSave.onclick = () => saveToSlot(QUICK_SAVE_KEY, 'Quick Save');
  }

  const btnQsLoad = document.getElementById('btn-quicksave-load');
  if (btnQsLoad) {
    btnQsLoad.onclick = () => loadFromSlot(QUICK_SAVE_KEY);
  }

  const slotList = document.getElementById('save-slots-list');
  if (slotList) {
    slotList.onclick = (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target) return;
      const action = target.getAttribute('data-action');
      const slot = target.getAttribute('data-slot');
      if (!action || !slot) return;

      if (action === 'save') {
        const slotNum = slot.slice(-1);
        saveToSlot(slot, `Slot ${slotNum}`);
      } else if (action === 'load') {
        loadFromSlot(slot);
      } else if (action === 'delete') {
        deleteSlot(slot);
      }
    };
  }

  const btnExport = document.getElementById('btn-export-save-file');
  if (btnExport) {
    btnExport.onclick = () => exportSaveFile();
  }

  const btnImport = document.getElementById('btn-import-save-file');
  const inputImport = document.getElementById('input-import-save') as HTMLInputElement | null;
  if (btnImport && inputImport) {
    btnImport.onclick = () => inputImport.click();
    inputImport.onchange = () => {
      if (inputImport.files && inputImport.files[0]) {
        importSaveFile(inputImport.files[0]);
        inputImport.value = '';
      }
    };
  }

  (window as any).rtsSaveSystem = {
    serializeGameState,
    deserializeAndLoadGame,
    saveToSlot,
    loadFromSlot,
    deleteSlot,
    exportSaveFile,
    importSaveFile,
    openSaveLoadModal,
    closeSaveLoadModal,
    refreshSaveLoadUI
  };
}

// =============================================================================
// 19. DIORAMA 3D DO MENU PRINCIPAL - DUELO ÉPICO DOS DOIS GUERREIROS
// =============================================================================

export const MENU_DIORAMA_POS = new THREE.Vector3(500, 0, 500);
export let menuDuelGroup: THREE.Group | null = null;

export function createMenuDuelScene(): THREE.Group {
  // Desativado: o menu principal agora utiliza a arte ilustrada oficial (menu-background.jpg)
  if (menuDuelGroup) return menuDuelGroup;
  menuDuelGroup = new THREE.Group();
  menuDuelGroup.visible = false;
  return menuDuelGroup;
}

export function updateMenuDuelScene(_delta: number): void {
  // Desativado: substituído por menu-background.jpg
}

// -----------------------------------------------------------------------------
// TRANSIÇÃO DE ESTADOS DO JOGO (MENU -> IN-GAME -> MENU)
// -----------------------------------------------------------------------------
export function setUIMenuMode(isMenu: boolean): void {
  const inGameHudEl = document.getElementById('in-game-hud');
  const mainMenuOverlayEl = document.getElementById('main-menu-overlay');

  if (isMenu) {
    document.body.classList.add('menu-mode');
    if (inGameHudEl) {
      inGameHudEl.style.display = 'none';
      inGameHudEl.classList.add('hidden');
    }
    if (mainMenuOverlayEl) {
      mainMenuOverlayEl.style.display = 'flex';
      mainMenuOverlayEl.classList.remove('menu-hidden');
      mainMenuOverlayEl.classList.remove('menu-fade-out');
    }
  } else {
    document.body.classList.remove('menu-mode');
    if (inGameHudEl) {
      inGameHudEl.style.display = '';
      inGameHudEl.classList.remove('hidden');
    }
    if (mainMenuOverlayEl) {
      mainMenuOverlayEl.classList.add('menu-hidden');
      mainMenuOverlayEl.classList.add('menu-fade-out');
      setTimeout(() => {
        if (currentGameState !== 'MENU') {
          mainMenuOverlayEl.style.display = 'none';
        }
      }, 600);
    }
  }
}

export function startNewGameFromMenu(): void {
  try {
    soundManager.ensureAudioContext();
    soundManager.warTrumpetAlert();
  } catch (_) {}

  const menuOverlay = document.getElementById('main-menu-overlay');
  menuOverlay?.classList.add('menu-hidden');
  menuOverlay?.classList.add('menu-fade-out');

  setTimeout(() => {
    currentGameState = 'IN_GAME';
    isGamePaused = false;
    hasMatchEverStarted = true;
    setUIMenuMode(false);
    if (menuOverlay) menuOverlay.style.display = 'none';
    if (menuDuelGroup) menuDuelGroup.visible = false;

    const alliedBaseX = tcCoord.minX + 1.5;
    const alliedBaseZ = tcCoord.minZ + 1.5;
    setupGameCamera(alliedBaseX, alliedBaseZ);
  }, 600);
}

export function returnToMainMenu(): void {
  const pauseModal = document.getElementById('pause-menu-modal');
  if (pauseModal) pauseModal.style.display = 'none';
  const pIndicator = document.getElementById('pause-indicator');
  if (pIndicator) {
    pIndicator.style.display = 'none';
    pIndicator.classList.add('hidden');
  }

  isGamePaused = true;
  currentGameState = 'MENU';

  setUIMenuMode(true);

  try {
    soundManager.uiClick();
  } catch (_) {}
}

export function setupMainMenuUI(): void {
  const btnNewGame = document.getElementById('btn-menu-new-game');
  const btnLoadGame = document.getElementById('btn-menu-load-game');
  const btnAbout = document.getElementById('btn-menu-about');
  const btnQuit = document.getElementById('btn-menu-quit');

  // Modais de Nova Partida e Sobre o Jogo
  const modalNewGameSetup = document.getElementById('modal-new-game-setup');
  const modalAboutGame = document.getElementById('modal-about-game');
  const btnCloseSetupModal = document.getElementById('btn-close-setup-modal');
  const btnSetupCancel = document.getElementById('btn-setup-cancel');
  const btnSetupStartGame = document.getElementById('btn-setup-start-game');
  const btnSetupOpenSettings = document.getElementById('btn-setup-open-settings');

  const cardModeCombat = document.getElementById('card-mode-combat');
  const cardModeBuilder = document.getElementById('card-mode-builder');
  const combatSpecificOptions = document.getElementById('combat-specific-options');
  const diffButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn-diff-option'));

  const summaryMapSize = document.getElementById('summary-map-size');
  const summaryFogState = document.getElementById('summary-fog-state');

  const btnCloseAboutModal = document.getElementById('btn-close-about-modal');
  const btnCloseAboutBtn = document.getElementById('btn-close-about-btn');

  let selectedGameMode: 'COMBAT' | 'BUILDER' = 'COMBAT';
  let selectedDiff: AIDifficulty = 'MEDIUM';

  const updateSetupModalUI = () => {
    cardModeCombat?.classList.toggle('active', selectedGameMode === 'COMBAT');
    cardModeBuilder?.classList.toggle('active', selectedGameMode === 'BUILDER');

    if (combatSpecificOptions) {
      combatSpecificOptions.style.display = selectedGameMode === 'COMBAT' ? 'block' : 'none';
    }

    if (btnSetupStartGame) {
      btnSetupStartGame.textContent = selectedGameMode === 'COMBAT' ? '▶ Iniciar Batalha' : '▶ Iniciar Construção';
    }

    for (const b of diffButtons) {
      b.classList.toggle('active', b.dataset.diff === selectedDiff);
    }

    if (summaryMapSize) {
      summaryMapSize.textContent = 'Grande (80×80)';
    }
    if (summaryFogState) {
      summaryFogState.textContent = 'Ativa (Exploração clássica)';
    }
  };

  const openNewGameSetupModal = () => {
    try {
      soundManager.uiClick();
    } catch (_) {}
    selectedGameMode = 'COMBAT';
    selectedDiff = 'MEDIUM';
    updateSetupModalUI();
    if (modalNewGameSetup) {
      modalNewGameSetup.style.display = 'flex';
      modalNewGameSetup.classList.remove('hidden');
    }
  };

  const closeNewGameSetupModal = () => {
    try {
      soundManager.uiClick();
    } catch (_) {}
    if (modalNewGameSetup) {
      modalNewGameSetup.style.display = 'none';
      modalNewGameSetup.classList.add('hidden');
    }
  };

  const openAboutModal = () => {
    try {
      soundManager.uiClick();
    } catch (_) {}
    if (modalAboutGame) {
      modalAboutGame.style.display = 'flex';
      modalAboutGame.classList.remove('hidden');
    }
  };

  const closeAboutModal = () => {
    try {
      soundManager.uiClick();
    } catch (_) {}
    if (modalAboutGame) {
      modalAboutGame.style.display = 'none';
      modalAboutGame.classList.add('hidden');
    }
  };

  cardModeCombat?.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      soundManager.uiClick();
    } catch (_) {}
    selectedGameMode = 'COMBAT';
    updateSetupModalUI();
  });

  cardModeBuilder?.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      soundManager.uiClick();
    } catch (_) {}
    selectedGameMode = 'BUILDER';
    updateSetupModalUI();
  });

  for (const b of diffButtons) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        soundManager.uiClick();
      } catch (_) {}
      const diff = b.dataset.diff as AIDifficulty;
      if (diff) {
        selectedDiff = diff;
        updateSetupModalUI();
      }
    });
  }

  btnSetupOpenSettings?.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      soundManager.uiClick();
    } catch (_) {}
    closeNewGameSetupModal();
    openMatchConfigModal(false);
  });

  btnCloseSetupModal?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewGameSetupModal();
  });

  btnSetupCancel?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewGameSetupModal();
  });

  btnSetupStartGame?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewGameSetupModal();

    // Aplica os Presets de Nova Partida
    currentAIDifficulty = selectedDiff;
    currentMatchConfig.aiDifficulty = selectedDiff;

    if (selectedGameMode === 'COMBAT') {
      currentMatchConfig.mapSize = 80;
      currentMatchConfig.revealWholeMap = false;
      currentMatchConfig.peacefulMode = false;
      hasEnemyFaction = true;
    } else {
      currentMatchConfig.mapSize = 80;
      currentMatchConfig.peacefulMode = true;
      hasEnemyFaction = false;
    }

    // Se o mapa atual já for do mesmo tamanho e nunca tiver começado, reinicia ou inicia
    if (!hasMatchEverStarted && mapSize === currentMatchConfig.mapSize) {
      if (currentMatchConfig.peacefulMode) {
        restartGame(80);
      }
      startNewGameFromMenu();
    } else {
      restartGame(currentMatchConfig.mapSize);
      startNewGameFromMenu();
    }
  });

  btnAbout?.addEventListener('click', (e) => {
    e.stopPropagation();
    openAboutModal();
  });

  btnCloseAboutModal?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAboutModal();
  });

  btnCloseAboutBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAboutModal();
  });

  // Efeito sonoro de hover nos botões de menu e pausa
  const menuButtons = document.querySelectorAll('.menu-btn, .btn-menu-action, .btn-pause-action');
  menuButtons.forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      try {
        soundManager.uiClick();
      } catch (_) {}
    });
  });

  btnNewGame?.addEventListener('click', (e) => {
    e.stopPropagation();
    openNewGameSetupModal();
  });

  btnLoadGame?.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      soundManager.uiClick();
    } catch (_) {}
    openSaveLoadModal();
  });

  // Mostra botão de Sair do Jogo se estiver rodando no Electron Desktop
  const isElectron = Boolean(
    window.electronUpdater ||
    (window as any).api ||
    navigator.userAgent.includes('Electron')
  );
  if (btnQuit && isElectron) {
    btnQuit.style.display = 'flex';
    btnQuit.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        soundManager.uiClick();
      } catch (_) {}
      try {
        window.close();
      } catch (_) {}
    });
  }

  // Controles do Modal de Pausa
  const btnPauseResume = document.getElementById('btn-pause-resume');
  const btnPauseSaveLoad = document.getElementById('btn-pause-save-load');
  const btnPauseSettings = document.getElementById('btn-pause-settings');
  const btnPauseMainMenu = document.getElementById('btn-pause-main-menu');
  const pauseBackdrop = document.getElementById('pause-menu-backdrop');

  btnPauseResume?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGamePause(false);
  });

  btnPauseSaveLoad?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSaveLoadModal();
  });

  btnPauseSettings?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMatchConfigModal();
  });

  btnPauseMainMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    returnToMainMenu();
  });

  pauseBackdrop?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGamePause(false);
  });
}

// Inicializa a partida na ordem estrita antes do primeiro render loop
setupInitialMatch(currentMapSeed);

// Inicializa verificação de auto-update para Desktop Electron
setupElectronAutoUpdate();

// Inicializa o sistema de Salvamento e Carregamento
setupSaveLoadSystem();

// Configura os botões da Tela Inicial e Menu de Pausa
setupMainMenuUI();

// Pre-posiciona a câmera sobre a base aliada para quando a partida iniciar
const alliedBaseX = tcCoord.minX + 1.5;
const alliedBaseZ = tcCoord.minZ + 1.5;
setupGameCamera(alliedBaseX, alliedBaseZ);

// Inicia no modo MENU (Overlay da arte ilustrada oficial ativa, Three.js pausado)
setUIMenuMode(true);

animate();

// ========================================================
// RELOCAÇÃO DO BOTÃO DE ATALHOS (MOBILE/TABLET → TOPO DIREITO)
// O dock usa backdrop-filter, que prende filhos position:fixed;
// por isso movemos o container para fora do dock em telas móveis.
// ========================================================
(() => {
  const container = document.getElementById('controls-trigger-container');
  const dock = document.getElementById('bottom-action-dock');
  const hud = document.getElementById('in-game-hud');
  if (!container || !dock || !hud) return;
  const mq = window.matchMedia('(max-width: 900px), (max-height: 600px)');
  const apply = () => {
    if (mq.matches) {
      if (container.parentElement !== hud) hud.appendChild(container);
      container.classList.add('controls-mobile-topright');
    } else {
      if (container.parentElement !== dock) dock.appendChild(container);
      container.classList.remove('controls-mobile-topright');
    }
  };
  apply();
  mq.addEventListener('change', apply);
})();
