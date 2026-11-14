-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "industryKey" TEXT,
    "brief" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "primaryResult" TEXT NOT NULL DEFAULT 'messages',
    "targetCpr" DOUBLE PRECISION,
    "autoTargetCpr" DOUBLE PRECISION,
    "autoTargetCprNote" TEXT,
    "targetRoas" DOUBLE PRECISION,
    "maxDailyBudget" DOUBLE PRECISION,
    "maxBudgetChangePct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "analysisDays" INTEGER NOT NULL DEFAULT 90,
    "minResults" INTEGER NOT NULL DEFAULT 20,
    "conversationLimit" INTEGER NOT NULL DEFAULT 500,
    "readImages" BOOLEAN NOT NULL DEFAULT false,
    "briefUpdatedAt" TIMESTAMP(3),
    "syncMode" TEXT NOT NULL DEFAULT 'hours',
    "syncHours" TEXT NOT NULL DEFAULT '6,12,18',
    "aiMode" TEXT NOT NULL DEFAULT 'daily',
    "optimizeMode" TEXT NOT NULL DEFAULT 'manual',
    "optimizeHours" TEXT NOT NULL DEFAULT '8,20',
    "lastOptimizeAt" TIMESTAMP(3),
    "optWarnPct" INTEGER NOT NULL DEFAULT 20,
    "optPausePct" INTEGER NOT NULL DEFAULT 40,
    "optExpensiveMode" TEXT NOT NULL DEFAULT 'suggest',
    "optMinSpendX" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "optConfidence" INTEGER NOT NULL DEFAULT 90,
    "optFreqMax" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "optBudgetStepPct" INTEGER NOT NULL DEFAULT 25,
    "optMinAgeDays" INTEGER NOT NULL DEFAULT 1,
    "optEarlyPct" INTEGER NOT NULL DEFAULT 100,
    "optEarlySpendX" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "optScaleGapHours" INTEGER NOT NULL DEFAULT 24,
    "optScaleMinResults" INTEGER NOT NULL DEFAULT 5,
    "optScaleConfidence" INTEGER NOT NULL DEFAULT 80,
    "optScaleSpendPct" INTEGER NOT NULL DEFAULT 90,
    "optScaleBeforeHour" INTEGER NOT NULL DEFAULT 18,
    "autoMode" TEXT NOT NULL DEFAULT 'off',
    "autoPause" BOOLEAN NOT NULL DEFAULT true,
    "autoScale" BOOLEAN NOT NULL DEFAULT true,
    "autoFromHour" INTEGER NOT NULL DEFAULT 7,
    "autoToHour" INTEGER NOT NULL DEFAULT 22,
    "autoNotify" BOOLEAN NOT NULL DEFAULT true,
    "autoNotifyTargets" TEXT NOT NULL DEFAULT '[]',
    "lastAutoRunAt" TIMESTAMP(3),
    "lastAutoSyncAt" TIMESTAMP(3),
    "lastAutoAiAt" TIMESTAMP(3),
    "dataSource" TEXT NOT NULL DEFAULT 'mock',
    "metaAdAccountId" TEXT,
    "metaPageId" TEXT,
    "metaPageName" TEXT,
    "metaExtraPages" TEXT NOT NULL DEFAULT '[]',
    "metaInstagramId" TEXT,
    "audienceOrigin" TEXT NOT NULL DEFAULT 'vn',
    "storeLat" DOUBLE PRECISION,
    "storeLng" DOUBLE PRECISION,
    "metaAccessToken" TEXT,
    "metaTokenExpiresAt" TIMESTAMP(3),
    "metaTokenOwnerId" TEXT,
    "metaTokenOwner" TEXT,
    "metaTokenMissing" TEXT,
    "metaTokenError" TEXT,
    "metaTokenCheckedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "sheetKeyHash" TEXT,
    "sheetKey" TEXT,
    "sheetSeenAt" TIMESTAMP(3),
    "sheetLinkedAt" TIMESTAMP(3),
    "sheetRows" INTEGER,
    "sheetFeedbackAt" TIMESTAMP(3),
    "sheetScriptV" INTEGER,
    "sheetAuto" BOOLEAN,
    "sheetSince" TIMESTAMP(3),
    "reportPhones" TEXT NOT NULL DEFAULT '[]',
    "reportEmails" TEXT NOT NULL DEFAULT '[]',
    "reportTelegram" TEXT NOT NULL DEFAULT '[]',
    "leadNotify" TEXT NOT NULL DEFAULT '{}',
    "googleCustomerId" TEXT,
    "googleAccountName" TEXT,
    "googleCurrency" TEXT,
    "googleSyncedAt" TIMESTAMP(3),
    "googleSyncError" TEXT,
    "kiotRetailer" TEXT,
    "kiotClientId" TEXT,
    "kiotSecret" TEXT,
    "kiotMonths" INTEGER NOT NULL DEFAULT 12,
    "kiotState" TEXT NOT NULL DEFAULT '{}',
    "kiotSyncAt" TIMESTAMP(3),
    "kiotSyncError" TEXT,
    "kiotRequestAt" TIMESTAMP(3),
    "kiotRunningAt" TIMESTAMP(3),
    "ghlLocationId" TEXT,
    "ghlToken" TEXT,
    "ghlLocation" TEXT,
    "ghlPipelines" TEXT NOT NULL DEFAULT '[]',
    "ghlPipelineId" TEXT,
    "ghlStageId" TEXT,
    "ghlStageMap" TEXT NOT NULL DEFAULT '{}',
    "ghlPush" BOOLEAN NOT NULL DEFAULT true,
    "ghlSince" TIMESTAMP(3),
    "ghlSyncAt" TIMESTAMP(3),
    "ghlSyncError" TEXT,
    "ghlRequestAt" TIMESTAMP(3),
    "ghlReverseMap" TEXT NOT NULL DEFAULT '{}',
    "ghlDealPipelineId" TEXT,
    "ghlHookKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dailyBudget" DOUBLE PRECISION,
    "resultType" TEXT NOT NULL DEFAULT 'messages',
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdTime" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSet" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dailyBudget" DOUBLE PRECISION,
    "optimizationGoal" TEXT NOT NULL DEFAULT '',
    "targeting" TEXT NOT NULL DEFAULT '{}',
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primaryText" TEXT NOT NULL DEFAULT '',
    "headline" TEXT NOT NULL DEFAULT '',
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMetric" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "DailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pageId" TEXT,
    "customerName" TEXT NOT NULL,
    "updatedTime" TIMESTAMP(3) NOT NULL,
    "sourceAdId" TEXT,
    "adReply" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "email" TEXT,
    "phones" TEXT NOT NULL DEFAULT '[]',
    "link" TEXT,
    "psid" TEXT,
    "intent" TEXT,
    "stage" TEXT,
    "sentiment" TEXT,
    "leadScore" INTEGER,
    "tags" TEXT,
    "needsReply" BOOLEAN,
    "suggestedReply" TEXT,
    "analysisNote" TEXT,
    "analyzedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromCustomer" BOOLEAN NOT NULL,
    "text" TEXT NOT NULL,
    "images" TEXT,
    "createdTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "score" INTEGER,
    "summary" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "auditId" TEXT,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "expectedImpact" TEXT NOT NULL DEFAULT '',
    "actionType" TEXT NOT NULL,
    "targetLevel" TEXT,
    "targetId" TEXT,
    "targetName" TEXT,
    "newDailyBudget" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'audit',
    "campaignId" TEXT,
    "campaignName" TEXT,
    "rule" TEXT,
    "params" TEXT NOT NULL DEFAULT '{}',
    "evidence" TEXT NOT NULL DEFAULT '{}',
    "baseline" TEXT,
    "evaluation" TEXT,
    "executedAt" TIMESTAMP(3),
    "auto" TEXT,
    "undoneAt" TIMESTAMP(3),
    "guide" TEXT,
    "guideDone" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDraft" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "policy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "useForAi" BOOLEAN NOT NULL DEFAULT true,
    "fileName" TEXT,
    "filePath" TEXT,
    "fileSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceAnalysis" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "candidates" TEXT NOT NULL,
    "stats" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetingRanking" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "analysisId" TEXT,
    "label" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "benchmarkCpr" DOUBLE PRECISION,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetingRanking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" BOOLEAN NOT NULL DEFAULT false,
    "claudeCred" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAccess" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "access" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetingItem" (
    "key" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "topic" TEXT,
    "industries" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import',
    "status" TEXT NOT NULL DEFAULT 'active',
    "vnLo" DOUBLE PRECISION,
    "vnHi" DOUBLE PRECISION,
    "globalLo" DOUBLE PRECISION,
    "globalHi" DOUBLE PRECISION,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reachCheckedAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "nameVi" TEXT,
    "copyText" TEXT,
    "findable" BOOLEAN,
    "findRank" INTEGER,
    "findCheckedAt" TIMESTAMP(3),

    CONSTRAINT "TargetingItem_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TargetingRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "params" TEXT NOT NULL DEFAULT '{}',
    "progress" TEXT NOT NULL DEFAULT '{}',
    "checkpoint" TEXT,
    "stats" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "clientId" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TargetingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetingChange" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "usedIn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetingChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetingSeedSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetingSeedSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PagePost" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pageId" TEXT,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "picture" TEXT,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "reactions" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PagePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "fromPage" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBreakdown" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "AdBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "params" TEXT NOT NULL DEFAULT '{}',
    "steps" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "allocationId" TEXT,

    CONSTRAINT "ClientJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignProposal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "report" TEXT NOT NULL,
    "answers" TEXT,
    "chosen" TEXT,
    "draftIds" TEXT,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSetHistory" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT '',
    "resultType" TEXT NOT NULL,
    "targeting" TEXT NOT NULL DEFAULT '{}',
    "adIds" TEXT NOT NULL DEFAULT '[]',
    "days" INTEGER NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "results" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "recentSpend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recentResults" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSetHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetingClientStat" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "industryKey" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL,
    "results" DOUBLE PRECISION NOT NULL,
    "wSpend" DOUBLE PRECISION NOT NULL,
    "wResults" DOUBLE PRECISION NOT NULL,
    "index" DOUBLE PRECISION NOT NULL,
    "adSets" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetingClientStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formName" TEXT NOT NULL DEFAULT '',
    "adId" TEXT,
    "adName" TEXT,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "phone" TEXT,
    "phones" TEXT NOT NULL DEFAULT '[]',
    "email" TEXT,
    "answers" TEXT NOT NULL DEFAULT '[]',
    "platform" TEXT,
    "isOrganic" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnAd" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "campaignId" TEXT,
    "campaignName" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdReferral" (
    "id" TEXT NOT NULL,
    "appId" TEXT,
    "pageId" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ADS',
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookApp" (
    "appId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "secretEnc" TEXT NOT NULL,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookApp_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "ContentReview" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "items" TEXT NOT NULL DEFAULT '[]',
    "policy" TEXT,
    "brief" TEXT,
    "plans" TEXT NOT NULL DEFAULT '[]',
    "chosen" INTEGER,
    "draftId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task" TEXT NOT NULL,
    "clientId" TEXT,
    "workspaceId" TEXT,
    "source" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "images" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NurtureFlow" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stages" TEXT NOT NULL DEFAULT '[]',
    "minScore" INTEGER,
    "waitHours" INTEGER NOT NULL DEFAULT 3,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "maxPerRun" INTEGER NOT NULL DEFAULT 30,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "everyHours" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL DEFAULT '',
    "brief" TEXT,
    "suggestions" TEXT NOT NULL DEFAULT '[]',
    "policy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "runRequestedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NurtureFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NurtureSend" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "conversationId" TEXT,
    "customerName" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "sentBy" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NurtureSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NurtureOptOut" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NurtureOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesFeedback" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "contact" TEXT NOT NULL DEFAULT '',
    "quality" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'web',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "recallAt" TIMESTAMP(3),
    "recallCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalesFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientReport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "since" TEXT NOT NULL,
    "until" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "vars" TEXT NOT NULL,
    "overrides" TEXT NOT NULL DEFAULT '{}',
    "message" TEXT,
    "keyHash" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "sends" TEXT NOT NULL DEFAULT '[]',
    "views" INTEGER NOT NULL DEFAULT 0,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repeat" TEXT NOT NULL DEFAULT 'daily',
    "days" TEXT NOT NULL DEFAULT '[]',
    "hour" INTEGER NOT NULL DEFAULT 9,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "autoSend" BOOLEAN NOT NULL DEFAULT false,
    "targets" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotChat" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT '',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL,
    "answered" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "noteStatus" TEXT,

    CONSTRAINT "BotChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadNotice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sends" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT,
    "rowKey" TEXT,
    "ackBy" TEXT,
    "ackAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),

    CONSTRAINT "LeadNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsCampaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channelType" TEXT NOT NULL DEFAULT '',
    "biddingStrategy" TEXT NOT NULL DEFAULT '',
    "dailyBudget" DOUBLE PRECISION,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversionValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searchImprShare" DOUBLE PRECISION,
    "lostBudgetShare" DOUBLE PRECISION,
    "lostRankShare" DOUBLE PRECISION,
    "targetCpa" DOUBLE PRECISION,
    "budgetId" TEXT,
    "budgetShared" BOOLEAN NOT NULL DEFAULT false,
    "devices" TEXT NOT NULL DEFAULT '{}',
    "negatives" TEXT NOT NULL DEFAULT '[]',
    "schedule" TEXT NOT NULL DEFAULT '[]',
    "hours" TEXT NOT NULL DEFAULT '{}',
    "lastDayHours" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "GAdsCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsChange" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "params" TEXT NOT NULL DEFAULT '{}',
    "before" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "rule" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "GAdsChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsAdGroup" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GAdsAdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsKeyword" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "qualityScore" INTEGER,
    "ctrQuality" TEXT,
    "adRelevance" TEXT,
    "landingPage" TEXT,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GAdsKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsAd" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "adStrength" TEXT NOT NULL DEFAULT '',
    "headlines" TEXT NOT NULL DEFAULT '[]',
    "descriptions" TEXT NOT NULL DEFAULT '[]',
    "finalUrl" TEXT NOT NULL DEFAULT '',
    "path1" TEXT NOT NULL DEFAULT '',
    "path2" TEXT NOT NULL DEFAULT '',
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GAdsAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsSearchTerm" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GAdsSearchTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAdsDaily" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversionValue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GAdsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KvBranch" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kvId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "KvBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KvCustomer" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kvId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "phone" TEXT,
    "gender" TEXT,
    "birthDate" TEXT,
    "area" TEXT NOT NULL DEFAULT '',
    "ward" TEXT NOT NULL DEFAULT '',
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalInvoiced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdDate" TIMESTAMP(3),
    "modifiedDate" TIMESTAMP(3),

    CONSTRAINT "KvCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KvInvoice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kvId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "date" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "KvInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KvDaily" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "invoices" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "withCustomer" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "KvDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KvProductDaily" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "KvProductDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesLift" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "objectName" TEXT NOT NULL DEFAULT '',
    "testIds" TEXT NOT NULL DEFAULT '[]',
    "controlIds" TEXT NOT NULL DEFAULT '[]',
    "runStart" TEXT NOT NULL,
    "runEnd" TEXT,
    "baseStart" TEXT NOT NULL,
    "baseEnd" TEXT NOT NULL,
    "branchWords" TEXT NOT NULL DEFAULT '',
    "manualSpend" DOUBLE PRECISION,
    "manualOrders" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "metaCache" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesLift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GhlLink" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "stageId" TEXT,
    "status" TEXT,
    "pushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pulledAt" TIMESTAMP(3),
    "dirtyAt" TIMESTAMP(3),
    "noteSent" TEXT,
    "dealOppId" TEXT,
    "dealStatus" TEXT,

    CONSTRAINT "GhlLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCode" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessHash" TEXT NOT NULL,
    "refreshHash" TEXT,
    "mcpClientId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_ghlHookKey_key" ON "Client"("ghlHookKey");

-- CreateIndex
CREATE INDEX "AdSet_campaignId_idx" ON "AdSet"("campaignId");

-- CreateIndex
CREATE INDEX "Ad_campaignId_idx" ON "Ad"("campaignId");

-- CreateIndex
CREATE INDEX "Ad_adSetId_idx" ON "Ad"("adSetId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetric_clientId_date_key" ON "DailyMetric"("clientId", "date");

-- CreateIndex
CREATE INDEX "Conversation_clientId_updatedTime_idx" ON "Conversation"("clientId", "updatedTime");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdTime_idx" ON "Message"("conversationId", "createdTime");

-- CreateIndex
CREATE INDEX "Recommendation_clientId_kind_status_idx" ON "Recommendation"("clientId", "kind", "status");

-- CreateIndex
CREATE INDEX "Activity_clientId_createdAt_idx" ON "Activity"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_clientId_category_idx" ON "KnowledgeDoc"("clientId", "category");

-- CreateIndex
CREATE INDEX "TargetingRanking_clientId_createdAt_idx" ON "TargetingRanking"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "ClientAccess_userId_idx" ON "ClientAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAccess_clientId_userId_key" ON "ClientAccess"("clientId", "userId");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_createdAt_idx" ON "Invite"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "TargetingItem_type_idx" ON "TargetingItem"("type");

-- CreateIndex
CREATE INDEX "TargetingItem_status_idx" ON "TargetingItem"("status");

-- CreateIndex
CREATE INDEX "TargetingRun_status_createdAt_idx" ON "TargetingRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TargetingChange_runId_idx" ON "TargetingChange"("runId");

-- CreateIndex
CREATE INDEX "TargetingChange_change_createdAt_idx" ON "TargetingChange"("change", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TargetingSeedSet_name_key" ON "TargetingSeedSet"("name");

-- CreateIndex
CREATE INDEX "PagePost_clientId_createdTime_idx" ON "PagePost"("clientId", "createdTime");

-- CreateIndex
CREATE INDEX "PostComment_clientId_idx" ON "PostComment"("clientId");

-- CreateIndex
CREATE INDEX "PostComment_postId_idx" ON "PostComment"("postId");

-- CreateIndex
CREATE INDEX "AdBreakdown_clientId_dimension_idx" ON "AdBreakdown"("clientId", "dimension");

-- CreateIndex
CREATE INDEX "ClientJob_status_createdAt_idx" ON "ClientJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ClientJob_clientId_status_idx" ON "ClientJob"("clientId", "status");

-- CreateIndex
CREATE INDEX "CampaignProposal_clientId_createdAt_idx" ON "CampaignProposal"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "AdSetHistory_clientId_resultType_idx" ON "AdSetHistory"("clientId", "resultType");

-- CreateIndex
CREATE INDEX "TargetingClientStat_industryKey_resultType_idx" ON "TargetingClientStat"("industryKey", "resultType");

-- CreateIndex
CREATE UNIQUE INDEX "TargetingClientStat_clientId_resultType_key_key" ON "TargetingClientStat"("clientId", "resultType", "key");

-- CreateIndex
CREATE INDEX "Lead_clientId_createdTime_idx" ON "Lead"("clientId", "createdTime");

-- CreateIndex
CREATE INDEX "OwnAd_clientId_idx" ON "OwnAd"("clientId");

-- CreateIndex
CREATE INDEX "AdReferral_pageId_psid_at_idx" ON "AdReferral"("pageId", "psid", "at");

-- CreateIndex
CREATE INDEX "ContentReview_clientId_createdAt_idx" ON "ContentReview"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_at_idx" ON "AiUsage"("at");

-- CreateIndex
CREATE INDEX "AiUsage_clientId_at_idx" ON "AiUsage"("clientId", "at");

-- CreateIndex
CREATE INDEX "AiUsage_workspaceId_at_idx" ON "AiUsage"("workspaceId", "at");

-- CreateIndex
CREATE INDEX "NurtureFlow_clientId_idx" ON "NurtureFlow"("clientId");

-- CreateIndex
CREATE INDEX "NurtureSend_flowId_psid_idx" ON "NurtureSend"("flowId", "psid");

-- CreateIndex
CREATE INDEX "NurtureSend_clientId_sentAt_idx" ON "NurtureSend"("clientId", "sentAt");

-- CreateIndex
CREATE INDEX "NurtureSend_pageId_psid_sentAt_idx" ON "NurtureSend"("pageId", "psid", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NurtureOptOut_pageId_psid_key" ON "NurtureOptOut"("pageId", "psid");

-- CreateIndex
CREATE UNIQUE INDEX "SalesFeedback_clientId_rowKey_key" ON "SalesFeedback"("clientId", "rowKey");

-- CreateIndex
CREATE INDEX "ClientReport_clientId_createdAt_idx" ON "ClientReport"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientReport_keyHash_idx" ON "ClientReport"("keyHash");

-- CreateIndex
CREATE INDEX "ReportSchedule_clientId_idx" ON "ReportSchedule"("clientId");

-- CreateIndex
CREATE INDEX "BotChat_clientId_createdAt_idx" ON "BotChat"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "BotChat_createdAt_idx" ON "BotChat"("createdAt");

-- CreateIndex
CREATE INDEX "LeadNotice_clientId_createdAt_idx" ON "LeadNotice"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadNotice_clientId_rowKey_idx" ON "LeadNotice"("clientId", "rowKey");

-- CreateIndex
CREATE INDEX "LeadNotice_code_idx" ON "LeadNotice"("code");

-- CreateIndex
CREATE INDEX "GAdsChange_clientId_status_idx" ON "GAdsChange"("clientId", "status");

-- CreateIndex
CREATE INDEX "GAdsAd_clientId_idx" ON "GAdsAd"("clientId");

-- CreateIndex
CREATE INDEX "GAdsSearchTerm_clientId_idx" ON "GAdsSearchTerm"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "GAdsDaily_clientId_campaignId_date_key" ON "GAdsDaily"("clientId", "campaignId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "KvBranch_clientId_kvId_key" ON "KvBranch"("clientId", "kvId");

-- CreateIndex
CREATE INDEX "KvCustomer_clientId_phone_idx" ON "KvCustomer"("clientId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "KvCustomer_clientId_kvId_key" ON "KvCustomer"("clientId", "kvId");

-- CreateIndex
CREATE INDEX "KvInvoice_clientId_date_idx" ON "KvInvoice"("clientId", "date");

-- CreateIndex
CREATE INDEX "KvInvoice_clientId_customerId_idx" ON "KvInvoice"("clientId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "KvInvoice_clientId_kvId_key" ON "KvInvoice"("clientId", "kvId");

-- CreateIndex
CREATE UNIQUE INDEX "KvDaily_clientId_date_branchId_key" ON "KvDaily"("clientId", "date", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "KvProductDaily_clientId_date_productId_key" ON "KvProductDaily"("clientId", "date", "productId");

-- CreateIndex
CREATE INDEX "SalesLift_clientId_idx" ON "SalesLift"("clientId");

-- CreateIndex
CREATE INDEX "GhlLink_clientId_opportunityId_idx" ON "GhlLink"("clientId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "GhlLink_clientId_rowKey_key" ON "GhlLink"("clientId", "rowKey");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_accessHash_key" ON "McpToken"("accessHash");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_refreshHash_key" ON "McpToken"("refreshHash");

-- CreateIndex
CREATE INDEX "McpToken_userId_idx" ON "McpToken"("userId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "AdSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMetric" ADD CONSTRAINT "DailyMetric_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDraft" ADD CONSTRAINT "CampaignDraft_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceAnalysis" ADD CONSTRAINT "AudienceAnalysis_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetingRanking" ADD CONSTRAINT "TargetingRanking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetingRanking" ADD CONSTRAINT "TargetingRanking_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AudienceAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAccess" ADD CONSTRAINT "ClientAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAccess" ADD CONSTRAINT "ClientAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetingChange" ADD CONSTRAINT "TargetingChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TargetingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagePost" ADD CONSTRAINT "PagePost_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "PagePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdBreakdown" ADD CONSTRAINT "AdBreakdown_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientJob" ADD CONSTRAINT "ClientJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignProposal" ADD CONSTRAINT "CampaignProposal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSetHistory" ADD CONSTRAINT "AdSetHistory_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetingClientStat" ADD CONSTRAINT "TargetingClientStat_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnAd" ADD CONSTRAINT "OwnAd_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReview" ADD CONSTRAINT "ContentReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureFlow" ADD CONSTRAINT "NurtureFlow_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureSend" ADD CONSTRAINT "NurtureSend_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "NurtureFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureSend" ADD CONSTRAINT "NurtureSend_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureOptOut" ADD CONSTRAINT "NurtureOptOut_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesFeedback" ADD CONSTRAINT "SalesFeedback_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientReport" ADD CONSTRAINT "ClientReport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadNotice" ADD CONSTRAINT "LeadNotice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsCampaign" ADD CONSTRAINT "GAdsCampaign_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsChange" ADD CONSTRAINT "GAdsChange_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsAdGroup" ADD CONSTRAINT "GAdsAdGroup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsKeyword" ADD CONSTRAINT "GAdsKeyword_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsAd" ADD CONSTRAINT "GAdsAd_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsSearchTerm" ADD CONSTRAINT "GAdsSearchTerm_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAdsDaily" ADD CONSTRAINT "GAdsDaily_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KvBranch" ADD CONSTRAINT "KvBranch_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KvCustomer" ADD CONSTRAINT "KvCustomer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KvInvoice" ADD CONSTRAINT "KvInvoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KvDaily" ADD CONSTRAINT "KvDaily_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KvProductDaily" ADD CONSTRAINT "KvProductDaily_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLift" ADD CONSTRAINT "SalesLift_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GhlLink" ADD CONSTRAINT "GhlLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

