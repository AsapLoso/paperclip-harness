export function prepareReportLock(root?: string): Promise<'already-reviewed' | 'reviewed-correction'>;
export function refreshReportLock(root?: string, options?: string | { baselineRef?: string; trustedLockSha256?: string }): Promise<'unchanged' | 'refreshed'>;
