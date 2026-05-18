"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  HardDrive,
  Trash2,
} from "lucide-react";
import type { Attachment } from "@mato/core/types";
import { api } from "@mato/core/api";
import { useWorkspaceId } from "@mato/core/hooks";
import { workspaceFilesOptions, filesKeys } from "@mato/core/files/queries";
import { Button } from "@mato/ui/components/ui/button";
import { Skeleton } from "@mato/ui/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@mato/ui/components/ui/tooltip";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function FileIcon({ contentType, filename }: { contentType: string; filename: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return <FileImage className="size-5 shrink-0 text-muted-foreground" />;
  }
  if (
    contentType === "application/json" ||
    contentType.startsWith("text/") ||
    ["md", "txt", "log", "csv", "json", "yml", "yaml", "toml", "sh", "py", "go", "ts", "js", "tsx", "jsx"].includes(ext)
  ) {
    return <FileText className="size-5 shrink-0 text-muted-foreground" />;
  }
  if (["csv", "xlsx", "xls"].includes(ext)) {
    return <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />;
  }
  return <File className="size-5 shrink-0 text-muted-foreground" />;
}

// ---------------------------------------------------------------------------
// File row
// ---------------------------------------------------------------------------

function FileRow({
  file,
  onDelete,
}: {
  file: Attachment;
  onDelete: (id: string) => void;
}) {
  const { t } = useT("files");

  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-4 py-3">
      <FileIcon contentType={file.content_type} filename={file.filename} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.filename}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(file.size_bytes)} &middot;{" "}
          {file.uploader_type === "agent"
            ? t(($) => $.page.uploader_agent)
            : t(($) => $.page.uploader_member)}{" "}
          &middot; {formatDate(file.created_at)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={file.download_url}
                download={file.filename}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            }
          >
            <Download className="size-4" />
            <span className="sr-only">{t(($) => $.page.download)}</span>
          </TooltipTrigger>
          <TooltipContent>{t(($) => $.page.download)}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(file.id)}
            >
              <Trash2 className="size-4" />
              <span className="sr-only">{t(($) => $.page.delete)}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t(($) => $.page.delete)}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function FilesPage() {
  const { t } = useT("files");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();

  const { data: files, isPending, isError } = useQuery(workspaceFilesOptions(wsId));

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWorkspaceFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: filesKeys.list(wsId) });
    },
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader>
        <HardDrive className="mr-2 size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
      </PageHeader>

      <div className="flex-1 overflow-auto p-4">
        {isPending && (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        )}

        {isError && (
          <p className="text-sm text-destructive">{t(($) => $.page.load_error)}</p>
        )}

        {!isPending && !isError && Array.isArray(files) && files.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <HardDrive className="mb-4 size-10 text-muted-foreground/40" />
            <p className="text-sm font-medium">{t(($) => $.page.empty.title)}</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-xs">
              {t(($) => $.page.empty.description)}
            </p>
          </div>
        )}

        {!isPending && !isError && Array.isArray(files) && files.length > 0 && (
          <div className="space-y-2">
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
