import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const filesKeys = {
  all: (wsId: string) => ["files", wsId] as const,
  list: (wsId: string) => [...filesKeys.all(wsId), "list"] as const,
};

export function workspaceFilesOptions(wsId: string) {
  return queryOptions({
    queryKey: filesKeys.list(wsId),
    queryFn: () => api.listWorkspaceFiles(wsId),
    enabled: !!wsId,
  });
}
