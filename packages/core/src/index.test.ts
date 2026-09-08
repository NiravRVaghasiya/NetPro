import { describe, it, expect } from "vitest";
import * as core from "./index";

describe("@netpro/core module boundaries", () => {
  it("exposes every feature module", () => {
    expect(typeof core.search.searchContacts).toBe("function");
    expect(typeof core.enrichment.EnrichmentPipeline).toBe("function");
    // Real since v1.0 Phase 3 (network analytics).
    expect(typeof core.analytics.getNetworkOverview).toBe("function");
    // Real since v1.0 Phase 4 (AI outreach drafting).
    expect(typeof core.ai.composeOutreachMessage).toBe("function");
    expect(typeof core.ai.resolveAiProvider).toBe("function");
    expect(typeof core.card.renderProfileCardHtml).toBe("function");
    expect(typeof core.card.publishProfileCard).toBe("function");
    expect(core.crm.MODULE_NAME).toBe("crm");
    // Real since v1.5 Phase 7 (CRM tracking & follow-ups).
    expect(typeof core.crm.logInteraction).toBe("function");
    expect(typeof core.crm.computeRelationshipScore).toBe("function");
    expect(typeof core.crm.createFollowUp).toBe("function");
    expect(typeof core.crm.getContactTimeline).toBe("function");
    // Real since v1.5 Phase 8 (batch campaigns, draft-only).
    expect(typeof core.campaigns.createCampaign).toBe("function");
    expect(typeof core.campaigns.renderCampaign).toBe("function");
    expect(typeof core.campaigns.markRecipientSent).toBe("function");
    expect(typeof core.campaigns.setCampaignStatus).toBe("function");
    expect(core.campaigns.TEMPLATE_VARIABLES).toContain("firstName");
    expect(core.campaigns.CAMPAIGN_STATUSES).toContain("draft");
    expect(typeof core.graph.addEdge).toBe("function");
    expect(typeof core.graph.listEdges).toBe("function");
    expect(typeof core.graph.recordEventAttendance).toBe("function");
    expect(core.graph.EDGE_RELATIONS).toContain("mutual_network");
    // Real since v2.0 Phase 6 (event matcher).
    expect(typeof core.events.importEvents).toBe("function");
    expect(typeof core.events.matchAttendees).toBe("function");
    expect(typeof core.events.recommendEvents).toBe("function");
    expect(typeof core.events.getEvent).toBe("function");
    expect(core.events.MODULE_NAME).toBe("events");
    expect(core.events.DISABLED_EVENT_PROVIDER.enabled).toBe(false);
    expect(typeof core.importPipeline.runImport).toBe("function");
    expect(typeof core.exportPipeline.exportContactsCSV).toBe("function");
    // Real since v2.5 Phase 1 (profile views privacy & retention foundations).
    expect(typeof core.views.hashViewerIp).toBe("function");
    expect(typeof core.views.hashViewerFingerprint).toBe("function");
    expect(typeof core.views.isBotUserAgent).toBe("function");
    expect(typeof core.views.shouldMarkOwnerView).toBe("function");
    expect(typeof core.views.purgeExpiredProfileViews).toBe("function");
    expect(core.views.VIEW_RETENTION_DAYS).toBe(90);
    expect(core.views.BOT_UA_MARKERS.length).toBeGreaterThan(0);
    // Real since v2.5 Phase 2 (tracking beacon & ingestion pipeline).
    expect(typeof core.views.parseReferrer).toBe("function");
    expect(typeof core.views.parseUtm).toBe("function");
    expect(typeof core.views.mergeUtm).toBe("function");
    expect(typeof core.views.createRateLimiter).toBe("function");
    expect(core.views.BEACON_RATE_LIMIT.limit).toBe(60);
    expect(typeof core.views.extractViewerIp).toBe("function");
    expect(typeof core.views.extractViewerGeo).toBe("function");
    expect(typeof core.views.isDntRequest).toBe("function");
    expect(typeof core.views.normalizeViewedPage).toBe("function");
    expect(typeof core.views.shouldCountView).toBe("function");
    expect(typeof core.views.recordView).toBe("function");
    expect(typeof core.views.createContactViewToken).toBe("function");
    expect(typeof core.views.resolveContactFromToken).toBe("function");
    expect(typeof core.views.findLiveContactId).toBe("function");
    expect(core.views.VIEWED_PAGES).toContain("/card");
  });
});
