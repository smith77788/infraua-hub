export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewIssue {
  severity: IssueSeverity;
  description: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
}

/** A review blocks merge only when it contains a high/critical issue. */
export function hasBlockingIssues(review: ReviewResult): boolean {
  return review.issues.some((i) => i.severity === 'high' || i.severity === 'critical');
}
