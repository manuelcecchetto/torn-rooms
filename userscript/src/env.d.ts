declare const __API_BASE__: string;
declare const __VERSION__: string;
declare const __FORCE_POLL__: boolean;

declare module '*.jpg' {
  const dataUrl: string;
  export default dataUrl;
}

declare module '*.css' {
  const css: string;
  export default css;
}

interface GMResponse {
  status: number;
  responseText: string;
  response: any;
}

interface GMRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  responseType?: 'text' | 'json' | 'stream';
  timeout?: number;
  onload?: (r: GMResponse) => void;
  onloadstart?: (r: GMResponse) => void;
  onerror?: (r: unknown) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}

declare function GM_xmlhttpRequest(details: GMRequest): { abort(): void };
declare function GM_getValue<T>(key: string, fallback: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
