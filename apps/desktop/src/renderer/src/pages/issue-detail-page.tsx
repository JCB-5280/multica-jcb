import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { IssueDetail } from "@mato/views/issues/components";
import { ErrorBoundary } from "@mato/ui/components/common/error-boundary";
import { useWorkspaceId } from "@mato/core/hooks";
import { issueDetailOptions } from "@mato/core/issues/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsId = useWorkspaceId();
  const { data: issue } = useQuery(issueDetailOptions(wsId, id!));

  useDocumentTitle(issue ? `${issue.identifier}: ${issue.title}` : "Issue");

  if (!id) return null;
  return (
    <ErrorBoundary resetKeys={[id]}>
      <IssueDetail issueId={id} />
    </ErrorBoundary>
  );
}
