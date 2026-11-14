import { getT } from "@/i18n/server";
import type { MetaClient, PublishResult, VerifyReport } from "./types";

/** Fail clearly instead of returning fake data when the client hasn't connected Meta. */
const notConnected = async () => (await getT())("targeting.meta.notConnected");

/**
 * Client not connected to Meta (dataSource = "mock"): no Meta data at all, and no auto-generated sample data.
 * Reads return empty; every operation needing Meta (publishing campaigns, changing budgets, forms, audiences...) reports not connected.
 * Analysis still runs on the Knowledge base and business description.
 */
export class MockMetaClient implements MetaClient {
  readonly kind = "mock" as const;
  constructor(private clientId: string) {}

  async fetchAccount() {
    return { campaigns: [], adSets: [], ads: [], daily: [] };
  }

  async fetchConversations() {
    return [];
  }

  async describeTargeting() {
    return [];
  }

  async verifyPublished(): Promise<VerifyReport> {
    throw new Error(await notConnected());
  }

  async estimateAudience() {
    return null;
  }

  async resolvePostLink(): Promise<never> {
    throw new Error(await notConnected());
  }
  async postDetail(): Promise<never> {
    throw new Error(await notConnected());
  }
  async adReviews(): Promise<never> {
    throw new Error(await notConnected());
  }
  async listPosts(): Promise<never> {
    throw new Error(await notConnected());
  }

  async listVideos(): Promise<never> {
    throw new Error(await notConnected());
  }

  async fetchPageActivity() {
    return { posts: [], comments: [] };
  }

  async fetchBreakdowns() {
    return [];
  }

  async fetchAdSetHistory() {
    return [];
  }

  async fetchOptimizeSnapshot() {
    return null;
  }

  async fetchOptimizeSnapshots() {
    return [];
  }

  async metricsSince(): Promise<never> {
    throw new Error(await notConnected());
  }

  async fetchLiftInsights() {
    return null;
  }

  async fetchPostComments() {
    return [];
  }

  async duplicateAdSet(): Promise<never> {
    throw new Error(await notConnected());
  }

  async updateAdSetTargeting(): Promise<never> {
    throw new Error(await notConnected());
  }

  async addAdFromTemplate(): Promise<never> {
    throw new Error(await notConnected());
  }

  async subscribePageWebhook(): Promise<never> {
    throw new Error(await notConnected());
  }

  async pageWebhookStatus(): Promise<never> {
    throw new Error(await notConnected());
  }

  async sendPageMessage(): Promise<never> {
    throw new Error(await notConnected());
  }

  async recentThreads(): Promise<never> {
    throw new Error(await notConnected());
  }

  async conversationOf(): Promise<never> {
    throw new Error(await notConnected());
  }

  async fetchCreativePerformance() {
    return [];
  }

  async fetchCampaignReport(): Promise<never> {
    throw new Error(await notConnected());
  }

  async fetchAdCreatives() {
    return [];
  }

  async fetchLeads() {
    return { leads: [], forms: 0 };
  }

  async accountScope() {
    return null;
  }

  async listLeadForms(): Promise<never> {
    throw new Error(await notConnected());
  }

  async createLeadForm(): Promise<never> {
    throw new Error(await notConnected());
  }

  async listCustomAudiences(): Promise<never> {
    throw new Error(await notConnected());
  }

  async setStatus(): Promise<never> {
    throw new Error(await notConnected());
  }

  async setDailyBudget(): Promise<never> {
    throw new Error(await notConnected());
  }

  async publishPlan(): Promise<PublishResult> {
    throw new Error(await notConnected());
  }
}
