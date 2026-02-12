export interface ApiResponse {
  ok: boolean;
  status: number;
  data: any;
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private botApiToken: string,
  ) {}

  async botTokenRequest(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    return this.request(method, path, `Bearer ${this.botApiToken}`, body);
  }

  async sessionRequest(method: string, path: string, sessionToken: string, body?: unknown): Promise<ApiResponse> {
    return this.request(method, path, `Bearer ${sessionToken}`, body);
  }

  private async request(method: string, path: string, authorization: string, body?: unknown): Promise<ApiResponse> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: authorization,
    };

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await res.json().catch(() => null);

      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }
}
