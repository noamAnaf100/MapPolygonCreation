import type { AppConfig, CoverRequest, CoverResult, CutRequest, EditResult, ExtendRequest, Health, LassoRequest, SelectRequest, WandResult } from "@map-wand/shared";

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

const post = <T,>(url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<T>(r));

export const api = {
  config: () => fetch("/api/config").then((r) => json<AppConfig>(r)),
  health: () => fetch("/api/health").then((r) => json<Health>(r)),
  select: (req: SelectRequest) => post<WandResult>("/api/select", req),
  lasso: (req: LassoRequest) => post<WandResult>("/api/lasso", req),
  cut: (req: CutRequest) => post<EditResult>("/api/cut", req),
  extend: (req: ExtendRequest) => post<EditResult>("/api/extend", req),
  cover: (req: CoverRequest) => post<CoverResult>("/api/cover", req),
};
