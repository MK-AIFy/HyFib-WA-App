import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface ListResponse<T> {
  items: T[];
  total?: number;
}

/** Generic list query for the many `{ items: [...] }` endpoints. */
export function useList<T>(key: QueryKey, path: string) {
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<ListResponse<T>>(path)
  });
}

/** Generic POST mutation that invalidates the paired list key on success. */
export function useCreate<TBody, TResult = unknown>(invalidate: QueryKey, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api.post<TResult>(path, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate })
  });
}
