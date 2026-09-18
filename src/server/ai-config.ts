import fs from 'fs';
import path from 'path';

export interface AISettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

const AI_SETTINGS_FILE = path.join(process.cwd(), '.ai_settings.json');

export function loadAISettings(): AISettings {
  try {
    if (fs.existsSync(AI_SETTINGS_FILE)) return JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf-8'));
  } catch (error) {
    console.error('Error reading AI settings file:', error);
  }
  return {};
}

export function saveAISettings(settings: AISettings) {
  try {
    fs.writeFileSync(AI_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving AI settings file:', error);
  }
}

export function isValidApiKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return trimmed.length >= 5 && trimmed.length <= 250 && !/\s/.test(trimmed);
}

export function normalizeAiBaseUrl(value?: string): string {
  const rawValue = value?.trim();
  if (!rawValue) return '';
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('Die Gateway-URL ist ungültig.');
  }
  const allowedHosts = new Set([
    'gateway.pcg.io',
    'generativelanguage.googleapis.com',
    ...(process.env.AI_ALLOWED_BASE_URLS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean),
  ]);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('Die Gateway-URL ist nicht freigegeben.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function getEffectiveApiConfig(customApiKey?: string, customBaseUrl?: string) {
  const settings = loadAISettings();
  const rawCustom = customApiKey !== undefined && customApiKey.trim() !== '' ? customApiKey.trim() : undefined;
  const rawSaved = settings.apiKey && isValidApiKey(settings.apiKey) ? settings.apiKey.trim() : undefined;
  let apiKey = rawCustom || rawSaved || process.env.GEMINI_API_KEY || '';
  if (apiKey && !isValidApiKey(apiKey)) apiKey = process.env.GEMINI_API_KEY || '';
  const configuredBaseUrl = customBaseUrl !== undefined && customBaseUrl.trim() !== '' ? customBaseUrl : settings.baseUrl;
  let baseUrl = normalizeAiBaseUrl(configuredBaseUrl);
  if (apiKey?.startsWith('sk-') && !baseUrl) baseUrl = 'https://gateway.pcg.io';
  if (!apiKey?.startsWith('sk-')) baseUrl = '';
  if (baseUrl) baseUrl = normalizeAiBaseUrl(baseUrl);
  return { apiKey, baseUrl, isGateway: Boolean(baseUrl && (baseUrl.includes('gateway') || baseUrl.includes('pcg'))) };
}

export function getModelName(customModel?: string, customApiKey?: string, customBaseUrl?: string): string {
  const settings = loadAISettings();
  const { isGateway } = getEffectiveApiConfig(customApiKey, customBaseUrl);
  const rawModel = customModel?.trim() || settings.model?.trim() || '';
  const gatewayModels = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'pcg-auto-pro', 'gemini-2.5-pro', 'claude-sonnet-5', 'gpt-5.4', 'Standard', 'Pro', 'Expert'];
  if (isGateway) return gatewayModels.includes(rawModel) ? rawModel : 'gemini-3.8-flash';
  return rawModel && (rawModel.startsWith('gemini-') || rawModel === 'Standard' || rawModel === 'Pro') ? rawModel : 'gemini-3.8-flash';
}
