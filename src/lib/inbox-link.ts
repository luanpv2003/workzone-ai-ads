/**
 * Link to the Page's Messenger inbox in Business Suite.
 * Individual conversations can't be opened directly: Business Suite selects a conversation by the customer's global Facebook ID (selected_item_id=1000…),
 * which Meta does not give apps; the PSID, the thread ID in the `link` Meta returns, and t_… conversation IDs all show "Đã xảy ra lỗi" (An error occurred) (tested 27/10/2026).
 */
export function pageInboxUrl(pageId: string | null | undefined) {
  return pageId ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}` : null;
}
