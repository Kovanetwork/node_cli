// shared cli helpers for api calls, auth, and output formatting

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.kova');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

export function getApiUrl(): string {
  return process.env.KOVA_API_URL || 'https://app.kovanetwork.com';
}

export function getAuthToken(): string | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    return data.token || null;
  } catch {
    return null;
  }
}

export function saveAuthToken(token: string) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(AUTH_FILE, JSON.stringify({ token, savedAt: new Date().toISOString() }));
}

export function clearAuthToken() {
  try {
    if (existsSync(AUTH_FILE)) {
      writeFileSync(AUTH_FILE, '{}');
    }
  } catch {}
}

export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const url = `${getApiUrl()}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, { ...options, headers });
}

export function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}

export function formatTable(rows: Record<string, any>[]) {
  if (rows.length === 0) return;

  const keys = Object.keys(rows[0]);
  const widths: Record<string, number> = {};

  // calculate column widths
  for (const key of keys) {
    widths[key] = key.length;
    for (const row of rows) {
      const val = String(row[key] ?? '');
      widths[key] = Math.max(widths[key], val.length);
    }
  }

  // print header
  const header = keys.map(k => k.padEnd(widths[k])).join('  ');
  console.log(header);
  console.log(keys.map(k => '-'.repeat(widths[k])).join('  '));

  // print rows
  for (const row of rows) {
    const line = keys.map(k => String(row[k] ?? '').padEnd(widths[k])).join('  ');
    console.log(line);
  }
}

export function handleApiError(err: any) {
  if (err.cause?.code === 'ECONNREFUSED') {
    console.error('\ncannot connect to kova api. check your network or KOVA_API_URL setting.');
  } else {
    console.error(`\nerror: ${err.message || 'unknown error'}`);
  }
  process.exit(1);
}
