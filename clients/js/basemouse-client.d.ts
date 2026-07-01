export interface BaseMouseClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export type RetrievalMode = 'lexical' | 'hybrid';
export interface QueryOptions { q?: string; type?: string; tag?: string; limit?: number; workspace?: string; retrieval?: RetrievalMode; mode?: RetrievalMode }
export class BaseMouseAPIError extends Error { status?: number; body?: unknown; url?: string }
export class BaseMouseClient {
  constructor(options?: BaseMouseClientOptions);
  search(options?: QueryOptions): Promise<any>;
  contextPack(options?: QueryOptions): Promise<any>;
  listRepository(options?: { limit?: number; offset?: number }): Promise<any>;
  createDocument(document: Record<string, unknown>): Promise<any>;
  updateDocument(id: string, fields: Record<string, unknown>, options?: { expectedVersion?: number }): Promise<any>;
  deleteDocument(id: string): Promise<any>;
  documentHistory(id: string): Promise<any>;
  usage(): Promise<any>;
  rotateKey(): Promise<any>;
}
export function formatContextPackForPrompt(pack: any): string;
export default BaseMouseClient;
