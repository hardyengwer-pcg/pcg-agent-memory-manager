import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { generateAIContent } from './server.ts';

export interface BrowserPageCapture {
  url: string;
  content: string;
}

interface BrowserMcpResponse {
  content?: Array<{ type?: string; text?: string }>;
  text?: string;
  isError?: boolean;
}

function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const value = response as BrowserMcpResponse;
  return value.text || value.content?.find((item) => item.type === 'text')?.text || JSON.stringify(response);
}

function parseUrls(value: string): string[] {
  const urls = value.split(',').map((url) => url.trim()).filter(Boolean);
  if (urls.length < 2) throw new Error('Bitte mindestens zwei URLs angeben, durch Komma getrennt.');
  for (const url of urls) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Nur HTTP(S)-URLs sind erlaubt: ${url}`);
  }
  return [...new Set(urls)];
}

function assertAllowedHosts(urls: string[]) {
  const configured = (process.env.BROWSER_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length === 0) return;

  const disallowed = urls.filter((url) => {
    const hostname = new URL(url).hostname.toLowerCase();
    return !configured.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  });
  if (disallowed.length > 0) throw new Error(`URL nicht durch BROWSER_ALLOWED_HOSTS freigegeben: ${disallowed.join(', ')}`);
}

export function buildBrowserComparisonPrompt(instruction: string, pages: BrowserPageCapture[]): string {
  const pageContext = pages.map((page) => [
    `--- URL: ${page.url} ---`,
    page.content.slice(0, 30000),
    `--- ENDE URL: ${page.url} ---`,
  ].join('\n')).join('\n\n');

  return `Vergleiche die folgenden sichtbaren Browser-Seiten auf Basis der Benutzeranweisung.

Benutzeranweisung:
${instruction}

Regeln:
- Verwende ausschließlich die bereitgestellten Seiteninhalte.
- Trenne Fakten, erkennbare Unterschiede und nicht belegbare Punkte.
- Erfinde keine IDs, Statuswerte, Verantwortlichen oder Links.
- Verweise bei jeder Aussage auf die betreffende URL.
- Wenn Informationen fehlen, benenne genau, welche Information fehlt.
- Antworte auf Deutsch und ohne Markdown-Tabelle.

Seiten:
${pageContext}`;
}

export class BrowserMcpClient {
  private readonly port = Number(process.env.BROWSER_MCP_PORT || 9009);
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, { resolve: (value: BrowserMcpResponse) => void; reject: (error: Error) => void }>();

  async connect() {
    this.server = new WebSocketServer({ port: this.port });
    this.server.on('connection', (socket) => {
      if (this.socket) this.socket.close();
      this.socket = socket;
      socket.on('message', (data) => this.handleMessage(data.toString()));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('listening', () => resolve());
      this.server!.once('error', reject);
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<BrowserMcpResponse> {
    const socket = await this.waitForSocket();
    const id = crypto.randomUUID();
    const response = await new Promise<BrowserMcpResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser-MCP-Extension antwortet nicht auf ${name}.`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id, type: name, payload: args }));
    });
    if (response.isError) throw new Error(responseText(response));
    return response;
  }

  async close() {
    for (const pending of this.pending.values()) pending.reject(new Error('Browser-MCP-Verbindung geschlossen.'));
    this.pending.clear();
    this.socket?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) || resolve());
    this.server = null;
    this.socket = null;
  }

  async navigate(url: string) {
    await this.withConnection(() => this.callTool('browser_navigate', { url }));
    await this.callTool('browser_wait', { time: 3 });
  }

  async snapshot(): Promise<string> {
    return responseText(await this.withConnection(() => this.callTool('browser_snapshot')));
  }

  private async waitForSocket(): Promise<WebSocket> {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
      if (attempt === 0) console.log('Warte bis der aktuelle Tab über die Browser-MCP-Extension verbunden wird ...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Keine Browser-MCP-Verbindung. Extension im gewünschten Tab öffnen und Connect klicken.');
  }

  private handleMessage(raw: string) {
    try {
      const message = JSON.parse(raw);
      if (message.type !== 'messageResponse') return;
      const requestId = message.payload?.requestId;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (message.payload?.error) pending.reject(new Error(message.payload.error));
      else pending.resolve(message.payload?.result || {});
    } catch {
      // Ignore malformed extension messages and keep the bridge alive.
    }
  }

  private async withConnection<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('No connection to browser extension') && !message.includes('Keine Browser-MCP-Verbindung')) throw error;
        if (attempt === 0) console.log('Warte bis der aktuelle Tab über die Browser-MCP-Extension verbunden wird ...');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

async function captureUrls(browser: BrowserMcpClient, urls: string[]): Promise<BrowserPageCapture[]> {
  const captures: BrowserPageCapture[] = [];
  for (const url of urls) {
    await browser.navigate(url);
    captures.push({ url, content: await browser.snapshot() });
  }
  return captures;
}

export async function compareBrowserPages(instruction: string, urlsArg: string): Promise<{ pages: BrowserPageCapture[]; result: string }> {
  const urls = parseUrls(urlsArg);
  assertAllowedHosts(urls);
  const browser = new BrowserMcpClient();
  try {
    await browser.connect();
    const pages = await captureUrls(browser, urls);
    const response = await generateAIContent({
      contents: buildBrowserComparisonPrompt(instruction, pages),
      config: { temperature: 0.1 },
    });
    return { pages, result: response.text?.trim() || 'Keine Vergleichsantwort erhalten.' };
  } finally {
    await browser.close();
  }
}

export async function captureCurrentBrowserPage(): Promise<string> {
  const browser = new BrowserMcpClient();
  try {
    await browser.connect();
    return await browser.snapshot();
  } finally {
    await browser.close();
  }
}
