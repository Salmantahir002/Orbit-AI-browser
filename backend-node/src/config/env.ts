import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

// The backend package: backend-node/ in the repo, resources/backend/ in the installed app. This file
// is <root>/src/config/env.ts, or <root>/dist/config/env.js once compiled.
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseCorsOrigins(raw: string | undefined): string[] {
  const value = raw ?? 'http://localhost:5173'
  if (value.trim().startsWith('[')) {
    return JSON.parse(value) as string[]
  }
  return value.split(',').map((origin) => origin.trim()).filter(Boolean)
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isNaN(parsed) ? fallback : parsed
}

export interface Settings {
  APP_NAME: string
  APP_ENV: 'development' | 'production' | string
  API_V1_PREFIX: string
  PORT: number
  CORS_ALLOWED_ORIGINS: string[]
  MODEL_DIR: string
  CLASSIFIER_THRESHOLD: number
  DL_MALICIOUS_THRESHOLD: number
  DEFAULT_CHUNK_SIZE: number
  DEFAULT_CHUNK_OVERLAP: number
  AGENT_MIN_CONFIDENCE: number
}

export const settings: Settings = {
  APP_NAME: process.env.APP_NAME ?? 'Prompt Injection Defense Browser Backend',
  APP_ENV: process.env.APP_ENV ?? 'development',
  API_V1_PREFIX: process.env.API_V1_PREFIX ?? '/api/v1',
  // Not present in the Python Settings (uvicorn.run() hardcodes 8000 in run_backend.py) —
  // the Node entrypoint needs a configurable bind port, so it's added here. Defaults to 8000
  // to match the existing frontend contract (all three HTTP clients hardcode 127.0.0.1:8000).
  PORT: parseNumber(process.env.PORT, 8000),
  CORS_ALLOWED_ORIGINS: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
  // A relative path is resolved against the backend package, not the working directory: the
  // installed app and `npm run electron:start` start the backend from elsewhere, and a path
  // relative to their working directory silently dropped them to rule-based detection.
  MODEL_DIR: path.resolve(BACKEND_ROOT, process.env.MODEL_DIR ?? 'dl_models/prompt_injection_model'),
  CLASSIFIER_THRESHOLD: parseNumber(process.env.CLASSIFIER_THRESHOLD, 0.7),
  // Probability on Prompt Guard's MALICIOUS class at which the DL detector
  // flags a chunk. 0.5 is the model's own decision boundary; lower it to trade
  // precision for recall without touching code.
  DL_MALICIOUS_THRESHOLD: parseNumber(process.env.DL_MALICIOUS_THRESHOLD, 0.5),
  DEFAULT_CHUNK_SIZE: parseNumber(process.env.DEFAULT_CHUNK_SIZE, 800),
  DEFAULT_CHUNK_OVERLAP: parseNumber(process.env.DEFAULT_CHUNK_OVERLAP, 100),
  AGENT_MIN_CONFIDENCE: parseNumber(process.env.AGENT_MIN_CONFIDENCE, 0.6),
}
